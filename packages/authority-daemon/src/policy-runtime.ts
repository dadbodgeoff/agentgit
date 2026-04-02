import fs from "node:fs";
import path from "node:path";

import * as TOML from "@iarna/toml";
import {
  DEFAULT_POLICY_PACK,
  compilePolicyPack,
  validatePolicyConfigDocument,
  type CompiledPolicyPack,
} from "@agentgit/policy-engine";
import {
  type GetEffectivePolicyResponsePayload,
  type PolicyConfig,
  type PolicyLoadedSource,
  type PolicyLoadedSourceScope,
  type PolicySummary,
} from "@agentgit/schemas";

export interface LoadPolicyRuntimeOptions {
  globalConfigPath?: string | null;
  workspaceConfigPath?: string | null;
  generatedConfigPath?: string | null;
  explicitConfigPath?: string | null;
}

export interface PolicyRuntimeState {
  compiled_policy: CompiledPolicyPack;
  effective_policy: GetEffectivePolicyResponsePayload;
}

interface PolicyFileCandidate {
  scope: PolicyLoadedSourceScope;
  path: string | null;
}

function parsePolicyDocument(filePath: string): unknown {
  const document = fs.readFileSync(filePath, "utf8");
  return filePath.endsWith(".json") ? JSON.parse(document) : TOML.parse(document);
}

function loadPolicyFile(candidate: PolicyFileCandidate): {
  config: PolicyConfig;
  source: PolicyLoadedSource;
} | null {
  if (!candidate.path) {
    return null;
  }

  const resolvedPath = path.resolve(candidate.path);
  if (!fs.existsSync(resolvedPath)) {
    return null;
  }

  const validation = validatePolicyConfigDocument(parsePolicyDocument(resolvedPath));
  if (!validation.valid || !validation.normalized_config) {
    throw new Error(
      `Invalid policy config at ${resolvedPath}: ${validation.issues.join("; ") || "unknown validation error"}`,
    );
  }

  return {
    config: validation.normalized_config,
    source: {
      scope: candidate.scope,
      path: resolvedPath,
      profile_name: validation.normalized_config.profile_name,
      policy_version: validation.normalized_config.policy_version,
      rule_count: validation.normalized_config.rules.length,
    },
  };
}

function createBuiltinPolicySource(): {
  config: PolicyConfig;
  source: PolicyLoadedSource;
} {
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

function buildEffectivePolicyResponse(
  configs: PolicyConfig[],
  sources: PolicyLoadedSource[],
): GetEffectivePolicyResponsePayload {
  const highestPrecedenceConfig = configs[0] ?? DEFAULT_POLICY_PACK;
  const compiled = compilePolicyPack(configs);
  const lowConfidenceThresholds = Object.entries(compiled.thresholds.low_confidence).map(
    ([action_family, ask_below]) => ({
      action_family,
      ask_below,
    }),
  );
  const summary: PolicySummary = {
    profile_name: highestPrecedenceConfig.profile_name,
    policy_versions: compiled.policy_versions,
    compiled_rule_count: compiled.rules.length,
    loaded_sources: sources,
    warnings: [],
  };

  return {
    policy: {
      profile_name: highestPrecedenceConfig.profile_name,
      policy_version: highestPrecedenceConfig.policy_version,
      thresholds: lowConfidenceThresholds.length > 0 ? { low_confidence: lowConfidenceThresholds } : undefined,
      rules: configs.flatMap((config) => config.rules),
    },
    summary,
  };
}

export function loadPolicyRuntime(options: LoadPolicyRuntimeOptions = {}): PolicyRuntimeState {
  const builtin = createBuiltinPolicySource();
  const discoveredFiles = dedupeCandidates([
    { scope: "explicit_path", path: options.explicitConfigPath ?? null },
    { scope: "workspace_generated", path: options.generatedConfigPath ?? null },
    { scope: "workspace", path: options.workspaceConfigPath ?? null },
    { scope: "user_global", path: options.globalConfigPath ?? null },
  ]);

  const loaded = discoveredFiles
    .map((candidate) => loadPolicyFile(candidate))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const configs = [...loaded.map((entry) => entry.config), builtin.config];
  const sources = [...loaded.map((entry) => entry.source), builtin.source];
  const effective_policy = buildEffectivePolicyResponse(configs, sources);

  return {
    compiled_policy: compilePolicyPack(configs),
    effective_policy,
  };
}

export function reloadPolicyRuntime(state: PolicyRuntimeState, options: LoadPolicyRuntimeOptions = {}): void {
  const refreshed = loadPolicyRuntime(options);
  state.compiled_policy = refreshed.compiled_policy;
  state.effective_policy = refreshed.effective_policy;
}
