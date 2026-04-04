import type { AuthorityClient } from "@agentgit/authority-sdk";

import type { CliResolvedConfig } from "../cli-config.js";

export type HelloResult = Awaited<ReturnType<AuthorityClient["hello"]>>;
export type RegisterRunResult = Awaited<ReturnType<AuthorityClient["registerRun"]>>;
export type TimelineResult = Awaited<ReturnType<AuthorityClient["queryTimeline"]>>;

export interface VersionResult {
  cli_version: string;
  supported_api_version: string;
  json_contract_version: string;
  exit_code_registry_version: string;
  config_schema_version: string;
}

export interface ConfigShowResult {
  resolved: CliResolvedConfig;
}

export interface ProfileListResult {
  active_profile: string | null;
  profiles: Array<{
    name: string;
    source: "user" | "workspace" | "both";
    active: boolean;
  }>;
}

export interface DoctorCheck {
  code: string;
  status: "pass" | "warn" | "fail";
  summary: string;
  details?: Record<string, unknown>;
}

export interface DoctorResult {
  cli_version: string;
  config: {
    config_root: string;
    user_config_path: string;
    workspace_config_path: string;
    active_profile: string | null;
    workspace_root: string;
    socket_path: string;
  };
  daemon: {
    reachable: boolean;
    session_id: string | null;
    accepted_api_version: string | null;
    runtime_version: string | null;
    schema_pack_version: string | null;
  };
  security_posture_status: "healthy" | "degraded" | "unknown";
  checks: DoctorCheck[];
  recommendations: string[];
}

export interface InitCommandResult {
  mode: "production";
  profile_name: string;
  config_path: string;
  profile_created: boolean;
  profile_overwritten: boolean;
  readiness_passed: boolean;
  doctor: DoctorResult;
}

export interface SetupCommandResult {
  mode: "local";
  profile_name: string;
  config_path: string;
  profile_created: boolean;
  profile_overwritten: boolean;
  created_directories: string[];
  workspace_root: string;
  socket_path: string;
  daemon_start_command: string;
  doctor_command: string;
}

export interface TimelineTrustSummary {
  nonGoverned: number;
  imported: number;
  observed: number;
  unknown: number;
}

export interface TrustReportResult {
  generated_at: string;
  workspace_root: string;
  daemon: DoctorResult["daemon"];
  security_posture_status: DoctorResult["security_posture_status"];
  mcp: {
    profile_count: number;
    active_profile_count: number;
    pending_profile_count: number;
    quarantined_profile_count: number;
    revoked_profile_count: number;
    profiles_without_active_trust_decision: number;
    profiles_requiring_credentials: number;
    profiles_missing_credentials: number;
    active_non_deny_trust_decision_count: number;
    active_credential_binding_count: number;
  };
  timeline_trust: null | {
    run_id: string;
    visibility_scope: TimelineResult["visibility_scope"];
    step_count: number;
    trust_summary: TimelineTrustSummary;
  };
  recommendations: string[];
}

export interface CloudRoadmapResult {
  generated_at: string;
  launch_contract: "local-first-mvp";
  mvp_scope_exclusions: string[];
  phases: Array<{
    phase_id: string;
    title: string;
    status: "deferred";
    target_window: string;
    deliverables: string[];
    entry_criteria: string[];
  }>;
}

export function summarizeTimelineTrust(steps: TimelineResult["steps"]): TimelineTrustSummary {
  const summary: TimelineTrustSummary = {
    nonGoverned: 0,
    imported: 0,
    observed: 0,
    unknown: 0,
  };

  for (const step of steps) {
    if (step.provenance === "governed") {
      continue;
    }

    summary.nonGoverned += 1;

    if (step.provenance === "imported") {
      summary.imported += 1;
    } else if (step.provenance === "observed") {
      summary.observed += 1;
    } else if (step.provenance === "unknown") {
      summary.unknown += 1;
    }
  }

  return summary;
}
