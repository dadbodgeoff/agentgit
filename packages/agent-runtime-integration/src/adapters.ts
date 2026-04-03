import fs from "node:fs";
import path from "node:path";

import { AgentGitError } from "@agentgit/schemas";

import {
  buildGenericGovernedLaunchMetadata,
  buildOpenClawGovernedLaunchMetadata,
  ensureGenericGovernedLaunchAssets,
  ensureOpenClawGovernedLaunchAssets,
  governedLaunchAssetsExist,
  removeGeneratedGovernedLaunchAssets,
  type GovernedLaunchAssetMetadata,
} from "./assets.js";
import {
  ProductStateStore,
  buildWorkspaceProfileId,
  createBackupFilePath,
  createBackupId,
  createInstallId,
  fileDigest,
} from "./state.js";
import {
  containedCredentialModeForStrictness,
  containerNetworkPolicyForStrictness,
  credentialPassthroughEnvKeys,
  inferContainerImage,
  resolveContainedBackendRuntime,
} from "./containment.js";
import type {
  ApplyResult,
  AssuranceLevel,
  ConfigBackupDocument,
  DetectionResult,
  GovernanceGuarantee,
  GovernanceMode,
  InstallPlan,
  RollbackResult,
  RuntimeInstallDocument,
  RuntimeProfileDocument,
  SetupPreferences,
  VerifyResult,
} from "./types.js";
import { DefaultCommandRunner, type CommandRunner, requireNonEmptyCommand, sha256Json, valuesEqual } from "./utils.js";

export interface AdapterContext {
  workspace_root: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  state: ProductStateStore;
  runner: CommandRunner;
  user_command?: string;
  repair_mode?: boolean;
  setup_preferences?: SetupPreferences;
}

export interface RuntimeAdapter {
  readonly runtime_id: DetectionResult["runtime_id"];
  detect(context: AdapterContext): DetectionResult | null;
  plan(context: AdapterContext, detection: DetectionResult): InstallPlan;
  apply(context: AdapterContext, plan: InstallPlan): ApplyResult;
  verify(context: AdapterContext, plan: InstallPlan): VerifyResult;
  rollback(context: AdapterContext, install: RuntimeInstallDocument, profile: RuntimeProfileDocument): RollbackResult;
}

function readExistingProfile(
  state: ProductStateStore,
  workspaceRoot: string,
  runtimeId: DetectionResult["runtime_id"],
): RuntimeProfileDocument | null {
  const profile = state.getProfileForWorkspace(workspaceRoot);
  return profile?.runtime_id === runtimeId ? profile : null;
}

function latestInstallForProfile(
  state: ProductStateStore,
  workspaceRoot: string,
  profileId: string,
): RuntimeInstallDocument | null {
  return (
    state
      .listRuntimeInstalls(workspaceRoot)
      .filter((install) => install.profile_id === profileId)
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0] ?? null
  );
}

function saveProfileAndInstall(
  context: AdapterContext,
  plan: InstallPlan,
  installId: string,
  appliedMutations: RuntimeInstallDocument["applied_mutations"] = plan.applied_mutations,
): {
  profile: RuntimeProfileDocument;
  install: RuntimeInstallDocument;
} {
  const profileId = buildWorkspaceProfileId(context.workspace_root);
  const existingProfile = context.state.getProfileForWorkspace(context.workspace_root);
  const profile = context.state.saveRuntimeProfile({
    profile_id: profileId,
    workspace_root: context.workspace_root,
    runtime_id: plan.runtime_id,
    launch_command: plan.launch_command,
    integration_method: plan.integration_method,
    install_scope: plan.install_scope,
    assurance_level: plan.assurance_level,
    governance_mode: plan.governance_mode,
    guarantees: plan.guarantees,
    execution_mode: plan.execution_mode,
    governed_surfaces: plan.governed_surfaces,
    degraded_reasons: plan.degraded_reasons,
    containment_backend: plan.containment_backend,
    container_image: plan.container_image,
    container_network_policy: plan.container_network_policy,
    contained_credential_mode: plan.contained_credential_mode,
    credential_passthrough_env_keys: plan.credential_passthrough_env_keys,
    contained_secret_env_bindings: plan.contained_secret_env_bindings,
    contained_secret_file_bindings: plan.contained_secret_file_bindings,
    contained_proxy_allowlist_hosts: plan.contained_proxy_allowlist_hosts,
    capability_snapshot: plan.capability_snapshot,
    runtime_display_name: plan.runtime_display_name,
    runtime_config_path: plan.runtime_config_path,
    adapter_metadata: plan.adapter_metadata,
    last_run_id: existingProfile?.last_run_id,
  });
  const install = context.state.saveRuntimeInstall({
    install_id: installId,
    profile_id: profile.profile_id,
    runtime_id: plan.runtime_id,
    workspace_root: context.workspace_root,
    install_scope: plan.install_scope,
    plan_digest: sha256Json(plan),
    applied_mutations: appliedMutations,
    status: "applied",
    integration_method: plan.integration_method,
    assurance_level: plan.assurance_level,
    governance_mode: plan.governance_mode,
    guarantees: plan.guarantees,
    execution_mode: plan.execution_mode,
    containment_backend: plan.containment_backend,
    container_network_policy: plan.container_network_policy,
    contained_credential_mode: plan.contained_credential_mode,
    contained_secret_env_bindings: plan.contained_secret_env_bindings,
    contained_secret_file_bindings: plan.contained_secret_file_bindings,
    contained_proxy_allowlist_hosts: plan.contained_proxy_allowlist_hosts,
    config_path: plan.runtime_config_path,
    capability_snapshot: plan.capability_snapshot,
  });
  return {
    profile,
    install,
  };
}

function shellWords(command: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .filter((value) => value.length > 0);
}

function integratedGovernanceMode(): GovernanceMode {
  return "native_integrated";
}

function attachedGovernanceMode(): GovernanceMode {
  return "attached_live";
}

function containedGovernanceMode(): GovernanceMode {
  return "contained_projection";
}

function integratedGuarantees(): GovernanceGuarantee[] {
  return ["native_runtime_integration", "known_plugin_surfaces_governed", "known_shell_entrypoints_governed"];
}

function attachedGuarantees(): GovernanceGuarantee[] {
  return ["known_shell_entrypoints_governed"];
}

function containedGuarantees(params: {
  network_policy?: InstallPlan["container_network_policy"];
  credential_mode?: InstallPlan["contained_credential_mode"];
  credential_passthrough_env_keys?: InstallPlan["credential_passthrough_env_keys"];
  egress_allowlist_hosts?: InstallPlan["contained_proxy_allowlist_hosts"];
}): GovernanceGuarantee[] {
  const guarantees: GovernanceGuarantee[] = ["real_workspace_protected", "publish_path_governed"];
  if (params.network_policy === "none" || (params.egress_allowlist_hosts?.length ?? 0) > 0) {
    guarantees.push("egress_policy_applied");
  }
  if (params.credential_mode !== "direct_env" || (params.credential_passthrough_env_keys?.length ?? 0) === 0) {
    guarantees.push("brokered_credentials_only");
  }
  return guarantees;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function parseGovernedAssetMetadata(value: unknown): GovernedLaunchAssetMetadata | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const helperScriptPath = typeof record.helper_script_path === "string" ? record.helper_script_path : null;
  const shimBinDir = typeof record.shim_bin_dir === "string" ? record.shim_bin_dir : null;
  const generatedAssetRoot = typeof record.generated_asset_root === "string" ? record.generated_asset_root : null;
  if (!helperScriptPath || !shimBinDir || !generatedAssetRoot) {
    return null;
  }

  return {
    generated_asset_root: generatedAssetRoot,
    helper_script_path: helperScriptPath,
    shim_bin_dir: shimBinDir,
    shim_commands: Array.isArray(record.shim_commands)
      ? record.shim_commands.filter((entry): entry is string => typeof entry === "string")
      : [],
    generated_assets: Array.isArray(record.generated_assets)
      ? record.generated_assets.filter((entry): entry is string => typeof entry === "string")
      : [],
    openclaw_plugin_root: typeof record.openclaw_plugin_root === "string" ? record.openclaw_plugin_root : undefined,
    openclaw_skill_path: typeof record.openclaw_skill_path === "string" ? record.openclaw_skill_path : undefined,
    openclaw_plugin_id: typeof record.openclaw_plugin_id === "string" ? record.openclaw_plugin_id : undefined,
    openclaw_tool_names: Array.isArray(record.openclaw_tool_names)
      ? record.openclaw_tool_names.filter((entry): entry is string => typeof entry === "string")
      : undefined,
    openclaw_denied_core_tools: Array.isArray(record.openclaw_denied_core_tools)
      ? record.openclaw_denied_core_tools.filter((entry): entry is string => typeof entry === "string")
      : undefined,
  };
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function unionStringArrays(left: string[], right: string[]): string[] {
  return Array.from(new Set([...left, ...right]));
}

const ASSURANCE_LEVEL_ORDER: Record<AssuranceLevel, number> = {
  observed: 0,
  attached: 1,
  contained: 2,
  integrated: 3,
};

function assuranceAtMost(target: AssuranceLevel, ceiling: AssuranceLevel): AssuranceLevel {
  return ASSURANCE_LEVEL_ORDER[target] <= ASSURANCE_LEVEL_ORDER[ceiling] ? target : ceiling;
}

function resolveAssuranceLevel(
  requestedTarget: AssuranceLevel | undefined,
  ceiling: AssuranceLevel,
): { assurance_level: AssuranceLevel; degraded_reasons: string[] } {
  if (!requestedTarget) {
    return {
      assurance_level: ceiling,
      degraded_reasons: [],
    };
  }

  const assuranceLevel = assuranceAtMost(requestedTarget, ceiling);
  if (assuranceLevel === requestedTarget) {
    return {
      assurance_level: assuranceLevel,
      degraded_reasons: [],
    };
  }

  return {
    assurance_level: assuranceLevel,
    degraded_reasons: [
      `Requested ${requestedTarget} assurance, but this runtime currently supports ${ceiling} assurance.`,
    ],
  };
}

function currentConfigMatchesAppliedDigest(install: RuntimeInstallDocument): boolean {
  return install.applied_mutations.every((mutation) => {
    if (!mutation.target_digest_after) {
      return true;
    }
    return fileDigest(mutation.config_file_path) === mutation.target_digest_after;
  });
}

function resolveOpenClawConfigPath(context: AdapterContext): string | null {
  const commandResult = context.runner.run("openclaw", ["config", "file"], {
    cwd: context.workspace_root,
    env: context.env,
  });
  if (commandResult.ok) {
    const target = commandResult.stdout.trim();
    return target.length > 0 ? path.resolve(target) : null;
  }

  const explicit = context.env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }

  const fallback = path.join(context.env.HOME ?? context.env.USERPROFILE ?? context.cwd, ".openclaw", "openclaw.json");
  return fs.existsSync(fallback) ? fallback : null;
}

function getOpenClawConfigValue(context: AdapterContext, configPath: string, configKey: string): unknown {
  const result = context.runner.run("openclaw", ["config", "get", configKey], {
    cwd: context.workspace_root,
    env: {
      ...context.env,
      OPENCLAW_CONFIG_PATH: configPath,
    },
  });
  if (!result.ok) {
    return undefined;
  }

  const trimmed = result.stdout.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function setOpenClawConfigValue(context: AdapterContext, configPath: string, configKey: string, value: unknown): void {
  const args =
    value === undefined
      ? ["config", "unset", configKey]
      : typeof value === "string"
        ? ["config", "set", configKey, value]
        : ["config", "set", configKey, JSON.stringify(value), "--strict-json"];
  const result = context.runner.run("openclaw", args, {
    cwd: context.workspace_root,
    env: {
      ...context.env,
      OPENCLAW_CONFIG_PATH: configPath,
    },
  });
  if (!result.ok) {
    throw new AgentGitError("OpenClaw config update failed.", "UPSTREAM_FAILURE", {
      command: ["openclaw", ...args].join(" "),
      stderr: result.stderr,
      stdout: result.stdout,
    });
  }
}

function validateOpenClawConfig(context: AdapterContext, configPath: string): void {
  const result = context.runner.run("openclaw", ["config", "validate"], {
    cwd: context.workspace_root,
    env: {
      ...context.env,
      OPENCLAW_CONFIG_PATH: configPath,
    },
  });
  if (!result.ok) {
    throw new AgentGitError("OpenClaw config validation failed after AgentGit setup.", "UPSTREAM_FAILURE", {
      config_path: configPath,
      stderr: result.stderr,
      stdout: result.stdout,
    });
  }
}

export class OpenClawAdapter implements RuntimeAdapter {
  readonly runtime_id = "openclaw" as const;

  detect(context: AdapterContext): DetectionResult | null {
    const existingProfile = readExistingProfile(context.state, context.workspace_root, this.runtime_id);
    if (existingProfile) {
      return {
        runtime_id: this.runtime_id,
        confidence: 0.99,
        workspace_root: context.workspace_root,
        install_scope_candidates: ["workspace"],
        evidence: [
          {
            kind: "existing_profile",
            detail: `AgentGit already has an OpenClaw profile for ${context.workspace_root}.`,
          },
        ],
        assurance_ceiling: "integrated",
        runtime_display_name: existingProfile.runtime_display_name ?? "OpenClaw",
        launch_command: existingProfile.launch_command,
        runtime_config_path: existingProfile.runtime_config_path,
        adapter_metadata: existingProfile.adapter_metadata,
      };
    }

    const configPath = resolveOpenClawConfigPath(context);
    const validation = context.runner.run("openclaw", ["config", "validate"], {
      cwd: context.workspace_root,
      env: context.env,
    });
    if (!configPath && !validation.ok) {
      return null;
    }

    const evidence = [];
    if (validation.ok) {
      evidence.push({
        kind: "binary" as const,
        detail: "Found a working openclaw CLI on PATH.",
      });
    }
    if (configPath) {
      evidence.push({
        kind: "config_file" as const,
        detail: `Found OpenClaw config at ${configPath}.`,
      });
    }

    return {
      runtime_id: this.runtime_id,
      confidence: configPath ? 0.94 : 0.82,
      workspace_root: context.workspace_root,
      install_scope_candidates: ["workspace"],
      evidence,
      assurance_ceiling: "integrated",
      runtime_display_name: "OpenClaw",
      launch_command: "openclaw",
      runtime_config_path: configPath ?? undefined,
      adapter_metadata: configPath ? { config_path: configPath } : undefined,
    };
  }

  plan(context: AdapterContext, detection: DetectionResult): InstallPlan {
    const assetMetadata = buildOpenClawGovernedLaunchMetadata(context.workspace_root);
    const configPath =
      detection.runtime_config_path ??
      resolveOpenClawConfigPath(context) ??
      path.join(context.env.HOME ?? context.cwd, ".openclaw", "openclaw.json");
    const existingProfile = context.state.getProfileForWorkspace(context.workspace_root);
    const existingInstall = existingProfile
      ? latestInstallForProfile(context.state, context.workspace_root, existingProfile.profile_id)
      : null;
    if (existingInstall && !currentConfigMatchesAppliedDigest(existingInstall) && !context.repair_mode) {
      throw new AgentGitError(
        "OpenClaw config changed after AgentGit setup. Re-run with agentgit setup --repair so AgentGit can re-check and repair the integration safely.",
        "CONFLICT",
        {
          config_path: configPath,
          recommended_command: "agentgit setup --repair",
        },
      );
    }
    const previousWorkspace = getOpenClawConfigValue(context, configPath, "agents.defaults.workspace");
    const rawCurrentToolsDeny = getOpenClawConfigValue(context, configPath, "tools.deny");
    const rawCurrentPluginPaths = getOpenClawConfigValue(context, configPath, "plugins.load.paths");
    const rawCurrentPluginAllow = getOpenClawConfigValue(context, configPath, "plugins.allow");
    const currentToolsDeny = normalizeStringArray(rawCurrentToolsDeny);
    const currentPluginPaths = normalizeStringArray(rawCurrentPluginPaths);
    const currentPluginAllow = normalizeStringArray(rawCurrentPluginAllow);
    const nextToolsDeny = unionStringArrays(currentToolsDeny, assetMetadata.openclaw_denied_core_tools ?? []);
    const nextPluginPaths = unionStringArrays(
      currentPluginPaths,
      assetMetadata.openclaw_plugin_root ? [assetMetadata.openclaw_plugin_root] : [],
    );
    const nextPluginAllow = unionStringArrays(
      currentPluginAllow,
      assetMetadata.openclaw_plugin_id ? [assetMetadata.openclaw_plugin_id] : [],
    );
    const assurance = resolveAssuranceLevel(context.setup_preferences?.assurance_target, detection.assurance_ceiling);
    return {
      runtime_id: this.runtime_id,
      runtime_display_name: detection.runtime_display_name,
      integration_method: "openclaw_config_launch_wrapper",
      files_to_create: [
        ...(fs.existsSync(configPath) ? [] : [configPath]),
        ...assetMetadata.generated_assets.filter((targetPath) => !fs.existsSync(targetPath)),
      ],
      files_to_modify: [configPath],
      env_to_inject: {},
      commands_to_run: [
        `openclaw config set agents.defaults.workspace ${JSON.stringify(context.workspace_root)}`,
        "openclaw config set tools.deny <agentgit-managed-array>",
        "openclaw config set plugins.load.paths <agentgit-plugin-path>",
        "openclaw config set plugins.allow <agentgit-plugin-id>",
        "openclaw config set plugins.entries.agentgit.enabled true",
        "openclaw config validate",
      ],
      backup_targets: [configPath],
      user_confirmation_required:
        previousWorkspace !== undefined &&
        typeof previousWorkspace === "string" &&
        previousWorkspace.length > 0 &&
        previousWorkspace !== context.workspace_root,
      launch_command: detection.launch_command ?? "openclaw",
      install_scope: "workspace",
      assurance_level: assurance.assurance_level,
      governance_mode: integratedGovernanceMode(),
      guarantees: integratedGuarantees(),
      execution_mode: "host_attached",
      governed_surfaces: ["OpenClaw governed plugin tools", "OpenClaw governed shell launch boundary"],
      degraded_reasons: assurance.degraded_reasons,
      runtime_config_path: configPath,
      adapter_metadata: {
        ...detection.adapter_metadata,
        managed_config_path: configPath,
        setup_experience: context.setup_preferences?.experience ?? "recommended",
        policy_strictness: context.setup_preferences?.policy_strictness ?? "balanced",
        assurance_target: context.setup_preferences?.assurance_target ?? detection.assurance_ceiling,
        ...assetMetadata,
      },
      applied_mutations: [
        {
          type: "config_path_set",
          config_file_path: configPath,
          path: "agents.defaults.workspace",
          previous_value: previousWorkspace,
          applied_value: context.workspace_root,
        },
        {
          type: "config_path_set",
          config_file_path: configPath,
          path: "tools.deny",
          previous_value: rawCurrentToolsDeny,
          applied_value: nextToolsDeny,
        },
        {
          type: "config_path_set",
          config_file_path: configPath,
          path: "plugins.load.paths",
          previous_value: rawCurrentPluginPaths,
          applied_value: nextPluginPaths,
        },
        {
          type: "config_path_set",
          config_file_path: configPath,
          path: "plugins.allow",
          previous_value: rawCurrentPluginAllow,
          applied_value: nextPluginAllow,
        },
        {
          type: "config_path_set",
          config_file_path: configPath,
          path: "plugins.entries.agentgit.enabled",
          previous_value: getOpenClawConfigValue(context, configPath, "plugins.entries.agentgit.enabled"),
          applied_value: true,
        },
      ],
    };
  }

  apply(context: AdapterContext, plan: InstallPlan): ApplyResult {
    const configPath = plan.runtime_config_path;
    if (!configPath) {
      throw new AgentGitError("OpenClaw install plan is missing a config path.", "INTERNAL_ERROR");
    }

    const assetMetadata = parseGovernedAssetMetadata(plan.adapter_metadata);
    const assetsReady = governedLaunchAssetsExist(assetMetadata);
    const configChanged = plan.applied_mutations.some(
      (mutation) => !valuesEqual(getOpenClawConfigValue(context, configPath, mutation.path), mutation.applied_value),
    );
    const existingProfile = context.state.getProfileForWorkspace(context.workspace_root);
    const existingInstall = existingProfile
      ? latestInstallForProfile(context.state, context.workspace_root, existingProfile.profile_id)
      : null;
    const configDrifted = existingInstall ? !currentConfigMatchesAppliedDigest(existingInstall) : false;
    if (!configChanged && assetsReady && existingProfile && existingInstall && !context.repair_mode && !configDrifted) {
      return {
        changed: false,
        profile: existingProfile,
        install: existingInstall,
      };
    }

    let backup: ConfigBackupDocument | undefined;
    if (configChanged) {
      const backupPath = createBackupFilePath(context.state.paths, context.workspace_root, configPath);
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      const targetExistedBefore = fs.existsSync(configPath);
      const beforeDigest = fileDigest(configPath);
      if (targetExistedBefore) {
        fs.copyFileSync(configPath, backupPath);
      } else {
        fs.writeFileSync(backupPath, "", "utf8");
      }
      backup = context.state.saveConfigBackup({
        backup_id: createBackupId(configPath),
        workspace_root: context.workspace_root,
        target_path: configPath,
        target_existed_before: targetExistedBefore,
        target_digest_before: beforeDigest,
        backup_path: backupPath,
      });
    }

    if (configChanged) {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      for (const mutation of plan.applied_mutations) {
        setOpenClawConfigValue(context, configPath, mutation.path, mutation.applied_value);
      }
      validateOpenClawConfig(context, configPath);
    }
    ensureOpenClawGovernedLaunchAssets(context.workspace_root);

    const appliedMutations = plan.applied_mutations.map((mutation) => ({
      ...mutation,
      target_digest_after: fileDigest(mutation.config_file_path),
    }));
    const installId = createInstallId(this.runtime_id);
    const { profile, install } = saveProfileAndInstall(context, plan, installId, appliedMutations);
    return {
      changed: configChanged || !assetsReady,
      profile,
      install,
      backup,
    };
  }

  verify(context: AdapterContext, plan: InstallPlan): VerifyResult {
    const configPath = plan.runtime_config_path;
    if (!configPath) {
      return {
        ready: false,
        health_checks: [
          {
            label: "openclaw config",
            ok: false,
            detail: "No OpenClaw config path was recorded.",
          },
        ],
        recommended_next_command: "agentgit setup --repair",
        assurance_ceiling: "integrated",
        degraded_reasons: [],
      };
    }

    const checks = [];
    const validation = context.runner.run("openclaw", ["config", "validate"], {
      cwd: context.workspace_root,
      env: {
        ...context.env,
        OPENCLAW_CONFIG_PATH: configPath,
      },
    });
    checks.push({
      label: "openclaw config validate",
      ok: validation.ok,
      detail: validation.ok ? "OpenClaw accepted the updated config." : validation.stderr || validation.stdout,
    });
    const workspaceValue = getOpenClawConfigValue(context, configPath, "agents.defaults.workspace");
    checks.push({
      label: "managed workspace",
      ok: workspaceValue === context.workspace_root,
      detail:
        workspaceValue === context.workspace_root
          ? `OpenClaw now points at ${context.workspace_root}.`
          : `OpenClaw currently points at ${String(workspaceValue ?? "unset")}.`,
    });
    const assetMetadata = parseGovernedAssetMetadata(plan.adapter_metadata);
    checks.push({
      label: "agentgit governed assets",
      ok: governedLaunchAssetsExist(assetMetadata),
      detail:
        governedLaunchAssetsExist(assetMetadata)
          ? "AgentGit generated the OpenClaw plugin, skill, and launch shims."
          : "AgentGit governed launch assets are missing; rerun setup --repair.",
    });

    return {
      ready: checks.every((check) => check.ok),
      health_checks: checks,
      recommended_next_command: "agentgit run",
      assurance_ceiling: "integrated",
      degraded_reasons: plan.degraded_reasons,
    };
  }

  rollback(context: AdapterContext, install: RuntimeInstallDocument, profile: RuntimeProfileDocument): RollbackResult {
    const preservedUserChanges: string[] = [];
    let changed = false;

    for (const mutation of install.applied_mutations) {
      const latestBackup = context.state.latestConfigBackup(context.workspace_root, mutation.config_file_path);
      const currentValue = getOpenClawConfigValue(context, mutation.config_file_path, mutation.path);
      const currentDigest = fileDigest(mutation.config_file_path);
      if (latestBackup && mutation.target_digest_after && currentDigest === mutation.target_digest_after) {
        fs.mkdirSync(path.dirname(mutation.config_file_path), { recursive: true });
        if (latestBackup.target_existed_before === false) {
          fs.rmSync(mutation.config_file_path, { force: true });
        } else {
          fs.copyFileSync(latestBackup.backup_path, mutation.config_file_path);
        }
        if (fs.existsSync(mutation.config_file_path)) {
          validateOpenClawConfig(context, mutation.config_file_path);
        }
        changed = true;
        continue;
      }

      if (!valuesEqual(currentValue, mutation.applied_value)) {
        if (!valuesEqual(currentValue, mutation.previous_value)) {
          preservedUserChanges.push(`${mutation.config_file_path}:${mutation.path}`);
        }
        continue;
      }

      setOpenClawConfigValue(context, mutation.config_file_path, mutation.path, mutation.previous_value);
      validateOpenClawConfig(context, mutation.config_file_path);
      changed = true;
    }

    const removedInstall = context.state.deleteRuntimeInstall(install.install_id);
    const latestRemaining = latestInstallForProfile(context.state, context.workspace_root, profile.profile_id);
    const removedProfile = latestRemaining ? false : context.state.deleteRuntimeProfile(profile.profile_id);
    if (preservedUserChanges.length === 0) {
      removeGeneratedGovernedLaunchAssets(parseGovernedAssetMetadata(profile.adapter_metadata));
    }

    return {
      changed,
      preserved_user_changes: preservedUserChanges,
      removed_profile: removedProfile,
      removed_install: removedInstall,
    };
  }
}

export class GenericCommandAdapter implements RuntimeAdapter {
  readonly runtime_id = "generic-command" as const;

  detect(context: AdapterContext): DetectionResult | null {
    const requestedContainment = context.setup_preferences?.containment_backend === "docker";
    const containedBackend = requestedContainment ? resolveContainedBackendRuntime("docker") : null;
    const backendCapability = containedBackend?.detect_capability(context);
    const assuranceCeiling =
      requestedContainment && backendCapability?.available ? "contained" : ("attached" as const);
    const existingProfile = readExistingProfile(context.state, context.workspace_root, this.runtime_id);
    if (existingProfile) {
      return {
        runtime_id: this.runtime_id,
        confidence: 0.99,
        workspace_root: context.workspace_root,
        install_scope_candidates: ["workspace"],
        evidence: [
          {
            kind: "existing_profile",
            detail: `AgentGit already has a saved launch command for ${context.workspace_root}.`,
          },
        ],
        assurance_ceiling: existingProfile.assurance_level,
        runtime_display_name: existingProfile.runtime_display_name ?? "Custom agent command",
        launch_command: existingProfile.launch_command,
        adapter_metadata: existingProfile.adapter_metadata,
      };
    }

    if (!context.user_command || context.user_command.trim().length === 0) {
      return null;
    }

    return {
      runtime_id: this.runtime_id,
      confidence: 0.97,
      workspace_root: context.workspace_root,
      install_scope_candidates: ["workspace"],
      evidence: [
        {
          kind: "user_command",
          detail: "Using the launch command you supplied.",
        },
      ],
      assurance_ceiling: assuranceCeiling,
      runtime_display_name: "Custom agent command",
      launch_command: context.user_command.trim(),
      adapter_metadata:
        requestedContainment && backendCapability
          ? {
              docker_available: backendCapability.capability_snapshot.docker_available,
              docker_desktop_vm: backendCapability.capability_snapshot.docker_desktop_vm,
              rootless_docker: backendCapability.capability_snapshot.rootless_docker,
              docker_server_platform: backendCapability.capability_snapshot.server_platform,
              docker_server_os: backendCapability.capability_snapshot.server_os,
              docker_server_arch: backendCapability.capability_snapshot.server_arch,
            }
          : undefined,
    };
  }

  plan(context: AdapterContext, detection: DetectionResult): InstallPlan {
    const launchCommand = requireNonEmptyCommand(
      detection.launch_command ?? context.user_command,
      "Generic setup needs a launch command. Re-run setup and provide the command that starts your agent.",
    );
    const assetMetadata = buildGenericGovernedLaunchMetadata(context.workspace_root);
    const assurance = resolveAssuranceLevel(context.setup_preferences?.assurance_target, detection.assurance_ceiling);
    const useDockerContainment =
      context.setup_preferences?.containment_backend === "docker" && detection.assurance_ceiling === "contained";
    const containedBackend = useDockerContainment ? resolveContainedBackendRuntime("docker") : null;
    const effectiveStrictness = context.setup_preferences?.policy_strictness ?? "balanced";
    const containerImage = useDockerContainment
      ? context.setup_preferences?.container_image?.trim() || inferContainerImage(launchCommand)
      : undefined;
    const containerNetworkPolicy = useDockerContainment
      ? context.setup_preferences?.container_network_policy ?? containerNetworkPolicyForStrictness(effectiveStrictness)
      : undefined;
    const containedCredentialMode = useDockerContainment
      ? context.setup_preferences?.contained_credential_mode ?? containedCredentialModeForStrictness(effectiveStrictness)
      : undefined;
    const containedSecretEnvBindings = useDockerContainment
      ? context.setup_preferences?.contained_secret_env_bindings ?? []
      : [];
    const containedSecretFileBindings = useDockerContainment
      ? context.setup_preferences?.contained_secret_file_bindings ?? []
      : [];
    const containedProxyAllowlistHosts = useDockerContainment
      ? context.setup_preferences?.contained_proxy_allowlist_hosts ?? []
      : [];
    const passthroughEnvKeys = useDockerContainment
      ? credentialPassthroughEnvKeys(
          containedCredentialMode ?? "none",
          context.setup_preferences?.credential_passthrough_env_keys,
        )
      : [];
    const backendCapability =
      containedBackend?.detect_capability(context, {
        network_policy: containerNetworkPolicy,
        credential_mode: containedCredentialMode,
        egress_allowlist_hosts: containedProxyAllowlistHosts,
      }) ?? null;
    const degradedReasons = [...assurance.degraded_reasons];
    const governanceMode = useDockerContainment ? containedGovernanceMode() : attachedGovernanceMode();
    const guarantees = useDockerContainment
      ? containedGuarantees({
        network_policy: containerNetworkPolicy,
        credential_mode: containedCredentialMode,
        credential_passthrough_env_keys: passthroughEnvKeys,
        egress_allowlist_hosts: containedProxyAllowlistHosts,
      })
      : attachedGuarantees();
    const capabilitySnapshot = backendCapability?.capability_snapshot;
    if (useDockerContainment && containerNetworkPolicy !== "none" && containedProxyAllowlistHosts.length === 0) {
      degradedReasons.push("Container network egress is not restricted.");
    }
    if (useDockerContainment && containerNetworkPolicy === "none" && containedProxyAllowlistHosts.length > 0) {
      degradedReasons.push("Contained egress allowlist entries are ignored because container networking is disabled.");
    }
    if (useDockerContainment && containerNetworkPolicy !== "none" && containedProxyAllowlistHosts.length > 0) {
      degradedReasons.push("Contained egress allowlist is proxy-based and only applies to proxy-aware HTTP(S) clients.");
    }
    if (useDockerContainment && containedCredentialMode === "direct_env") {
      if (passthroughEnvKeys.length > 0) {
        degradedReasons.push(`Container receives direct host credential passthrough for ${passthroughEnvKeys.join(", ")}.`);
      }
    }
    if (useDockerContainment && containedCredentialMode === "brokered_secret_refs" && containedSecretEnvBindings.length === 0) {
      if (containedSecretFileBindings.length === 0) {
        degradedReasons.push("Brokered secret refs are enabled, but no contained secret bindings were provided.");
      }
    }
    return {
      runtime_id: this.runtime_id,
      runtime_display_name: detection.runtime_display_name,
      integration_method: useDockerContainment ? "docker_contained_launch" : "launch_wrapper",
      files_to_create: useDockerContainment
        ? []
        : assetMetadata.generated_assets.filter((targetPath) => !fs.existsSync(targetPath)),
      files_to_modify: [],
      env_to_inject: {},
      commands_to_run: [],
      backup_targets: [],
      user_confirmation_required: false,
      launch_command: launchCommand,
      install_scope: "workspace",
      assurance_level: assurance.assurance_level,
      governance_mode: governanceMode,
      guarantees,
      execution_mode: useDockerContainment ? "docker_contained" : "host_attached",
      governed_surfaces: useDockerContainment
        ? ["contained runtime boundary", "governed publication boundary"]
        : ["governed shell launch boundary"],
      degraded_reasons: degradedReasons,
      containment_backend: useDockerContainment ? "docker" : undefined,
      container_image: containerImage,
      container_network_policy: containerNetworkPolicy,
      contained_credential_mode: containedCredentialMode,
      credential_passthrough_env_keys: passthroughEnvKeys,
      contained_secret_env_bindings: containedSecretEnvBindings,
      contained_secret_file_bindings: containedSecretFileBindings,
      contained_proxy_allowlist_hosts: containedProxyAllowlistHosts,
      capability_snapshot: capabilitySnapshot,
      adapter_metadata: {
        setup_experience: context.setup_preferences?.experience ?? "recommended",
        policy_strictness: effectiveStrictness,
        assurance_target: context.setup_preferences?.assurance_target ?? detection.assurance_ceiling,
        containment_backend: useDockerContainment ? "docker" : undefined,
        container_image: containerImage,
        container_network_policy: containerNetworkPolicy,
        contained_credential_mode: containedCredentialMode,
        credential_passthrough_env_keys: passthroughEnvKeys,
        contained_secret_env_bindings: containedSecretEnvBindings,
        contained_secret_file_bindings: containedSecretFileBindings,
        contained_proxy_allowlist_hosts: containedProxyAllowlistHosts,
        docker_available: backendCapability?.available,
        docker_desktop_vm: capabilitySnapshot?.docker_desktop_vm,
        rootless_docker: capabilitySnapshot?.rootless_docker,
        docker_server_platform: capabilitySnapshot?.server_platform,
        docker_server_os: capabilitySnapshot?.server_os,
        docker_server_arch: capabilitySnapshot?.server_arch,
        ...(useDockerContainment ? {} : assetMetadata),
      },
      applied_mutations: [],
    };
  }

  apply(context: AdapterContext, plan: InstallPlan): ApplyResult {
    const existingProfile = context.state.getProfileForWorkspace(context.workspace_root);
    const existingInstall = existingProfile
      ? latestInstallForProfile(context.state, context.workspace_root, existingProfile.profile_id)
      : null;
    const assetMetadata = parseGovernedAssetMetadata(plan.adapter_metadata);
    const assetsReady = plan.execution_mode === "docker_contained" ? true : governedLaunchAssetsExist(assetMetadata);
    if (
      existingProfile &&
      existingInstall &&
      existingProfile.runtime_id === this.runtime_id &&
      existingProfile.launch_command === plan.launch_command &&
      existingProfile.governance_mode === plan.governance_mode &&
      JSON.stringify(existingProfile.guarantees) === JSON.stringify(plan.guarantees) &&
      existingProfile.execution_mode === plan.execution_mode &&
      existingProfile.container_image === plan.container_image &&
      existingProfile.container_network_policy === plan.container_network_policy &&
      existingProfile.contained_credential_mode === plan.contained_credential_mode &&
      JSON.stringify(existingProfile.contained_secret_env_bindings ?? []) ===
        JSON.stringify(plan.contained_secret_env_bindings ?? []) &&
      JSON.stringify(existingProfile.contained_secret_file_bindings ?? []) ===
        JSON.stringify(plan.contained_secret_file_bindings ?? []) &&
      JSON.stringify(existingProfile.contained_proxy_allowlist_hosts ?? []) ===
        JSON.stringify(plan.contained_proxy_allowlist_hosts ?? []) &&
      JSON.stringify(existingProfile.capability_snapshot ?? null) === JSON.stringify(plan.capability_snapshot ?? null) &&
      assetsReady
    ) {
      return {
        changed: false,
        profile: existingProfile,
        install: existingInstall,
      };
    }

    if (plan.execution_mode !== "docker_contained") {
      ensureGenericGovernedLaunchAssets(context.workspace_root);
    }
    const installId = createInstallId(this.runtime_id);
    const { profile, install } = saveProfileAndInstall(context, plan, installId);
    return {
      changed: true,
      profile,
      install,
    };
  }

  verify(context: AdapterContext, plan: InstallPlan): VerifyResult {
    const assetMetadata = parseGovernedAssetMetadata(plan.adapter_metadata);
    const backendCapability =
      plan.execution_mode === "docker_contained" && plan.containment_backend
        ? resolveContainedBackendRuntime(plan.containment_backend).detect_capability(context, {
            network_policy: plan.container_network_policy,
            credential_mode: plan.contained_credential_mode,
            egress_allowlist_hosts: plan.contained_proxy_allowlist_hosts,
          })
        : null;
    const dockerAvailable = backendCapability?.available ?? true;
    const liveCapabilitySnapshot = backendCapability?.capability_snapshot ?? plan.capability_snapshot;
    const degradedReasons =
      plan.execution_mode === "docker_contained"
        ? [...new Set([...plan.degraded_reasons, ...(backendCapability?.degraded_reasons ?? [])])]
        : plan.degraded_reasons;
    const configuredDirectEnvKeys = plan.contained_credential_mode === "direct_env" ? (plan.credential_passthrough_env_keys ?? []) : [];
    const missingDirectEnvKeys = configuredDirectEnvKeys.filter((key) => {
      const value = context.env[key];
      return typeof value !== "string" || value.trim().length === 0;
    });
    if (missingDirectEnvKeys.length > 0) {
      degradedReasons.push(`Selected direct host credential env keys are currently not set: ${missingDirectEnvKeys.join(", ")}.`);
    }
    const ready =
      plan.execution_mode === "docker_contained"
        ? Boolean(plan.container_image) && dockerAvailable
        : governedLaunchAssetsExist(assetMetadata);
    return {
      ready,
      health_checks: [
        {
          label: plan.execution_mode === "docker_contained" ? "docker contained launch" : "governed launch assets",
          ok: ready,
          detail:
            plan.execution_mode === "docker_contained"
              ? !dockerAvailable
                ? "Docker is not available right now, so this contained runtime cannot launch until Docker is back."
                : `AgentGit saved the Docker-contained launch profile using ${plan.container_image}.`
              : governedLaunchAssetsExist(assetMetadata)
                ? "AgentGit saved the command and generated governed shell shims for agentgit run."
                : "AgentGit launch shims are missing; rerun agentgit setup --repair.",
        },
        ...(plan.execution_mode === "docker_contained"
          ? [
              {
                label: "contained projection boundary",
                ok: true,
                detail: "Contained runtime writes only to an AgentGit-managed projected workspace, not the real repo.",
              },
              {
                label: "container root filesystem",
                ok: true,
                detail: "Contained runtime launches with a read-only container root filesystem and a tmpfs /tmp.",
              },
              {
                label: "docker runtime hardening",
                ok: dockerAvailable,
                detail: !dockerAvailable
                  ? "Docker runtime details are unavailable until Docker is running again."
                  : liveCapabilitySnapshot?.rootless_docker
                    ? "Docker reports rootless mode on this host."
                    : liveCapabilitySnapshot?.docker_desktop_vm
                      ? "Docker runs through Docker Desktop's VM-backed runtime on this host."
                      : "Docker is available on this host without rootless-mode detection.",
              },
              {
                label: "container network policy",
                ok: true,
                detail:
                  plan.container_network_policy === "none"
                    ? "Contained runtime network egress is blocked."
                    : plan.contained_proxy_allowlist_hosts && plan.contained_proxy_allowlist_hosts.length > 0
                      ? `Contained runtime routes proxy-aware HTTP(S) egress through an allowlist for: ${plan.contained_proxy_allowlist_hosts.join(", ")}.`
                      : "Contained runtime network egress inherits the host Docker network.",
              },
              {
                label: "contained credential policy",
                ok: true,
                detail:
                  plan.contained_credential_mode === "direct_env"
                    ? plan.credential_passthrough_env_keys && plan.credential_passthrough_env_keys.length > 0
                      ? `Contained runtime is allowlisted to receive only these host env credentials when present: ${plan.credential_passthrough_env_keys.join(", ")}.`
                      : "Contained runtime is configured for direct env credentials, but no host env keys are currently allowlisted."
                    : plan.contained_credential_mode === "brokered_secret_refs"
                      ? (plan.contained_secret_env_bindings && plan.contained_secret_env_bindings.length > 0) ||
                        (plan.contained_secret_file_bindings && plan.contained_secret_file_bindings.length > 0)
                        ? `Contained runtime will receive brokered secret refs through ${[
                            plan.contained_secret_env_bindings && plan.contained_secret_env_bindings.length > 0
                              ? `env refs: ${plan.contained_secret_env_bindings.map((binding) => binding.env_key).join(", ")}`
                              : null,
                            plan.contained_secret_file_bindings && plan.contained_secret_file_bindings.length > 0
                              ? `file refs: ${plan.contained_secret_file_bindings.map((binding) => binding.relative_path).join(", ")}`
                              : null,
                          ]
                            .filter((value): value is string => value !== null)
                            .join("; ")}.`
                        : "Contained runtime is configured for brokered secret refs, but no bindings are currently configured."
                    : "Contained runtime will not receive host credential env vars.",
              },
            ]
          : []),
      ],
      recommended_next_command: dockerAvailable ? "agentgit run" : "agentgit setup --repair --contained",
      assurance_ceiling: plan.execution_mode === "docker_contained" ? "contained" : "attached",
      degraded_reasons: degradedReasons,
    };
  }

  rollback(context: AdapterContext, install: RuntimeInstallDocument, profile: RuntimeProfileDocument): RollbackResult {
    if (profile.execution_mode !== "docker_contained") {
      removeGeneratedGovernedLaunchAssets(parseGovernedAssetMetadata(profile.adapter_metadata));
    }
    return {
      changed: true,
      preserved_user_changes: [],
      removed_profile: context.state.deleteRuntimeProfile(profile.profile_id),
      removed_install: context.state.deleteRuntimeInstall(install.install_id),
    };
  }
}

export function createAdapterRegistry(): RuntimeAdapter[] {
  return [new OpenClawAdapter(), new GenericCommandAdapter()];
}

export function createAdapterContext(params: {
  workspace_root: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  state: ProductStateStore;
  runner?: CommandRunner;
  user_command?: string;
  repair_mode?: boolean;
  setup_preferences?: SetupPreferences;
}): AdapterContext {
  return {
    workspace_root: params.workspace_root,
    env: params.env ?? process.env,
    cwd: params.cwd ?? process.cwd(),
    state: params.state,
    runner: params.runner ?? new DefaultCommandRunner(),
    user_command: params.user_command,
    repair_mode: params.repair_mode ?? false,
    setup_preferences: params.setup_preferences,
  };
}

export function detectBestRuntime(context: AdapterContext, adapters: RuntimeAdapter[] = createAdapterRegistry()): {
  adapter: RuntimeAdapter;
  detection: DetectionResult;
} | null {
  const detections = adapters
    .map((adapter) => {
      const detection = adapter.detect(context);
      return detection ? { adapter, detection } : null;
    })
    .filter((value): value is { adapter: RuntimeAdapter; detection: DetectionResult } => value !== null)
    .sort((left, right) => right.detection.confidence - left.detection.confidence);

  return detections[0] ?? null;
}

export function planSetup(context: AdapterContext, adapters: RuntimeAdapter[] = createAdapterRegistry()): {
  adapter: RuntimeAdapter;
  detection: DetectionResult;
  plan: InstallPlan;
} {
  const detected = detectBestRuntime(context, adapters);
  if (!detected) {
    throw new AgentGitError(
      "AgentGit could not detect a supported runtime automatically. Re-run setup and provide --command '<start your agent>' for the generic fallback.",
      "BAD_REQUEST",
      {
        recommended_command: "agentgit setup --command '<start your agent>'",
      },
    );
  }

  return {
    ...detected,
    plan: detected.adapter.plan(context, detected.detection),
  };
}
