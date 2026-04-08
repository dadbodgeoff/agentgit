import "server-only";

import { createHash, randomUUID } from "node:crypto";
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
import { desc, eq } from "drizzle-orm";

import { withScopedAuthorityClient } from "@/lib/backend/authority/client";
import {
  findRepositoryPolicyVersionLocal,
  listRepositoryPolicyVersionsLocal,
  saveRepositoryPolicyVersionLocal,
} from "@/lib/backend/workspace/cloud-state.local";
import { findRepositoryRuntimeRecord } from "@/lib/backend/workspace/repository-inventory";
import { getCloudDatabase, hasDatabaseUrl } from "@/lib/db/client";
import { cloudRepositoryPolicyVersions } from "@/lib/db/schema";
import {
  RepositoryPolicyChangeSourceSchema,
  RepositoryPolicyDocumentInputSchema,
  RepositoryPolicySaveResponseSchema,
  RepositoryPolicySnapshotSchema,
  RepositoryPolicyValidationSchema,
  RepositoryPolicyVersionDiffEntrySchema,
  RepositoryPolicyVersionSummarySchema,
  StoredRepositoryPolicyVersionSchema,
  type RepositoryPolicyChangeSource,
  type RepositoryPolicySaveResponse,
  type RepositoryPolicySnapshot,
  type RepositoryPolicyValidation,
  type RepositoryPolicyVersionDiffEntry,
  type RepositoryPolicyVersionSummary,
  type StoredRepositoryPolicyVersion,
} from "@/schemas/cloud";

type PolicyFileCandidate = {
  scope: PolicyLoadedSourceScope;
  path: string | null;
};

type RepositoryPolicyActor = {
  userId: string;
  name: string;
  email: string;
};

type RepositoryPolicyVersionSeed = {
  workspaceId: string;
  repositoryId: string;
  repositoryOwner: string;
  repositoryName: string;
  policyPath: string;
  config: PolicyConfig;
  actor: RepositoryPolicyActor | null;
  changeSource: RepositoryPolicyChangeSource;
  createdAt?: string;
};

type RepositoryPolicyRuntimeRecord = Awaited<ReturnType<typeof findRepositoryRuntimeRecord>>;

export class RepositoryPolicyInputError extends Error {
  constructor(
    message: string,
    public readonly issues: string[] = [],
  ) {
    super(message);
    this.name = "RepositoryPolicyInputError";
  }
}

export class RepositoryPolicyVersionNotFoundError extends Error {
  constructor(message = "Repository policy version was not found.") {
    super(message);
    this.name = "RepositoryPolicyVersionNotFoundError";
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

function validatePolicyDocument(
  document: unknown,
): RepositoryPolicyValidation & { normalizedConfig: PolicyConfig | null } {
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

function getLocalRecommendations(
  repoRoot: string,
  compiledPolicy: ReturnType<typeof compilePolicyPack>,
): PolicyThresholdRecommendation[] {
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
  } catch {
    return [];
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

function serializePolicyVersionDocument(config: PolicyConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function writePolicyDocument(policyPath: string, config: PolicyConfig): void {
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  const tempPath = `${policyPath}.tmp`;
  fs.writeFileSync(tempPath, serializePolicyDocument(config), "utf8");
  fs.renameSync(tempPath, policyPath);
}

function hashPolicyDocument(document: string): string {
  return createHash("sha256").update(document, "utf8").digest("hex");
}

function getThresholdCount(config: PolicyConfig): number {
  return config.thresholds?.low_confidence.length ?? 0;
}

function parseStoredPolicyConfig(document: string): PolicyConfig {
  const validation = validatePolicyDocument(parsePolicyDocumentText(document));
  if (!validation.valid || !validation.normalizedConfig) {
    throw new RepositoryPolicyInputError("Stored policy version is invalid.", validation.issues);
  }

  return validation.normalizedConfig;
}

function formatThresholdValue(value: number | null): string | null {
  if (value === null) {
    return null;
  }

  return value.toFixed(2);
}

function getRuleLabel(rule: PolicyConfig["rules"][number], index: number): string {
  const explicitRuleId =
    typeof rule.rule_id === "string" && rule.rule_id.trim().length > 0 ? rule.rule_id.trim() : null;
  return explicitRuleId ?? `rule-${index + 1}`;
}

function buildThresholdMap(config: PolicyConfig): Map<string, number> {
  return new Map((config.thresholds?.low_confidence ?? []).map((entry) => [entry.action_family, entry.ask_below]));
}

function buildRuleMap(config: PolicyConfig): Map<string, string> {
  return new Map(config.rules.map((rule, index) => [getRuleLabel(rule, index), JSON.stringify(rule, null, 2)]));
}

function buildPolicyDiff(
  previousConfig: PolicyConfig | null,
  currentConfig: PolicyConfig,
): RepositoryPolicyVersionDiffEntry[] {
  if (!previousConfig) {
    return [];
  }

  const diffEntries: RepositoryPolicyVersionDiffEntry[] = [];

  if (previousConfig.profile_name !== currentConfig.profile_name) {
    diffEntries.push(
      RepositoryPolicyVersionDiffEntrySchema.parse({
        id: "metadata:profile_name",
        section: "metadata",
        change: "changed",
        label: "profile_name",
        before: previousConfig.profile_name,
        after: currentConfig.profile_name,
      }),
    );
  }

  if (previousConfig.policy_version !== currentConfig.policy_version) {
    diffEntries.push(
      RepositoryPolicyVersionDiffEntrySchema.parse({
        id: "metadata:policy_version",
        section: "metadata",
        change: "changed",
        label: "policy_version",
        before: previousConfig.policy_version,
        after: currentConfig.policy_version,
      }),
    );
  }

  const thresholdKeys = new Set([
    ...buildThresholdMap(previousConfig).keys(),
    ...buildThresholdMap(currentConfig).keys(),
  ]);
  const previousThresholds = buildThresholdMap(previousConfig);
  const currentThresholds = buildThresholdMap(currentConfig);
  for (const key of [...thresholdKeys].sort((left, right) => left.localeCompare(right))) {
    const before = previousThresholds.get(key) ?? null;
    const after = currentThresholds.get(key) ?? null;
    if (before === after) {
      continue;
    }

    diffEntries.push(
      RepositoryPolicyVersionDiffEntrySchema.parse({
        id: `threshold:${key}`,
        section: "threshold",
        change: before === null ? "added" : after === null ? "removed" : "changed",
        label: key,
        before: formatThresholdValue(before),
        after: formatThresholdValue(after),
      }),
    );
  }

  const previousRules = buildRuleMap(previousConfig);
  const currentRules = buildRuleMap(currentConfig);
  const ruleKeys = new Set([...previousRules.keys(), ...currentRules.keys()]);
  for (const key of [...ruleKeys].sort((left, right) => left.localeCompare(right))) {
    const before = previousRules.get(key) ?? null;
    const after = currentRules.get(key) ?? null;
    if (before === after) {
      continue;
    }

    diffEntries.push(
      RepositoryPolicyVersionDiffEntrySchema.parse({
        id: `rule:${key}`,
        section: "rule",
        change: before === null ? "added" : after === null ? "removed" : "changed",
        label: key,
        before,
        after,
      }),
    );
  }

  return diffEntries;
}

function summarizePolicyDiff(
  diffEntries: RepositoryPolicyVersionDiffEntry[],
  changeSource: RepositoryPolicyChangeSource,
): string {
  if (changeSource === "seed") {
    return "Seeded version history from the current workspace override.";
  }

  if (diffEntries.length === 0) {
    return changeSource === "rollback"
      ? "Rolled back to a previous version with no additional effective changes."
      : "Saved with no effective policy diff from the prior version.";
  }

  const metadataChanges = diffEntries.filter((entry) => entry.section === "metadata").length;
  const thresholdChanges = diffEntries.filter((entry) => entry.section === "threshold").length;
  const ruleChanges = diffEntries.filter((entry) => entry.section === "rule").length;
  const summaryParts = [
    metadataChanges > 0 ? `${metadataChanges} metadata` : null,
    thresholdChanges > 0 ? `${thresholdChanges} threshold` : null,
    ruleChanges > 0 ? `${ruleChanges} rule` : null,
  ].filter((entry): entry is string => entry !== null);

  return `${changeSource === "rollback" ? "Rolled back" : "Saved"} with ${summaryParts.join(", ")} change${diffEntries.length === 1 ? "" : "s"}.`;
}

function createStoredRepositoryPolicyVersion(seed: RepositoryPolicyVersionSeed): StoredRepositoryPolicyVersion {
  const document = serializePolicyVersionDocument(seed.config);
  const actorName = seed.actor?.name?.trim() || "AgentGit Cloud";
  const actorEmail = seed.actor?.email?.trim() || "system@agentgit.dev";

  return StoredRepositoryPolicyVersionSchema.parse({
    id: `polver_${randomUUID().replaceAll("-", "")}`,
    workspaceId: seed.workspaceId,
    repositoryId: seed.repositoryId,
    repositoryOwner: seed.repositoryOwner,
    repositoryName: seed.repositoryName,
    policyPath: seed.policyPath,
    document,
    documentHash: hashPolicyDocument(document),
    profileName: seed.config.profile_name,
    policyVersion: seed.config.policy_version,
    ruleCount: seed.config.rules.length,
    thresholdCount: getThresholdCount(seed.config),
    changeSource: RepositoryPolicyChangeSourceSchema.parse(seed.changeSource),
    actorUserId: seed.actor?.userId ?? null,
    actorName,
    actorEmail,
    createdAt: seed.createdAt ?? new Date().toISOString(),
  });
}

async function listPersistedRepositoryPolicyVersions(
  workspaceId: string,
  repositoryId: string,
): Promise<StoredRepositoryPolicyVersion[]> {
  if (!hasDatabaseUrl()) {
    return listRepositoryPolicyVersionsLocal(workspaceId, repositoryId);
  }

  const db = getCloudDatabase();
  const rows = await db
    .select()
    .from(cloudRepositoryPolicyVersions)
    .where(eq(cloudRepositoryPolicyVersions.workspaceId, workspaceId))
    .orderBy(desc(cloudRepositoryPolicyVersions.createdAt));

  return rows
    .filter((row) => row.repositoryId === repositoryId)
    .map((row) =>
      StoredRepositoryPolicyVersionSchema.parse({
        id: row.id,
        workspaceId: row.workspaceId,
        repositoryId: row.repositoryId,
        repositoryOwner: row.repositoryOwner,
        repositoryName: row.repositoryName,
        policyPath: row.policyPath,
        document: row.document,
        documentHash: row.documentHash,
        profileName: row.profileName,
        policyVersion: row.policyVersion,
        ruleCount: row.ruleCount,
        thresholdCount: row.thresholdCount,
        changeSource: row.changeSource,
        actorUserId: row.actorUserId,
        actorName: row.actorName,
        actorEmail: row.actorEmail,
        createdAt: row.createdAt.toISOString(),
      }),
    );
}

async function findPersistedRepositoryPolicyVersion(
  workspaceId: string,
  repositoryId: string,
  versionId: string,
): Promise<StoredRepositoryPolicyVersion | null> {
  if (!hasDatabaseUrl()) {
    return findRepositoryPolicyVersionLocal(workspaceId, repositoryId, versionId);
  }

  const db = getCloudDatabase();
  const row = await db.query.cloudRepositoryPolicyVersions.findFirst({
    where: eq(cloudRepositoryPolicyVersions.id, versionId),
  });

  if (!row || row.workspaceId !== workspaceId || row.repositoryId !== repositoryId) {
    return null;
  }

  return StoredRepositoryPolicyVersionSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    repositoryId: row.repositoryId,
    repositoryOwner: row.repositoryOwner,
    repositoryName: row.repositoryName,
    policyPath: row.policyPath,
    document: row.document,
    documentHash: row.documentHash,
    profileName: row.profileName,
    policyVersion: row.policyVersion,
    ruleCount: row.ruleCount,
    thresholdCount: row.thresholdCount,
    changeSource: row.changeSource,
    actorUserId: row.actorUserId,
    actorName: row.actorName,
    actorEmail: row.actorEmail,
    createdAt: row.createdAt.toISOString(),
  });
}

async function persistRepositoryPolicyVersion(
  version: StoredRepositoryPolicyVersion,
): Promise<StoredRepositoryPolicyVersion> {
  if (!hasDatabaseUrl()) {
    return saveRepositoryPolicyVersionLocal(version);
  }

  const db = getCloudDatabase();
  await db.insert(cloudRepositoryPolicyVersions).values({
    id: version.id,
    workspaceId: version.workspaceId,
    repositoryId: version.repositoryId,
    repositoryOwner: version.repositoryOwner,
    repositoryName: version.repositoryName,
    policyPath: version.policyPath,
    document: version.document,
    documentHash: version.documentHash,
    profileName: version.profileName,
    policyVersion: version.policyVersion,
    ruleCount: version.ruleCount,
    thresholdCount: version.thresholdCount,
    changeSource: version.changeSource,
    actorUserId: version.actorUserId,
    actorName: version.actorName,
    actorEmail: version.actorEmail,
    createdAt: new Date(version.createdAt),
  });

  return version;
}

async function ensureRepositoryPolicyHistorySeeded(
  workspaceId: string,
  repository: NonNullable<RepositoryPolicyRuntimeRecord>,
  workspacePolicyPath: string,
  workspaceConfig: PolicyConfig | null,
): Promise<StoredRepositoryPolicyVersion[]> {
  const existing = await listPersistedRepositoryPolicyVersions(workspaceId, repository.inventory.id);
  if (!workspaceConfig) {
    return existing;
  }

  const currentDocument = serializePolicyVersionDocument(workspaceConfig);
  const currentHash = hashPolicyDocument(currentDocument);
  const latest = existing[0] ?? null;
  if (latest?.documentHash === currentHash) {
    return existing;
  }

  const seededVersion = createStoredRepositoryPolicyVersion({
    workspaceId,
    repositoryId: repository.inventory.id,
    repositoryOwner: repository.inventory.owner,
    repositoryName: repository.inventory.name,
    policyPath: workspacePolicyPath,
    config: workspaceConfig,
    actor: null,
    changeSource: "seed",
  });
  await persistRepositoryPolicyVersion(seededVersion);
  return [seededVersion, ...existing];
}

function toRepositoryPolicyVersionHistory(versions: StoredRepositoryPolicyVersion[]): RepositoryPolicyVersionSummary[] {
  return versions.map((version, index) => {
    const previous = versions[index + 1] ?? null;
    const currentConfig = parseStoredPolicyConfig(version.document);
    const previousConfig = previous ? parseStoredPolicyConfig(previous.document) : null;
    const diffFromPrevious = buildPolicyDiff(previousConfig, currentConfig);

    return RepositoryPolicyVersionSummarySchema.parse({
      id: version.id,
      createdAt: version.createdAt,
      changeSource: version.changeSource,
      actorUserId: version.actorUserId,
      actorName: version.actorName,
      actorEmail: version.actorEmail,
      profileName: version.profileName,
      policyVersion: version.policyVersion,
      ruleCount: version.ruleCount,
      thresholdCount: version.thresholdCount,
      document: version.document,
      isCurrent: index === 0,
      summary: summarizePolicyDiff(diffFromPrevious, version.changeSource),
      diffFromPrevious,
    });
  });
}

async function maybePersistRepositoryPolicyVersion(seed: RepositoryPolicyVersionSeed): Promise<boolean> {
  const existing = await listPersistedRepositoryPolicyVersions(seed.workspaceId, seed.repositoryId);
  const nextVersion = createStoredRepositoryPolicyVersion(seed);
  const latest = existing[0] ?? null;

  if (seed.changeSource === "save" && latest?.documentHash === nextVersion.documentHash) {
    return false;
  }

  await persistRepositoryPolicyVersion(nextVersion);
  return true;
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
  workspaceId: string,
): Promise<RepositoryPolicySnapshot | null> {
  const repository = await findRepositoryRuntimeRecord(owner, name, workspaceId);
  if (!repository) {
    return null;
  }

  const runtime = resolvePolicyRuntime(repository.metadata.root);
  const authorityReachable = await isAuthorityReachable(repository.metadata.root);
  const recommendations = getLocalRecommendations(repository.metadata.root, runtime.compiled);
  const workspaceConfig = runtime.workspaceConfig ?? runtime.effectivePolicy.policy;
  const validation = validatePolicyDocument(workspaceConfig);
  const storedHistory = runtime.hasWorkspaceOverride
    ? await ensureRepositoryPolicyHistorySeeded(
        workspaceId,
        repository,
        runtime.workspacePolicyPath,
        runtime.workspaceConfig,
      )
    : [];
  const history = toRepositoryPolicyVersionHistory(storedHistory);

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
    currentVersionId: history[0]?.id ?? null,
    history,
  });
}

export async function saveRepositoryPolicy(
  owner: string,
  name: string,
  document: string,
  workspaceId: string,
  actor: RepositoryPolicyActor,
  changeSource: RepositoryPolicyChangeSource = "save",
): Promise<RepositoryPolicySaveResponse | null> {
  const repository = await findRepositoryRuntimeRecord(owner, name, workspaceId);
  if (!repository) {
    return null;
  }

  let parsedDocument: unknown;
  try {
    parsedDocument = parsePolicyDocumentText(document);
  } catch (error) {
    throw new RepositoryPolicyInputError(
      error instanceof Error ? error.message : "Policy document could not be parsed.",
    );
  }

  const validation = validatePolicyDocument(parsedDocument);
  if (!validation.valid || !validation.normalizedConfig) {
    throw new RepositoryPolicyInputError("Policy document is invalid.", validation.issues);
  }

  const policyPath = getWorkspacePolicyPath(repository.metadata.root);
  writePolicyDocument(policyPath, validation.normalizedConfig);
  const versionRecorded = await maybePersistRepositoryPolicyVersion({
    workspaceId,
    repositoryId: repository.inventory.id,
    repositoryOwner: repository.inventory.owner,
    repositoryName: repository.inventory.name,
    policyPath,
    config: validation.normalizedConfig,
    actor,
    changeSource,
  });

  const policy = await resolveRepositoryPolicy(owner, name, workspaceId);
  if (!policy) {
    return null;
  }

  const message =
    changeSource === "rollback"
      ? versionRecorded
        ? "Policy rolled back."
        : "Policy already matched the selected version."
      : versionRecorded
        ? "Policy saved."
        : "Policy saved. No effective diff from the latest version.";

  return RepositoryPolicySaveResponseSchema.parse({
    policy,
    savedAt: new Date().toISOString(),
    message,
  });
}

export async function rollbackRepositoryPolicyVersion(
  owner: string,
  name: string,
  versionId: string,
  workspaceId: string,
  actor: RepositoryPolicyActor,
): Promise<RepositoryPolicySaveResponse | null> {
  const repository = await findRepositoryRuntimeRecord(owner, name, workspaceId);
  if (!repository) {
    return null;
  }

  const targetVersion = await findPersistedRepositoryPolicyVersion(workspaceId, repository.inventory.id, versionId);
  if (!targetVersion) {
    throw new RepositoryPolicyVersionNotFoundError();
  }

  return saveRepositoryPolicy(owner, name, targetVersion.document, workspaceId, actor, "rollback");
}
