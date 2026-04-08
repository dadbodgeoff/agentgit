import { getCloudRuntimeSummary } from "@/lib/release/runtime-config";

function main() {
  const summary = getCloudRuntimeSummary();
  const hasFailures = summary.checks.some((check) => check.level === "fail");

  console.log(
    JSON.stringify(
      {
        mode: summary.mode,
        status: summary.status,
        authBaseUrl: summary.authBaseUrl,
        agentgitRoot: summary.agentgitRoot,
        workspaceRoots: summary.workspaceRoots,
        checks: summary.checks,
      },
      null,
      2,
    ),
  );

  if (hasFailures) {
    process.exitCode = 1;
  }
}

main();
