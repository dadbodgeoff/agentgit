import path from "node:path";

import { describe, expect, it } from "vitest";

import { PreconditionError, type RawActionAttempt } from "@agentgit/schemas";

import { normalizeActionAttempt } from "./index.js";

function makeAttempt(overrides: Partial<RawActionAttempt> = {}): RawActionAttempt {
  const workspaceRoot = "/workspace/project";

  return {
    run_id: "run_test",
    tool_registration: {
      tool_name: "write_file",
      tool_kind: "filesystem",
    },
    raw_call: {
      operation: "write",
      path: "src/index.ts",
      content: "console.log('hello');",
    },
    environment_context: {
      workspace_roots: [workspaceRoot],
      cwd: workspaceRoot,
      credential_mode: "none",
    },
    framework_context: {
      agent_name: "test-agent",
      agent_framework: "test-framework",
    },
    received_at: "2026-03-29T12:00:00.000Z",
    ...overrides,
  };
}

describe("normalizeActionAttempt", () => {
  it("should normalize a simple file write to an ActionRecord with schema_version action.v1", () => {
    const action = normalizeActionAttempt(makeAttempt(), "sess_test");

    expect(action.schema_version).toBe("action.v1");
    expect(action.operation.domain).toBe("filesystem");
    expect(action.target.primary.locator).toBe("/workspace/project/src/index.ts");
  });

  it("should resolve relative paths against cwd", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        raw_call: {
          operation: "write",
          path: "./nested/file.ts",
          content: "export const ok = true;",
        },
      }),
      "sess_test",
    );

    expect(action.target.primary.locator).toBe("/workspace/project/nested/file.ts");
  });

  it("should resolve absolute paths as-is", () => {
    const targetPath = "/workspace/project/absolute.ts";
    const action = normalizeActionAttempt(
      makeAttempt({
        raw_call: {
          operation: "write",
          path: targetPath,
          content: "export const ok = true;",
        },
      }),
      "sess_test",
    );

    expect(action.target.primary.locator).toBe(targetPath);
  });

  it("should set side_effect_level to destructive for delete operations", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        raw_call: {
          operation: "delete",
          path: "src/old.ts",
        },
      }),
      "sess_test",
    );

    expect(action.risk_hints.side_effect_level).toBe("destructive");
  });

  it("should set side_effect_level to mutating for write operations", () => {
    const action = normalizeActionAttempt(makeAttempt(), "sess_test");

    expect(action.risk_hints.side_effect_level).toBe("mutating");
  });

  it("should set confidence to 0.99 for paths inside workspace roots", () => {
    const action = normalizeActionAttempt(makeAttempt(), "sess_test");

    expect(action.provenance.confidence).toBe(0.99);
  });

  it("should set confidence lower for paths outside workspace roots", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        raw_call: {
          operation: "write",
          path: "/tmp/outside.ts",
          content: "nope",
        },
      }),
      "sess_test",
    );

    expect(action.provenance.confidence).toBeLessThan(0.99);
  });

  it("should set sensitivity_hint to moderate for files over 256KB", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        raw_call: {
          operation: "write",
          path: "src/large.ts",
          content: "a".repeat(300_000),
        },
      }),
      "sess_test",
    );

    expect(action.risk_hints.sensitivity_hint).toBe("moderate");
  });

  it("should set sensitivity_hint to low for files under 256KB", () => {
    const action = normalizeActionAttempt(makeAttempt(), "sess_test");

    expect(action.risk_hints.sensitivity_hint).toBe("low");
  });

  it("should populate facets.filesystem with operation, paths, byte_length", () => {
    const content = "hello";
    const action = normalizeActionAttempt(
      makeAttempt({
        raw_call: {
          operation: "write",
          path: "src/file.ts",
          content,
        },
      }),
      "sess_test",
    );

    expect(action.facets.filesystem).toEqual({
      operation: "write",
      paths: ["/workspace/project/src/file.ts"],
      path_count: 1,
      recursive: false,
      overwrite: true,
      byte_length: Buffer.byteLength(content, "utf8"),
    });
  });

  it("should set scope.breadth to single for single file operations", () => {
    const action = normalizeActionAttempt(makeAttempt(), "sess_test");

    expect(action.target.scope.breadth).toBe("single");
  });

  it("should add unknown_scope warning when path is outside workspace", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        raw_call: {
          operation: "write",
          path: "/outside/project.ts",
          content: "x",
        },
      }),
      "sess_test",
    );

    expect(action.normalization.warnings).toContain("unknown_scope");
  });

  it("should normalize a safe read-only command with read_only side_effect_level", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        tool_registration: {
          tool_name: "exec_command",
          tool_kind: "shell",
        },
        raw_call: {
          argv: ["ls", "-la"],
        },
      }),
      "sess_test",
    );

    expect(action.risk_hints.side_effect_level).toBe("read_only");
  });

  it("should normalize git status as read_only", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        tool_registration: {
          tool_name: "exec_command",
          tool_kind: "shell",
        },
        raw_call: {
          argv: ["git", "status"],
        },
      }),
      "sess_test",
    );

    expect(action.risk_hints.side_effect_level).toBe("read_only");
  });

  it("should normalize git diff as read_only", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        tool_registration: {
          tool_name: "exec_command",
          tool_kind: "shell",
        },
        raw_call: {
          argv: ["git", "diff"],
        },
      }),
      "sess_test",
    );

    expect(action.risk_hints.side_effect_level).toBe("read_only");
  });

  it("should normalize git log as read_only", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        tool_registration: {
          tool_name: "exec_command",
          tool_kind: "shell",
        },
        raw_call: {
          argv: ["git", "log", "--oneline"],
        },
      }),
      "sess_test",
    );

    expect(action.risk_hints.side_effect_level).toBe("read_only");
    expect(action.operation.display_name).toBe("Inspect git history");
    expect(action.facets.shell).toMatchObject({
      command_family: "version_control_read_only",
    });
  });

  it("should normalize rm as destructive with high confidence", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        tool_registration: {
          tool_name: "exec_command",
          tool_kind: "shell",
        },
        raw_call: {
          argv: ["rm", "-rf", "dist"],
        },
      }),
      "sess_test",
    );

    expect(action.risk_hints.side_effect_level).toBe("destructive");
    expect(action.normalization.normalization_confidence).toBeGreaterThan(0.9);
  });

  it("should normalize mv as mutating", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        tool_registration: {
          tool_name: "exec_command",
          tool_kind: "shell",
        },
        raw_call: {
          argv: ["mv", "a.txt", "b.txt"],
        },
      }),
      "sess_test",
    );

    expect(action.risk_hints.side_effect_level).toBe("mutating");
  });

  it("should normalize cp as mutating", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        tool_registration: {
          tool_name: "exec_command",
          tool_kind: "shell",
        },
        raw_call: {
          argv: ["cp", "a.txt", "b.txt"],
        },
      }),
      "sess_test",
    );

    expect(action.risk_hints.side_effect_level).toBe("mutating");
  });

  it("should normalize git reset --hard as destructive", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        tool_registration: {
          tool_name: "exec_command",
          tool_kind: "shell",
        },
        raw_call: {
          argv: ["git", "reset", "--hard", "HEAD~1"],
        },
      }),
      "sess_test",
    );

    expect(action.risk_hints.side_effect_level).toBe("destructive");
    expect(action.facets.shell).toMatchObject({
      command_family: "version_control_mutating",
      classifier_rule: "shell.git.destructive",
    });
  });

  it("should normalize npm install as mutating with likely network effects", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        tool_registration: {
          tool_name: "exec_command",
          tool_kind: "shell",
        },
        raw_call: {
          argv: ["npm", "install"],
        },
      }),
      "sess_test",
    );

    expect(action.risk_hints.side_effect_level).toBe("mutating");
    expect(action.risk_hints.external_effects).toBe("network");
    expect(action.operation.display_name).toBe("Install packages");
    expect(action.normalization.normalization_confidence).toBeGreaterThan(0.7);
    expect(action.facets.shell).toMatchObject({
      command_family: "package_manager",
    });
  });

  it("should normalize make build as a build tool mutation", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        tool_registration: {
          tool_name: "exec_command",
          tool_kind: "shell",
        },
        raw_call: {
          argv: ["make", "build"],
        },
      }),
      "sess_test",
    );

    expect(action.risk_hints.side_effect_level).toBe("mutating");
    expect(action.operation.display_name).toBe("Run build tool");
    expect(action.normalization.normalization_confidence).toBeGreaterThan(0.5);
    expect(action.facets.shell).toMatchObject({
      command_family: "build_tool",
    });
  });

  it("should normalize unknown commands conservatively as mutating with low confidence and warnings", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        tool_registration: {
          tool_name: "exec_command",
          tool_kind: "shell",
        },
        raw_call: {
          argv: ["python", "script.py"],
        },
      }),
      "sess_test",
    );

    expect(action.risk_hints.side_effect_level).toBe("mutating");
    expect(action.risk_hints.reversibility_hint).toBe("potentially_reversible");
    expect(action.risk_hints.sensitivity_hint).toBe("moderate");
    expect(action.operation.display_name).toBe("Run python script");
    expect(action.normalization.normalization_confidence).toBeLessThan(0.3);
    expect(action.normalization.warnings).toContain("opaque_execution");
  });

  it("should parse command string into argv when argv is not provided", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        tool_registration: {
          tool_name: "exec_command",
          tool_kind: "shell",
        },
        raw_call: {
          command: "ls -la src",
        },
      }),
      "sess_test",
    );

    expect(action.facets.shell).toMatchObject({
      argv: ["ls", "-la", "src"],
    });
  });

  it("should use argv array directly when provided", () => {
    const argv = ["ls", "-la", "src"];
    const action = normalizeActionAttempt(
      makeAttempt({
        tool_registration: {
          tool_name: "exec_command",
          tool_kind: "shell",
        },
        raw_call: {
          argv,
        },
      }),
      "sess_test",
    );

    expect(action.facets.shell).toMatchObject({
      argv,
    });
  });

  it("should set batch to true for rm commands", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        tool_registration: {
          tool_name: "exec_command",
          tool_kind: "shell",
        },
        raw_call: {
          argv: ["rm", "-rf", "dist"],
        },
      }),
      "sess_test",
    );

    expect(action.risk_hints.batch).toBe(true);
  });

  it("should populate facets.shell with argv, cwd, interpreter", () => {
    const cwd = path.join("/workspace/project", "packages");
    const action = normalizeActionAttempt(
      makeAttempt({
        tool_registration: {
          tool_name: "exec_command",
          tool_kind: "shell",
        },
        environment_context: {
          workspace_roots: ["/workspace/project"],
          cwd,
          credential_mode: "none",
        },
        raw_call: {
          argv: ["ls", "-la"],
        },
      }),
      "sess_test",
    );

    expect(action.facets.shell).toMatchObject({
      argv: ["ls", "-la"],
      cwd,
      interpreter: "ls",
      declared_env_keys: [],
      stdin_kind: "none",
    });
  });

  it("should normalize owned function draft creation with deterministic object locator", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        tool_registration: {
          tool_name: "drafts_create",
          tool_kind: "function",
        },
        raw_call: {
          integration: "drafts",
          operation: "create_draft",
          subject: "Launch plan",
          body: "Ship the first compensator.",
        },
      }),
      "sess_test",
    );

    expect(action.operation.domain).toBe("function");
    expect(action.operation.name).toBe("drafts.create_draft");
    expect(action.target.primary.locator).toContain(`draft_${action.action_id}`);
    expect(action.target.primary.label).toBe("Launch plan");
    expect(action.risk_hints.reversibility_hint).toBe("compensatable");
    expect(action.facets.function).toMatchObject({
      integration: "drafts",
      operation: "create_draft",
      object_type: "message_draft",
      trusted_compensator: "drafts.archive_draft",
    });
  });

  it("should normalize owned function draft archive with explicit locator", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        tool_registration: {
          tool_name: "drafts_archive",
          tool_kind: "function",
        },
        raw_call: {
          integration: "drafts",
          operation: "archive_draft",
          draft_id: "draft_existing",
        },
      }),
      "sess_test",
    );

    expect(action.operation.domain).toBe("function");
    expect(action.operation.name).toBe("drafts.archive_draft");
    expect(action.target.primary.locator).toBe("drafts://message_draft/draft_existing");
    expect(action.target.primary.label).toBe("Draft draft_existing");
    expect(action.facets.function).toMatchObject({
      integration: "drafts",
      operation: "archive_draft",
      object_type: "message_draft",
      trusted_compensator: "drafts.unarchive_draft",
    });
  });

  it("should normalize owned function draft unarchive with archive compensator", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        tool_registration: {
          tool_name: "drafts_unarchive",
          tool_kind: "function",
        },
        raw_call: {
          integration: "drafts",
          operation: "unarchive_draft",
          draft_id: "draft_existing",
        },
      }),
      "sess_test",
    );

    expect(action.operation.domain).toBe("function");
    expect(action.operation.name).toBe("drafts.unarchive_draft");
    expect(action.target.primary.locator).toBe("drafts://message_draft/draft_existing");
    expect(action.target.primary.label).toBe("Draft draft_existing");
    expect(action.facets.function).toMatchObject({
      integration: "drafts",
      operation: "unarchive_draft",
      object_type: "message_draft",
      trusted_compensator: "drafts.archive_draft",
      payload_keys: ["draft_id"],
    });
  });

  it("should normalize owned function draft update with restore compensator", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        tool_registration: {
          tool_name: "drafts_update",
          tool_kind: "function",
        },
        raw_call: {
          integration: "drafts",
          operation: "update_draft",
          draft_id: "draft_existing",
          subject: "Updated launch plan",
          body: "Refine the scope.",
        },
      }),
      "sess_test",
    );

    expect(action.operation.domain).toBe("function");
    expect(action.operation.name).toBe("drafts.update_draft");
    expect(action.target.primary.locator).toBe("drafts://message_draft/draft_existing");
    expect(action.facets.function).toMatchObject({
      integration: "drafts",
      operation: "update_draft",
      object_type: "message_draft",
      trusted_compensator: "drafts.restore_draft",
      payload_keys: ["draft_id", "subject", "body"],
    });
  });

  it("should normalize owned function draft labeling with removable target locator", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        tool_registration: {
          tool_name: "drafts_add_label",
          tool_kind: "function",
        },
        raw_call: {
          integration: "drafts",
          operation: "add_label",
          draft_id: "draft_existing",
          label: "priority/high",
        },
      }),
      "sess_test",
    );

    expect(action.operation.domain).toBe("function");
    expect(action.operation.name).toBe("drafts.add_label");
    expect(action.target.primary.locator).toBe("drafts://message_draft/draft_existing/labels/priority%2Fhigh");
    expect(action.target.primary.label).toBe("Draft draft_existing label priority/high");
    expect(action.facets.function).toMatchObject({
      integration: "drafts",
      operation: "add_label",
      object_type: "message_draft",
      trusted_compensator: "drafts.remove_label",
      payload_keys: ["draft_id", "label"],
    });
  });

  it("should normalize owned function draft label removal with add compensator", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        tool_registration: {
          tool_name: "drafts_remove_label",
          tool_kind: "function",
        },
        raw_call: {
          integration: "drafts",
          operation: "remove_label",
          draft_id: "draft_existing",
          label: "priority/high",
        },
      }),
      "sess_test",
    );

    expect(action.operation.domain).toBe("function");
    expect(action.operation.name).toBe("drafts.remove_label");
    expect(action.target.primary.locator).toBe("drafts://message_draft/draft_existing/labels/priority%2Fhigh");
    expect(action.target.primary.label).toBe("Draft draft_existing label priority/high");
    expect(action.facets.function).toMatchObject({
      integration: "drafts",
      operation: "remove_label",
      object_type: "message_draft",
      trusted_compensator: "drafts.add_label",
      payload_keys: ["draft_id", "label"],
    });
  });

  it("should normalize owned function draft restore with restore preimage compensator", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        tool_registration: {
          tool_name: "drafts_restore",
          tool_kind: "function",
        },
        raw_call: {
          integration: "drafts",
          operation: "restore_draft",
          draft_id: "draft_existing",
          subject: "Restored launch plan",
          body: "Return the original body.",
          status: "archived",
          labels: ["priority/high", "priority/high", "ops"],
        },
      }),
      "sess_test",
    );

    expect(action.operation.domain).toBe("function");
    expect(action.operation.name).toBe("drafts.restore_draft");
    expect(action.target.primary.locator).toBe("drafts://message_draft/draft_existing");
    expect(action.target.primary.label).toBe("Draft draft_existing");
    expect(action.input.raw).toMatchObject({
      integration: "drafts",
      operation: "restore_draft",
      draft_id: "draft_existing",
      subject: "Restored launch plan",
      body: "Return the original body.",
      status: "archived",
      labels: ["priority/high", "ops"],
    });
    expect(action.facets.function).toMatchObject({
      integration: "drafts",
      operation: "restore_draft",
      object_type: "message_draft",
      trusted_compensator: "drafts.restore_draft",
      payload_keys: ["draft_id", "subject", "body", "status", "labels"],
    });
  });

  it("should normalize owned function draft delete with restore compensator and destructive risk", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        tool_registration: {
          tool_name: "drafts_delete",
          tool_kind: "function",
        },
        raw_call: {
          integration: "drafts",
          operation: "delete_draft",
          draft_id: "draft_existing",
        },
      }),
      "sess_test",
    );

    expect(action.operation.domain).toBe("function");
    expect(action.operation.name).toBe("drafts.delete_draft");
    expect(action.target.primary.locator).toBe("drafts://message_draft/draft_existing");
    expect(action.risk_hints.side_effect_level).toBe("destructive");
    expect(action.facets.function).toMatchObject({
      integration: "drafts",
      operation: "delete_draft",
      object_type: "message_draft",
      trusted_compensator: "drafts.restore_draft",
      payload_keys: ["draft_id"],
    });
  });

  it("should reject draft restore attempts with invalid status", () => {
    expect(() =>
      normalizeActionAttempt(
        makeAttempt({
          tool_registration: {
            tool_name: "drafts_restore",
            tool_kind: "function",
          },
          raw_call: {
            integration: "drafts",
            operation: "restore_draft",
            draft_id: "draft_existing",
            subject: "Restore me",
            body: "Body",
            status: "purged",
            labels: ["priority/high"],
          },
        }),
        "sess_test",
      ),
    ).toThrow("Draft restore status must be either active, archived, or deleted.");
  });

  it("should reject draft restore attempts with malformed labels", () => {
    expect(() =>
      normalizeActionAttempt(
        makeAttempt({
          tool_registration: {
            tool_name: "drafts_restore",
            tool_kind: "function",
          },
          raw_call: {
            integration: "drafts",
            operation: "restore_draft",
            draft_id: "draft_existing",
            subject: "Restore me",
            body: "Body",
            status: "active",
            labels: ["priority/high", "   "],
          },
        }),
        "sess_test",
      ),
    ).toThrow("Draft restore labels must be an array of non-empty strings.");
  });

  it("should normalize owned function note creation with note locator", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        tool_registration: {
          tool_name: "notes_create",
          tool_kind: "function",
        },
        raw_call: {
          integration: "notes",
          operation: "create_note",
          title: "Launch notes",
          body: "Track the second owned integration.",
        },
      }),
      "sess_test",
    );

    expect(action.operation.domain).toBe("function");
    expect(action.operation.name).toBe("notes.create_note");
    expect(action.target.primary.locator).toContain("notes://workspace_note/note_");
    expect(action.target.primary.label).toBe("Launch notes");
    expect(action.facets.function).toMatchObject({
      integration: "notes",
      operation: "create_note",
      object_type: "workspace_note",
      trusted_compensator: "notes.archive_note",
      payload_keys: ["title", "body"],
    });
  });

  it("should normalize owned function note archive with unarchive compensator", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        tool_registration: {
          tool_name: "notes_archive",
          tool_kind: "function",
        },
        raw_call: {
          integration: "notes",
          operation: "archive_note",
          note_id: "note_existing",
        },
      }),
      "sess_test",
    );

    expect(action.operation.domain).toBe("function");
    expect(action.operation.name).toBe("notes.archive_note");
    expect(action.target.primary.locator).toBe("notes://workspace_note/note_existing");
    expect(action.target.primary.label).toBe("Note note_existing");
    expect(action.facets.function).toMatchObject({
      integration: "notes",
      operation: "archive_note",
      object_type: "workspace_note",
      trusted_compensator: "notes.unarchive_note",
      payload_keys: ["note_id"],
    });
  });

  it("should normalize owned function note unarchive with archive compensator", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        tool_registration: {
          tool_name: "notes_unarchive",
          tool_kind: "function",
        },
        raw_call: {
          integration: "notes",
          operation: "unarchive_note",
          note_id: "note_existing",
        },
      }),
      "sess_test",
    );

    expect(action.operation.domain).toBe("function");
    expect(action.operation.name).toBe("notes.unarchive_note");
    expect(action.target.primary.locator).toBe("notes://workspace_note/note_existing");
    expect(action.target.primary.label).toBe("Note note_existing");
    expect(action.facets.function).toMatchObject({
      integration: "notes",
      operation: "unarchive_note",
      object_type: "workspace_note",
      trusted_compensator: "notes.archive_note",
      payload_keys: ["note_id"],
    });
  });

  it("should normalize owned function note delete with restore compensator and destructive risk", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        tool_registration: {
          tool_name: "notes_delete",
          tool_kind: "function",
        },
        raw_call: {
          integration: "notes",
          operation: "delete_note",
          note_id: "note_existing",
        },
      }),
      "sess_test",
    );

    expect(action.operation.domain).toBe("function");
    expect(action.operation.name).toBe("notes.delete_note");
    expect(action.target.primary.locator).toBe("notes://workspace_note/note_existing");
    expect(action.risk_hints.side_effect_level).toBe("destructive");
    expect(action.facets.function).toMatchObject({
      integration: "notes",
      operation: "delete_note",
      object_type: "workspace_note",
      trusted_compensator: "notes.restore_note",
      payload_keys: ["note_id"],
    });
  });

  it("should normalize owned function note update with restore compensator", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        tool_registration: {
          tool_name: "notes_update",
          tool_kind: "function",
        },
        raw_call: {
          integration: "notes",
          operation: "update_note",
          note_id: "note_existing",
          title: "Updated launch notes",
          body: "Refine the note scope.",
        },
      }),
      "sess_test",
    );

    expect(action.operation.domain).toBe("function");
    expect(action.operation.name).toBe("notes.update_note");
    expect(action.target.primary.locator).toBe("notes://workspace_note/note_existing");
    expect(action.target.primary.label).toBe("Note note_existing");
    expect(action.facets.function).toMatchObject({
      integration: "notes",
      operation: "update_note",
      object_type: "workspace_note",
      trusted_compensator: "notes.restore_note",
      payload_keys: ["note_id", "title", "body"],
    });
  });

  it("should reject note update attempts without mutable fields", () => {
    expect(() =>
      normalizeActionAttempt(
        makeAttempt({
          tool_registration: {
            tool_name: "notes_update",
            tool_kind: "function",
          },
          raw_call: {
            integration: "notes",
            operation: "update_note",
            note_id: "note_existing",
          },
        }),
        "sess_test",
      ),
    ).toThrow("Note update requires at least one mutable field.");
  });

  it("should normalize owned function note restore with restore compensator", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        tool_registration: {
          tool_name: "notes_restore",
          tool_kind: "function",
        },
        raw_call: {
          integration: "notes",
          operation: "restore_note",
          note_id: "note_existing",
          title: "Restored launch notes",
          body: "Return the original note.",
          status: "archived",
        },
      }),
      "sess_test",
    );

    expect(action.operation.domain).toBe("function");
    expect(action.operation.name).toBe("notes.restore_note");
    expect(action.target.primary.locator).toBe("notes://workspace_note/note_existing");
    expect(action.target.primary.label).toBe("Note note_existing");
    expect(action.input.raw).toMatchObject({
      integration: "notes",
      operation: "restore_note",
      note_id: "note_existing",
      title: "Restored launch notes",
      body: "Return the original note.",
      status: "archived",
    });
    expect(action.facets.function).toMatchObject({
      integration: "notes",
      operation: "restore_note",
      object_type: "workspace_note",
      trusted_compensator: "notes.restore_note",
      payload_keys: ["note_id", "title", "body", "status"],
    });
  });

  it("should reject note restore attempts with invalid status", () => {
    expect(() =>
      normalizeActionAttempt(
        makeAttempt({
          tool_registration: {
            tool_name: "notes_restore",
            tool_kind: "function",
          },
          raw_call: {
            integration: "notes",
            operation: "restore_note",
            note_id: "note_existing",
            title: "Restore me",
            body: "Body",
            status: "purged",
          },
        }),
        "sess_test",
      ),
    ).toThrow("Note restore status must be either active, archived, or deleted.");
  });

  it("should reject note archive attempts without note_id", () => {
    expect(() =>
      normalizeActionAttempt(
        makeAttempt({
          tool_registration: {
            tool_name: "notes_archive",
            tool_kind: "function",
          },
          raw_call: {
            integration: "notes",
            operation: "archive_note",
          },
        }),
        "sess_test",
      ),
    ).toThrow("Note archive requires a non-empty note_id.");
  });

  it("should normalize brokered ticket creation with deterministic locator", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        environment_context: {
          workspace_roots: ["/workspace/project"],
          cwd: "/workspace/project",
          credential_mode: "brokered",
        },
        tool_registration: {
          tool_name: "tickets_create",
          tool_kind: "function",
        },
        raw_call: {
          integration: "tickets",
          operation: "create_ticket",
          title: "Launch blocker",
          body: "Credentialed adapters must use brokered auth.",
        },
      }),
      "sess_test",
    );

    expect(action.operation.domain).toBe("function");
    expect(action.operation.name).toBe("tickets.create_ticket");
    expect(action.execution_path.credential_mode).toBe("brokered");
    expect(action.target.primary.locator).toContain("tickets://issue/ticket_");
    expect(action.target.primary.label).toBe("Launch blocker");
    expect(action.input.raw).toMatchObject({
      integration: "tickets",
      operation: "create_ticket",
      ticket_id: expect.stringContaining("ticket_act_"),
      title: "Launch blocker",
      body: "Credentialed adapters must use brokered auth.",
    });
    expect(action.facets.function).toMatchObject({
      integration: "tickets",
      operation: "create_ticket",
      object_type: "issue_ticket",
      trusted_compensator: "tickets.delete_ticket",
      payload_keys: ["title", "body", "ticket_id"],
    });
  });

  it("should normalize brokered ticket update with restore compensator", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        environment_context: {
          workspace_roots: ["/workspace/project"],
          cwd: "/workspace/project",
          credential_mode: "brokered",
        },
        tool_registration: {
          tool_name: "tickets_update",
          tool_kind: "function",
        },
        raw_call: {
          integration: "tickets",
          operation: "update_ticket",
          ticket_id: "ticket_existing",
          title: "Updated blocker",
        },
      }),
      "sess_test",
    );

    expect(action.operation.domain).toBe("function");
    expect(action.operation.name).toBe("tickets.update_ticket");
    expect(action.execution_path.credential_mode).toBe("brokered");
    expect(action.target.primary.locator).toBe("tickets://issue/ticket_existing");
    expect(action.target.primary.label).toBe("Ticket ticket_existing");
    expect(action.input.raw).toMatchObject({
      integration: "tickets",
      operation: "update_ticket",
      ticket_id: "ticket_existing",
      title: "Updated blocker",
    });
    expect(action.facets.function).toMatchObject({
      integration: "tickets",
      operation: "update_ticket",
      object_type: "issue_ticket",
      trusted_compensator: "tickets.restore_ticket",
      payload_keys: ["ticket_id", "title"],
    });
  });

  it("should reject ticket update attempts without mutable fields", () => {
    expect(() =>
      normalizeActionAttempt(
        makeAttempt({
          environment_context: {
            workspace_roots: ["/workspace/project"],
            cwd: "/workspace/project",
            credential_mode: "brokered",
          },
          tool_registration: {
            tool_name: "tickets_update",
            tool_kind: "function",
          },
          raw_call: {
            integration: "tickets",
            operation: "update_ticket",
            ticket_id: "ticket_existing",
          },
        }),
        "sess_test",
      ),
    ).toThrow("Ticket update requires at least one mutable field.");
  });

  it("should normalize brokered ticket delete with restore compensator", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        environment_context: {
          workspace_roots: ["/workspace/project"],
          cwd: "/workspace/project",
          credential_mode: "brokered",
        },
        tool_registration: {
          tool_name: "tickets_delete",
          tool_kind: "function",
        },
        raw_call: {
          integration: "tickets",
          operation: "delete_ticket",
          ticket_id: "ticket_existing",
        },
      }),
      "sess_test",
    );

    expect(action.operation.name).toBe("tickets.delete_ticket");
    expect(action.target.primary.locator).toBe("tickets://issue/ticket_existing");
    expect(action.risk_hints.side_effect_level).toBe("destructive");
    expect(action.facets.function).toMatchObject({
      integration: "tickets",
      operation: "delete_ticket",
      trusted_compensator: "tickets.restore_ticket",
      payload_keys: ["ticket_id"],
    });
  });

  it("should normalize brokered ticket restore with full state payload", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        environment_context: {
          workspace_roots: ["/workspace/project"],
          cwd: "/workspace/project",
          credential_mode: "brokered",
        },
        tool_registration: {
          tool_name: "tickets_restore",
          tool_kind: "function",
        },
        raw_call: {
          integration: "tickets",
          operation: "restore_ticket",
          ticket_id: "ticket_existing",
          title: "Restored blocker",
          body: "Restore the external ticket exactly.",
          status: "closed",
          labels: ["priority/high", "priority/high"],
          assigned_users: ["user_123", "user_123"],
        },
      }),
      "sess_test",
    );

    expect(action.operation.name).toBe("tickets.restore_ticket");
    expect(action.target.primary.locator).toBe("tickets://issue/ticket_existing");
    expect(action.input.raw).toEqual({
      integration: "tickets",
      operation: "restore_ticket",
      ticket_id: "ticket_existing",
      title: "Restored blocker",
      body: "Restore the external ticket exactly.",
      status: "closed",
      labels: ["priority/high"],
      assigned_users: ["user_123"],
    });
    expect(action.facets.function).toMatchObject({
      integration: "tickets",
      operation: "restore_ticket",
      trusted_compensator: "tickets.restore_ticket",
      payload_keys: ["ticket_id", "title", "body", "status", "labels", "assigned_users"],
    });
  });

  it("should reject ticket restore attempts without a valid target status", () => {
    expect(() =>
      normalizeActionAttempt(
        makeAttempt({
          environment_context: {
            workspace_roots: ["/workspace/project"],
            cwd: "/workspace/project",
            credential_mode: "brokered",
          },
          tool_registration: {
            tool_name: "tickets_restore",
            tool_kind: "function",
          },
          raw_call: {
            integration: "tickets",
            operation: "restore_ticket",
            ticket_id: "ticket_existing",
            title: "Restored blocker",
            body: "Restore the external ticket exactly.",
            status: "deleted",
            labels: [],
            assigned_users: [],
          },
        }),
        "sess_test",
      ),
    ).toThrow("Ticket restore status must be either active or closed.");
  });

  it("should reject ticket restore attempts with malformed labels", () => {
    expect(() =>
      normalizeActionAttempt(
        makeAttempt({
          environment_context: {
            workspace_roots: ["/workspace/project"],
            cwd: "/workspace/project",
            credential_mode: "brokered",
          },
          tool_registration: {
            tool_name: "tickets_restore",
            tool_kind: "function",
          },
          raw_call: {
            integration: "tickets",
            operation: "restore_ticket",
            ticket_id: "ticket_existing",
            title: "Restored blocker",
            body: "Restore the external ticket exactly.",
            status: "active",
            labels: [""],
            assigned_users: [],
          },
        }),
        "sess_test",
      ),
    ).toThrow("Ticket restore labels must be an array of non-empty strings.");
  });

  it("should normalize brokered ticket close with reopen compensator", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        environment_context: {
          workspace_roots: ["/workspace/project"],
          cwd: "/workspace/project",
          credential_mode: "brokered",
        },
        tool_registration: {
          tool_name: "tickets_close",
          tool_kind: "function",
        },
        raw_call: {
          integration: "tickets",
          operation: "close_ticket",
          ticket_id: "ticket_existing",
        },
      }),
      "sess_test",
    );

    expect(action.operation.domain).toBe("function");
    expect(action.operation.name).toBe("tickets.close_ticket");
    expect(action.execution_path.credential_mode).toBe("brokered");
    expect(action.target.primary.locator).toBe("tickets://issue/ticket_existing");
    expect(action.target.primary.label).toBe("Ticket ticket_existing");
    expect(action.input.raw).toMatchObject({
      integration: "tickets",
      operation: "close_ticket",
      ticket_id: "ticket_existing",
    });
    expect(action.facets.function).toMatchObject({
      integration: "tickets",
      operation: "close_ticket",
      object_type: "issue_ticket",
      trusted_compensator: "tickets.reopen_ticket",
      payload_keys: ["ticket_id"],
    });
  });

  it("should reject ticket close attempts without ticket_id", () => {
    expect(() =>
      normalizeActionAttempt(
        makeAttempt({
          environment_context: {
            workspace_roots: ["/workspace/project"],
            cwd: "/workspace/project",
            credential_mode: "brokered",
          },
          tool_registration: {
            tool_name: "tickets_close",
            tool_kind: "function",
          },
          raw_call: {
            integration: "tickets",
            operation: "close_ticket",
          },
        }),
        "sess_test",
      ),
    ).toThrow("Ticket close requires a non-empty ticket_id.");
  });

  it("should normalize brokered ticket reopen with close compensator", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        environment_context: {
          workspace_roots: ["/workspace/project"],
          cwd: "/workspace/project",
          credential_mode: "brokered",
        },
        tool_registration: {
          tool_name: "tickets_reopen",
          tool_kind: "function",
        },
        raw_call: {
          integration: "tickets",
          operation: "reopen_ticket",
          ticket_id: "ticket_existing",
        },
      }),
      "sess_test",
    );

    expect(action.operation.domain).toBe("function");
    expect(action.operation.name).toBe("tickets.reopen_ticket");
    expect(action.execution_path.credential_mode).toBe("brokered");
    expect(action.target.primary.locator).toBe("tickets://issue/ticket_existing");
    expect(action.target.primary.label).toBe("Ticket ticket_existing");
    expect(action.input.raw).toMatchObject({
      integration: "tickets",
      operation: "reopen_ticket",
      ticket_id: "ticket_existing",
    });
    expect(action.facets.function).toMatchObject({
      integration: "tickets",
      operation: "reopen_ticket",
      object_type: "issue_ticket",
      trusted_compensator: "tickets.close_ticket",
      payload_keys: ["ticket_id"],
    });
  });

  it("should reject ticket reopen attempts without ticket_id", () => {
    expect(() =>
      normalizeActionAttempt(
        makeAttempt({
          environment_context: {
            workspace_roots: ["/workspace/project"],
            cwd: "/workspace/project",
            credential_mode: "brokered",
          },
          tool_registration: {
            tool_name: "tickets_reopen",
            tool_kind: "function",
          },
          raw_call: {
            integration: "tickets",
            operation: "reopen_ticket",
          },
        }),
        "sess_test",
      ),
    ).toThrow("Ticket reopen requires a non-empty ticket_id.");
  });

  it("should normalize brokered ticket labeling with removable target locator", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        environment_context: {
          workspace_roots: ["/workspace/project"],
          cwd: "/workspace/project",
          credential_mode: "brokered",
        },
        tool_registration: {
          tool_name: "tickets_add_label",
          tool_kind: "function",
        },
        raw_call: {
          integration: "tickets",
          operation: "add_label",
          ticket_id: "ticket_existing",
          label: "priority/high",
        },
      }),
      "sess_test",
    );

    expect(action.operation.domain).toBe("function");
    expect(action.operation.name).toBe("tickets.add_label");
    expect(action.target.primary.locator).toBe("tickets://issue/ticket_existing/labels/priority%2Fhigh");
    expect(action.target.primary.label).toBe("Ticket ticket_existing label priority/high");
    expect(action.facets.function).toMatchObject({
      integration: "tickets",
      operation: "add_label",
      object_type: "issue_ticket",
      trusted_compensator: "tickets.remove_label",
      payload_keys: ["ticket_id", "label"],
    });
  });

  it("should reject ticket labeling attempts without label", () => {
    expect(() =>
      normalizeActionAttempt(
        makeAttempt({
          environment_context: {
            workspace_roots: ["/workspace/project"],
            cwd: "/workspace/project",
            credential_mode: "brokered",
          },
          tool_registration: {
            tool_name: "tickets_add_label",
            tool_kind: "function",
          },
          raw_call: {
            integration: "tickets",
            operation: "add_label",
            ticket_id: "ticket_existing",
          },
        }),
        "sess_test",
      ),
    ).toThrow("Ticket labeling requires a non-empty label.");
  });

  it("should normalize brokered ticket label removal with add compensator", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        environment_context: {
          workspace_roots: ["/workspace/project"],
          cwd: "/workspace/project",
          credential_mode: "brokered",
        },
        tool_registration: {
          tool_name: "tickets_remove_label",
          tool_kind: "function",
        },
        raw_call: {
          integration: "tickets",
          operation: "remove_label",
          ticket_id: "ticket_existing",
          label: "priority/high",
        },
      }),
      "sess_test",
    );

    expect(action.operation.domain).toBe("function");
    expect(action.operation.name).toBe("tickets.remove_label");
    expect(action.target.primary.locator).toBe("tickets://issue/ticket_existing/labels/priority%2Fhigh");
    expect(action.target.primary.label).toBe("Ticket ticket_existing label priority/high");
    expect(action.facets.function).toMatchObject({
      integration: "tickets",
      operation: "remove_label",
      object_type: "issue_ticket",
      trusted_compensator: "tickets.add_label",
      payload_keys: ["ticket_id", "label"],
    });
  });

  it("should reject ticket label removal attempts without label", () => {
    expect(() =>
      normalizeActionAttempt(
        makeAttempt({
          environment_context: {
            workspace_roots: ["/workspace/project"],
            cwd: "/workspace/project",
            credential_mode: "brokered",
          },
          tool_registration: {
            tool_name: "tickets_remove_label",
            tool_kind: "function",
          },
          raw_call: {
            integration: "tickets",
            operation: "remove_label",
            ticket_id: "ticket_existing",
          },
        }),
        "sess_test",
      ),
    ).toThrow("Ticket label removal requires a non-empty label.");
  });

  it("should normalize brokered ticket assignment with removable assignee locator", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        environment_context: {
          workspace_roots: ["/workspace/project"],
          cwd: "/workspace/project",
          credential_mode: "brokered",
        },
        tool_registration: {
          tool_name: "tickets_assign_user",
          tool_kind: "function",
        },
        raw_call: {
          integration: "tickets",
          operation: "assign_user",
          ticket_id: "ticket_existing",
          user_id: "user_123",
        },
      }),
      "sess_test",
    );

    expect(action.operation.domain).toBe("function");
    expect(action.operation.name).toBe("tickets.assign_user");
    expect(action.target.primary.locator).toBe("tickets://issue/ticket_existing/assignees/user_123");
    expect(action.target.primary.label).toBe("Ticket ticket_existing assignee user_123");
    expect(action.facets.function).toMatchObject({
      integration: "tickets",
      operation: "assign_user",
      object_type: "issue_ticket",
      trusted_compensator: "tickets.unassign_user",
      payload_keys: ["ticket_id", "user_id"],
    });
  });

  it("should reject ticket assignment attempts without user_id", () => {
    expect(() =>
      normalizeActionAttempt(
        makeAttempt({
          environment_context: {
            workspace_roots: ["/workspace/project"],
            cwd: "/workspace/project",
            credential_mode: "brokered",
          },
          tool_registration: {
            tool_name: "tickets_assign_user",
            tool_kind: "function",
          },
          raw_call: {
            integration: "tickets",
            operation: "assign_user",
            ticket_id: "ticket_existing",
          },
        }),
        "sess_test",
      ),
    ).toThrow("Ticket assignment requires a non-empty user_id.");
  });

  it("should normalize brokered ticket unassignment with assign compensator", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        environment_context: {
          workspace_roots: ["/workspace/project"],
          cwd: "/workspace/project",
          credential_mode: "brokered",
        },
        tool_registration: {
          tool_name: "tickets_unassign_user",
          tool_kind: "function",
        },
        raw_call: {
          integration: "tickets",
          operation: "unassign_user",
          ticket_id: "ticket_existing",
          user_id: "user_123",
        },
      }),
      "sess_test",
    );

    expect(action.operation.domain).toBe("function");
    expect(action.operation.name).toBe("tickets.unassign_user");
    expect(action.target.primary.locator).toBe("tickets://issue/ticket_existing/assignees/user_123");
    expect(action.target.primary.label).toBe("Ticket ticket_existing assignee user_123");
    expect(action.facets.function).toMatchObject({
      integration: "tickets",
      operation: "unassign_user",
      object_type: "issue_ticket",
      trusted_compensator: "tickets.assign_user",
      payload_keys: ["ticket_id", "user_id"],
    });
  });

  it("should reject ticket unassignment attempts without user_id", () => {
    expect(() =>
      normalizeActionAttempt(
        makeAttempt({
          environment_context: {
            workspace_roots: ["/workspace/project"],
            cwd: "/workspace/project",
            credential_mode: "brokered",
          },
          tool_registration: {
            tool_name: "tickets_unassign_user",
            tool_kind: "function",
          },
          raw_call: {
            integration: "tickets",
            operation: "unassign_user",
            ticket_id: "ticket_existing",
          },
        }),
        "sess_test",
      ),
    ).toThrow("Ticket unassignment requires a non-empty user_id.");
  });

  it("normalizes an MCP tool call into a governed mcp_proxy action", () => {
    const action = normalizeActionAttempt(
      makeAttempt({
        tool_registration: {
          tool_name: "mcp_call_tool",
          tool_kind: "mcp",
        },
        environment_context: {
          workspace_roots: ["/workspace/project"],
          cwd: "/workspace/project",
          credential_mode: "none",
        },
        raw_call: {
          server_id: "notes_server",
          tool_name: "echo_note",
          arguments: {
            note: "launch blocker",
          },
          annotations: {
            readOnlyHint: true,
          },
          input_schema: {
            type: "object",
            properties: {
              note: {
                type: "string",
              },
            },
            required: ["note"],
          },
        },
      }),
      "sess_test",
    );

    expect(action.operation.domain).toBe("mcp");
    expect(action.execution_path.surface).toBe("mcp_proxy");
    expect(action.target.primary.locator).toBe("mcp://server/notes_server/tools/echo_note");
    expect(action.facets.mcp).toMatchObject({
      server_id: "notes_server",
      tool_name: "echo_note",
      tool_locator: "mcp://server/notes_server/tools/echo_note",
      argument_keys: ["note"],
      declared_read_only_hint: true,
    });
    expect(action.normalization.mapper).toBe("mcp/v1");
    expect(action.normalization.warnings).toContain("mcp_read_only_hint_untrusted");
  });

  it("rejects MCP tool calls without a server_id", () => {
    expect(() =>
      normalizeActionAttempt(
        makeAttempt({
          tool_registration: {
            tool_name: "mcp_call_tool",
            tool_kind: "mcp",
          },
          raw_call: {
            tool_name: "echo_note",
            arguments: {
              note: "launch blocker",
            },
          },
        }),
        "sess_test",
      ),
    ).toThrow("MCP tool execution requires a non-empty server_id.");
  });

  it("rejects MCP tool calls with non-object arguments", () => {
    expect(() =>
      normalizeActionAttempt(
        makeAttempt({
          tool_registration: {
            tool_name: "mcp_call_tool",
            tool_kind: "mcp",
          },
          raw_call: {
            server_id: "notes_server",
            tool_name: "echo_note",
            arguments: ["not", "an", "object"],
          },
        }),
        "sess_test",
      ),
    ).toThrow("MCP tool execution requires arguments to be a JSON object.");
  });

  it("fails closed for governed browser/computer attempts", () => {
    expect(() =>
      normalizeActionAttempt(
        makeAttempt({
          tool_registration: {
            tool_name: "browser_click",
            tool_kind: "browser",
          },
        }),
        "sess_test",
      ),
    ).toThrow(PreconditionError);
    expect(() =>
      normalizeActionAttempt(
        makeAttempt({
          tool_registration: {
            tool_name: "browser_click",
            tool_kind: "browser",
          },
        }),
        "sess_test",
      ),
    ).toThrow("Governed browser/computer execution is not part of the supported runtime surface.");
  });
});
