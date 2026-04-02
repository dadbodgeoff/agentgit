import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkspaceIndex, matchesIgnorePattern } from "./index.js";

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentgit-wi-test-"));
}

async function writeFile(root: string, relativePath: string, content: string): Promise<void> {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf8");
}

function createIndex(workspaceRoot: string, tempRoot: string): WorkspaceIndex {
  return new WorkspaceIndex({
    dbPath: path.join(tempRoot, "index.db"),
    workspaceRoot,
    snapshotDir: path.join(tempRoot, "snapshots"),
  });
}

describe("matchesIgnorePattern", () => {
  it("matches dotenv files", () => {
    expect(matchesIgnorePattern(".env", [".env"])).toBe(true);
    expect(matchesIgnorePattern(".env.local", [".env"])).toBe(true);
  });

  it("matches extension globs", () => {
    expect(matchesIgnorePattern("certs/server.pem", ["*.pem"])).toBe(true);
    expect(matchesIgnorePattern("src/index.ts", ["*.pem"])).toBe(false);
  });

  it("matches directory patterns", () => {
    expect(matchesIgnorePattern("node_modules/pkg/index.js", ["**/node_modules/**"])).toBe(true);
    expect(matchesIgnorePattern(".git/objects/abc", ["**/.git/**"])).toBe(true);
  });
});

describe("WorkspaceIndex", () => {
  let tempRoot: string;
  let workspaceRoot: string;
  let index: WorkspaceIndex;

  beforeEach(async () => {
    tempRoot = await makeTempDir();
    workspaceRoot = path.join(tempRoot, "workspace");
    await fs.mkdir(workspaceRoot, { recursive: true });
    index = createIndex(workspaceRoot, tempRoot);
  });

  afterEach(async () => {
    index.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("prepareScan detects new files without mutating the baseline", async () => {
    await writeFile(workspaceRoot, "src/foo.ts", "hello");

    const prepared = await index.prepareScan();

    expect(prepared.files).toHaveLength(1);
    expect(prepared.files[0]?.change_type).toBe("created");
    expect(index.checkFile("src/foo.ts")).toBeNull();
    expect(index.getStats().current_baseline_revision).toBe(0);
  });

  it("commitSnapshot promotes the prepared baseline", async () => {
    await writeFile(workspaceRoot, "src/foo.ts", "hello");

    const prepared = await index.prepareScan();
    const snapshot = await index.commitSnapshot({
      preparedSet: prepared,
      trigger_reason: "action:write",
      action_id: "act_001",
      run_id: "run_001",
      anchor_path: path.join(workspaceRoot, "src/foo.ts"),
    });

    expect(snapshot.file_count).toBe(1);
    expect(snapshot.anchor_exists).toBe(true);
    expect(index.checkFile("src/foo.ts")).not.toBeNull();
    expect(index.getStats().current_baseline_revision).toBe(1);
  });

  it("persists zero-delta checkpoints instead of fabricating IDs", async () => {
    await writeFile(workspaceRoot, "src/foo.ts", "hello");
    const firstPrepared = await index.prepareScan();
    await index.commitSnapshot({
      preparedSet: firstPrepared,
      trigger_reason: "initial",
      anchor_path: path.join(workspaceRoot, "src/foo.ts"),
    });

    const zeroDeltaPrepared = await index.prepareScan();
    expect(zeroDeltaPrepared.files).toHaveLength(0);

    const zeroDeltaSnapshot = await index.commitSnapshot({
      preparedSet: zeroDeltaPrepared,
      trigger_reason: "no-op",
      anchor_path: path.join(workspaceRoot, "src/foo.ts"),
    });

    expect(index.getSnapshotManifest(zeroDeltaSnapshot.snap_id)).not.toBeNull();
    expect(index.listSnapshots()).toHaveLength(2);
  });

  it("restores anchor-backed zero-delta checkpoints after the anchor file is deleted", async () => {
    await writeFile(workspaceRoot, "src/foo.ts", "hello");
    const firstPrepared = await index.prepareScan();
    await index.commitSnapshot({
      preparedSet: firstPrepared,
      trigger_reason: "initial",
      anchor_path: path.join(workspaceRoot, "src/foo.ts"),
    });

    const zeroDeltaPrepared = await index.prepareScan();
    const zeroDeltaSnapshot = await index.commitSnapshot({
      preparedSet: zeroDeltaPrepared,
      trigger_reason: "checkpoint",
      anchor_path: path.join(workspaceRoot, "src/foo.ts"),
    });

    await fs.rm(path.join(workspaceRoot, "src/foo.ts"));
    const deletedPrepared = await index.prepareScan();
    await index.commitSnapshot({
      preparedSet: deletedPrepared,
      trigger_reason: "delete",
      anchor_path: path.join(workspaceRoot, "src/foo.ts"),
    });

    await index.restore(zeroDeltaSnapshot.snap_id);

    await expect(fs.readFile(path.join(workspaceRoot, "src/foo.ts"), "utf8")).resolves.toBe("hello");
  });

  it("restore replays a prior snapshot state and records a recovery checkpoint", async () => {
    await writeFile(workspaceRoot, "config.json", '{"version":1}');
    const firstPrepared = await index.prepareScan();
    const firstSnapshot = await index.commitSnapshot({
      preparedSet: firstPrepared,
      trigger_reason: "initial",
      anchor_path: path.join(workspaceRoot, "config.json"),
    });

    await writeFile(workspaceRoot, "config.json", '{"version":2}');
    const secondPrepared = await index.prepareScan();
    await index.commitSnapshot({
      preparedSet: secondPrepared,
      trigger_reason: "action:write",
      anchor_path: path.join(workspaceRoot, "config.json"),
    });

    const result = await index.restore(firstSnapshot.snap_id);

    expect(result.files_restored.length).toBeGreaterThan(0);
    expect(await fs.readFile(path.join(workspaceRoot, "config.json"), "utf8")).toBe('{"version":1}');
    expect(index.getSnapshotManifest(result.recovery_snapshot_id)).not.toBeNull();
  });

  it("previewRestore reports overlapping later actions", async () => {
    await writeFile(workspaceRoot, "config.json", '{"version":1}');
    const firstPrepared = await index.prepareScan();
    const firstSnapshot = await index.commitSnapshot({
      preparedSet: firstPrepared,
      trigger_reason: "initial",
      action_id: "act_initial",
      anchor_path: path.join(workspaceRoot, "config.json"),
    });

    await writeFile(workspaceRoot, "config.json", '{"version":2}');
    const secondPrepared = await index.prepareScan();
    await index.commitSnapshot({
      preparedSet: secondPrepared,
      trigger_reason: "action:write",
      action_id: "act_later",
      anchor_path: path.join(workspaceRoot, "config.json"),
    });

    const preview = await index.previewRestore(firstSnapshot.snap_id);

    expect(preview.paths_to_change).toBeGreaterThan(0);
    expect(preview.later_actions_affected).toBe(1);
    expect(preview.overlapping_paths).toContain("config.json");
    expect(preview.data_loss_risk).not.toBe("low");
  });

  it("statLiveFile hashes the current on-disk state", async () => {
    await writeFile(workspaceRoot, "src/app.ts", "const x = 1;");

    const state = await index.statLiveFile("src/app.ts");

    expect(state.exists).toBe(true);
    expect(state.content_hash).toBeTruthy();
    expect(state.size_bytes).toBeGreaterThan(0);
  });

  it("tracks deletions after commit", async () => {
    await writeFile(workspaceRoot, "notes.txt", "hello");
    const createdPrepared = await index.prepareScan();
    await index.commitSnapshot({
      preparedSet: createdPrepared,
      trigger_reason: "initial",
      anchor_path: path.join(workspaceRoot, "notes.txt"),
    });

    await fs.rm(path.join(workspaceRoot, "notes.txt"));
    const deletedPrepared = await index.prepareScan();

    expect(deletedPrepared.files).toHaveLength(1);
    expect(deletedPrepared.files[0]?.change_type).toBe("deleted");
  });

  it("rejects stale prepared scans after the baseline advances", async () => {
    await writeFile(workspaceRoot, "file.txt", "v1");

    const firstPrepared = await index.prepareScan();
    const secondPrepared = await index.prepareScan();

    await index.commitSnapshot({
      preparedSet: firstPrepared,
      trigger_reason: "first",
      anchor_path: path.join(workspaceRoot, "file.txt"),
    });

    await expect(
      index.commitSnapshot({
        preparedSet: secondPrepared,
        trigger_reason: "stale",
        anchor_path: path.join(workspaceRoot, "file.txt"),
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      retryable: true,
    });

    expect(index.listSnapshots()).toHaveLength(1);
    const snapDirs = await fs.readdir(path.join(tempRoot, "snapshots", "snaps"));
    expect(snapDirs).toHaveLength(1);
    expect(index.getStats().current_baseline_revision).toBe(1);
  });

  it("does not index ignored dotenv files", async () => {
    await writeFile(workspaceRoot, ".env", "SECRET=abc");
    await writeFile(workspaceRoot, "src/app.ts", "export {}");

    const prepared = await index.prepareScan();

    expect(prepared.files.map((file) => file.path)).toEqual(["src/app.ts"]);
  });

  it("returns no-op compaction in v1", async () => {
    await writeFile(workspaceRoot, "file.txt", "hello");
    const prepared = await index.prepareScan();
    await index.commitSnapshot({
      preparedSet: prepared,
      trigger_reason: "initial",
      anchor_path: path.join(workspaceRoot, "file.txt"),
    });

    await expect(index.compact(20)).resolves.toEqual({
      snaps_removed: 0,
      bytes_freed: 0,
      compacted_snap_id: null,
    });
  });

  it("restores only the requested path subset from a prior snapshot", async () => {
    await writeFile(workspaceRoot, "config.json", '{"version":1}');
    await writeFile(workspaceRoot, "notes.txt", "v1");
    const firstPrepared = await index.prepareScan();
    const firstSnapshot = await index.commitSnapshot({
      preparedSet: firstPrepared,
      trigger_reason: "initial",
      action_id: "act_initial",
      anchor_path: path.join(workspaceRoot, "config.json"),
    });

    await writeFile(workspaceRoot, "config.json", '{"version":2}');
    await writeFile(workspaceRoot, "notes.txt", "v2");
    const secondPrepared = await index.prepareScan();
    await index.commitSnapshot({
      preparedSet: secondPrepared,
      trigger_reason: "update",
      action_id: "act_update",
      anchor_path: path.join(workspaceRoot, "config.json"),
    });

    const preview = await index.previewRestoreSubset(firstSnapshot.snap_id, ["config.json"]);
    expect(preview.paths_to_change).toBe(1);
    expect(preview.later_actions_affected).toBe(1);
    expect(preview.overlapping_paths).toContain("config.json");
    expect(preview.overlapping_paths).not.toContain("notes.txt");

    const result = await index.restoreSubset(firstSnapshot.snap_id, ["config.json"]);
    expect(result.files_restored).toEqual([{ path: "config.json", action: "restored" }]);
    expect(await fs.readFile(path.join(workspaceRoot, "config.json"), "utf8")).toBe('{"version":1}');
    expect(await fs.readFile(path.join(workspaceRoot, "notes.txt"), "utf8")).toBe("v2");
  });

  it("rebases duplicate synthetic anchors without changing historical restore state", async () => {
    await writeFile(workspaceRoot, "config.json", '{"version":1}');
    const firstPrepared = await index.prepareScan();
    const firstSnapshot = await index.commitSnapshot({
      preparedSet: firstPrepared,
      trigger_reason: "initial",
      anchor_path: path.join(workspaceRoot, "config.json"),
    });

    const secondPrepared = await index.prepareScan();
    const secondSnapshot = await index.commitSnapshot({
      preparedSet: secondPrepared,
      trigger_reason: "checkpoint",
      anchor_path: path.join(workspaceRoot, "config.json"),
    });

    await writeFile(workspaceRoot, "config.json", '{"version":2}');
    const thirdPrepared = await index.prepareScan();
    await index.commitSnapshot({
      preparedSet: thirdPrepared,
      trigger_reason: "update",
      anchor_path: path.join(workspaceRoot, "config.json"),
    });

    const duplicateAnchorPath = path.join(
      tempRoot,
      "snapshots",
      "snaps",
      secondSnapshot.snap_id,
      "files",
      "config.json",
    );
    expect(await fs.readFile(duplicateAnchorPath, "utf8")).toBe('{"version":1}');

    const result = await index.rebaseSyntheticAnchors();
    expect(result.snapshots_scanned).toBe(3);
    expect(result.anchors_rebased).toBe(1);
    expect(result.bytes_freed).toBe(Buffer.byteLength('{"version":1}', "utf8"));
    await expect(fs.access(duplicateAnchorPath)).rejects.toBeDefined();

    const rebasedManifest = index.getSnapshotManifest(secondSnapshot.snap_id);
    expect(rebasedManifest?.anchor_source_snap_id).toBe(firstSnapshot.snap_id);

    await fs.rm(path.join(workspaceRoot, "config.json"));
    await index.restore(secondSnapshot.snap_id);
    await expect(fs.readFile(path.join(workspaceRoot, "config.json"), "utf8")).resolves.toBe('{"version":1}');
  });
});
