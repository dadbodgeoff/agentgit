import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as TOML from "@iarna/toml";

import { API_VERSION } from "@agentgit/schemas";

import { CLI_CONFIG_SCHEMA_VERSION, configError, inputError } from "./cli-contract.js";

export interface CliGlobalFlags {
  jsonOutput: boolean;
  profileName?: string;
  configRoot?: string;
  workspaceRoot?: string;
  socketPath?: string;
  connectTimeoutMs?: number;
  responseTimeoutMs?: number;
  maxConnectRetries?: number;
  connectRetryDelayMs?: number;
  command?: string;
  rest: string[];
}

export interface CliProfileRecord {
  socket_path?: string;
  workspace_root?: string;
  connect_timeout_ms?: number;
  response_timeout_ms?: number;
  max_connect_retries?: number;
  connect_retry_delay_ms?: number;
}

interface CliConfigFileRecord {
  schema_version: string;
  active_profile?: string;
  defaults?: CliProfileRecord;
  profiles?: Record<string, CliProfileRecord>;
}

export interface CliConfigPaths {
  configRoot: string;
  userConfigPath: string;
  workspaceConfigPath: string;
}

export interface CliResolvedValue<T> {
  value: T;
  source: string;
}

export interface CliResolvedConfig {
  paths: CliConfigPaths;
  requested_profile: string | null;
  active_profile: string | null;
  workspace_root: CliResolvedValue<string>;
  socket_path: CliResolvedValue<string>;
  connect_timeout_ms: CliResolvedValue<number>;
  response_timeout_ms: CliResolvedValue<number>;
  max_connect_retries: CliResolvedValue<number>;
  connect_retry_delay_ms: CliResolvedValue<number>;
  supported_api_version: string;
  user_config_exists: boolean;
  workspace_config_exists: boolean;
  user_profiles: string[];
  workspace_profiles: string[];
}

export interface CliConfigValidationResult {
  valid: boolean;
  issues: string[];
  paths: CliConfigPaths;
  user_config_exists: boolean;
  workspace_config_exists: boolean;
}

interface ParsedConfigLayer {
  exists: boolean;
  config: CliConfigFileRecord;
}

const SYSTEM_DEFAULT_CONNECT_TIMEOUT_MS = 1_000;
const SYSTEM_DEFAULT_RESPONSE_TIMEOUT_MS = 5_000;
const SYSTEM_DEFAULT_MAX_CONNECT_RETRIES = 1;
const SYSTEM_DEFAULT_CONNECT_RETRY_DELAY_MS = 50;

export function defaultCliConfigRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.AGENTGIT_CLI_CONFIG_ROOT?.trim();
  if (configured) {
    return path.resolve(configured);
  }

  const xdgRoot = env.XDG_CONFIG_HOME?.trim();
  if (xdgRoot) {
    return path.resolve(xdgRoot, "agentgit");
  }

  return path.resolve(os.homedir(), ".config", "agentgit");
}

export function createCliConfigPaths(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  configRootOverride?: string,
  workspaceRootOverride?: string,
): CliConfigPaths {
  const configRoot = path.resolve(configRootOverride ?? defaultCliConfigRoot(env));
  const workspaceRoot = path.resolve(workspaceRootOverride ?? env.AGENTGIT_ROOT ?? cwd);

  return {
    configRoot,
    userConfigPath: path.join(configRoot, "authority-cli.toml"),
    workspaceConfigPath: path.join(workspaceRoot, ".agentgit", "authority-cli.toml"),
  };
}

export function parseGlobalFlags(argv: string[], env: NodeJS.ProcessEnv = process.env): CliGlobalFlags {
  const args = [...argv];
  const flags: CliGlobalFlags = {
    jsonOutput: false,
    rest: [],
  };

  while (args.length > 0) {
    const current = args[0]!;
    if (!current.startsWith("--")) {
      break;
    }

    args.shift();
    switch (current) {
      case "--":
        break;
      case "--json":
        flags.jsonOutput = true;
        continue;
      case "--profile":
        flags.profileName = shiftRequiredValue(args, "--profile");
        continue;
      case "--config-root":
        flags.configRoot = path.resolve(shiftRequiredValue(args, "--config-root"));
        continue;
      case "--workspace-root":
        flags.workspaceRoot = path.resolve(shiftRequiredValue(args, "--workspace-root"));
        continue;
      case "--socket-path":
        flags.socketPath = path.resolve(shiftRequiredValue(args, "--socket-path"));
        continue;
      case "--connect-timeout-ms":
        flags.connectTimeoutMs = parseNonNegativeInteger(
          shiftRequiredValue(args, "--connect-timeout-ms"),
          "--connect-timeout-ms",
        );
        continue;
      case "--response-timeout-ms":
        flags.responseTimeoutMs = parseNonNegativeInteger(
          shiftRequiredValue(args, "--response-timeout-ms"),
          "--response-timeout-ms",
        );
        continue;
      case "--max-connect-retries":
        flags.maxConnectRetries = parseNonNegativeInteger(
          shiftRequiredValue(args, "--max-connect-retries"),
          "--max-connect-retries",
        );
        continue;
      case "--connect-retry-delay-ms":
        flags.connectRetryDelayMs = parseNonNegativeInteger(
          shiftRequiredValue(args, "--connect-retry-delay-ms"),
          "--connect-retry-delay-ms",
        );
        continue;
      default:
        throw inputError(`Unknown global flag: ${current}`, {
          flag: current,
          supported_flags: [
            "--json",
            "--profile",
            "--config-root",
            "--workspace-root",
            "--socket-path",
            "--connect-timeout-ms",
            "--response-timeout-ms",
            "--max-connect-retries",
            "--connect-retry-delay-ms",
          ],
        });
    }
  }

  if (args[0] === "--") {
    args.shift();
  }

  const [command, ...rest] = args;
  flags.command = command;
  flags.rest = rest;

  if (flags.workspaceRoot === undefined) {
    const envWorkspaceRoot = env.AGENTGIT_ROOT?.trim();
    if (envWorkspaceRoot) {
      flags.workspaceRoot = path.resolve(envWorkspaceRoot);
    }
  }

  if (flags.socketPath === undefined) {
    const envSocketPath = env.AGENTGIT_SOCKET_PATH?.trim();
    if (envSocketPath) {
      flags.socketPath = path.resolve(envSocketPath);
    }
  }

  return flags;
}

export function resolveCliConfig(
  cwd: string,
  flags: CliGlobalFlags,
  env: NodeJS.ProcessEnv = process.env,
): CliResolvedConfig {
  const paths = createCliConfigPaths(cwd, env, flags.configRoot, flags.workspaceRoot);
  const userLayer = readConfigLayer(paths.userConfigPath);
  const workspaceLayer = readConfigLayer(paths.workspaceConfigPath);
  const requestedProfile = flags.profileName ?? null;
  const activeProfile =
    requestedProfile ?? workspaceLayer.config.active_profile ?? userLayer.config.active_profile ?? null;

  const defaultWorkspaceRoot = path.resolve(flags.workspaceRoot ?? env.AGENTGIT_ROOT ?? cwd);
  const systemDefaults: CliProfileRecord = {
    workspace_root: defaultWorkspaceRoot,
    socket_path: path.resolve(defaultWorkspaceRoot, ".agentgit", "authority.sock"),
    connect_timeout_ms: SYSTEM_DEFAULT_CONNECT_TIMEOUT_MS,
    response_timeout_ms: SYSTEM_DEFAULT_RESPONSE_TIMEOUT_MS,
    max_connect_retries: SYSTEM_DEFAULT_MAX_CONNECT_RETRIES,
    connect_retry_delay_ms: SYSTEM_DEFAULT_CONNECT_RETRY_DELAY_MS,
  };

  const resolved: CliResolvedConfig = {
    paths,
    requested_profile: requestedProfile,
    active_profile: activeProfile,
    workspace_root: { value: systemDefaults.workspace_root!, source: "system_defaults" },
    socket_path: { value: systemDefaults.socket_path!, source: "system_defaults" },
    connect_timeout_ms: {
      value: systemDefaults.connect_timeout_ms!,
      source: "system_defaults",
    },
    response_timeout_ms: {
      value: systemDefaults.response_timeout_ms!,
      source: "system_defaults",
    },
    max_connect_retries: {
      value: systemDefaults.max_connect_retries!,
      source: "system_defaults",
    },
    connect_retry_delay_ms: {
      value: systemDefaults.connect_retry_delay_ms!,
      source: "system_defaults",
    },
    supported_api_version: API_VERSION,
    user_config_exists: userLayer.exists,
    workspace_config_exists: workspaceLayer.exists,
    user_profiles: Object.keys(userLayer.config.profiles ?? {}).sort(),
    workspace_profiles: Object.keys(workspaceLayer.config.profiles ?? {}).sort(),
  };

  applyProfileLayer(resolved, userLayer.config.defaults, "user_defaults");
  if (activeProfile) {
    applyProfileLayer(resolved, userLayer.config.profiles?.[activeProfile], `user_profile:${activeProfile}`);
  }
  applyProfileLayer(resolved, workspaceLayer.config.defaults, "workspace_defaults");
  if (activeProfile) {
    applyProfileLayer(resolved, workspaceLayer.config.profiles?.[activeProfile], `workspace_profile:${activeProfile}`);
  }

  if (flags.workspaceRoot) {
    resolved.workspace_root = {
      value: path.resolve(flags.workspaceRoot),
      source: "runtime_flag:workspace_root",
    };
  } else if (env.AGENTGIT_ROOT?.trim()) {
    resolved.workspace_root = {
      value: path.resolve(env.AGENTGIT_ROOT),
      source: "env:AGENTGIT_ROOT",
    };
  }

  if (flags.socketPath) {
    resolved.socket_path = {
      value: path.resolve(flags.socketPath),
      source: "runtime_flag:socket_path",
    };
  } else if (env.AGENTGIT_SOCKET_PATH?.trim()) {
    resolved.socket_path = {
      value: path.resolve(env.AGENTGIT_SOCKET_PATH),
      source: "env:AGENTGIT_SOCKET_PATH",
    };
  } else if (resolved.socket_path.source === "system_defaults") {
    resolved.socket_path = {
      value: path.resolve(resolved.workspace_root.value, ".agentgit", "authority.sock"),
      source: "system_defaults",
    };
  }

  if (typeof flags.connectTimeoutMs === "number") {
    resolved.connect_timeout_ms = {
      value: flags.connectTimeoutMs,
      source: "runtime_flag:connect_timeout_ms",
    };
  }
  if (typeof flags.responseTimeoutMs === "number") {
    resolved.response_timeout_ms = {
      value: flags.responseTimeoutMs,
      source: "runtime_flag:response_timeout_ms",
    };
  }
  if (typeof flags.maxConnectRetries === "number") {
    resolved.max_connect_retries = {
      value: flags.maxConnectRetries,
      source: "runtime_flag:max_connect_retries",
    };
  }
  if (typeof flags.connectRetryDelayMs === "number") {
    resolved.connect_retry_delay_ms = {
      value: flags.connectRetryDelayMs,
      source: "runtime_flag:connect_retry_delay_ms",
    };
  }

  return resolved;
}

export function validateCliConfig(
  cwd: string,
  flags: Pick<CliGlobalFlags, "configRoot" | "workspaceRoot">,
  env: NodeJS.ProcessEnv = process.env,
): CliConfigValidationResult {
  const issues: string[] = [];
  const paths = createCliConfigPaths(cwd, env, flags.configRoot, flags.workspaceRoot);

  let userConfigExists = false;
  let workspaceConfigExists = false;

  try {
    const userLayer = readConfigLayer(paths.userConfigPath);
    userConfigExists = userLayer.exists;
  } catch (error) {
    issues.push(`User config invalid: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const workspaceLayer = readConfigLayer(paths.workspaceConfigPath);
    workspaceConfigExists = workspaceLayer.exists;
  } catch (error) {
    issues.push(`Workspace config invalid: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    valid: issues.length === 0,
    issues,
    paths,
    user_config_exists: userConfigExists,
    workspace_config_exists: workspaceConfigExists,
  };
}

export function readUserConfig(
  configRoot: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): { path: string; config: CliConfigFileRecord; exists: boolean } {
  const paths = createCliConfigPaths(cwd, env, configRoot);
  const layer = readConfigLayer(paths.userConfigPath);
  return {
    path: paths.userConfigPath,
    config: layer.config,
    exists: layer.exists,
  };
}

export function writeUserConfig(configPath: string, config: CliConfigFileRecord): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const serialized = TOML.stringify({
    schema_version: CLI_CONFIG_SCHEMA_VERSION,
    ...(config.active_profile ? { active_profile: config.active_profile } : {}),
    ...(config.defaults ? { defaults: config.defaults } : {}),
    ...(config.profiles && Object.keys(config.profiles).length > 0 ? { profiles: config.profiles } : {}),
  } as never);
  fs.writeFileSync(configPath, serialized, "utf8");
}

export function listProfileNames(
  resolvedConfig: CliResolvedConfig,
): Array<{ name: string; source: "user" | "workspace" | "both"; active: boolean }> {
  const names = new Set([...resolvedConfig.user_profiles, ...resolvedConfig.workspace_profiles]);

  return [...names].sort().map((name) => ({
    name,
    source:
      resolvedConfig.user_profiles.includes(name) && resolvedConfig.workspace_profiles.includes(name)
        ? "both"
        : resolvedConfig.user_profiles.includes(name)
          ? "user"
          : "workspace",
    active: resolvedConfig.active_profile === name,
  }));
}

export function upsertUserProfile(
  config: CliConfigFileRecord,
  profileName: string,
  values: CliProfileRecord,
): CliConfigFileRecord {
  const normalizedProfileName = normalizeProfileName(profileName);
  const profiles = {
    ...(config.profiles ?? {}),
    [normalizedProfileName]: {
      ...(config.profiles?.[normalizedProfileName] ?? {}),
      ...values,
    },
  };

  return {
    ...config,
    schema_version: CLI_CONFIG_SCHEMA_VERSION,
    profiles,
  };
}

export function removeUserProfile(config: CliConfigFileRecord, profileName: string): CliConfigFileRecord {
  const normalizedProfileName = normalizeProfileName(profileName);
  const profiles = { ...(config.profiles ?? {}) };
  delete profiles[normalizedProfileName];

  return {
    ...config,
    schema_version: CLI_CONFIG_SCHEMA_VERSION,
    active_profile: config.active_profile === normalizedProfileName ? undefined : config.active_profile,
    profiles,
  };
}

export function setActiveUserProfile(config: CliConfigFileRecord, profileName: string): CliConfigFileRecord {
  const normalizedProfileName = normalizeProfileName(profileName);
  const knownProfiles = {
    ...(config.profiles ?? {}),
  };

  if (!(normalizedProfileName in knownProfiles)) {
    throw configError(`Profile ${normalizedProfileName} is not defined in user config.`, {
      profile: normalizedProfileName,
    });
  }

  return {
    ...config,
    schema_version: CLI_CONFIG_SCHEMA_VERSION,
    active_profile: normalizedProfileName,
  };
}

export function getProfileFromResolvedConfig(
  resolvedConfig: CliResolvedConfig,
  profileName?: string,
): {
  name: string;
  source: "user" | "workspace";
  profile: CliProfileRecord;
} | null {
  const selected = profileName ?? resolvedConfig.active_profile;
  if (!selected) {
    return null;
  }

  if (resolvedConfig.workspace_profiles.includes(selected)) {
    const workspaceLayer = readConfigLayer(resolvedConfig.paths.workspaceConfigPath);
    return {
      name: selected,
      source: "workspace",
      profile: workspaceLayer.config.profiles?.[selected] ?? {},
    };
  }

  if (resolvedConfig.user_profiles.includes(selected)) {
    const userLayer = readConfigLayer(resolvedConfig.paths.userConfigPath);
    return {
      name: selected,
      source: "user",
      profile: userLayer.config.profiles?.[selected] ?? {},
    };
  }

  return null;
}

function readConfigLayer(configPath: string): ParsedConfigLayer {
  if (!fs.existsSync(configPath)) {
    return {
      exists: false,
      config: {
        schema_version: CLI_CONFIG_SCHEMA_VERSION,
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = TOML.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw configError(
      `Could not parse TOML at ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    exists: true,
    config: normalizeConfigRecord(parsed, configPath),
  };
}

function normalizeConfigRecord(value: unknown, configPath: string): CliConfigFileRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw configError(`Config file ${configPath} must contain a TOML table.`);
  }

  const record = value as Record<string, unknown>;
  const schemaVersion = typeof record.schema_version === "string" ? record.schema_version.trim() : "";
  if (schemaVersion.length > 0 && schemaVersion !== CLI_CONFIG_SCHEMA_VERSION) {
    throw configError(`Config file ${configPath} uses unsupported schema_version ${schemaVersion}.`, {
      expected_schema_version: CLI_CONFIG_SCHEMA_VERSION,
      actual_schema_version: schemaVersion,
    });
  }

  return {
    schema_version: CLI_CONFIG_SCHEMA_VERSION,
    ...(typeof record.active_profile === "string"
      ? { active_profile: normalizeProfileName(record.active_profile) }
      : {}),
    ...(record.defaults ? { defaults: normalizeProfileRecord(record.defaults, `${configPath}:defaults`) } : {}),
    ...(record.profiles ? { profiles: normalizeProfilesRecord(record.profiles, `${configPath}:profiles`) } : {}),
  };
}

function normalizeProfilesRecord(value: unknown, field: string): Record<string, CliProfileRecord> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw configError(`${field} must be a table of profile definitions.`);
  }

  const profiles: Record<string, CliProfileRecord> = {};
  for (const [name, profileValue] of Object.entries(value as Record<string, unknown>)) {
    profiles[normalizeProfileName(name)] = normalizeProfileRecord(profileValue, `${field}.${name}`);
  }
  return profiles;
}

function normalizeProfileRecord(value: unknown, field: string): CliProfileRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw configError(`${field} must be a TOML table.`);
  }

  const record = value as Record<string, unknown>;
  const normalized: CliProfileRecord = {};

  if (record.socket_path !== undefined) {
    normalized.socket_path = normalizePathString(record.socket_path, `${field}.socket_path`);
  }
  if (record.workspace_root !== undefined) {
    normalized.workspace_root = normalizePathString(record.workspace_root, `${field}.workspace_root`);
  }
  if (record.connect_timeout_ms !== undefined) {
    normalized.connect_timeout_ms = normalizeInteger(record.connect_timeout_ms, `${field}.connect_timeout_ms`);
  }
  if (record.response_timeout_ms !== undefined) {
    normalized.response_timeout_ms = normalizeInteger(record.response_timeout_ms, `${field}.response_timeout_ms`);
  }
  if (record.max_connect_retries !== undefined) {
    normalized.max_connect_retries = normalizeInteger(record.max_connect_retries, `${field}.max_connect_retries`);
  }
  if (record.connect_retry_delay_ms !== undefined) {
    normalized.connect_retry_delay_ms = normalizeInteger(
      record.connect_retry_delay_ms,
      `${field}.connect_retry_delay_ms`,
    );
  }

  return normalized;
}

function normalizePathString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw configError(`${field} must be a non-empty string.`);
  }

  return path.resolve(value.trim());
}

function normalizeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw configError(`${field} must be a non-negative integer.`);
  }

  return Number(value);
}

function parseNonNegativeInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw inputError(`${flag} expects a non-negative integer.`, {
      flag,
      value,
    });
  }
  return parsed;
}

function shiftRequiredValue(args: string[], flag: string): string {
  const value = args.shift();
  if (!value || value.startsWith("--")) {
    throw inputError(`${flag} requires a value.`, {
      flag,
    });
  }

  return value;
}

function normalizeProfileName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-zA-Z0-9._-]+$/.test(normalized)) {
    throw configError(`Profile name ${value} is invalid.`, {
      profile: value,
    });
  }

  return normalized;
}

function applyProfileLayer(resolved: CliResolvedConfig, layer: CliProfileRecord | undefined, source: string): void {
  if (!layer) {
    return;
  }

  if (layer.workspace_root) {
    resolved.workspace_root = {
      value: path.resolve(layer.workspace_root),
      source,
    };
  }
  if (layer.socket_path) {
    resolved.socket_path = {
      value: path.resolve(layer.socket_path),
      source,
    };
  }
  if (typeof layer.connect_timeout_ms === "number") {
    resolved.connect_timeout_ms = {
      value: layer.connect_timeout_ms,
      source,
    };
  }
  if (typeof layer.response_timeout_ms === "number") {
    resolved.response_timeout_ms = {
      value: layer.response_timeout_ms,
      source,
    };
  }
  if (typeof layer.max_connect_retries === "number") {
    resolved.max_connect_retries = {
      value: layer.max_connect_retries,
      source,
    };
  }
  if (typeof layer.connect_retry_delay_ms === "number") {
    resolved.connect_retry_delay_ms = {
      value: layer.connect_retry_delay_ms,
      source,
    };
  }
}
