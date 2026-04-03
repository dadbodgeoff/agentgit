import { describe, expect, it } from "vitest";

import { createAdapterContext } from "./adapters.js";
import {
  buildDockerCapabilitySnapshot,
  detectDockerCapability,
  resolveContainedBackendRuntime,
} from "./containment.js";
import { ProductStateStore } from "./state.js";
import type { CommandRunOptions, CommandRunResult, CommandRunner } from "./utils.js";

class CapabilityRunner implements CommandRunner {
  run(command: string, args: string[] = [], _options: CommandRunOptions = {}): CommandRunResult {
    if (command === "git" && args[0] === "rev-parse") {
      return { ok: true, exit_code: 0, stdout: "/tmp/workspace", stderr: "" };
    }

    if (command === "docker" && args[0] === "version") {
      return {
        ok: true,
        exit_code: 0,
        stdout: JSON.stringify({
          Server: {
            Platform: { Name: "Docker Desktop 4.63.0 (177762)" },
            Os: "linux",
            Arch: "aarch64",
          },
        }),
        stderr: "",
      };
    }

    if (command === "docker" && args[0] === "info") {
      return {
        ok: true,
        exit_code: 0,
        stdout: JSON.stringify({
          OperatingSystem: "Docker Desktop",
          SecurityOptions: ["name=rootless"],
        }),
        stderr: "",
      };
    }

    return { ok: false, exit_code: 1, stdout: "", stderr: "unsupported command" };
  }
}

describe("containment helpers", () => {
  it("detects Docker Desktop and rootless capability truth", () => {
    const store = new ProductStateStore(process.env);
    const context = createAdapterContext({
      workspace_root: "/tmp/workspace",
      state: store,
      runner: new CapabilityRunner(),
      cwd: "/tmp/workspace",
    });

    const capability = detectDockerCapability(context);
    expect(capability).toMatchObject({
      available: true,
      docker_desktop_vm: true,
      rootless_docker: true,
      server_platform: "Docker Desktop 4.63.0 (177762)",
      server_os: "linux",
      server_arch: "aarch64",
    });
    store.close();
  });

  it("builds contained capability snapshots from policy truth", () => {
    const snapshot = buildDockerCapabilitySnapshot({
      capability: {
        available: true,
        docker_desktop_vm: false,
        rootless_docker: true,
        server_platform: "Docker Engine - Community",
        server_os: "linux",
        server_arch: "x86_64",
        degraded_reasons: [],
      },
      network_policy: "none",
      credential_mode: "brokered_secret_refs",
    });

    expect(snapshot).toEqual({
      backend_kind: "docker",
      capability_version: 1,
      docker_available: true,
      docker_desktop_vm: false,
      rootless_docker: true,
      projection_enforced: true,
      read_only_rootfs_enabled: true,
      network_restricted: true,
      credential_brokering_enabled: true,
      proxy_egress_allowlist_applied: false,
      egress_allowlist_hosts: [],
      server_platform: "Docker Engine - Community",
      server_os: "linux",
      server_arch: "x86_64",
    });
  });

  it("resolves the Docker contained backend through the shared backend registry", () => {
    const store = new ProductStateStore(process.env);
    const context = createAdapterContext({
      workspace_root: "/tmp/workspace",
      state: store,
      runner: new CapabilityRunner(),
      cwd: "/tmp/workspace",
    });

    const backend = resolveContainedBackendRuntime("docker");
    const capability = backend.detect_capability(context, {
      network_policy: "none",
      credential_mode: "brokered_secret_refs",
    });

    expect(backend.backend).toBe("docker");
    expect(capability.available).toBe(true);
    expect(capability.capability_snapshot).toMatchObject({
      backend_kind: "docker",
      capability_version: 1,
      docker_available: true,
      network_restricted: true,
      credential_brokering_enabled: true,
    });
    store.close();
  });
});
