import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { ProductStateStore, buildWorkspaceProfileId } from "./state.js";

let tempDir: string | null = null;
let previousConfigRoot: string | undefined;

function makeTempDir(): string {
  const root = path.join(process.cwd(), ".dt", `agent-runtime-state-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

afterEach(() => {
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  if (previousConfigRoot === undefined) {
    delete process.env.AGENTGIT_CLI_CONFIG_ROOT;
  } else {
    process.env.AGENTGIT_CLI_CONFIG_ROOT = previousConfigRoot;
  }
});

describe("ProductStateStore", () => {
  it("migrates v0 runtime profile documents on read", () => {
    tempDir = makeTempDir();
    previousConfigRoot = process.env.AGENTGIT_CLI_CONFIG_ROOT;
    process.env.AGENTGIT_CLI_CONFIG_ROOT = tempDir;

    const workspaceRoot = "/tmp/workspace";
    const store = new ProductStateStore(process.env);
    const db = new Database(store.paths.db_path);
    const profileFixture = JSON.parse(
      fs.readFileSync(new URL("./test-fixtures/runtime-profile.v0.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    db.prepare("DELETE FROM documents WHERE collection = ? AND key = ?").run(
      "runtime_profiles",
      buildWorkspaceProfileId(workspaceRoot),
    );
    db.prepare("INSERT INTO documents (collection, key, body_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(
        "runtime_profiles",
        buildWorkspaceProfileId(workspaceRoot),
        JSON.stringify({
          ...profileFixture,
          profile_id: buildWorkspaceProfileId(workspaceRoot),
          workspace_root: workspaceRoot,
        }),
        "2026-04-02T00:00:00.000Z",
        "2026-04-02T00:00:00.000Z",
      );

    const profile = store.getProfileForWorkspace(workspaceRoot);
    expect(profile).toMatchObject({
      profile_id: buildWorkspaceProfileId(workspaceRoot),
      workspace_root: workspaceRoot,
      runtime_id: "generic-command",
      assurance_level: "attached",
      governance_mode: "attached_live",
      guarantees: ["known_shell_entrypoints_governed"],
      execution_mode: "host_attached",
      container_network_policy: "inherit",
      contained_credential_mode: "none",
      default_checkpoint_policy: "never",
      contained_egress_mode: "inherit",
      contained_egress_assurance: "degraded",
      degraded_reasons: [],
      schema_version: 11,
    });
    expect(profile?.created_at).toBe("2026-04-02T00:00:00.000Z");
    db.close();
    store.close();
  });

  it("derives contained capability snapshots for older contained profiles on read", () => {
    tempDir = makeTempDir();
    previousConfigRoot = process.env.AGENTGIT_CLI_CONFIG_ROOT;
    process.env.AGENTGIT_CLI_CONFIG_ROOT = tempDir;

    const workspaceRoot = "/tmp/workspace";
    const store = new ProductStateStore(process.env);
    const db = new Database(store.paths.db_path);
    db.prepare("DELETE FROM documents WHERE collection = ? AND key = ?").run(
      "runtime_profiles",
      buildWorkspaceProfileId(workspaceRoot),
    );
    db.prepare("INSERT INTO documents (collection, key, body_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(
        "runtime_profiles",
        buildWorkspaceProfileId(workspaceRoot),
        JSON.stringify({
          schema_version: 7,
          profile_id: buildWorkspaceProfileId(workspaceRoot),
          workspace_root: workspaceRoot,
          runtime_id: "generic-command",
          launch_command: "rm important-plan.md",
          integration_method: "docker_contained_launch",
          install_scope: "workspace",
          assurance_level: "contained",
          governance_mode: "contained_projection",
          guarantees: ["real_workspace_protected", "publish_path_governed", "egress_policy_applied"],
          execution_mode: "docker_contained",
          governed_surfaces: ["contained runtime boundary", "governed publication boundary"],
          degraded_reasons: [],
          containment_backend: "docker",
          container_image: "alpine:3.20",
          container_network_policy: "none",
          contained_credential_mode: "brokered_secret_refs",
          contained_secret_env_bindings: [{ env_key: "OPENAI_API_KEY", secret_id: "contained_openai" }],
          adapter_metadata: {
            docker_available: true,
            docker_desktop_vm: true,
            rootless_docker: false,
            docker_server_platform: "Docker Desktop 4.63.0 (177762)",
            docker_server_os: "linux",
            docker_server_arch: "aarch64",
          },
          created_at: "2026-04-02T00:00:00.000Z",
          updated_at: "2026-04-02T00:00:00.000Z",
        }),
        "2026-04-02T00:00:00.000Z",
        "2026-04-02T00:00:00.000Z",
      );

    const profile = store.getProfileForWorkspace(workspaceRoot);
    expect(profile?.capability_snapshot).toMatchObject({
      docker_available: true,
      docker_desktop_vm: true,
      rootless_docker: false,
      projection_enforced: true,
      read_only_rootfs_enabled: true,
      network_restricted: true,
      credential_brokering_enabled: true,
      egress_mode: "none",
      egress_assurance: "boundary_enforced",
      server_platform: "Docker Desktop 4.63.0 (177762)",
      server_os: "linux",
      server_arch: "aarch64",
    });
    expect(profile?.contained_credential_mode).toBe("brokered_bindings");
    expect(profile?.runtime_credential_bindings).toEqual([
      expect.objectContaining({
        kind: "env",
        target: {
          surface: "env",
          env_key: "OPENAI_API_KEY",
        },
        broker_source_ref: "contained_openai",
      }),
    ]);
    db.close();
    store.close();
  });

  it("fails closed on future schema versions", () => {
    tempDir = makeTempDir();
    previousConfigRoot = process.env.AGENTGIT_CLI_CONFIG_ROOT;
    process.env.AGENTGIT_CLI_CONFIG_ROOT = tempDir;

    const workspaceRoot = "/tmp/workspace";
    const store = new ProductStateStore(process.env);
    const db = new Database(store.paths.db_path);
    db.prepare("DELETE FROM documents WHERE collection = ? AND key = ?").run(
      "runtime_profiles",
      buildWorkspaceProfileId(workspaceRoot),
    );
    db.prepare("INSERT INTO documents (collection, key, body_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(
        "runtime_profiles",
        buildWorkspaceProfileId(workspaceRoot),
        JSON.stringify({
          schema_version: 99,
          profile_id: buildWorkspaceProfileId(workspaceRoot),
          workspace_root: workspaceRoot,
          runtime_id: "generic-command",
          launch_command: "my-agent",
          integration_method: "launch_wrapper",
          install_scope: "workspace",
          governed_surfaces: ["launch boundary"],
          created_at: "2026-04-02T00:00:00.000Z",
          updated_at: "2026-04-02T00:00:00.000Z",
        }),
        "2026-04-02T00:00:00.000Z",
        "2026-04-02T00:00:00.000Z",
      );

    expect(() => store.getProfileForWorkspace(workspaceRoot)).toThrow(/future schema version 99/);
    db.close();
    store.close();
  });
});
