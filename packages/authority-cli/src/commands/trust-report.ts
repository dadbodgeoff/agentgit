import { AuthorityClient } from "@agentgit/authority-sdk";

import { inputError } from "../cli-contract.js";
import type { CliResolvedConfig } from "../cli-config.js";
import { parseVisibilityScopeArg, shiftCommandValue } from "../parsers/common.js";
import { buildDoctorResult } from "./doctor.js";
import type { TimelineResult, TrustReportResult } from "./lifecycle-types.js";
import { summarizeTimelineTrust } from "./lifecycle-types.js";

export function parseTrustReportOptions(args: string[]): {
  runId?: string;
  visibilityScope: TimelineResult["visibility_scope"];
} {
  let runId: string | undefined;
  let visibilityScope: TimelineResult["visibility_scope"] = "user";
  const rest = [...args];

  while (rest.length > 0) {
    const current = rest.shift()!;
    switch (current) {
      case "--run-id":
        runId = shiftCommandValue(rest, "--run-id");
        break;
      case "--visibility": {
        const parsed = shiftCommandValue(rest, "--visibility");
        const scope = parseVisibilityScopeArg(parsed);
        if (!scope) {
          throw inputError("--visibility expects one of user, model, internal, or sensitive_internal.", {
            flag: "--visibility",
            value: parsed,
          });
        }
        visibilityScope = scope;
        break;
      }
      default:
        throw inputError(`Unknown trust-report flag: ${current}`, {
          flag: current,
        });
    }
  }

  return {
    runId,
    visibilityScope,
  };
}

export async function buildTrustReport(
  client: AuthorityClient,
  resolvedConfig: CliResolvedConfig,
  options: {
    runId?: string;
    visibilityScope: TimelineResult["visibility_scope"];
  },
  cliVersion: string,
): Promise<TrustReportResult> {
  const [doctor, profilesResult, trustDecisionsResult, bindingsResult, timeline] = await Promise.all([
    buildDoctorResult(client, resolvedConfig, cliVersion),
    client.listMcpServerProfiles(),
    client.listMcpServerTrustDecisions(),
    client.listMcpServerCredentialBindings(),
    options.runId ? client.queryTimeline(options.runId, options.visibilityScope) : Promise.resolve(null),
  ]);

  const activeTrustDecisions = new Set(
    trustDecisionsResult.trust_decisions
      .filter((decision) => decision.decision !== "deny")
      .map((decision) => decision.trust_decision_id),
  );
  const activeCredentialBindings = new Set(
    bindingsResult.credential_bindings
      .filter((binding) => binding.status === "active" || binding.status === "degraded")
      .map((binding) => binding.credential_binding_id),
  );

  let activeProfileCount = 0;
  let pendingProfileCount = 0;
  let quarantinedProfileCount = 0;
  let revokedProfileCount = 0;
  let profilesWithoutActiveTrustDecision = 0;
  let profilesRequiringCredentials = 0;
  let profilesMissingCredentials = 0;

  for (const profile of profilesResult.profiles) {
    if (profile.status === "active") {
      activeProfileCount += 1;
    } else if (profile.status === "pending_approval") {
      pendingProfileCount += 1;
    } else if (profile.status === "quarantined") {
      quarantinedProfileCount += 1;
    } else if (profile.status === "revoked") {
      revokedProfileCount += 1;
    }

    if (!profile.active_trust_decision_id || !activeTrustDecisions.has(profile.active_trust_decision_id)) {
      profilesWithoutActiveTrustDecision += 1;
    }

    if (profile.auth_descriptor.mode !== "none") {
      profilesRequiringCredentials += 1;
      if (
        !profile.active_credential_binding_id ||
        !activeCredentialBindings.has(profile.active_credential_binding_id)
      ) {
        profilesMissingCredentials += 1;
      }
    }
  }

  const recommendations = [...doctor.recommendations];
  if (profilesWithoutActiveTrustDecision > 0) {
    recommendations.push(
      `Record non-deny trust decisions for ${profilesWithoutActiveTrustDecision} MCP profile(s) before production activation.`,
    );
  }
  if (profilesMissingCredentials > 0) {
    recommendations.push(
      `Bind active credentials for ${profilesMissingCredentials} MCP profile(s) that declare non-none auth modes.`,
    );
  }
  if (timeline) {
    const summary = summarizeTimelineTrust(timeline.steps);
    if (summary.nonGoverned > 0) {
      recommendations.push(
        `Run ${timeline.run_summary.run_id} includes ${summary.nonGoverned} non-governed timeline step(s); inspect imported/observed provenance before using it as control evidence.`,
      );
    }
  }

  return {
    generated_at: new Date().toISOString(),
    workspace_root: resolvedConfig.workspace_root.value,
    daemon: doctor.daemon,
    security_posture_status: doctor.security_posture_status,
    mcp: {
      profile_count: profilesResult.profiles.length,
      active_profile_count: activeProfileCount,
      pending_profile_count: pendingProfileCount,
      quarantined_profile_count: quarantinedProfileCount,
      revoked_profile_count: revokedProfileCount,
      profiles_without_active_trust_decision: profilesWithoutActiveTrustDecision,
      profiles_requiring_credentials: profilesRequiringCredentials,
      profiles_missing_credentials: profilesMissingCredentials,
      active_non_deny_trust_decision_count: activeTrustDecisions.size,
      active_credential_binding_count: activeCredentialBindings.size,
    },
    timeline_trust: timeline
      ? {
          run_id: timeline.run_summary.run_id,
          visibility_scope: timeline.visibility_scope,
          step_count: timeline.steps.length,
          trust_summary: summarizeTimelineTrust(timeline.steps),
        }
      : null,
    recommendations,
  };
}
