import "server-only";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as TOML from "@iarna/toml";
import { AuthorityClientTransportError } from "@agentgit/authority-sdk";
import {
  DEFAULT_POLICY_PACK,
  compilePolicyPack,
  recommendPolicyThresholds,
  validatePolicyConfigDocument,
} from "@agentgit/policy-engine";
import { RunJournal } from "@agentgit/run-journal";
import type {
  PolicyConfig,
  PolicyLoadedSource,
  PolicyLoadedSourceScope,
  PolicyThresholdRecommendation,
} from "@agentgit/schemas";

import { withScopedAuthorityClient } from "@/lib/backend/authority/client";
import { findRepositoryRuntimeRecord } from "@/lib/backend/workspace/repository-inventory";
import {
  RepositoryPolicyDocumentInputSchema,
  RepositoryPolicySaveResponseSchema,
  RepositoryPolicySnapshotSchema,
  RepositoryPolicyValidationSchema,
  type RepositoryPolicySaveResponse,
  type RepositoryPolicySnapshot,
  type RepositoryPolicyValidation,
} from "@/schemas/cloud";

type PolicyFileCandidate = {
  scope: PolicyLoadedSourceScope;
  path: string | null;
};

export class RepositoryPolicyInputError extends Error {
  constructor(
    message: string,
    public readonly issues: string[] = [],
  ) {
    super(message);
    this.name = "RepositoryPolicyInputError";
  }
}

function getWorkspacePolicyPath(repoRoot: string): string {
  return process.env.AGENTGIT_POLICY_WORKSPACE_CONFIG_PATH ?? path.join(repoRoot, ".agentgit", "policy.toml");
}

function getGeneratedPolicyPath(repoRoot: string): string {
  return (
    process.env.AGENTGIT_POLICY_CALIBRATION_CONFIG_PATH ??
    path.join(repoRoot, ".agentgit", "policy.calibration.generated.json")
  );
}

function getGlobalPolicyPath(): string {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  return (
    process.env.AGENTGIT_POLICY_GLOBAL_CONFIG_PATH ??
    path.join(
      xdgConfigHome && xdgConfigHome.length > 0 ? xdgConfigHome : path.join(os.homedir(), ".config"),
      "agentgit",
      "authority-policy.toml",
    )
  );
}

function getExplicitPolicyPath(): string | null {
  return process.env.AGENTGIT_POLICY_CONFIG_PATH ?? null;
}

function parsePolicyDocumentText(document: string): unknown {
  const trimmed = document.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }

  return TOML.parse(trimmed);
}

function loadPolicyDocumentFromFile(filePath: string): unknown {
  return parsePolicyDocumentText(fs.readFileSync(filePath, "utf8"));
}

function validatePolicyDocument(document: unknown): RepositoryPolicyValidation & { normalizedConfig: PolicyConfig | null } {
  const validation = validatePolicyConfigDocument(document);

  return {
    ...RepositoryPolicyValidationSchema.parse({
      valid: validation.valid,
      issues: validation.issues,
      compiledProfileName: validation.compiled_policy?.profile_name ?? null,
      compiledRuleCount: validation.compiled_policy?.rules.length ?? null,
    }),
    normalizedConfig: validation.normalized_config,
  };
}

function toRepositoryPolicyValidation(
  validation: RepositoryPolicyValidation & { normalizedConfig: PolicyConfig | null },
): RepositoryPolicyValidation {
  return RepositoryPolicyValidationSchema.parse({
    valid: validation.valid,
    issues: validation.issues,
    compiledProfileName: validation.compiledProfileName,
    compiledRuleCount: validation.compiledRuleCount,
  });
}

function createBuiltinPolicySource(): { config: PolicyConfig; source: PolicyLoadedSource } {
  return {
    config: DEFAULT_POLICY_PACK,
    source: {
      scope: "builtin_default",
      path: null,
      profile_name: DEFAULT_POLICY_PACK.profile_name,
      policy_version: DEFAULT_POLICY_PACK.policy_version,
      rule_count: DEFAULT_POLICY_PACK.rules.length,
    },
  };
}

function dedupeCandidates(candidates: PolicyFileCandidate[]): PolicyFileCandidate[] {
  const seen = new Set<string>();

  return candidates.filter((candidate) => {
    if (!candidate.path) {
      return false;
    }

    const resolvedPath = path.resolve(candidate.path);
    if (seen.has(resolvedPath)) {
      return false;
    }

    seen.add(resolvedPath);
    return true;
  });
}

function loadPolicyFile(candidate: PolicyFileCandidate): { config: PolicyConfig; source: PolicyLoadedSource } | null {
  if (!candidate.path) {
    return null;
  }

  const resolvedPath = path.resolve(candidate.path);
  if (!fs.existsSync(resolvedPath)) {
    return null;
  }

  const validation = validatePolicyDocument(loadPolicyDocumentFromFile(resolvedPath));
  if (!validation.valid || !validation.normalizedConfig) {
    throw new RepositoryPolicyInputError(`Invalid policy config at ${resolvedPath}.`, validation.issues);
  }

  return {
    config: validation.normalizedConfig,
    source: {
      scope: candidate.scope,
      path: resolvedPath,
      profile_name: validation.normalizedConfig.profile_name,
      policy_version: validation.normalizedConfig.policy_version,
      rule_count: validation.normalizedConfig.rules.length,
    },
  };
}

function buildEffectivePolicy(configs: PolicyConfig[], sources: PolicyLoadedSource[]) {
  const highestPrecedenceConfig = configs[0] ?? DEFAULT_POLICY_PACK;
  const compiled = compilePolicyPack(configs);
  const lowConfidenceThresholds = Object.entries(compiled.thresholds.low_confidence)
    .map(([action_family, ask_below]) => ({ action_family, ask_below }))
    .sort((left, right) => left.action_family.localeCompare(right.action_family));

  return {
    compiled,
    effectivePolicy: {
      policy: {
        profile_name: highestPrecedenceConfig.profile_name,
        policy_version: highestPrecedenceConfig.policy_version,
        thresholds: lowConfidenceThresholds.length > 0 ? { low_confidence: lowConfidenceThresholds } : undefined,
        rules: configs.flatMap((config) => config.rules),
      },
      summary: {
        profile_name: highestPrecedenceConfig.profile_name,
        policy_versions: compiled.policy_versions,
        compiled_rule_count: compiled.rules.length,
        loaded_sources: sources,
        warnings: [],
      },
    },
  };
}

function resolvePolicyRuntime(repoRoot: string) {
  const workspacePolicyPath = getWorkspacePolicyPath(repoRoot);
  const discoveredFiles = dedupeCandidates([
    { scope: "explicit_path", path: getExplicitPolicyPath() },
    { scope: "workspace_generated", path: getGeneratedPolicyPath(repoRoot) },
    { scope: "workspace", path: workspacePolicyPath },
    { scope: "user_global", path: getGlobalPolicyPath() },
  ]);
  const loaded = discoveredFiles
    .map((candidate) => loadPolicyFile(candidate))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const builtin = createBuiltinPolicySource();
  const configs = [...loaded.map((entry) => entry.config), builtin.config];
  const sources = [...loaded.map((entry) => entry.source), builtin.source];
  const workspaceSource = loaded.find((entry) => entry.source.scope === "workspace");

  return {
    workspacePolicyPath,
    hasWorkspaceOverride: workspaceSource !== undefined,
    workspaceConfig: workspaceSource?.config ?? null,
    loadedSources: sources,
    ...buildEffectivePolicy(configs, sources),
  };
}

function getJournalPath(repoRoot: string): string {
  return path.join(repoRoot, ".agentgit", "state", "authority.db");
}

function getLocalRecommendations(repoRoot: string, compiledPolicy: ReturnType<typeof compilePolicyPack>): PolicyThresholdRecommendation[] {
  const journalPath = getJournalPath(repoRoot);
  if (!fs.existsSync(journalPath)) {
    return [];
  }

  const journal = new RunJournal({ dbPath: journalPath });
  try {
    const report = journal.getPolicyCalibrationReport({
      include_samples: true,
      sample_limit: null,
    });

    return recommendPolicyThresholds(report.report, compiledPolicy, {
      min_samples: 5,
    });
  } finally {
    journal.close();
  }
}

async function isAuthorityReachable(repoRoot: string): Promise<boolean> {
  try {
    await withScopedAuthorityClient([repoRoot], async (client) => client.getCapabilities(repoRoot));
    return true;
  } catch (error) {
    if (error instanceof AuthorityClientTransportError) {
      return false;
    }

    return false;
  }
}

function serializePolicyDocument(config: PolicyConfig): string {
  return `${TOML.stringify(config as never).trimEnd()}\n`;
}

function writePolicyDocument(policyPath: string, config: PolicyConfig): void {
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  const tempPath = `${policyPath}.tmp`;
  fs.writeFileSync(tempPath, serializePolicyDocument(config), "utf8");
  fs.renameSync(tempPath, policyPath);
}

export function validateRepositoryPolicyDocument(document: string): RepositoryPolicyValidation {
  const parsedInput = RepositoryPolicyDocumentInputSchema.safeParse({ document });
  if (!parsedInput.success) {
    return RepositoryPolicyValidationSchema.parse({
      valid: false,
      issues: parsedInput.error.issues.map((issue) => issue.message),
      compiledProfileName: null,
      compiledRuleCount: null,
    });
  }

  try {
    const validation = validatePolicyDocument(parsePolicyDocumentText(parsedInput.data.document));
    return toRepositoryPolicyValidation(validation);
  } catch (error) {
    return RepositoryPolicyValidationSchema.parse({
      valid: false,
      issues: [error instanceof Error ? error.message : "Policy document could not be parsed."],
      compiledProfileName: null,
      compiledRuleCount: null,
    });
  }
}

export async function resolveRepositoryPolicy(
  owner: string,
  name: string,
  workspaceId?: string,
): Promise<RepositoryPolicySnapshot | null> {
  const repository = findRepositoryRuntimeRecord(owner, name, workspaceId);
  if (!repository) {
    return null;
  }

  const runtime = resolvePolicyRuntime(repository.metadata.root);
  const authorityReachable = await isAuthorityReachable(repository.metadata.root);
  const recommendations = getLocalRecommendations(repository.metadata.root, runtime.compiled);
  const workspaceConfig = runtime.workspaceConfig ?? runtime.effectivePolicy.policy;
  const validation = validatePolicyDocument(workspaceConfig);

  return RepositoryPolicySnapshotSchema.parse({
    repoId: repository.inventory.id,
    owner: repository.inventory.owner,
    name: repository.inventory.name,
    policyPath: runtime.workspacePolicyPath,
    authorityReachable,
    hasWorkspaceOverride: runtime.hasWorkspaceOverride,
    effectivePolicy: runtime.effectivePolicy,
    workspaceConfig,
    validation: toRepositoryPolicyValidation(validation),
    recommendations,
    loadedSources: runtime.loadedSources,
  });
}

export async function saveRepositoryPolicy(
  owner: string,
  name: string,
  document: string,
  workspaceId?: string,
): Promise<RepositoryPolicySaveResponse | null> {
  const repository = findRepositoryRuntimeRecord(owner, name, workspaceId);
  if (!repository) {
    return null;
  }

  let parsedDocument: unknown;
  try {
    parsedDocument = parsePolicyDocumentText(document);
  } catch (error) {
    throw new RepositoryPolicyInputError(error instanceof Error ? error.message : "Policy document could not be parsed.");
  }

  const validation = validatePolicyDocument(parsedDocument);
  if (!validation.valid || !validation.normalizedConfig) {
    throw new RepositoryPolicyInputError("Policy document is invalid.", validation.issues);
  }

  writePolicyDocument(getWorkspacePolicyPath(repository.metadata.root), validation.normalizedConfig);

  const policy = await resolveRepositoryPolicy(owner, name, workspaceId);
  if (!policy) {
    return null;
  }

  return RepositoryPolicySaveResponseSchema.parse({
    policy,
    savedAt: new Date().toISOString(),
    message: "Policy saved.",
  });
}
