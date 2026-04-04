import fs from "node:fs";

import { AuthorityClient } from "@agentgit/authority-sdk";

import { toCliError } from "../cli-contract.js";
import type { CliResolvedConfig } from "../cli-config.js";
import type { DoctorCheck, DoctorResult } from "./lifecycle-types.js";

export async function buildDoctorResult(
  client: AuthorityClient,
  resolvedConfig: CliResolvedConfig,
  cliVersion: string,
): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const recommendations: string[] = [];
  const workspaceExists = fs.existsSync(resolvedConfig.workspace_root.value);
  checks.push({
    code: "WORKSPACE_ROOT",
    status: workspaceExists ? "pass" : "fail",
    summary: workspaceExists ? "Workspace root exists." : "Workspace root does not exist.",
    details: {
      workspace_root: resolvedConfig.workspace_root.value,
      source: resolvedConfig.workspace_root.source,
    },
  });

  let daemonReachable = false;
  let sessionId: string | null = null;
  let acceptedApiVersion: string | null = null;
  let runtimeVersion: string | null = null;
  let schemaPackVersion: string | null = null;
  let securityPostureStatus: DoctorResult["security_posture_status"] = "unknown";

  try {
    const hello = await client.hello([resolvedConfig.workspace_root.value]);
    daemonReachable = true;
    sessionId = hello.session_id;
    acceptedApiVersion = hello.accepted_api_version;
    runtimeVersion = hello.runtime_version;
    schemaPackVersion = hello.schema_pack_version;
    checks.push({
      code: "DAEMON_REACHABLE",
      status: "pass",
      summary: "Authority daemon handshake succeeded.",
      details: {
        session_id: hello.session_id,
        accepted_api_version: hello.accepted_api_version,
        runtime_version: hello.runtime_version,
        schema_pack_version: hello.schema_pack_version,
      },
    });

    const capabilities = await client.getCapabilities(resolvedConfig.workspace_root.value);
    const credentialMode = capabilities.capabilities.find(
      (capability) => capability.capability_name === "host.credential_broker_mode",
    );
    checks.push({
      code: "CAPABILITIES",
      status: capabilities.degraded_mode_warnings.length > 0 ? "warn" : "pass",
      summary:
        capabilities.degraded_mode_warnings.length > 0
          ? `${capabilities.degraded_mode_warnings.length} degraded capability warning(s) detected.`
          : "Capability surface is healthy.",
      details: {
        warnings: capabilities.degraded_mode_warnings,
      },
    });
    checks.push({
      code: "SECRET_STORAGE_MODE",
      status: credentialMode?.status === "available" ? "pass" : credentialMode?.status === "degraded" ? "warn" : "fail",
      summary:
        credentialMode && typeof credentialMode.details.mode === "string"
          ? `Credential broker mode: ${credentialMode.details.mode}${
              typeof credentialMode.details.key_provider === "string"
                ? ` via ${credentialMode.details.key_provider}`
                : ""
            }.`
          : "Credential broker mode is unavailable.",
      details: credentialMode?.details as Record<string, unknown> | undefined,
    });

    const [servers, secrets, policies, diagnostics] = await Promise.all([
      client.listMcpServers(),
      client.listMcpSecrets(),
      client.listMcpHostPolicies(),
      client.diagnostics(["security_posture", "hosted_worker", "hosted_queue"]),
    ]);
    checks.push({
      code: "MCP_REGISTRY",
      status: "pass",
      summary: `MCP registry contains ${servers.servers.length} server(s), ${secrets.secrets.length} secret(s), and ${policies.policies.length} host policy item(s).`,
      details: {
        servers: servers.servers.length,
        secrets: secrets.secrets.length,
        host_policies: policies.policies.length,
      },
    });

    if (diagnostics.security_posture) {
      const posture = diagnostics.security_posture;
      securityPostureStatus = posture.status;
      checks.push({
        code: "SECURITY_POSTURE",
        status: posture.status === "healthy" ? "pass" : "warn",
        summary:
          posture.status === "healthy"
            ? `Security posture is production-ready on this host (${posture.stdio_sandbox.current_host_mode}).`
            : `${posture.primary_reason?.message ?? "Security posture is degraded on this host."} Host mode: ${posture.stdio_sandbox.current_host_mode}.`,
        details: {
          primary_reason: posture.primary_reason,
          warnings: posture.warnings,
          current_host_mode: posture.stdio_sandbox.current_host_mode,
          current_host_mode_reason: posture.stdio_sandbox.current_host_mode_reason,
        },
      });

      if (posture.secret_storage.provider === null) {
        recommendations.push("Configure an OS-backed secret provider before treating this daemon as production-ready.");
      }
      if (posture.secret_storage.legacy_key_path) {
        recommendations.push(
          `Remove the legacy local key file once migration is confirmed: ${posture.secret_storage.legacy_key_path}`,
        );
      }
      if (
        posture.stdio_sandbox.registered_server_count > 0 &&
        posture.stdio_sandbox.production_ready_server_count < posture.stdio_sandbox.registered_server_count
      ) {
        recommendations.push(
          posture.stdio_sandbox.docker_runtime_usable || posture.stdio_sandbox.podman_runtime_usable
            ? "Set all stdio MCP servers to the `oci_container` sandbox. That is the required production path on Linux, macOS, and Windows."
            : "Install Docker or Podman and re-register stdio MCP servers with `oci_container`; governed stdio execution now requires an OCI sandbox.",
        );
      }
      if (posture.stdio_sandbox.fallback_server_count > 0) {
        recommendations.push(
          `Remove ${posture.stdio_sandbox.fallback_server_count} legacy stdio MCP server registration(s) that still report fallback-only posture; OCI is the only supported governed sandbox path.`,
        );
      }
      if (posture.stdio_sandbox.mutable_tag_server_count > 0) {
        recommendations.push(
          `Replace mutable-tag OCI images for ${posture.stdio_sandbox.mutable_tag_server_count} stdio MCP server(s) with sha256-pinned refs; new governed registrations now reject mutable tags unless oci_container.build is configured for local development.`,
        );
      }
      if (posture.stdio_sandbox.local_build_server_count > 0) {
        recommendations.push(
          `Move ${posture.stdio_sandbox.local_build_server_count} stdio MCP server(s) off oci_container.build before production rollout; local OCI builds are a development path, not a release supply-chain policy.`,
        );
      }
      if (posture.stdio_sandbox.registry_policy_server_count < posture.stdio_sandbox.digest_pinned_server_count) {
        recommendations.push(
          "Add allowed_registries coverage for every remote OCI stdio MCP image so the configured registry trust boundary is explicit.",
        );
      }
      if (
        posture.stdio_sandbox.signature_verification_server_count < posture.stdio_sandbox.digest_pinned_server_count
      ) {
        recommendations.push(
          "Configure cosign-based signature_verification for every remote OCI stdio MCP image; digest pinning alone is not the full production trust bar.",
        );
      }
      if (
        posture.stdio_sandbox.provenance_attestation_server_count <
        posture.stdio_sandbox.signature_verification_server_count
      ) {
        recommendations.push(
          "Require SLSA provenance attestations for OCI stdio MCP images so production trust covers provenance as well as signatures.",
        );
      }
      recommendations.push(
        "For local development, prefer `oci_container` with a `build` config so developers can build from source locally while staying on the same OCI boundary used in production.",
      );
      if (posture.stdio_sandbox.unconfigured_server_count > 0) {
        recommendations.push(
          `Add explicit sandbox configuration for ${posture.stdio_sandbox.unconfigured_server_count} stdio MCP server(s); the runtime now fails closed when sandbox config is missing.`,
        );
      }
      if (posture.streamable_http.legacy_bearer_env_servers.length > 0) {
        recommendations.push(
          `Move ${posture.streamable_http.legacy_bearer_env_servers.length} streamable_http server(s) from bearer env vars to brokered secret refs.`,
        );
      }
      if (posture.streamable_http.missing_secret_ref_servers.length > 0) {
        recommendations.push(
          `Bind managed secrets for ${posture.streamable_http.missing_secret_ref_servers.length} streamable_http server(s) before production use.`,
        );
      }
      if (posture.streamable_http.missing_public_host_policy_servers.length > 0) {
        recommendations.push(
          `Add explicit public host policies for ${posture.streamable_http.missing_public_host_policy_servers.length} streamable_http server(s) so runtime host validation stays fail-closed.`,
        );
      }
      if (recommendations.length === 0) {
        recommendations.push(
          "Keep OCI sandboxing as the default production stdio path, and use GitHub Actions only to validate that the host protections stay intact across releases.",
        );
      }
      recommendations.push(`Windows plan: ${posture.stdio_sandbox.windows_plan.summary}`);
    }

    if (diagnostics.hosted_worker) {
      const hostedWorker = diagnostics.hosted_worker;
      checks.push({
        code: "HOSTED_WORKER",
        status: hostedWorker.status === "healthy" ? "pass" : "warn",
        summary:
          hostedWorker.status === "healthy"
            ? `Hosted MCP worker is reachable at ${hostedWorker.endpoint}.`
            : (hostedWorker.primary_reason?.message ?? "Hosted MCP worker is degraded."),
        details: {
          endpoint: hostedWorker.endpoint,
          endpoint_kind: hostedWorker.endpoint_kind,
          managed_by_daemon: hostedWorker.managed_by_daemon,
          runtime_id: hostedWorker.runtime_id,
          image_digest: hostedWorker.image_digest,
          warnings: hostedWorker.warnings,
        },
      });

      if (!hostedWorker.reachable) {
        recommendations.push(
          hostedWorker.managed_by_daemon
            ? "Fix hosted worker startup before relying on hosted delegated MCP execution; queued jobs cannot drain while the managed worker is unreachable."
            : "Start or repair the external hosted MCP worker before relying on hosted delegated MCP execution.",
        );
      }
    }

    if (diagnostics.hosted_queue) {
      const hostedQueue = diagnostics.hosted_queue;
      checks.push({
        code: "HOSTED_QUEUE",
        status: hostedQueue.status === "healthy" ? "pass" : "warn",
        summary:
          hostedQueue.status === "healthy"
            ? `Hosted MCP queue is healthy (${hostedQueue.queued_jobs} queued, ${hostedQueue.running_jobs} running).`
            : (hostedQueue.primary_reason?.message ?? "Hosted MCP queue is degraded."),
        details: {
          queued_jobs: hostedQueue.queued_jobs,
          running_jobs: hostedQueue.running_jobs,
          failed_jobs: hostedQueue.failed_jobs,
          retryable_failed_jobs: hostedQueue.retryable_failed_jobs,
          active_server_profiles: hostedQueue.active_server_profiles,
          warnings: hostedQueue.warnings,
        },
      });

      if (hostedQueue.failed_jobs > 0) {
        recommendations.push(
          "Inspect failed hosted MCP jobs with `list-hosted-mcp-jobs` or `show-hosted-mcp-job`, then recover them with `requeue-hosted-mcp-job` once the underlying worker or endpoint issue is fixed.",
        );
      }
    }
  } catch (error) {
    const cliError = toCliError(error);
    checks.push({
      code: "DAEMON_REACHABLE",
      status: "fail",
      summary: cliError.message,
      details: {
        error_code: cliError.code,
        exit_code: cliError.exitCode,
      },
    });
    recommendations.push(
      "Fix daemon reachability first; runtime security checks cannot be verified until the daemon is reachable.",
    );
  }

  return {
    cli_version: cliVersion,
    config: {
      config_root: resolvedConfig.paths.configRoot,
      user_config_path: resolvedConfig.paths.userConfigPath,
      workspace_config_path: resolvedConfig.paths.workspaceConfigPath,
      active_profile: resolvedConfig.active_profile,
      workspace_root: resolvedConfig.workspace_root.value,
      socket_path: resolvedConfig.socket_path.value,
    },
    daemon: {
      reachable: daemonReachable,
      session_id: sessionId,
      accepted_api_version: acceptedApiVersion,
      runtime_version: runtimeVersion,
      schema_pack_version: schemaPackVersion,
    },
    security_posture_status: securityPostureStatus,
    checks,
    recommendations,
  };
}
