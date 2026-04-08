import { execFileSync } from "node:child_process";
import path from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";
import { LocalSnapshotEngine } from "@agentgit/snapshot-engine";
import type { ActionRecord } from "@agentgit/schemas";
import { RunJournal } from "@agentgit/run-journal";

async function waitForOkResponse(page: Page, pathFragment: string) {
  await page.waitForResponse((response) => response.url().includes(pathFragment) && response.ok(), { timeout: 45_000 });
}

async function loadMoreUntilVisible(page: Page, locator: Locator, maxPages = 6) {
  for (let attempt = 0; attempt < maxPages; attempt += 1) {
    if (await locator.count()) {
      await expect(locator.first()).toBeVisible({ timeout: 20_000 });
      return;
    }

    const loadMoreButton = page.getByRole("button", { name: "Load more" });
    if (!(await loadMoreButton.count())) {
      break;
    }

    await loadMoreButton.first().click();
  }

  await expect(locator.first()).toBeVisible({ timeout: 20_000 });
}

async function signInAs(
  page: Page,
  params: {
    callbackUrl: string;
    email: string;
    name: string;
    role: "member" | "admin" | "owner";
  },
) {
  await page.goto(`/sign-in?callbackUrl=${encodeURIComponent(params.callbackUrl)}`);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible({ timeout: 15_000 });
  const csrfResponse = await page.request.get("/api/auth/csrf");
  const csrfPayload = (await csrfResponse.json()) as { csrfToken?: string };
  if (!csrfPayload.csrfToken) {
    throw new Error("Missing CSRF token from development auth flow.");
  }

  const loginResponse = await page.request.post("/api/auth/callback/development", {
    form: {
      callbackUrl: params.callbackUrl,
      csrfToken: csrfPayload.csrfToken,
      email: params.email,
      json: "true",
      name: params.name,
      role: params.role,
    },
  });

  if (!loginResponse.ok()) {
    throw new Error(`Development auth failed with ${loginResponse.status()}`);
  }

  await Promise.all([
    page.waitForURL(
      (url) =>
        url.pathname === params.callbackUrl ||
        url.pathname === params.callbackUrl.replace(/\/$/, "") ||
        url.pathname.startsWith("/app"),
      { timeout: 45_000 },
    ),
    page.goto(params.callbackUrl),
  ]);
}

function parseRepositoryIdentity(remoteUrl: string): { owner: string; name: string } {
  const sshMatch = remoteUrl.trim().match(/^[^@]+@[^:]+:(.+)$/);
  const target = sshMatch ? sshMatch[1] : remoteUrl.trim();
  const pathname = target.startsWith("http://") || target.startsWith("https://") ? new URL(target).pathname : target;
  const segments = pathname
    .replace(/^\/+/, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter((segment) => segment.length > 0);

  if (segments.length < 2) {
    throw new Error(`Could not derive repository identity from remote: ${remoteUrl}`);
  }

  return {
    owner: segments[segments.length - 2]!,
    name: segments[segments.length - 1]!,
  };
}

function getWorkspaceRepositoryPolicyPath(): string {
  const workspaceRoot = path.resolve(process.cwd(), "../..");
  const remoteUrl = execFileSync("git", ["config", "--get", "remote.origin.url"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  }).trim();
  const repository = parseRepositoryIdentity(remoteUrl);
  return `/app/repos/${repository.owner}/${repository.name}/policy`;
}

function getWorkspaceRepositoryIdentity(): { owner: string; name: string; workspaceRoot: string } {
  const workspaceRoot = path.resolve(process.cwd(), "../..");
  const remoteUrl = execFileSync("git", ["config", "--get", "remote.origin.url"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  }).trim();
  const repository = parseRepositoryIdentity(remoteUrl);

  return {
    ...repository,
    workspaceRoot,
  };
}

function getWorkspaceRepositoryState() {
  const { owner, name, workspaceRoot } = getWorkspaceRepositoryIdentity();
  const remoteUrl = execFileSync("git", ["config", "--get", "remote.origin.url"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  }).trim();
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  }).trim();
  const currentBranch = execFileSync("git", ["branch", "--show-current"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  }).trim();
  const repoStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  }).trim();
  const provider = remoteUrl.includes("github.com")
    ? "github"
    : remoteUrl.includes("gitlab")
      ? "gitlab"
      : remoteUrl.includes("bitbucket")
        ? "bitbucket"
        : "local";

  return {
    owner,
    name,
    workspaceRoot,
    repository: {
      provider,
      repo: {
        owner,
        name,
      },
      remoteUrl,
      defaultBranch: currentBranch.length > 0 ? currentBranch : "main",
      currentBranch: currentBranch.length > 0 ? currentBranch : "main",
      headSha,
      isDirty: repoStatus.length > 0,
      aheadBy: 0,
      behindBy: 0,
      workspaceRoot,
      lastFetchedAt: null,
    },
  };
}

function makeConfidenceAssessment(score: number): ActionRecord["confidence_assessment"] {
  return {
    engine_version: "playwright-smoke/v1",
    score,
    band: score >= 0.85 ? "high" : score >= 0.65 ? "guarded" : "low",
    requires_human_review: score < 0.65,
    factors: [
      {
        factor_id: "smoke_baseline",
        label: "Smoke baseline",
        kind: "baseline",
        delta: score,
        rationale: "Smoke test seeding baseline.",
      },
    ],
  };
}

function makeSmokeAction(workspaceRoot: string, runId: string, actionId: string): ActionRecord {
  return {
    schema_version: "action.v1",
    action_id: actionId,
    run_id: runId,
    session_id: "sess_playwright_smoke",
    status: "normalized",
    timestamps: {
      requested_at: "2026-04-07T15:00:00Z",
      normalized_at: "2026-04-07T15:00:01Z",
    },
    provenance: {
      mode: "governed",
      source: "playwright",
      confidence: 0.95,
    },
    actor: {
      type: "agent",
      tool_name: "write_file",
      tool_kind: "filesystem",
    },
    operation: {
      domain: "filesystem",
      kind: "write",
      name: "filesystem.write",
      display_name: "Update README.md",
    },
    execution_path: {
      surface: "governed_fs",
      mode: "pre_execution",
      credential_mode: "none",
    },
    target: {
      primary: {
        type: "path",
        locator: path.join(workspaceRoot, "README.md"),
      },
      scope: {
        breadth: "single",
        estimated_count: 1,
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
      side_effect_level: "mutating",
      external_effects: "none",
      reversibility_hint: "reversible",
      sensitivity_hint: "low",
      batch: false,
    },
    facets: {
      filesystem: {
        operation: "write",
      },
    },
    normalization: {
      mapper: "playwright-smoke",
      inferred_fields: [],
      warnings: [],
      normalization_confidence: 0.99,
    },
    confidence_assessment: makeConfidenceAssessment(0.95),
  };
}

async function seedRepositorySnapshot(): Promise<{
  owner: string;
  name: string;
  snapshotId: string;
  runId: string;
  actionId: string;
}> {
  const { owner, name, workspaceRoot } = getWorkspaceRepositoryIdentity();
  const runId = `run_smoke_${Date.now()}`;
  const actionId = `act_smoke_${Date.now()}`;
  const targetPath = path.join(workspaceRoot, "README.md");
  const journal = new RunJournal({
    dbPath: path.join(workspaceRoot, ".agentgit", "state", "authority.db"),
  });
  const snapshotEngine = new LocalSnapshotEngine({
    rootDir: path.join(workspaceRoot, ".agentgit", "state", "snapshots"),
  });
  const snapshot = await snapshotEngine.createSnapshot({
    action: makeSmokeAction(workspaceRoot, runId, actionId),
    requested_class: "journal_plus_anchor",
    workspace_root: workspaceRoot,
  });

  try {
    journal.registerRunLifecycle({
      run_id: runId,
      session_id: "sess_playwright_smoke",
      workflow_name: "playwright-snapshot-smoke",
      agent_framework: "cloud",
      agent_name: "Codex",
      workspace_roots: [workspaceRoot],
      client_metadata: {},
      budget_config: {
        max_mutating_actions: null,
        max_destructive_actions: null,
      },
      created_at: "2026-04-07T15:00:00Z",
    });

    journal.appendRunEvent(runId, {
      event_type: "policy.evaluated",
      occurred_at: "2026-04-07T15:00:01Z",
      recorded_at: "2026-04-07T15:00:01Z",
      payload: {
        action_id: actionId,
        decision: "allow",
        reasons: ["Smoke policy seed"],
        snapshot_required: true,
        approval_required: false,
        matched_rules: ["repo.default"],
      },
    });

    journal.appendRunEvent(runId, {
      event_type: "action.normalized",
      occurred_at: "2026-04-07T15:00:02Z",
      recorded_at: "2026-04-07T15:00:02Z",
      payload: {
        action_id: actionId,
        target_locator: targetPath,
        action: {
          operation: {
            domain: "filesystem",
            kind: "update_file",
            display_name: "Update README.md",
          },
          target: {
            primary: {
              locator: targetPath,
            },
          },
        },
      },
    });

    journal.appendRunEvent(runId, {
      event_type: "execution.completed",
      occurred_at: "2026-04-07T15:00:03Z",
      recorded_at: "2026-04-07T15:00:03Z",
      payload: {
        action_id: actionId,
      },
    });

    journal.appendRunEvent(runId, {
      event_type: "snapshot.created",
      occurred_at: "2026-04-07T15:00:04Z",
      recorded_at: "2026-04-07T15:00:04Z",
      payload: {
        action_id: actionId,
        snapshot_id: snapshot.snapshot_id,
        snapshot_class: "journal_plus_anchor",
        fidelity: "full",
      },
    });

    journal.appendRunEvent(runId, {
      event_type: "recovery.executed",
      occurred_at: "2026-04-07T15:00:05Z",
      recorded_at: "2026-04-07T15:00:05Z",
      payload: {
        action_id: actionId,
        snapshot_id: snapshot.snapshot_id,
      },
    });
  } finally {
    journal.close();
  }

  return { owner, name, snapshotId: snapshot.snapshot_id, runId, actionId };
}

test("admin smoke covers approvals, bootstrap, fleet, writeback, restore, and readiness", async ({ page }) => {
  test.setTimeout(300_000);
  const snapshotSeed = await seedRepositorySnapshot();
  const repositoryState = getWorkspaceRepositoryState();

  await signInAs(page, {
    callbackUrl: "/app/approvals",
    email: "admin-smoke@agentgit.dev",
    name: "Admin Smoke",
    role: "admin",
  });

  await expect(page.getByRole("heading", { name: "Approval queue" })).toBeVisible();
  await expect(page.locator("main")).toContainText(/Approval queue|Could not load approvals\. Retry\./);

  await page.goto("/app/repos");
  await expect(page.getByRole("heading", { name: "Repositories" })).toBeVisible();
  await page.getByRole("button", { name: "Connect repository" }).first().click();
  await expect(page.getByRole("heading", { name: "Connect repositories" })).toBeVisible();
  await page.getByRole("checkbox").first().check();
  await page.getByRole("button", { name: "Save repository scope" }).click();
  await expect(page.locator("text=Bootstrap a local connector")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Generate bootstrap token" }).click();
  await expect(page.locator("text=Bootstrap command")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.goto("/app/settings/team");
  await expect(page.getByRole("heading", { name: "Team" })).toBeVisible();
  await page.getByRole("button", { name: "Add invite" }).click();
  await page.getByLabel("Name").last().fill("Riley Smoke");
  await page.getByLabel("Email").last().fill("riley-smoke@agentgit.dev");
  await page.getByRole("button", { name: "Save roster" }).click();
  await expect(page.getByText("Team saved")).toBeVisible();

  await page.goto("/app/settings/integrations");
  await expect(page.getByRole("heading", { name: "Integrations" })).toBeVisible();
  await waitForOkResponse(page, "/api/v1/settings/integrations");
  await expect(page.getByRole("button", { name: "Generate bootstrap token" })).toBeVisible();
  await page.getByRole("button", { name: "Generate bootstrap token" }).click();
  await expect(page.getByText("Bootstrap command")).toBeVisible();
  await expect(page.locator("main")).toContainText("agentgit-cloud-connector bootstrap");

  const bootstrapResponse = await page.request.post("/api/v1/sync/bootstrap-token");
  expect(bootstrapResponse.ok()).toBeTruthy();
  const bootstrapPayload = (await bootstrapResponse.json()) as {
    bootstrapToken?: string;
    workspaceId?: string;
    commandHint?: string;
  };
  expect(bootstrapPayload.bootstrapToken).toBeTruthy();
  expect(bootstrapPayload.commandHint).toContain("agentgit-cloud-connector bootstrap");

  const registrationResponse = await page.request.post("/api/v1/sync/register", {
    headers: {
      authorization: `Bearer ${bootstrapPayload.bootstrapToken}`,
    },
    data: {
      workspaceId: bootstrapPayload.workspaceId,
      connectorName: "Admin smoke connector",
      machineName: "admin-smoke-mac",
      connectorVersion: "0.1.0",
      platform: {
        os: process.platform,
        arch: process.arch,
        hostname: execFileSync("hostname", { encoding: "utf8" }).trim(),
      },
      capabilities: [
        "repo_state_sync",
        "run_event_sync",
        "snapshot_manifest_sync",
        "restore_execution",
        "git_commit",
        "git_push",
        "pull_request_open",
      ],
      repository: repositoryState.repository,
    },
  });
  expect(registrationResponse.ok()).toBeTruthy();
  const registrationPayload = (await registrationResponse.json()) as {
    connector?: {
      id?: string;
    };
  };
  const connectorId = registrationPayload.connector?.id;
  expect(connectorId).toBeTruthy();

  await page.goto("/app/settings/integrations");
  await expect(page.getByRole("heading", { name: "Integrations" })).toBeVisible();
  await waitForOkResponse(page, "/api/v1/settings/integrations");
  await expect(page.locator("main")).toContainText("Admin smoke connector", { timeout: 20_000 });
  await page.getByRole("button", { name: "Queue sync now" }).click();
  await expect(page.getByText("Connector command queued")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Queue create commit" }).click();
  await expect(page.getByText("Connector command queued")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Queue push branch" }).click();
  await expect(page.getByText("Connector command queued")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Queue open PR" }).click();
  await expect(page.getByText("Connector command queued")).toBeVisible({ timeout: 20_000 });

  await page.goto(`/app/repos/${snapshotSeed.owner}/${snapshotSeed.name}/snapshots`);
  await waitForOkResponse(page, `/api/v1/repositories/${snapshotSeed.owner}/${snapshotSeed.name}/snapshots`);
  await expect(page.getByRole("heading", { name: "Snapshots" })).toBeVisible();
  await loadMoreUntilVisible(page, page.getByText(snapshotSeed.snapshotId));
  await expect(page.locator("main")).toContainText("Update README.md", { timeout: 20_000 });
  const verifiedSnapshotButton = page
    .getByRole("row", { name: /verified.*Not restored/ })
    .first()
    .getByRole("button")
    .first();
  const verifiedSnapshotText = (await verifiedSnapshotButton.innerText()).trim();
  const verifiedSnapshotId = verifiedSnapshotText.split("\n")[0]?.trim();
  expect(verifiedSnapshotId).toBeTruthy();

  const restoreResponse = await page.request.post(
    `/api/v1/repositories/${snapshotSeed.owner}/${snapshotSeed.name}/snapshots/${encodeURIComponent(
      verifiedSnapshotId ?? "",
    )}/restore`,
    {
      data: {
        intent: "execute",
      },
    },
  );
  const restoreResponseBody = await restoreResponse.text();
  expect(restoreResponse.ok(), restoreResponseBody).toBeTruthy();
  const restorePayload = JSON.parse(restoreResponseBody) as {
    snapshotId?: string;
    commandId?: string;
    restored?: boolean;
    message?: string;
  };
  expect(restorePayload.snapshotId).toBe(verifiedSnapshotId);
  expect(restorePayload.message).toBeTruthy();

  await page.reload();
  await waitForOkResponse(page, `/api/v1/repositories/${snapshotSeed.owner}/${snapshotSeed.name}/snapshots`);
  await expect(page.locator("main")).toContainText(verifiedSnapshotId ?? "", { timeout: 20_000 });

  await page.goto("/app/settings/connectors");
  await expect(page.getByRole("heading", { name: "Connector fleet" })).toBeVisible();
  await expect(page.locator("main")).toContainText("Admin smoke connector", { timeout: 20_000 });
  await page
    .getByRole("button", { name: /Admin smoke connector.*Selected/ })
    .first()
    .click();
  await expect(page.locator("main")).toContainText("create_commit", { timeout: 20_000 });
  await expect(page.locator("main")).toContainText("push_branch", { timeout: 20_000 });
  await expect(page.locator("main")).toContainText("open_pull_request", { timeout: 20_000 });
  await expect(page.locator("main")).toContainText("execute_restore", { timeout: 20_000 });
  await page.getByRole("button", { name: "Revoke connector" }).click();
  await expect(page.getByRole("button", { name: "Connector revoked" })).toBeVisible({ timeout: 20_000 });

  const healthResponse = await page.request.get("/api/v1/health");
  expect(healthResponse.ok()).toBeTruthy();
  const healthPayload = (await healthResponse.json()) as {
    status?: string;
    checks?: Array<{ id: string; level: string; message: string }>;
  };
  expect(
    healthPayload.checks?.some(
      (check) => check.id === "authority_daemon" && (check.level === "ok" || check.level === "warn"),
    ),
  ).toBe(true);
  expect(healthPayload.checks?.some((check) => check.id === "auth_secret" && check.level === "ok")).toBe(true);
  expect(healthPayload.checks?.some((check) => check.id === "auth_base_url" && check.level === "ok")).toBe(true);
  expect(healthPayload.checks?.some((check) => check.id === "github_provider" && check.level === "ok")).toBe(true);
  expect(healthPayload.checks?.some((check) => check.id === "workspace_roots_configured" && check.level === "ok")).toBe(
    true,
  );
  expect(healthPayload.checks?.some((check) => check.id === "workspace_roots_available" && check.level === "ok")).toBe(
    true,
  );
  expect(healthPayload.checks?.some((check) => check.id === "sentry_dsn" && check.level === "ok")).toBe(true);
  expect(healthPayload.checks?.some((check) => check.id === "sentry_source_maps" && check.level === "ok")).toBe(true);
  expect(healthPayload.checks?.some((check) => check.id === "vercel_analytics" && check.level === "ok")).toBe(true);
  expect(healthPayload.checks?.some((check) => check.id === "dev_credentials" && check.level === "fail")).toBe(true);

  await page.goto("/app/settings/team");
  await expect(page.getByRole("heading", { name: "Team" })).toBeVisible();
  await page.goto("/app/calibration");
  await expect(page.getByRole("heading", { name: "Calibration" })).toBeVisible();
  await expect(page.locator("main")).toContainText("Policy calibration dashboard");

  await page.goto("/app/activity");
  await waitForOkResponse(page, "/api/v1/activity");
  await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
  await expect(page.locator("main")).toContainText("Recovery executed", { timeout: 15_000 });

  await page.goto("/app/audit");
  await waitForOkResponse(page, "/api/v1/audit");
  await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible();
  await expect(page.locator("main")).toContainText("playwright-snapshot-smoke", { timeout: 15_000 });

  await page.goto(getWorkspaceRepositoryPolicyPath());
  await expect(page.getByRole("heading", { name: "Policy" })).toBeVisible();
  const policyDocument = page.getByLabel("Policy document");
  const currentDocument = await policyDocument.inputValue();
  const nextDocument = currentDocument.replace(/"policy_version":\s*"([^"]+)"/, '"policy_version": "2026-04-07-smoke"');
  await policyDocument.fill(nextDocument);
  await page.getByRole("button", { name: "Save policy" }).click();
  await expect(page.getByText("Policy saved.")).toBeVisible({ timeout: 20_000 });
});

test("owner smoke covers onboarding and billing", async ({ page }) => {
  test.setTimeout(60_000);
  await signInAs(page, {
    callbackUrl: "/app/onboarding",
    email: "owner-smoke@agentgit.dev",
    name: "Owner Smoke",
    role: "owner",
  });

  await expect(page.getByRole("heading", { name: "Onboarding" })).toBeVisible();
  await waitForOkResponse(page, "/api/v1/onboarding");
  await expect(page.getByRole("heading", { name: "Create the workspace" })).toBeVisible({ timeout: 15_000 });

  await page.goto("/app/settings/billing");
  await expect(page.getByRole("heading", { name: "Billing" })).toBeVisible();
  await waitForOkResponse(page, "/api/v1/settings/billing");
  await expect(page.getByRole("heading", { name: "Plan and billing cycle" })).toBeVisible({ timeout: 15_000 });
});

test("member smoke verifies RBAC denial on admin settings", async ({ page }) => {
  test.setTimeout(60_000);
  await signInAs(page, {
    callbackUrl: "/app",
    email: "member-smoke@agentgit.dev",
    name: "Member Smoke",
    role: "member",
  });

  await page.goto("/app/settings/team");
  await expect(page.getByText("Access denied")).toBeVisible();
  await expect(page.getByText("You do not have permission to access workspace settings.")).toBeVisible();
});
