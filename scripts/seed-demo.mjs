#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { RunJournal } from "../packages/run-journal/dist/index.js";
import { LocalSnapshotEngine } from "../packages/snapshot-engine/dist/index.js";
import { IntegrationState } from "../packages/integration-state/dist/index.js";
import { ControlPlaneStateStore } from "../packages/control-plane-state/dist/index.js";
import {
  ActionRecordSchema,
  ApprovalInboxItemSchema,
  PolicyOutcomeRecordSchema,
} from "../packages/schemas/dist/index.js";
import {
  ConnectorEventBatchRequestSchema,
  ConnectorEventBatchResponseSchema,
  ConnectorHeartbeatRequestSchema,
  ConnectorHeartbeatResponseSchema,
  ConnectorRegistrationRequestSchema,
  ConnectorRegistrationResponseSchema,
  ConnectorRecordSchema,
  RepositoryStateSnapshotSchema,
} from "../packages/cloud-sync-protocol/dist/index.js";

import {
  ActivityFeedResponseSchema,
  ApprovalListResponseSchema,
  AuditLogResponseSchema,
  ConnectorBootstrapResponseSchema,
  OnboardingBootstrapSchema,
  OnboardingFormValuesSchema,
  OnboardingLaunchResponseSchema,
  RepositoryListResponseSchema,
  RepositorySnapshotsResponseSchema,
  RepositoryRunsResponseSchema,
  WorkspaceConnectorInventorySchema,
  WorkspaceSettingsSaveResponseSchema,
  WorkspaceSettingsSchema,
  WorkspaceSettingsUpdateSchema,
} from "../apps/agentgit-cloud/src/schemas/cloud.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DEMO_MARKER_FILE = ".agentgit-demo-seed.json";
const DEMO_WORKSPACE_NAME = "Acme Engineering";
const DEMO_WORKSPACE_SLUG = "acme-engineering";
const DEMO_WORKSPACE_OWNER = "acme";
const DEFAULT_OWNER_EMAIL = "owner@acme.demo";
const DEFAULT_OWNER_NAME = "Avery Carter";

const parsedArgs = parseArgs(process.argv.slice(2));

if (parsedArgs.help) {
  printUsage();
  process.exit(0);
}

const now = new Date();
const cloudUrl = normalizeBaseUrl(
  parsedArgs.cloudUrl ?? process.env.AGENTGIT_CLOUD_URL ?? process.env.AUTH_URL ?? process.env.NEXTAUTH_URL,
);
const ownerEmail = parsedArgs.ownerEmail ?? DEFAULT_OWNER_EMAIL;
const ownerName = parsedArgs.ownerName ?? DEFAULT_OWNER_NAME;
const cloudRoot = path.resolve(parsedArgs.cloudRoot ?? process.env.AGENTGIT_ROOT ?? process.cwd());
const configuredWorkspaceRoots = resolveWorkspaceRoots(
  parsedArgs.workspaceRoots ?? process.env.DEMO_REPO_ROOTS ?? process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS,
);

if (configuredWorkspaceRoots.length < 5) {
  throw new Error(
    [
      "Demo seeding needs at least 5 workspace roots.",
      "Pass --workspace-roots /abs/repo-1,/abs/repo-2,/abs/repo-3,/abs/repo-4,/abs/repo-5",
      "or set DEMO_REPO_ROOTS / AGENTGIT_CLOUD_WORKSPACE_ROOTS before running the script.",
    ].join(" "),
  );
}

const demoRoots = configuredWorkspaceRoots.slice(0, 5).map((root) => path.resolve(root));
const demoRepos = buildDemoRepositories(demoRoots);

await main();

async function main() {
  logStep(`Preparing ${demoRepos.length} demo repositories under the configured workspace roots`);
  for (const repo of demoRepos) {
    await recreateDemoRepository(repo);
  }

  logStep("Seeding local run journals and snapshot manifests");
  const seededState = await seedLocalRepositoryState(demoRepos, now);

  logStep(`Authenticating against ${cloudUrl} with the development credentials provider`);
  const client = new SessionClient(cloudUrl);
  await signInWithDevelopmentCredentials(client, {
    ownerEmail,
    ownerName,
    callbackUrl: "/app",
  });

  logStep(`Creating or refreshing the ${DEMO_WORKSPACE_NAME} workspace via onboarding APIs`);
  const onboarding = await onboardWorkspace(client, demoRepos);

  logStep("Applying workspace settings so the demo data matches the product story");
  await saveWorkspaceSettings(client, {
    workspaceName: DEMO_WORKSPACE_NAME,
    workspaceSlug: DEMO_WORKSPACE_SLUG,
    defaultNotificationChannel: "slack",
    approvalTtlMinutes: 45,
    requireRejectComment: true,
    freezeDeploysOutsideBusinessHours: true,
  });

  logStep("Cleaning existing demo connectors and events from the local control-plane store");
  const controlPlaneDbPath = path.join(cloudRoot, ".agentgit", "state", "cloud", "control-plane.db");
  await cleanupExistingDemoControlPlaneState(controlPlaneDbPath);

  logStep("Registering demo connectors and publishing approval / policy sync events");
  const connectorSummary = await seedConnectors(client, onboarding.workspaceId, seededState, controlPlaneDbPath);

  logStep("Validating the seeded demo surface through the hosted APIs");
  const validation = await validateSeededSurface(client, demoRepos);

  printSummary({
    workspaceId: onboarding.workspaceId,
    workspaceName: DEMO_WORKSPACE_NAME,
    workspaceSlug: DEMO_WORKSPACE_SLUG,
    ownerEmail,
    cloudUrl,
    connectors: connectorSummary,
    validation,
    rootsUsed: demoRepos.map((repo) => repo.root),
  });
}

function parseArgs(argv) {
  const result = {
    help: false,
    cloudUrl: null,
    cloudRoot: null,
    ownerEmail: null,
    ownerName: null,
    workspaceRoots: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }

    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }

    const [flag, inlineValue] = arg.split("=", 2);
    const value = inlineValue ?? argv[index + 1];
    if (inlineValue === undefined) {
      index += 1;
    }

    if (!value) {
      throw new Error(`Missing value for ${flag}`);
    }

    switch (flag) {
      case "--cloud-url":
        result.cloudUrl = value;
        break;
      case "--cloud-root":
        result.cloudRoot = value;
        break;
      case "--owner-email":
        result.ownerEmail = value;
        break;
      case "--owner-name":
        result.ownerName = value;
        break;
      case "--workspace-roots":
        result.workspaceRoots = value;
        break;
      default:
        throw new Error(`Unsupported flag: ${flag}`);
    }
  }

  return result;
}

function printUsage() {
  process.stdout.write(
    [
      "Usage: pnpm seed:demo [options]",
      "",
      "Required environment or flags:",
      "  --cloud-url         Running AgentGit Cloud base URL",
      "  --workspace-roots   Comma-separated absolute repo roots used by the running cloud app",
      "",
      "Optional:",
      "  --cloud-root        Root used by the cloud app for .agentgit/state/cloud (defaults to AGENTGIT_ROOT or cwd)",
      "  --owner-email       Dev-auth email (default: owner@acme.demo)",
      "  --owner-name        Dev-auth display name (default: Avery Carter)",
      "",
      "Examples:",
      "  pnpm seed:demo --cloud-url http://localhost:3000 \\",
      "    --workspace-roots /tmp/demo/payments,/tmp/demo/portal,/tmp/demo/guard,/tmp/demo/sandbox,/tmp/demo/mobile",
      "",
      "Notes:",
      "  - The running cloud app must have development credentials enabled.",
      "  - The app must be able to inspect the same workspace roots passed here.",
      `  - Only directories marked with ${DEMO_MARKER_FILE} are recreated on reruns.`,
      "",
    ].join("\n"),
  );
}

function normalizeBaseUrl(value) {
  if (!value) {
    throw new Error("Missing cloud URL. Pass --cloud-url or set AGENTGIT_CLOUD_URL / AUTH_URL / NEXTAUTH_URL.");
  }

  return value.replace(/\/+$/, "");
}

function resolveWorkspaceRoots(rawValue) {
  if (!rawValue) {
    return [];
  }

  return rawValue
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function buildDemoRepositories(roots) {
  return [
    {
      key: "payments-api",
      root: roots[0],
      owner: DEMO_WORKSPACE_OWNER,
      name: "payments-api",
      state: "healthy",
      description: "Governed service for payments workflows and charge orchestration.",
      commitOffsetHours: 120,
      runCount: 9,
      targetFiles: ["src/ledger.ts", "src/settlement.ts", "README.md"],
    },
    {
      key: "customer-portal",
      root: roots[1],
      owner: DEMO_WORKSPACE_OWNER,
      name: "customer-portal",
      state: "healthy",
      description: "Customer-facing portal with guided release automation.",
      commitOffsetHours: 96,
      runCount: 9,
      targetFiles: ["app/dashboard/page.tsx", "app/settings/page.tsx", "README.md"],
    },
    {
      key: "deployment-guard",
      root: roots[2],
      owner: DEMO_WORKSPACE_OWNER,
      name: "deployment-guard",
      state: "policy_violations",
      description: "Release protection service with strict policy enforcement.",
      commitOffsetHours: 72,
      runCount: 6,
      targetFiles: ["policies/release-policy.json", "scripts/release-check.ts", "README.md"],
    },
    {
      key: "agent-sandbox",
      root: roots[3],
      owner: DEMO_WORKSPACE_OWNER,
      name: "agent-sandbox",
      state: "pending_approvals",
      description: "High-change sandbox where risky workflows route through human approvals.",
      commitOffsetHours: 48,
      runCount: 6,
      targetFiles: ["infra/main.tf", "ops/migrations.md", "README.md"],
    },
    {
      key: "mobile-shell",
      root: roots[4],
      owner: DEMO_WORKSPACE_OWNER,
      name: "mobile-shell",
      state: "freshly_connected",
      description: "Freshly connected mobile workspace with no governed runs yet.",
      commitOffsetHours: 2,
      runCount: 0,
      targetFiles: ["app/App.tsx", "README.md"],
    },
  ];
}

async function recreateDemoRepository(repo) {
  await assertWorkspaceRootIsSafe(repo.root);
  await fs.rm(repo.root, { recursive: true, force: true });
  await fs.mkdir(repo.root, { recursive: true });

  const marker = {
    seededAt: new Date().toISOString(),
    seededBy: "scripts/seed-demo.mjs",
    repository: `${repo.owner}/${repo.name}`,
    state: repo.state,
  };

  const files = buildRepositoryFiles(repo, marker);
  for (const [relativePath, content] of Object.entries(files)) {
    await writeFile(path.join(repo.root, relativePath), content);
  }

  runGit(["init", "-b", "main"], repo.root);
  runGit(["config", "user.name", "AgentGit Demo Seeder"], repo.root);
  runGit(["config", "user.email", "demo-seed@agentgit.dev"], repo.root);
  runGit(["remote", "add", "origin", `https://github.com/${repo.owner}/${repo.name}.git`], repo.root);
  runGit(["add", "."], repo.root);

  const commitAt = new Date(now.getTime() - repo.commitOffsetHours * HOUR_MS).toISOString();
  runGit(["commit", "-m", "Seed demo repository baseline"], repo.root, {
    GIT_AUTHOR_DATE: commitAt,
    GIT_COMMITTER_DATE: commitAt,
  });
}

async function assertWorkspaceRootIsSafe(root) {
  try {
    const stats = await fs.stat(root);
    if (!stats.isDirectory()) {
      throw new Error(`Workspace root is not a directory: ${root}`);
    }
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return;
    }

    throw error;
  }

  const entries = await fs.readdir(root);
  if (entries.length === 0) {
    return;
  }

  try {
    await fs.access(path.join(root, DEMO_MARKER_FILE));
  } catch {
    throw new Error(
      [
        `Refusing to overwrite a non-demo directory: ${root}`,
        `Create an empty directory or reuse a path already marked with ${DEMO_MARKER_FILE}.`,
      ].join(" "),
    );
  }
}

function buildRepositoryFiles(repo, marker) {
  const basePackageJson = {
    name: `${repo.owner}-${repo.name}`,
    private: true,
    version: "0.0.0-demo",
    description: repo.description,
    scripts: {
      dev: "echo demo workspace",
      build: "echo demo build",
      test: "echo demo test",
    },
  };

  const commonFiles = {
    [DEMO_MARKER_FILE]: `${JSON.stringify(marker, null, 2)}\n`,
    ".gitignore": ".agentgit/\nnode_modules/\n.env*\n",
    "README.md": [
      `# ${repo.owner}/${repo.name}`,
      "",
      repo.description,
      "",
      `This repository is demo data for the ${DEMO_WORKSPACE_NAME} sales environment.`,
      "",
    ].join("\n"),
    "package.json": `${JSON.stringify(basePackageJson, null, 2)}\n`,
  };

  if (repo.key === "payments-api") {
    return {
      ...commonFiles,
      "src/ledger.ts": ["export function settleInvoice(invoiceId) {", "  return `settled:${invoiceId}`;", "}", ""].join(
        "\n",
      ),
      "src/settlement.ts": [
        "export function previewSettlement(batchId) {",
        "  return { batchId, dryRun: true };",
        "}",
        "",
      ].join("\n"),
    };
  }

  if (repo.key === "customer-portal") {
    return {
      ...commonFiles,
      "app/dashboard/page.tsx": [
        "export default function DashboardPage() {",
        "  return <main>Customer portal dashboard</main>;",
        "}",
        "",
      ].join("\n"),
      "app/settings/page.tsx": [
        "export default function SettingsPage() {",
        "  return <main>Settings</main>;",
        "}",
        "",
      ].join("\n"),
    };
  }

  if (repo.key === "deployment-guard") {
    return {
      ...commonFiles,
      "policies/release-policy.json": `${JSON.stringify(
        {
          approvalsRequired: true,
          blockProdAfterHours: true,
          denySecretsInDiff: true,
        },
        null,
        2,
      )}\n`,
      "scripts/release-check.ts": [
        "export function evaluateReleaseWindow() {",
        "  return 'manual-review';",
        "}",
        "",
      ].join("\n"),
    };
  }

  if (repo.key === "agent-sandbox") {
    return {
      ...commonFiles,
      "infra/main.tf": [
        'terraform { required_version = ">= 1.8.0" }',
        "",
        'resource "null_resource" "sandbox" {}',
        "",
      ].join("\n"),
      "ops/migrations.md": [
        "# Migration Notes",
        "",
        "- Review change windows before applying production updates.",
        "",
      ].join("\n"),
    };
  }

  return {
    ...commonFiles,
    "app/App.tsx": ["export function App() {", "  return null;", "}", ""].join("\n"),
  };
}

async function writeFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

function runGit(args, cwd, extraEnv = {}) {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      ...extraEnv,
    },
    stdio: "ignore",
  });
}

async function seedLocalRepositoryState(repos, referenceTime) {
  const pendingApprovals = [];
  const snapshots = [];
  const repositoryStates = [];
  const connectors = [];

  const runTimestamps = createRunTimeline(referenceTime, 30);
  const repoRuns = [
    ...Array.from({ length: 9 }, (_, index) => ({ repoKey: "payments-api", index })),
    ...Array.from({ length: 9 }, (_, index) => ({ repoKey: "customer-portal", index })),
    ...Array.from({ length: 6 }, (_, index) => ({ repoKey: "deployment-guard", index })),
    ...Array.from({ length: 6 }, (_, index) => ({ repoKey: "agent-sandbox", index })),
  ].map((record, index) => ({
    ...record,
    createdAt: runTimestamps[index],
  }));

  const runsByRepo = new Map();
  for (const runRecord of repoRuns) {
    const existing = runsByRepo.get(runRecord.repoKey) ?? [];
    existing.push(runRecord);
    runsByRepo.set(runRecord.repoKey, existing);
  }

  for (const repo of repos) {
    const journal = new RunJournal({
      dbPath: path.join(repo.root, ".agentgit", "state", "authority.db"),
    });
    const snapshotEngine = new LocalSnapshotEngine({
      rootDir: path.join(repo.root, ".agentgit", "state", "snapshots"),
    });

    try {
      const repoRunsForSeed = runsByRepo.get(repo.key) ?? [];
      const seeded = await seedRepositoryRuns({
        repo,
        journal,
        snapshotEngine,
        runPlan: repoRunsForSeed,
      });
      pendingApprovals.push(...seeded.pendingApprovals);
      snapshots.push(...seeded.snapshots);
      repositoryStates.push(seeded.repositoryState);
      if (seeded.connectorSeed) {
        connectors.push(seeded.connectorSeed);
      }
      journal.checkpointWal();
    } finally {
      journal.close();
    }
  }

  return {
    pendingApprovals,
    repositoryStates,
    snapshots,
    connectors,
  };
}

function createRunTimeline(referenceTime, count) {
  const startTime = referenceTime.getTime() - 7 * DAY_MS + 4 * HOUR_MS;
  const spacingMs = Math.floor((6.5 * DAY_MS) / count);
  return Array.from({ length: count }, (_, index) => new Date(startTime + index * spacingMs).toISOString());
}

async function seedRepositoryRuns({ repo, journal, snapshotEngine, runPlan }) {
  const pendingApprovals = [];
  const snapshots = [];
  const connectorSeed = buildConnectorSeed(repo);

  for (const entry of runPlan) {
    const runId = `demo_${repo.key}_run_${String(entry.index + 1).padStart(2, "0")}`;
    const workflow = pickWorkflow(repo.key, entry.index);
    const agent = pickAgent(repo.key, entry.index);
    const runCreatedAt = entry.createdAt;

    journal.registerRunLifecycle({
      run_id: runId,
      session_id: `sess_${repo.key}`,
      workflow_name: workflow.name,
      agent_framework: agent.framework,
      agent_name: agent.name,
      workspace_roots: [repo.root],
      client_metadata: {
        seeded: true,
        repository: `${repo.owner}/${repo.name}`,
        scenario: repo.state,
      },
      budget_config: {
        max_mutating_actions: repo.key === "agent-sandbox" ? 8 : 5,
        max_destructive_actions: repo.key === "deployment-guard" ? 2 : 1,
      },
      created_at: runCreatedAt,
    });

    const scenario = planRunScenario(repo, entry.index);
    for (const [actionIndex, actionPlan] of scenario.actions.entries()) {
      const actionId = `${runId}_act_${String(actionIndex + 1).padStart(2, "0")}`;
      const actionTimestamp = offsetIso(runCreatedAt, (actionIndex + 1) * 60);
      const action = makeAction({
        repo,
        runId,
        actionId,
        occurredAt: actionTimestamp,
        plan: actionPlan,
      });

      journal.appendRunEvent(runId, {
        event_type: "action.normalized",
        occurred_at: actionTimestamp,
        recorded_at: actionTimestamp,
        payload: {
          action_id: action.action_id,
          target_locator: action.target.primary.locator,
          target_label: action.target.primary.label,
          action,
          occurred_at: actionTimestamp,
        },
      });

      const policyTimestamp = offsetIso(actionTimestamp, 45);
      const policyOutcome = makePolicyOutcome({
        actionId,
        evaluatedAt: policyTimestamp,
        plan: actionPlan,
      });

      journal.appendRunEvent(runId, {
        event_type: "policy.evaluated",
        occurred_at: policyTimestamp,
        recorded_at: policyTimestamp,
        payload: {
          action_id: action.action_id,
          decision: policyOutcome.decision,
          reasons: policyOutcome.reasons,
          snapshot_required: policyOutcome.preconditions.snapshot_required,
          approval_required: policyOutcome.preconditions.approval_required,
          policy_outcome: policyOutcome,
        },
      });

      if (actionPlan.snapshotRequired) {
        const snapshot = await snapshotEngine.createSnapshot({
          action,
          requested_class: actionPlan.snapshotClass,
          workspace_root: repo.root,
        });

        snapshots.push({
          repository: `${repo.owner}/${repo.name}`,
          snapshotId: snapshot.snapshot_id,
        });

        const snapshotTimestamp = offsetIso(policyTimestamp, 45);
        journal.appendRunEvent(runId, {
          event_type: "snapshot.created",
          occurred_at: snapshotTimestamp,
          recorded_at: snapshotTimestamp,
          payload: {
            action_id: action.action_id,
            snapshot_id: snapshot.snapshot_id,
            snapshot_class: snapshot.snapshot_class,
            fidelity: snapshot.fidelity,
          },
        });

        if (actionPlan.addRecoveryEvent) {
          const recoveryTimestamp = offsetIso(snapshotTimestamp, 90);
          journal.appendRunEvent(runId, {
            event_type: "recovery.executed",
            occurred_at: recoveryTimestamp,
            recorded_at: recoveryTimestamp,
            payload: {
              action_id: action.action_id,
              snapshot_id: snapshot.snapshot_id,
              outcome: "restored",
              recovery_class: "recoverable_local",
              strategy: "restore_snapshot",
            },
          });
        }
      }

      if (actionPlan.approvalCount > 0) {
        for (let approvalIndex = 0; approvalIndex < actionPlan.approvalCount; approvalIndex += 1) {
          const approvalReason = actionPlan.approvalReasons[approvalIndex];
          const approvalAction = ActionRecordSchema.parse({
            ...action,
            action_id: `${action.action_id}_approval_${approvalIndex + 1}`,
            operation: {
              ...action.operation,
              display_name: approvalReason.actionSummary,
            },
            target: {
              ...action.target,
              primary: {
                ...action.target.primary,
                locator: path.join(repo.root, approvalReason.targetPath),
                label: approvalReason.targetLabel,
              },
            },
            risk_hints: {
              ...action.risk_hints,
              side_effect_level: approvalReason.sideEffectLevel,
              external_effects: approvalReason.externalEffects,
              sensitivity_hint: approvalReason.sensitivityHint,
            },
            confidence_assessment: makeConfidenceAssessment(approvalReason.confidenceScore),
          });

          const approvalPolicy = PolicyOutcomeRecordSchema.parse({
            ...policyOutcome,
            policy_outcome_id: `${policyOutcome.policy_outcome_id}_approval_${approvalIndex + 1}`,
            action_id: approvalAction.action_id,
            reasons: [
              {
                code: approvalReason.reasonCode,
                severity: approvalReason.severity,
                message: approvalReason.reasonSummary,
              },
            ],
            decision: "ask",
            preconditions: {
              snapshot_required: false,
              approval_required: true,
              simulation_supported: false,
            },
            policy_context: {
              matched_rules: [approvalReason.ruleName],
              sticky_decision_applied: false,
            },
            evaluated_at: offsetIso(policyTimestamp, approvalIndex * 30 + 15),
          });

          const approval = journal.createApprovalRequest({
            run_id: runId,
            action: approvalAction,
            policy_outcome: approvalPolicy,
          });

          const inboxItem = ApprovalInboxItemSchema.parse({
            approval_id: approval.approval_id,
            run_id: runId,
            workflow_name: workflow.name,
            action_id: approvalAction.action_id,
            action_summary: approvalReason.actionSummary,
            action_domain: approvalReason.domain,
            side_effect_level: approvalReason.sideEffectLevel,
            status: "pending",
            requested_at: approval.requested_at,
            resolved_at: null,
            resolution_note: null,
            decision_requested: "approve_or_deny",
            snapshot_required: false,
            reason_summary: approvalReason.reasonSummary,
            primary_reason: {
              code: approvalReason.reasonCode,
              message: approvalReason.reasonSummary,
            },
            target_locator: approvalAction.target.primary.locator,
            target_label: approvalAction.target.primary.label ?? approvalReason.targetLabel,
          });

          pendingApprovals.push({
            repositoryOwner: repo.owner,
            repositoryName: repo.name,
            approval: inboxItem,
          });

          journal.appendRunEvent(runId, {
            event_type: "approval.requested",
            occurred_at: inboxItem.requested_at,
            recorded_at: inboxItem.requested_at,
            payload: {
              action_id: approvalAction.action_id,
              approval_id: approval.approval_id,
              action_summary: approvalReason.actionSummary,
              reason_summary: approvalReason.reasonSummary,
              snapshot_required: false,
              target_locator: approvalAction.target.primary.locator,
            },
          });
        }

        continue;
      }

      const terminalTimestamp = offsetIso(policyTimestamp, 75);
      if (actionPlan.terminal === "failed") {
        journal.appendRunEvent(runId, {
          event_type: "execution.failed",
          occurred_at: terminalTimestamp,
          recorded_at: terminalTimestamp,
          payload: {
            action_id: action.action_id,
            summary: actionPlan.failureSummary,
            reason: actionPlan.failureSummary,
          },
        });
      } else {
        journal.appendRunEvent(runId, {
          event_type: "execution.completed",
          occurred_at: terminalTimestamp,
          recorded_at: terminalTimestamp,
          payload: {
            action_id: action.action_id,
            summary: actionPlan.successSummary,
            side_effect_level: action.risk_hints.side_effect_level,
          },
        });
      }
    }
  }

  return {
    pendingApprovals,
    snapshots,
    repositoryState: buildRepositoryStateSnapshot(repo),
    connectorSeed,
  };
}

function planRunScenario(repo, index) {
  if (repo.key === "payments-api") {
    return {
      actions: [
        {
          domain: "filesystem",
          kind: "write",
          name: "filesystem.write",
          displayName: pickFrom(
            ["Refresh settlement ledger", "Tune retry handling", "Update ledger invariants"],
            index,
          ),
          targetPath: repo.targetFiles[index % repo.targetFiles.length],
          scopeBreadth: "single",
          sideEffectLevel: "mutating",
          externalEffects: "none",
          reversibilityHint: "reversible",
          sensitivityHint: "low",
          confidenceScore: 0.93,
          decision: index === 2 || index === 7 ? "allow_with_snapshot" : "allow",
          snapshotRequired: index === 2 || index === 7,
          snapshotClass: "journal_plus_anchor",
          successSummary: "Ledger update completed.",
          approvalCount: 0,
          approvalReasons: [],
          addRecoveryEvent: index === 2,
        },
      ],
    };
  }

  if (repo.key === "customer-portal") {
    return {
      actions: [
        {
          domain: "filesystem",
          kind: "write",
          name: "filesystem.write",
          displayName: pickFrom(["Polish dashboard copy", "Refresh onboarding panel", "Tune release banner"], index),
          targetPath: repo.targetFiles[index % repo.targetFiles.length],
          scopeBreadth: "single",
          sideEffectLevel: "mutating",
          externalEffects: "none",
          reversibilityHint: "reversible",
          sensitivityHint: "moderate",
          confidenceScore: 0.89,
          decision: index === 4 ? "allow_with_snapshot" : "allow",
          snapshotRequired: index === 4,
          snapshotClass: "journal_plus_anchor",
          successSummary: "Portal update completed.",
          approvalCount: 0,
          approvalReasons: [],
          addRecoveryEvent: false,
        },
      ],
    };
  }

  if (repo.key === "deployment-guard") {
    return {
      actions: [
        {
          domain: "policy",
          kind: "enforce",
          name: "policy.enforce",
          displayName: pickFrom(
            ["Block unreviewed production deploy", "Reject secret-bearing diff", "Stop after-hours release"],
            index,
          ),
          targetPath: repo.targetFiles[index % repo.targetFiles.length],
          scopeBreadth: "workspace",
          sideEffectLevel: index < 2 ? "destructive" : "mutating",
          externalEffects: "communication",
          reversibilityHint: "potentially_reversible",
          sensitivityHint: "high",
          confidenceScore: 0.58,
          decision: index < 4 ? "deny" : index === 4 ? "allow_with_snapshot" : "allow",
          snapshotRequired: index === 4,
          snapshotClass: "exact_anchor",
          successSummary: "Release protection check completed.",
          failureSummary:
            index < 2
              ? "Policy engine blocked the release because the diff crosses protected boundaries."
              : "Release policy check failed and requires operator review.",
          terminal: index < 2 ? "failed" : "completed",
          approvalCount: 0,
          approvalReasons: [],
          addRecoveryEvent: false,
        },
      ],
    };
  }

  if (repo.key === "agent-sandbox") {
    if (index < 4) {
      return {
        actions: [
          {
            domain: "deploy",
            kind: "apply",
            name: "deploy.apply",
            displayName: pickFrom(
              [
                "Apply production Terraform drift fix",
                "Rotate webhook credentials",
                "Run customer data backfill",
                "Promote hotfix to production",
              ],
              index,
            ),
            targetPath: repo.targetFiles[index % repo.targetFiles.length],
            scopeBreadth: "workspace",
            sideEffectLevel: index % 2 === 0 ? "destructive" : "mutating",
            externalEffects: index % 2 === 0 ? "financial" : "network",
            reversibilityHint: index % 2 === 0 ? "irreversible" : "potentially_reversible",
            sensitivityHint: index % 2 === 0 ? "high" : "moderate",
            confidenceScore: 0.47,
            decision: "ask",
            snapshotRequired: false,
            snapshotClass: "metadata_only",
            successSummary: "Change completed after review.",
            approvalCount: 2,
            approvalReasons: buildApprovalReasons(index),
            addRecoveryEvent: false,
          },
        ],
      };
    }

    return {
      actions: [
        {
          domain: "filesystem",
          kind: "write",
          name: "filesystem.write",
          displayName: pickFrom(["Refresh runbook", "Document migration guardrails"], index),
          targetPath: repo.targetFiles[index % repo.targetFiles.length],
          scopeBreadth: "single",
          sideEffectLevel: "mutating",
          externalEffects: "none",
          reversibilityHint: "reversible",
          sensitivityHint: "moderate",
          confidenceScore: 0.82,
          decision: index === 5 ? "allow_with_snapshot" : "allow",
          snapshotRequired: index === 5,
          snapshotClass: "journal_plus_anchor",
          successSummary: "Sandbox documentation updated.",
          approvalCount: 0,
          approvalReasons: [],
          addRecoveryEvent: false,
        },
      ],
    };
  }

  return { actions: [] };
}

function buildApprovalReasons(seedIndex) {
  const matrices = [
    [
      {
        actionSummary: "Apply Terraform plan to production networking",
        domain: "deploy",
        sideEffectLevel: "destructive",
        externalEffects: "financial",
        sensitivityHint: "high",
        severity: "critical",
        confidenceScore: 0.38,
        reasonCode: "PROD_TERRAFORM_APPLY",
        reasonSummary: "Critical risk: production network changes require explicit reviewer sign-off.",
        ruleName: "rules.prod_terraform_apply",
        targetPath: "infra/main.tf",
        targetLabel: "Production Terraform plan",
      },
      {
        actionSummary: "Rotate Stripe webhook secret in production",
        domain: "network",
        sideEffectLevel: "mutating",
        externalEffects: "communication",
        sensitivityHint: "high",
        severity: "high",
        confidenceScore: 0.44,
        reasonCode: "CREDENTIAL_ROTATION",
        reasonSummary: "High risk: credential rotation touches live integrations and must be reviewed.",
        ruleName: "rules.credential_rotation",
        targetPath: "ops/migrations.md",
        targetLabel: "Stripe credential rotation",
      },
    ],
    [
      {
        actionSummary: "Backfill customer ledger adjustments",
        domain: "policy",
        sideEffectLevel: "mutating",
        externalEffects: "financial",
        sensitivityHint: "moderate",
        severity: "moderate",
        confidenceScore: 0.52,
        reasonCode: "CUSTOMER_DATA_BACKFILL",
        reasonSummary: "Moderate risk: customer-impacting backfills require a reviewer before execution.",
        ruleName: "rules.customer_data_backfill",
        targetPath: "ops/migrations.md",
        targetLabel: "Customer ledger backfill",
      },
      {
        actionSummary: "Promote hotfix to production cluster",
        domain: "deploy",
        sideEffectLevel: "destructive",
        externalEffects: "network",
        sensitivityHint: "high",
        severity: "high",
        confidenceScore: 0.41,
        reasonCode: "HOTFIX_PROMOTION",
        reasonSummary: "High risk: production promotions need a second reviewer during business hours.",
        ruleName: "rules.hotfix_promotion",
        targetPath: "infra/main.tf",
        targetLabel: "Production cluster hotfix",
      },
    ],
    [
      {
        actionSummary: "Patch public ingress allowlist",
        domain: "network",
        sideEffectLevel: "destructive",
        externalEffects: "network",
        sensitivityHint: "high",
        severity: "critical",
        confidenceScore: 0.36,
        reasonCode: "PUBLIC_INGRESS_CHANGE",
        reasonSummary: "Critical risk: ingress rule changes can interrupt production traffic.",
        ruleName: "rules.public_ingress_change",
        targetPath: "infra/main.tf",
        targetLabel: "Ingress allowlist",
      },
      {
        actionSummary: "Trigger database migration during peak hours",
        domain: "deploy",
        sideEffectLevel: "mutating",
        externalEffects: "communication",
        sensitivityHint: "moderate",
        severity: "high",
        confidenceScore: 0.46,
        reasonCode: "PEAK_HOURS_MIGRATION",
        reasonSummary: "High risk: migrations during peak traffic need manual scheduling approval.",
        ruleName: "rules.peak_hours_migration",
        targetPath: "ops/migrations.md",
        targetLabel: "Peak-hours migration",
      },
    ],
    [
      {
        actionSummary: "Restart multi-region sandbox workloads",
        domain: "deploy",
        sideEffectLevel: "mutating",
        externalEffects: "network",
        sensitivityHint: "moderate",
        severity: "moderate",
        confidenceScore: 0.54,
        reasonCode: "MULTI_REGION_RESTART",
        reasonSummary: "Moderate risk: coordinated restarts need reviewer confirmation.",
        ruleName: "rules.multi_region_restart",
        targetPath: "infra/main.tf",
        targetLabel: "Multi-region restart",
      },
      {
        actionSummary: "Refresh payment provider API credentials",
        domain: "network",
        sideEffectLevel: "destructive",
        externalEffects: "communication",
        sensitivityHint: "high",
        severity: "high",
        confidenceScore: 0.4,
        reasonCode: "PAYMENT_PROVIDER_CREDENTIALS",
        reasonSummary: "High risk: payment provider credentials require a named reviewer before rotation.",
        ruleName: "rules.payment_provider_credentials",
        targetPath: "ops/migrations.md",
        targetLabel: "Payment provider credentials",
      },
    ],
  ];

  return matrices[seedIndex];
}

function pickWorkflow(repoKey, index) {
  const table = {
    "payments-api": ["settlement-reconciliation", "chargeback-recovery", "invoice-closeout", "partner-ledger-sync"],
    "customer-portal": ["portal-release-polish", "support-escalation-fix", "docs-refresh", "self-serve-onboarding"],
    "deployment-guard": ["release-freeze-check", "policy-override-audit", "secrets-gate", "prod-window-verification"],
    "agent-sandbox": ["prod-change-review", "credential-rotation", "migration-window-check", "drift-remediation"],
  };

  return {
    name: pickFrom(table[repoKey], index),
  };
}

function pickAgent(repoKey, index) {
  const table = {
    "payments-api": [
      { framework: "codex-cli", name: "Ledger Shepherd" },
      { framework: "openai-agents-sdk", name: "Settlement Pilot" },
    ],
    "customer-portal": [
      { framework: "codex-cli", name: "Portal Maintainer" },
      { framework: "agentgit-runtime", name: "Release Concierge" },
    ],
    "deployment-guard": [
      { framework: "openai-agents-sdk", name: "Policy Marshal" },
      { framework: "agentgit-runtime", name: "Freeze Sentinel" },
    ],
    "agent-sandbox": [
      { framework: "codex-cli", name: "Ops Autopilot" },
      { framework: "openai-agents-sdk", name: "Change Captain" },
    ],
  };

  return pickFrom(table[repoKey], index);
}

function pickFrom(items, index) {
  return items[index % items.length];
}

function makeAction({ repo, runId, actionId, occurredAt, plan }) {
  const targetPath = path.join(repo.root, plan.targetPath);
  const actorFramework = repo.key === "deployment-guard" ? "agentgit-runtime" : "codex-cli";
  const actorName = repo.key === "customer-portal" ? "Portal Maintainer" : "AgentGit";

  return ActionRecordSchema.parse({
    schema_version: "action.v1",
    action_id: actionId,
    run_id: runId,
    session_id: `sess_${repo.key}`,
    status: "normalized",
    timestamps: {
      requested_at: occurredAt,
      normalized_at: occurredAt,
    },
    provenance: {
      mode: "governed",
      source: "seed-demo",
      confidence: 0.99,
    },
    actor: {
      type: "agent",
      agent_name: actorName,
      agent_framework: actorFramework,
      tool_name: plan.domain === "filesystem" ? "write_file" : "exec_command",
      tool_kind: plan.domain === "filesystem" ? "filesystem" : "shell",
    },
    operation: {
      domain: plan.domain,
      kind: plan.kind,
      name: plan.name,
      display_name: plan.displayName,
    },
    execution_path: {
      surface: plan.domain === "filesystem" ? "governed_fs" : "governed_shell",
      mode: "pre_execution",
      credential_mode: "brokered",
    },
    target: {
      primary: {
        type: "path",
        locator: targetPath,
        label: path.basename(plan.targetPath),
      },
      scope: {
        breadth: plan.scopeBreadth,
        estimated_count: plan.scopeBreadth === "workspace" ? 5 : 1,
        unknowns: [],
      },
    },
    input: {
      raw: {},
      redacted: {},
      schema_ref: null,
      contains_sensitive_data: false,
    },
    risk_hints: {
      side_effect_level: plan.sideEffectLevel,
      external_effects: plan.externalEffects,
      reversibility_hint: plan.reversibilityHint,
      sensitivity_hint: plan.sensitivityHint,
      batch: plan.scopeBreadth === "workspace",
    },
    facets:
      plan.domain === "filesystem"
        ? {
            filesystem: {
              operation: plan.kind,
            },
          }
        : {
            shell: {
              command_family: plan.domain === "deploy" ? "deploy" : "operator_task",
            },
          },
    normalization: {
      mapper: "seed-demo",
      inferred_fields: [],
      warnings: [],
      normalization_confidence: plan.confidenceScore,
    },
    confidence_assessment: makeConfidenceAssessment(plan.confidenceScore),
  });
}

function makePolicyOutcome({ actionId, evaluatedAt, plan }) {
  const reasonsByDecision = {
    allow: [
      {
        code: "SAFE_TO_RUN",
        severity: "low",
        message: "Policy engine allowed the action without additional review.",
      },
    ],
    allow_with_snapshot: [
      {
        code: "SNAPSHOT_REQUIRED",
        severity: "moderate",
        message: "Policy engine allowed the action after capturing a rollback point.",
      },
    ],
    ask: [
      {
        code: "APPROVAL_REQUIRED",
        severity: "high",
        message: "Policy engine requires human approval before continuing.",
      },
    ],
    deny: [
      {
        code: "POLICY_BLOCKED",
        severity: "critical",
        message: "Policy engine blocked the action because it crosses a protected boundary.",
      },
    ],
  };

  return PolicyOutcomeRecordSchema.parse({
    schema_version: "policy-outcome.v1",
    policy_outcome_id: `pol_${actionId}`,
    action_id: actionId,
    decision: plan.decision,
    reasons: reasonsByDecision[plan.decision],
    trust_requirements: {
      wrapped_path_required: true,
      brokered_credentials_required: plan.domain !== "filesystem",
      direct_credentials_forbidden: plan.domain === "deploy" || plan.domain === "network",
    },
    preconditions: {
      snapshot_required: plan.snapshotRequired,
      approval_required: plan.decision === "ask",
      simulation_supported: false,
    },
    approval: null,
    budget_effects: {
      budget_check: "passed",
      estimated_cost: plan.externalEffects === "financial" ? 42 : 0,
      remaining_mutating_actions: null,
      remaining_destructive_actions: null,
    },
    policy_context: {
      matched_rules: [`rules.${plan.domain}.${plan.kind}`],
      sticky_decision_applied: false,
      recoverability_class:
        plan.snapshotRequired || plan.reversibilityHint === "reversible" ? "recoverable_local" : undefined,
      recovery_proof_kind: plan.snapshotRequired ? "snapshot_preimage" : undefined,
      recovery_proof_source: plan.snapshotRequired ? "seed-demo" : undefined,
      recovery_proof_scope: plan.snapshotRequired ? "workspace" : undefined,
    },
    evaluated_at: evaluatedAt,
  });
}

function makeConfidenceAssessment(score) {
  return {
    engine_version: "seed-demo/v1",
    score,
    band: score >= 0.85 ? "high" : score >= 0.65 ? "guarded" : "low",
    requires_human_review: score < 0.65,
    factors: [
      {
        factor_id: "seed-demo-baseline",
        label: "Seed demo baseline",
        kind: "baseline",
        delta: score,
        rationale: "Deterministic seed data confidence profile.",
      },
    ],
  };
}

function offsetIso(value, offsetSeconds) {
  return new Date(new Date(value).getTime() + offsetSeconds * 1000).toISOString();
}

function buildRepositoryStateSnapshot(repo) {
  const remoteUrl = runGitRead(["config", "--get", "remote.origin.url"], repo.root);
  const currentBranch = runGitRead(["branch", "--show-current"], repo.root) || "main";
  const headSha = runGitRead(["rev-parse", "HEAD"], repo.root);

  return RepositoryStateSnapshotSchema.parse({
    provider: "github",
    repo: {
      owner: repo.owner,
      name: repo.name,
    },
    remoteUrl,
    defaultBranch: "main",
    currentBranch,
    headSha,
    isDirty: false,
    aheadBy: 0,
    behindBy: 0,
    workspaceRoot: repo.root,
    lastFetchedAt: new Date(now.getTime() - 30 * 60 * 1000).toISOString(),
  });
}

function buildConnectorSeed(repo) {
  if (repo.key === "payments-api") {
    return {
      connectorName: "demo-ledger-west",
      machineName: "ci-ledger-west-01",
      connectorVersion: "1.4.0-demo",
      platform: {
        os: "linux",
        arch: "x64",
        hostname: "ci-ledger-west-01",
      },
      capabilities: [
        "repo_state_sync",
        "run_event_sync",
        "snapshot_manifest_sync",
        "approval_resolution",
        "restore_execution",
      ],
      repositoryState: buildRepositoryStateSnapshot(repo),
      status: "active",
    };
  }

  if (repo.key === "agent-sandbox") {
    return {
      connectorName: "demo-ops-east",
      machineName: "ops-east-02",
      connectorVersion: "1.4.0-demo",
      platform: {
        os: "linux",
        arch: "arm64",
        hostname: "ops-east-02",
      },
      capabilities: [
        "repo_state_sync",
        "run_event_sync",
        "snapshot_manifest_sync",
        "approval_resolution",
        "restore_execution",
        "git_commit",
      ],
      repositoryState: buildRepositoryStateSnapshot(repo),
      status: "active",
    };
  }

  if (repo.key === "deployment-guard") {
    return {
      connectorName: "demo-release-guard",
      machineName: "guard-mac-mini",
      connectorVersion: "1.3.8-demo",
      platform: {
        os: "darwin",
        arch: "arm64",
        hostname: "guard-mac-mini",
      },
      capabilities: ["repo_state_sync", "run_event_sync", "snapshot_manifest_sync"],
      repositoryState: buildRepositoryStateSnapshot(repo),
      status: "stale",
    };
  }

  return null;
}

function runGitRead(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

async function signInWithDevelopmentCredentials(client, { ownerEmail, ownerName, callbackUrl }) {
  const csrf = await client.request("/api/auth/csrf", {
    transform(payload) {
      if (!payload || typeof payload !== "object" || typeof payload.csrfToken !== "string") {
        throw new Error("Development auth did not return a csrfToken.");
      }
      return payload;
    },
  });

  await client.request("/api/auth/callback/development", {
    method: "POST",
    form: {
      callbackUrl,
      csrfToken: csrf.csrfToken,
      email: ownerEmail,
      json: "true",
      name: ownerName,
      role: "owner",
    },
    expectedStatuses: [200, 302],
  });
}

async function onboardWorkspace(client, repos) {
  const bootstrap = await client.request("/api/v1/onboarding", {
    schema: OnboardingBootstrapSchema,
  });

  const repositoryIdByKey = new Map(
    bootstrap.availableRepositories.map((repository) => [`${repository.owner}/${repository.name}`, repository.id]),
  );

  const repositoryIds = repos.map((repo) => {
    const repositoryId = repositoryIdByKey.get(`${repo.owner}/${repo.name}`);
    if (!repositoryId) {
      throw new Error(
        [
          `The running cloud app did not discover ${repo.owner}/${repo.name}.`,
          "Make sure it was started with matching AGENTGIT_CLOUD_WORKSPACE_ROOTS / DEMO_REPO_ROOTS values.",
        ].join(" "),
      );
    }
    return repositoryId;
  });

  const payload = OnboardingFormValuesSchema.parse({
    workspaceName: DEMO_WORKSPACE_NAME,
    workspaceSlug: DEMO_WORKSPACE_SLUG,
    repositoryIds,
    invites: [],
    defaultNotificationChannel: "slack",
    policyPack: "guarded",
    confirmLaunch: true,
  });

  return client.request("/api/v1/onboarding", {
    method: "POST",
    json: payload,
    schema: OnboardingLaunchResponseSchema,
  });
}

async function saveWorkspaceSettings(client, overrides) {
  const current = await client.request("/api/v1/settings/workspace", {
    schema: WorkspaceSettingsSchema,
  });

  const payload = WorkspaceSettingsUpdateSchema.parse({
    workspaceName: overrides.workspaceName ?? current.workspaceName,
    workspaceSlug: overrides.workspaceSlug ?? current.workspaceSlug,
    defaultNotificationChannel: overrides.defaultNotificationChannel ?? current.defaultNotificationChannel,
    approvalTtlMinutes: overrides.approvalTtlMinutes ?? current.approvalTtlMinutes,
    requireRejectComment: overrides.requireRejectComment ?? current.requireRejectComment,
    freezeDeploysOutsideBusinessHours:
      overrides.freezeDeploysOutsideBusinessHours ?? current.freezeDeploysOutsideBusinessHours,
    enterpriseSso: current.enterpriseSso,
  });

  return client.request("/api/v1/settings/workspace", {
    method: "PUT",
    json: payload,
    schema: WorkspaceSettingsSaveResponseSchema,
  });
}

async function cleanupExistingDemoControlPlaneState(dbPath) {
  const store = new IntegrationState({
    dbPath,
    collections: {
      connectors: { parse: (_key, value) => value },
      connectorTokens: { parse: (_key, value) => value },
      connectorBootstrapTokens: { parse: (_key, value) => value },
      connectorHeartbeats: { parse: (_key, value) => value },
      connectorEvents: { parse: (_key, value) => value },
      connectorCommands: { parse: (_key, value) => value },
    },
  });

  try {
    const demoConnectorIds = new Set(
      store
        .list("connectors")
        .filter(
          (record) =>
            record &&
            typeof record === "object" &&
            typeof record.connectorName === "string" &&
            record.connectorName.startsWith("demo-"),
        )
        .map((record) => record.id),
    );

    for (const connectorId of demoConnectorIds) {
      store.delete("connectors", connectorId);
      store.delete("connectorHeartbeats", connectorId);
    }

    for (const tokenRecord of store.list("connectorTokens")) {
      if (tokenRecord && typeof tokenRecord === "object" && demoConnectorIds.has(tokenRecord.connectorId)) {
        store.delete("connectorTokens", tokenRecord.tokenHash);
      }
    }

    for (const eventRecord of store.list("connectorEvents")) {
      const event = eventRecord?.event;
      if (
        event &&
        typeof event === "object" &&
        (demoConnectorIds.has(event.connectorId) ||
          (typeof event.eventId === "string" && event.eventId.startsWith("demo_")))
      ) {
        store.delete("connectorEvents", event.eventId);
      }
    }

    for (const commandRecord of store.list("connectorCommands")) {
      const command = commandRecord?.command;
      if (
        command &&
        typeof command === "object" &&
        (demoConnectorIds.has(command.connectorId) ||
          (typeof command.commandId === "string" && command.commandId.startsWith("demo_")))
      ) {
        store.delete("connectorCommands", command.commandId);
      }
    }
  } finally {
    store.close();
  }
}

async function seedConnectors(client, workspaceId, seededState, controlPlaneDbPath) {
  const connectors = [];

  for (const connectorSeed of seededState.connectors) {
    const bootstrap = await client.request("/api/v1/sync/bootstrap-token", {
      method: "POST",
      schema: ConnectorBootstrapResponseSchema,
    });

    const registrationPayload = ConnectorRegistrationRequestSchema.parse({
      workspaceId,
      connectorName: connectorSeed.connectorName,
      machineName: connectorSeed.machineName,
      connectorVersion: connectorSeed.connectorVersion,
      platform: connectorSeed.platform,
      capabilities: connectorSeed.capabilities,
      repository: connectorSeed.repositoryState,
    });

    const registration = await client.request("/api/v1/sync/register", {
      method: "POST",
      json: registrationPayload,
      headers: {
        authorization: `Bearer ${bootstrap.bootstrapToken}`,
      },
      schema: ConnectorRegistrationResponseSchema,
    });

    const connector = {
      ...connectorSeed,
      connectorId: registration.connector.id,
      accessToken: registration.accessToken,
      workspaceId,
    };
    connectors.push(connector);
  }

  const connectorsByRepo = new Map(
    connectors.map((connector) => [
      `${connector.repositoryState.repo.owner}/${connector.repositoryState.repo.name}`,
      connector,
    ]),
  );

  for (const connector of connectors.filter((item) => item.status === "active")) {
    const heartbeatPayload = ConnectorHeartbeatRequestSchema.parse({
      connectorId: connector.connectorId,
      sentAt: new Date().toISOString(),
      repository: connector.repositoryState,
      localDaemon: {
        reachable: true,
        socketPath: path.join(connector.repositoryState.workspaceRoot, ".agentgit", "authority", "authority.sock"),
        journalPath: path.join(connector.repositoryState.workspaceRoot, ".agentgit", "state", "authority.db"),
        snapshotRootPath: path.join(connector.repositoryState.workspaceRoot, ".agentgit", "state", "snapshots"),
      },
    });

    await client.request("/api/v1/sync/heartbeat", {
      method: "POST",
      headers: {
        authorization: `Bearer ${connector.accessToken}`,
      },
      json: heartbeatPayload,
      schema: ConnectorHeartbeatResponseSchema,
    });
  }

  const eventsByConnectorId = new Map();
  for (const connector of connectors) {
    eventsByConnectorId.set(connector.connectorId, []);
  }

  for (const pendingApproval of seededState.pendingApprovals) {
    const connector = connectorsByRepo.get(`${pendingApproval.repositoryOwner}/${pendingApproval.repositoryName}`);
    if (!connector) {
      continue;
    }

    eventsByConnectorId.get(connector.connectorId).push({
      schemaVersion: "cloud-sync.v1",
      eventId: `demo_${pendingApproval.approval.approval_id}`,
      connectorId: connector.connectorId,
      workspaceId,
      repository: {
        owner: pendingApproval.repositoryOwner,
        name: pendingApproval.repositoryName,
      },
      sequence: 0,
      occurredAt: pendingApproval.approval.requested_at,
      type: "approval.requested",
      payload: pendingApproval.approval,
    });
  }

  const policyEvents = buildPolicyStateEvents(workspaceId, connectors);
  for (const event of policyEvents) {
    eventsByConnectorId.get(event.connectorId).push(event);
  }

  for (const connector of connectors) {
    eventsByConnectorId.get(connector.connectorId).push({
      schemaVersion: "cloud-sync.v1",
      eventId: `demo_${connector.connectorId}_repo_state`,
      connectorId: connector.connectorId,
      workspaceId,
      repository: {
        owner: connector.repositoryState.repo.owner,
        name: connector.repositoryState.repo.name,
      },
      sequence: 0,
      occurredAt: new Date(now.getTime() - 10 * 60 * 1000).toISOString(),
      type: "repo_state.snapshot",
      payload: connector.repositoryState,
    });
  }

  for (const connector of connectors) {
    const sortedEvents = eventsByConnectorId
      .get(connector.connectorId)
      .sort((left, right) => new Date(left.occurredAt).getTime() - new Date(right.occurredAt).getTime())
      .map((event, index) => ({
        ...event,
        sequence: index + 1,
      }));

    if (sortedEvents.length === 0) {
      continue;
    }

    const batch = ConnectorEventBatchRequestSchema.parse({
      connectorId: connector.connectorId,
      sentAt: new Date().toISOString(),
      events: sortedEvents,
    });

    await client.request("/api/v1/sync/events", {
      method: "POST",
      headers: {
        authorization: `Bearer ${connector.accessToken}`,
      },
      json: batch,
      schema: ConnectorEventBatchResponseSchema,
    });
  }

  const staleConnector = connectors.find((connector) => connector.status === "stale");
  if (staleConnector) {
    const controlPlane = new ControlPlaneStateStore(controlPlaneDbPath);
    try {
      const record = controlPlane.getConnector(staleConnector.connectorId);
      if (!record) {
        throw new Error(`Could not find seeded connector ${staleConnector.connectorId} in control-plane state.`);
      }

      const staleAt = new Date(now.getTime() - 25 * 60 * 1000).toISOString();
      controlPlane.putConnector(
        ConnectorRecordSchema.parse({
          ...record,
          lastSeenAt: staleAt,
          status: "active",
        }),
      );
    } finally {
      controlPlane.close();
    }
  }

  return {
    total: connectors.length,
    active: connectors.filter((connector) => connector.status === "active").length,
    stale: connectors.filter((connector) => connector.status === "stale").length,
  };
}

function buildPolicyStateEvents(workspaceId, connectors) {
  const payments = connectors.find((connector) => connector.repositoryState.repo.name === "payments-api");
  const guard = connectors.find((connector) => connector.repositoryState.repo.name === "deployment-guard");
  if (!payments || !guard) {
    return [];
  }

  return [
    {
      schemaVersion: "cloud-sync.v1",
      eventId: "demo_policy_payments_01",
      connectorId: payments.connectorId,
      workspaceId,
      repository: payments.repositoryState.repo,
      sequence: 0,
      occurredAt: new Date(now.getTime() - 18 * HOUR_MS).toISOString(),
      type: "policy.state",
      payload: {
        kind: "workspace_policy",
        digest: "policy-digest-payments-01",
      },
    },
    {
      schemaVersion: "cloud-sync.v1",
      eventId: "demo_policy_payments_02",
      connectorId: payments.connectorId,
      workspaceId,
      repository: payments.repositoryState.repo,
      sequence: 0,
      occurredAt: new Date(now.getTime() - 12 * HOUR_MS).toISOString(),
      type: "policy.state",
      payload: {
        kind: "workflow_policy",
        digest: "policy-digest-payments-02",
      },
    },
    {
      schemaVersion: "cloud-sync.v1",
      eventId: "demo_policy_guard_01",
      connectorId: guard.connectorId,
      workspaceId,
      repository: guard.repositoryState.repo,
      sequence: 0,
      occurredAt: new Date(now.getTime() - 8 * HOUR_MS).toISOString(),
      type: "policy.state",
      payload: {
        kind: "release_freeze_policy",
        digest: "policy-digest-guard-01",
      },
    },
    {
      schemaVersion: "cloud-sync.v1",
      eventId: "demo_policy_guard_02",
      connectorId: guard.connectorId,
      workspaceId,
      repository: guard.repositoryState.repo,
      sequence: 0,
      occurredAt: new Date(now.getTime() - 4 * HOUR_MS).toISOString(),
      type: "policy.state",
      payload: {
        kind: "secret_scan_policy",
        digest: "policy-digest-guard-02",
      },
    },
  ];
}

async function validateSeededSurface(client, repos) {
  const repositories = await client.request("/api/v1/repos?limit=20", {
    schema: RepositoryListResponseSchema,
  });
  const approvals = await client.request("/api/v1/approvals?limit=20", {
    schema: ApprovalListResponseSchema,
  });
  const connectors = await client.request("/api/v1/sync/connectors?limit=10", {
    schema: WorkspaceConnectorInventorySchema,
  });
  const activity = await client.request("/api/v1/activity?limit=25", {
    schema: ActivityFeedResponseSchema,
  });
  const audit = await client.request("/api/v1/audit?limit=25", {
    schema: AuditLogResponseSchema,
  });

  const snapshotRepo = repos.find((repo) => repo.key === "payments-api");
  const pendingRepo = repos.find((repo) => repo.key === "agent-sandbox");
  const snapshots = await client.request(
    `/api/v1/repositories/${snapshotRepo.owner}/${snapshotRepo.name}/snapshots?limit=10`,
    {
      schema: RepositorySnapshotsResponseSchema,
    },
  );
  const runs = await client.request(`/api/v1/repositories/${pendingRepo.owner}/${pendingRepo.name}/runs?limit=10`, {
    schema: RepositoryRunsResponseSchema,
  });

  return {
    repositories: repositories.total,
    approvals: approvals.total,
    connectors: connectors.total,
    activity: activity.total,
    audit: audit.total,
    snapshots: snapshots.total,
    runsInPendingRepo: runs.total,
  };
}

function printSummary(summary) {
  const lines = [
    "",
    "Demo seed complete.",
    `Cloud URL: ${summary.cloudUrl}`,
    `Workspace: ${summary.workspaceName} (${summary.workspaceSlug})`,
    `Workspace ID: ${summary.workspaceId}`,
    `Owner sign-in: ${summary.ownerEmail}`,
    `Roots seeded: ${summary.rootsUsed.length}`,
    `Connectors: ${summary.connectors.total} total (${summary.connectors.active} active, ${summary.connectors.stale} stale)`,
    `Validated repositories: ${summary.validation.repositories}`,
    `Validated approvals: ${summary.validation.approvals}`,
    `Validated audit events: ${summary.validation.audit}`,
    `Validated snapshots: ${summary.validation.snapshots}`,
    "",
    "Notes:",
    `- The shell header still uses AUTH_WORKSPACE_NAME / AUTH_WORKSPACE_SLUG from the running app session.`,
    `- If the shell label is not "${DEMO_WORKSPACE_NAME}", restart the cloud app with matching auth fallback env vars.`,
    "",
  ];

  process.stdout.write(`${lines.join("\n")}`);
}

function logStep(message) {
  process.stdout.write(`\n[seed-demo] ${message}\n`);
}

class SessionClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookies = new Map();
  }

  async request(targetPath, options = {}) {
    const headers = new Headers(options.headers ?? {});
    const cookieHeader = this.cookieHeader();
    if (cookieHeader) {
      headers.set("cookie", cookieHeader);
    }

    let body = undefined;
    if (options.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.json);
    } else if (options.form) {
      headers.set("content-type", "application/x-www-form-urlencoded");
      body = new URLSearchParams(options.form).toString();
    }

    const response = await fetch(new URL(targetPath, this.baseUrl), {
      method: options.method ?? "GET",
      headers,
      body,
      redirect: "manual",
    });

    this.captureCookies(response);

    const expectedStatuses = options.expectedStatuses ?? [200];
    if (!expectedStatuses.includes(response.status)) {
      const raw = await response.text();
      throw new Error(
        `Request ${options.method ?? "GET"} ${targetPath} failed with ${response.status}: ${raw.slice(0, 400)}`,
      );
    }

    if (response.status === 204) {
      return null;
    }

    const text = await response.text();
    if (text.length === 0) {
      return null;
    }

    const payload = JSON.parse(text);
    if (options.transform) {
      return options.transform(payload);
    }

    return options.schema ? options.schema.parse(payload) : payload;
  }

  captureCookies(response) {
    const getSetCookie = response.headers.getSetCookie?.bind(response.headers);
    const values = typeof getSetCookie === "function" ? getSetCookie() : [];
    for (const headerValue of values) {
      const pair = headerValue.split(";", 1)[0];
      const index = pair.indexOf("=");
      if (index <= 0) {
        continue;
      }
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      this.cookies.set(name, value);
    }
  }

  cookieHeader() {
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}
