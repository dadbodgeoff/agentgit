import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { RunJournal } from "@agentgit/run-journal";

async function waitForOkResponse(page: Page, pathFragment: string) {
  await page.waitForResponse(
    (response) => response.url().includes(pathFragment) && response.ok(),
    { timeout: 45_000 },
  );
}

async function signInAs(
  page: Page,
  params: {
    callbackUrl: string;
    email: string;
    name: string;
    role: "member" | "admin" | "owner";
  },
) {
  await page.goto(`/sign-in?callbackUrl=${encodeURIComponent(params.callbackUrl)}`);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Display name").fill(params.name);
  await page.getByLabel("Email").fill(params.email);
  await page.getByLabel("Workspace role").selectOption(params.role);
  await Promise.all([
    page.waitForURL(
      (url) =>
        url.pathname === params.callbackUrl ||
        url.pathname === params.callbackUrl.replace(/\/$/, "") ||
        url.pathname.startsWith("/app"),
      { timeout: 20_000 },
    ),
    page.getByRole("button", { name: "Continue with development access" }).click(),
  ]);
}

function parseRepositoryIdentity(remoteUrl: string): { owner: string; name: string } {
  const sshMatch = remoteUrl.trim().match(/^[^@]+@[^:]+:(.+)$/);
  const target = sshMatch ? sshMatch[1] : remoteUrl.trim();
  const pathname = target.startsWith("http://") || target.startsWith("https://") ? new URL(target).pathname : target;
  const segments = pathname
    .replace(/^\/+/, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter((segment) => segment.length > 0);

  if (segments.length < 2) {
    throw new Error(`Could not derive repository identity from remote: ${remoteUrl}`);
  }

  return {
    owner: segments[segments.length - 2]!,
    name: segments[segments.length - 1]!,
  };
}

function getWorkspaceRepositoryPolicyPath(): string {
  const workspaceRoot = path.resolve(process.cwd(), "../..");
  const remoteUrl = execFileSync("git", ["config", "--get", "remote.origin.url"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  }).trim();
  const repository = parseRepositoryIdentity(remoteUrl);
  return `/app/repos/${repository.owner}/${repository.name}/policy`;
}

function getWorkspaceRepositoryIdentity(): { owner: string; name: string; workspaceRoot: string } {
  const workspaceRoot = path.resolve(process.cwd(), "../..");
  const remoteUrl = execFileSync("git", ["config", "--get", "remote.origin.url"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  }).trim();
  const repository = parseRepositoryIdentity(remoteUrl);

  return {
    ...repository,
    workspaceRoot,
  };
}

function seedRepositorySnapshot(): { owner: string; name: string; snapshotId: string; runId: string; actionId: string } {
  const { owner, name, workspaceRoot } = getWorkspaceRepositoryIdentity();
  const snapshotId = `snap_smoke_${Date.now()}`;
  const runId = `run_smoke_${Date.now()}`;
  const actionId = `act_smoke_${Date.now()}`;
  const targetPath = path.join(workspaceRoot, "README.md");
  const journal = new RunJournal({
    dbPath: path.join(workspaceRoot, ".agentgit", "state", "authority.db"),
  });

  try {
    journal.registerRunLifecycle({
      run_id: runId,
      session_id: "sess_playwright_smoke",
      workflow_name: "playwright-snapshot-smoke",
      agent_framework: "cloud",
      agent_name: "Codex",
      workspace_roots: [workspaceRoot],
      client_metadata: {},
      budget_config: {
        max_mutating_actions: null,
        max_destructive_actions: null,
      },
      created_at: "2026-04-07T15:00:00Z",
    });

    journal.appendRunEvent(runId, {
      event_type: "policy.evaluated",
      occurred_at: "2026-04-07T15:00:01Z",
      recorded_at: "2026-04-07T15:00:01Z",
      payload: {
        action_id: actionId,
        decision: "allow",
        reasons: ["Smoke policy seed"],
        snapshot_required: true,
        approval_required: false,
        matched_rules: ["repo.default"],
      },
    });

    journal.appendRunEvent(runId, {
      event_type: "action.normalized",
      occurred_at: "2026-04-07T15:00:02Z",
      recorded_at: "2026-04-07T15:00:02Z",
      payload: {
        action_id: actionId,
        target_locator: targetPath,
        action: {
          operation: {
            domain: "filesystem",
            kind: "update_file",
            display_name: "Update README.md",
          },
          target: {
            primary: {
              locator: targetPath,
            },
          },
        },
      },
    });

    journal.appendRunEvent(runId, {
      event_type: "execution.completed",
      occurred_at: "2026-04-07T15:00:03Z",
      recorded_at: "2026-04-07T15:00:03Z",
      payload: {
        action_id: actionId,
      },
    });

    journal.appendRunEvent(runId, {
      event_type: "snapshot.created",
      occurred_at: "2026-04-07T15:00:04Z",
      recorded_at: "2026-04-07T15:00:04Z",
      payload: {
        action_id: actionId,
        snapshot_id: snapshotId,
        snapshot_class: "metadata_only",
        fidelity: "metadata_only",
      },
    });

    journal.appendRunEvent(runId, {
      event_type: "recovery.executed",
      occurred_at: "2026-04-07T15:00:05Z",
      recorded_at: "2026-04-07T15:00:05Z",
      payload: {
        action_id: actionId,
        snapshot_id: snapshotId,
      },
    });
  } finally {
    journal.close();
  }

  const manifestPath = path.join(
    workspaceRoot,
    ".agentgit",
    "state",
    "snapshots",
    "metadata",
    `${snapshotId}.json`,
  );
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        snapshot_id: snapshotId,
        action_id: actionId,
        run_id: runId,
        target_path: targetPath,
        workspace_root: workspaceRoot,
        existed_before: true,
        entry_kind: "file",
        snapshot_class: "metadata_only",
        fidelity: "metadata_only",
        created_at: "2026-04-07T15:00:02Z",
        action_display_name: "Update README.md",
        operation_domain: "filesystem",
        operation_kind: "update_file",
      },
      null,
      2,
    ),
    "utf8",
  );

  return { owner, name, snapshotId, runId, actionId };
}

test("admin smoke covers approvals, team settings, policy, and calibration", async ({ page }) => {
  test.setTimeout(120_000);
  const snapshotSeed = seedRepositorySnapshot();

  await signInAs(page, {
    callbackUrl: "/app/approvals",
    email: "admin-smoke@agentgit.dev",
    name: "Admin Smoke",
    role: "admin",
  });

  await expect(page.getByRole("heading", { name: "Approval queue" })).toBeVisible();

  await page.goto("/app/settings/team");
  await expect(page.getByRole("heading", { name: "Team" })).toBeVisible();
  await page.getByRole("button", { name: "Add invite" }).click();
  await page.getByLabel("Name").last().fill("Riley Smoke");
  await page.getByLabel("Email").last().fill("riley-smoke@agentgit.dev");
  await page.getByRole("button", { name: "Save roster" }).click();
  await expect(page.getByText("Team saved")).toBeVisible();

  await page.goto("/app/settings/integrations");
  await expect(page.getByRole("heading", { name: "Integrations" })).toBeVisible();
  await expect(page.getByText("Connector sync")).toBeVisible();
  await page.getByRole("button", { name: "Generate bootstrap token" }).click();
  await expect(page.getByText("Bootstrap command")).toBeVisible();
  await expect(page.locator("main")).toContainText("agentgit-cloud-connector bootstrap");

  await page.goto(getWorkspaceRepositoryPolicyPath());
  await expect(page.getByRole("heading", { name: "Policy" })).toBeVisible();
  const policyDocument = page.getByLabel("Policy document");
  const currentDocument = await policyDocument.inputValue();
  const nextDocument = currentDocument.replace(
    /"policy_version":\s*"([^"]+)"/,
    '"policy_version": "2026-04-07-smoke"',
  );
  await policyDocument.fill(nextDocument);
  await page.getByRole("button", { name: "Save policy" }).click();
  await expect(page.getByText("Policy saved.")).toBeVisible();

  await page.goto("/app/calibration");
  await expect(page.getByRole("heading", { name: "Calibration" })).toBeVisible();
  await expect(page.locator("main")).toContainText("Policy calibration dashboard");

  await page.goto("/app/activity");
  await waitForOkResponse(page, "/api/v1/activity");
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await expect(page.locator("main")).toContainText(snapshotSeed.runId, { timeout: 15_000 });

  await page.goto("/app/audit");
  await waitForOkResponse(page, "/api/v1/audit");
  await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible();
  await expect(page.locator("main")).toContainText("playwright-snapshot-smoke", { timeout: 15_000 });

  await page.goto(`/app/repos/${snapshotSeed.owner}/${snapshotSeed.name}/snapshots`);
  await waitForOkResponse(page, `/api/v1/repositories/${snapshotSeed.owner}/${snapshotSeed.name}/snapshots`);
  await expect(page.getByRole("heading", { name: "Snapshots" })).toBeVisible();
  await expect(page.getByText(snapshotSeed.snapshotId)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("main")).toContainText("Update README.md", { timeout: 20_000 });
});

test("owner smoke covers onboarding and billing", async ({ page }) => {
  test.setTimeout(60_000);
  await signInAs(page, {
    callbackUrl: "/app/onboarding",
    email: "owner-smoke@agentgit.dev",
    name: "Owner Smoke",
    role: "owner",
  });

  await expect(page.getByRole("heading", { name: "Onboarding" })).toBeVisible();
  await waitForOkResponse(page, "/api/v1/onboarding");
  await expect(page.getByRole("heading", { name: "Create the workspace" })).toBeVisible({ timeout: 15_000 });

  await page.goto("/app/settings/billing");
  await expect(page.getByRole("heading", { name: "Billing" })).toBeVisible();
  await waitForOkResponse(page, "/api/v1/settings/billing");
  await expect(page.getByRole("heading", { name: "Plan and billing cycle" })).toBeVisible({ timeout: 15_000 });
});

test("member smoke verifies RBAC denial on admin settings", async ({ page }) => {
  test.setTimeout(60_000);
  await signInAs(page, {
    callbackUrl: "/app",
    email: "member-smoke@agentgit.dev",
    name: "Member Smoke",
    role: "member",
  });

  await page.goto("/app/settings/team");
  await expect(page.getByText("Access denied")).toBeVisible();
  await expect(page.getByText("You do not have permission to access workspace settings.")).toBeVisible();
});
