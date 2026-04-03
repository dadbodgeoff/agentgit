import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

import type { AdapterContext } from "./adapters.js";
import type {
  ContainmentBackend,
  ContainedCredentialMode,
  ContainedEgressAssurance,
  ContainedEgressMode,
  ContainerNetworkPolicy,
  DockerCapabilitySnapshot,
  RuntimeProfileDocument,
} from "./types.js";

const UTF8_FATAL_DECODER = new TextDecoder("utf-8", { fatal: true });

export const SUPPORTED_DIRECT_CREDENTIAL_ENV_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
] as const;

export interface DockerCapability {
  available: boolean;
  docker_desktop_vm: boolean;
  rootless_docker: boolean;
  server_platform?: string;
  server_os?: string;
  server_arch?: string;
  degraded_reasons: string[];
}

export interface ContainedBackendCapability {
  backend: ContainmentBackend;
  available: boolean;
  degraded_reasons: string[];
  capability_snapshot: DockerCapabilitySnapshot;
}

export interface PrepareContainedLaunchParams {
  profile: RuntimeProfileDocument;
  projection_root: string;
  host_env: NodeJS.ProcessEnv;
  resolved_secret_env_file_path?: string;
  resolved_secret_file_root?: string;
  egress_proxy_port?: number;
  secret_mount_root: string;
}

export interface PreparedContainedLaunch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface ContainedBackendRuntime {
  backend: ContainmentBackend;
  detect_capability(context: AdapterContext, params?: {
    network_policy?: ContainerNetworkPolicy;
    credential_mode?: ContainedCredentialMode;
    egress_mode?: ContainedEgressMode;
    egress_allowlist_hosts?: string[];
  }): ContainedBackendCapability;
  prepare_launch(params: PrepareContainedLaunchParams): PreparedContainedLaunch;
}

export interface WorkspaceProjectionHandle {
  projection_root: string;
  baseline_manifest_path: string;
}

export interface ProjectionChange {
  kind: "write" | "delete";
  relative_path: string;
  absolute_workspace_path: string;
  absolute_projection_path: string;
}

export interface ProjectionDiff {
  changes: ProjectionChange[];
  conflicting_paths: string[];
}

export function detectDockerCapability(context: AdapterContext): DockerCapability {
  const result = context.runner.run("docker", ["version", "--format", "{{json .}}"], {
    cwd: context.workspace_root,
    env: context.env,
  });
  if (!result.ok) {
    return {
      available: false,
      docker_desktop_vm: false,
      rootless_docker: false,
      degraded_reasons: ["Docker is not available on this machine."],
    };
  }

  let serverPlatform: string | undefined;
  let serverOs: string | undefined;
  let serverArch: string | undefined;
  try {
    const payload = JSON.parse(result.stdout) as {
      Server?: {
        Platform?: { Name?: string };
        Os?: string;
        Arch?: string;
      };
    };
    serverPlatform = payload.Server?.Platform?.Name;
    serverOs = payload.Server?.Os;
    serverArch = payload.Server?.Arch;
  } catch {
    serverPlatform = undefined;
    serverOs = undefined;
    serverArch = undefined;
  }

  const infoResult = context.runner.run("docker", ["info", "--format", "{{json .}}"], {
    cwd: context.workspace_root,
    env: context.env,
  });
  let dockerDesktopVm = false;
  let rootlessDocker = false;
  if (infoResult.ok) {
    try {
      const payload = JSON.parse(infoResult.stdout) as {
        OperatingSystem?: string;
        Rootless?: boolean;
        SecurityOptions?: unknown[];
      };
      const operatingSystem = payload.OperatingSystem?.toLowerCase() ?? "";
      dockerDesktopVm =
        operatingSystem.includes("docker desktop") ||
        (serverPlatform?.toLowerCase().includes("docker desktop") ?? false);
      if (typeof payload.Rootless === "boolean") {
        rootlessDocker = payload.Rootless;
      } else if (Array.isArray(payload.SecurityOptions)) {
        rootlessDocker = payload.SecurityOptions.some(
          (entry) => typeof entry === "string" && entry.toLowerCase().includes("rootless"),
        );
      }
    } catch {
      dockerDesktopVm = serverPlatform?.toLowerCase().includes("docker desktop") ?? false;
    }
  } else {
    dockerDesktopVm = serverPlatform?.toLowerCase().includes("docker desktop") ?? false;
  }

  return {
    available: true,
    docker_desktop_vm: dockerDesktopVm,
    rootless_docker: rootlessDocker,
    server_platform: serverPlatform,
    server_os: serverOs,
    server_arch: serverArch,
    degraded_reasons: [],
  };
}

export function inferContainerImage(command: string): string {
  const executable = command.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (["node", "npm", "npx", "pnpm", "yarn"].includes(executable)) {
    return "node:22-alpine";
  }
  if (["python", "python3", "pip", "pip3"].includes(executable)) {
    return "python:3.12-alpine";
  }
  return "alpine:3.20";
}

export function containerNetworkPolicyForStrictness(strictness: "balanced" | "strict"): ContainerNetworkPolicy {
  return strictness === "strict" ? "none" : "inherit";
}

export function containedCredentialModeForStrictness(
  strictness: "balanced" | "strict",
): ContainedCredentialMode {
  return strictness === "strict" ? "none" : "direct_env";
}

export function deriveContainedEgressMode(params: {
  network_policy?: ContainerNetworkPolicy;
  egress_allowlist_hosts?: string[];
}): ContainedEgressMode {
  if (params.network_policy === "none") {
    return "none";
  }

  return (params.egress_allowlist_hosts?.length ?? 0) > 0 ? "proxy_http_https" : "inherit";
}

export function deriveContainedEgressAssurance(params: {
  egress_mode: ContainedEgressMode;
  backend_supports_enforced_allowlist: boolean;
}): ContainedEgressAssurance {
  if (params.egress_mode === "none") {
    return "boundary_enforced";
  }

  if (params.egress_mode === "backend_enforced_allowlist" && params.backend_supports_enforced_allowlist) {
    return "boundary_enforced";
  }

  return "degraded";
}

export function isSupportedDirectCredentialEnvKey(key: string): boolean {
  return (SUPPORTED_DIRECT_CREDENTIAL_ENV_KEYS as readonly string[]).includes(key);
}

export function credentialPassthroughEnvKeys(mode: ContainedCredentialMode, requestedKeys?: string[]): string[] {
  if (mode !== "direct_env") {
    return [];
  }
  return Array.from(
    new Set(
      (requestedKeys ?? [])
        .map((key) => key.trim())
        .filter((key) => key.length > 0 && isSupportedDirectCredentialEnvKey(key)),
    ),
  );
}

export function buildDockerCapabilitySnapshot(params: {
  capability: DockerCapability;
  network_policy?: ContainerNetworkPolicy;
  credential_mode?: ContainedCredentialMode;
  egress_mode?: ContainedEgressMode;
  egress_allowlist_hosts?: string[];
}): DockerCapabilitySnapshot {
  const egressMode =
    params.egress_mode ?? deriveContainedEgressMode({
      network_policy: params.network_policy,
      egress_allowlist_hosts: params.egress_allowlist_hosts,
    });
  return {
    backend_kind: "docker",
    capability_version: 1,
    docker_available: params.capability.available,
    docker_desktop_vm: params.capability.docker_desktop_vm,
    rootless_docker: params.capability.rootless_docker,
    projection_enforced: true,
    read_only_rootfs_enabled: true,
    network_restricted: egressMode === "none",
    credential_brokering_enabled: params.credential_mode === "brokered_bindings",
    egress_mode: egressMode,
    egress_assurance: deriveContainedEgressAssurance({
      egress_mode: egressMode,
      backend_supports_enforced_allowlist: false,
    }),
    backend_enforced_allowlist_supported: false,
    raw_socket_egress_blocked: egressMode === "none",
    proxy_egress_allowlist_applied: egressMode === "proxy_http_https" && (params.egress_allowlist_hosts?.length ?? 0) > 0,
    egress_allowlist_hosts: egressMode !== "none" ? (params.egress_allowlist_hosts ?? []) : [],
    server_platform: params.capability.server_platform,
    server_os: params.capability.server_os,
    server_arch: params.capability.server_arch,
  };
}

class DockerContainedBackend implements ContainedBackendRuntime {
  readonly backend = "docker" as const;

  detect_capability(
    context: AdapterContext,
    params?: {
      network_policy?: ContainerNetworkPolicy;
      credential_mode?: ContainedCredentialMode;
      egress_mode?: ContainedEgressMode;
      egress_allowlist_hosts?: string[];
    },
  ): ContainedBackendCapability {
    const capability = detectDockerCapability(context);
    return {
      backend: this.backend,
      available: capability.available,
      degraded_reasons: capability.degraded_reasons,
      capability_snapshot: buildDockerCapabilitySnapshot({
        capability,
        network_policy: params?.network_policy,
        credential_mode: params?.credential_mode,
        egress_mode: params?.egress_mode,
        egress_allowlist_hosts: params?.egress_allowlist_hosts,
      }),
    };
  }

  prepare_launch(params: PrepareContainedLaunchParams): PreparedContainedLaunch {
    if (!params.profile.container_image) {
      throw new Error("Contained runtime profile is missing a Docker image.");
    }

    const args = [
      "run",
      "--rm",
      "--init",
      "--cap-drop=ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "256",
      "--workdir",
      "/workspace",
      "--mount",
      `type=bind,src=${params.projection_root},target=/workspace`,
      "--tmpfs",
      "/tmp",
      "--read-only",
    ];
    if (typeof process.getuid === "function" && typeof process.getgid === "function") {
      args.push("--user", `${process.getuid()}:${process.getgid()}`);
    }
    if (params.profile.container_network_policy === "none") {
      args.push("--network", "none");
    }
    if (params.profile.contained_egress_mode === "backend_enforced_allowlist") {
      throw new Error("Docker-contained runtime does not support backend-enforced allowlist egress.");
    }
    if (params.resolved_secret_env_file_path) {
      args.push("--env-file", params.resolved_secret_env_file_path);
    }
    if (params.resolved_secret_file_root) {
      args.push(
        "--mount",
        `type=bind,src=${params.resolved_secret_file_root},target=${params.secret_mount_root},readonly`,
      );
    }
    if (params.egress_proxy_port !== undefined) {
      args.push("--add-host", "host.docker.internal:host-gateway");
      args.push("-e", `HTTP_PROXY=http://host.docker.internal:${params.egress_proxy_port}`);
      args.push("-e", `HTTPS_PROXY=http://host.docker.internal:${params.egress_proxy_port}`);
      args.push("-e", `ALL_PROXY=http://host.docker.internal:${params.egress_proxy_port}`);
      args.push("-e", `http_proxy=http://host.docker.internal:${params.egress_proxy_port}`);
      args.push("-e", `https_proxy=http://host.docker.internal:${params.egress_proxy_port}`);
      args.push("-e", `all_proxy=http://host.docker.internal:${params.egress_proxy_port}`);
    }
    for (const key of params.profile.credential_passthrough_env_keys ?? []) {
      if (typeof params.host_env[key] === "string" && params.host_env[key]!.length > 0) {
        args.push("-e", key);
      }
    }
    args.push(params.profile.container_image, "sh", "-lc", params.profile.launch_command);
    return {
      command: "docker",
      args,
      env: params.host_env,
    };
  }
}

const CONTAINED_BACKENDS: Record<ContainmentBackend, ContainedBackendRuntime> = {
  docker: new DockerContainedBackend(),
};

export function resolveContainedBackendRuntime(backend: ContainmentBackend): ContainedBackendRuntime {
  return CONTAINED_BACKENDS[backend];
}

function shouldExcludeFromProjection(relativePath: string): boolean {
  return relativePath === ".agentgit" || relativePath.startsWith(`.agentgit${path.sep}`);
}

function walkFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  if (!fs.existsSync(root)) {
    return files;
  }

  const visit = (currentRoot: string, relativeRoot: string) => {
    for (const entry of fs.readdirSync(currentRoot, { withFileTypes: true })) {
      const nextRelative = relativeRoot ? path.join(relativeRoot, entry.name) : entry.name;
      if (shouldExcludeFromProjection(nextRelative)) {
        continue;
      }
      const nextPath = path.join(currentRoot, entry.name);
      if (entry.isDirectory()) {
        visit(nextPath, nextRelative);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Contained execution only supports regular files today. Unsupported entry: ${nextPath}`);
      }
      files.set(nextRelative, fileDigest(nextPath));
    }
  };

  visit(root, "");
  return files;
}

function fileDigest(targetPath: string): string {
  return fs.existsSync(targetPath)
    ? createHashFromBuffer(fs.readFileSync(targetPath))
    : createHashFromBuffer(Buffer.from(""));
}

function createHashFromBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function createWorkspaceProjection(
  workspaceRoot: string,
  projectionRoot: string,
): WorkspaceProjectionHandle {
  fs.rmSync(projectionRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(projectionRoot), { recursive: true });
  fs.cpSync(workspaceRoot, projectionRoot, {
    recursive: true,
    filter(source) {
      const relativePath = path.relative(workspaceRoot, source);
      if (!relativePath || relativePath === "") {
        return true;
      }
      return !shouldExcludeFromProjection(relativePath);
    },
  });
  const baselineManifestPath = path.join(path.dirname(projectionRoot), "baseline-manifest.json");
  fs.writeFileSync(
    baselineManifestPath,
    JSON.stringify(Object.fromEntries(walkFiles(workspaceRoot)), null, 2),
    "utf8",
  );
  return {
    projection_root: projectionRoot,
    baseline_manifest_path: baselineManifestPath,
  };
}

export function diffWorkspaceProjection(
  workspaceRoot: string,
  projectionRoot: string,
  baselineManifestPath: string,
): ProjectionDiff {
  const baseline = new Map<string, string>(
    Object.entries(JSON.parse(fs.readFileSync(baselineManifestPath, "utf8")) as Record<string, string>),
  );
  const currentWorkspace = walkFiles(workspaceRoot);
  const projection = walkFiles(projectionRoot);
  const paths = new Set<string>([...baseline.keys(), ...projection.keys()]);
  const changes: ProjectionChange[] = [];
  const conflictingPaths: string[] = [];

  for (const relativePath of Array.from(paths).sort()) {
    const baselineDigest = baseline.get(relativePath);
    const projectionDigest = projection.get(relativePath);
    if (baselineDigest === projectionDigest) {
      continue;
    }

    const workspaceDigest = currentWorkspace.get(relativePath);
    const absoluteWorkspacePath = path.join(workspaceRoot, relativePath);
    const absoluteProjectionPath = path.join(projectionRoot, relativePath);

    if (baselineDigest === undefined) {
      if (workspaceDigest !== undefined) {
        conflictingPaths.push(absoluteWorkspacePath);
        continue;
      }
      changes.push({
        kind: "write",
        relative_path: relativePath,
        absolute_workspace_path: absoluteWorkspacePath,
        absolute_projection_path: absoluteProjectionPath,
      });
      continue;
    }

    if (projectionDigest === undefined) {
      if (workspaceDigest !== baselineDigest) {
        conflictingPaths.push(absoluteWorkspacePath);
        continue;
      }
      changes.push({
        kind: "delete",
        relative_path: relativePath,
        absolute_workspace_path: absoluteWorkspacePath,
        absolute_projection_path: absoluteProjectionPath,
      });
      continue;
    }

    if (workspaceDigest !== baselineDigest) {
      conflictingPaths.push(absoluteWorkspacePath);
      continue;
    }
    changes.push({
      kind: "write",
      relative_path: relativePath,
      absolute_workspace_path: absoluteWorkspacePath,
      absolute_projection_path: absoluteProjectionPath,
    });
  }

  return {
    changes,
    conflicting_paths: Array.from(new Set(conflictingPaths)),
  };
}

export function readProjectionFileText(targetPath: string): string {
  const buffer = fs.readFileSync(targetPath);
  try {
    return UTF8_FATAL_DECODER.decode(buffer);
  } catch {
    throw new Error(`Contained publication only supports UTF-8 files today: ${targetPath}`);
  }
}
