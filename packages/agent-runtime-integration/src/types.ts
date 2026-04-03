import type { RecoveryTarget, RunCheckpointKind } from "@agentgit/schemas";

export type RuntimeId = "openclaw" | "generic-command";
export type InstallScope = "workspace";
export type IntegrationMethod = "launch_wrapper" | "openclaw_config_launch_wrapper" | "docker_contained_launch";
export type InstallStatus = "applied" | "removed" | "needs_repair";
export type AssuranceLevel = "observed" | "attached" | "contained" | "integrated";
export type SetupExperience = "recommended" | "advanced";
export type PolicyStrictness = "balanced" | "strict";
export type ContainmentBackend = "docker";
export type RuntimeExecutionMode = "host_attached" | "docker_contained";
export type GovernanceMode = "attached_live" | "contained_projection" | "native_integrated";
export type DefaultCheckpointPolicy = "never" | "risky_runs" | "always_before_run";
export type CheckpointIntent = "operator_requested" | "broad_risk_default" | "high_value_workspace";
export type GovernanceGuarantee =
  | "native_runtime_integration"
  | "known_plugin_surfaces_governed"
  | "known_shell_entrypoints_governed"
  | "real_workspace_protected"
  | "publish_path_governed"
  | "brokered_credentials_only"
  | "egress_policy_applied";
export type ContainerNetworkPolicy = "inherit" | "none";
export type ContainedEgressMode = "inherit" | "none" | "proxy_http_https" | "backend_enforced_allowlist";
export type ContainedEgressAssurance = "degraded" | "scoped" | "boundary_enforced";
export type ContainedCredentialMode = "none" | "direct_env" | "brokered_bindings";
export type RuntimeCredentialBindingKind = "env" | "file" | "header_template" | "runtime_ticket" | "tool_scoped_ref";

export type RuntimeCredentialBindingTarget =
  | {
      surface: "env";
      env_key: string;
    }
  | {
      surface: "file";
      relative_path: string;
    };

export interface RuntimeCredentialBindingDocument {
  binding_id: string;
  kind: RuntimeCredentialBindingKind;
  target: RuntimeCredentialBindingTarget;
  broker_source_ref: string;
  redacted_delivery_metadata: Record<string, unknown>;
  expires_at?: string;
  rotates: boolean;
}

export interface ContainedSecretEnvBinding {
  env_key: string;
  secret_id: string;
}

export interface ContainedSecretFileBinding {
  relative_path: string;
  secret_id: string;
}

export interface DockerCapabilitySnapshot {
  backend_kind: ContainmentBackend;
  capability_version: number;
  docker_available: boolean;
  docker_desktop_vm: boolean;
  rootless_docker: boolean;
  projection_enforced: boolean;
  read_only_rootfs_enabled: boolean;
  network_restricted: boolean;
  credential_brokering_enabled: boolean;
  egress_mode: ContainedEgressMode;
  egress_assurance: ContainedEgressAssurance;
  backend_enforced_allowlist_supported: boolean;
  raw_socket_egress_blocked: boolean;
  proxy_egress_allowlist_applied?: boolean;
  egress_allowlist_hosts?: string[];
  server_platform?: string;
  server_os?: string;
  server_arch?: string;
}

export interface ProductStateDocument {
  schema_version: number;
  created_at: string;
  updated_at: string;
}

export interface RuntimeProfileDocument extends ProductStateDocument {
  profile_id: string;
  workspace_root: string;
  runtime_id: RuntimeId;
  launch_command: string;
  integration_method: IntegrationMethod;
  install_scope: InstallScope;
  assurance_level: AssuranceLevel;
  governance_mode: GovernanceMode;
  guarantees: GovernanceGuarantee[];
  execution_mode: RuntimeExecutionMode;
  governed_surfaces: string[];
  degraded_reasons: string[];
  default_checkpoint_policy?: DefaultCheckpointPolicy;
  checkpoint_intent?: CheckpointIntent;
  checkpoint_reason_template?: string;
  containment_backend?: ContainmentBackend;
  container_image?: string;
  container_network_policy?: ContainerNetworkPolicy;
  contained_egress_mode?: ContainedEgressMode;
  contained_egress_assurance?: ContainedEgressAssurance;
  contained_credential_mode?: ContainedCredentialMode;
  runtime_credential_bindings?: RuntimeCredentialBindingDocument[];
  credential_passthrough_env_keys?: string[];
  contained_secret_env_bindings?: ContainedSecretEnvBinding[];
  contained_secret_file_bindings?: ContainedSecretFileBinding[];
  contained_proxy_allowlist_hosts?: string[];
  capability_snapshot?: DockerCapabilitySnapshot;
  runtime_display_name?: string;
  runtime_config_path?: string;
  last_run_id?: string;
  adapter_metadata?: Record<string, unknown>;
}

export interface RuntimeInstallMutation {
  type: "config_path_set";
  config_file_path: string;
  path: string;
  previous_value: unknown;
  applied_value: unknown;
  target_digest_after?: string;
}

export interface RuntimeInstallDocument extends ProductStateDocument {
  install_id: string;
  profile_id: string;
  runtime_id: RuntimeId;
  workspace_root: string;
  install_scope: InstallScope;
  plan_digest: string;
  applied_mutations: RuntimeInstallMutation[];
  status: InstallStatus;
  integration_method: IntegrationMethod;
  assurance_level: AssuranceLevel;
  governance_mode: GovernanceMode;
  guarantees: GovernanceGuarantee[];
  execution_mode: RuntimeExecutionMode;
  default_checkpoint_policy?: DefaultCheckpointPolicy;
  checkpoint_intent?: CheckpointIntent;
  checkpoint_reason_template?: string;
  containment_backend?: ContainmentBackend;
  container_network_policy?: ContainerNetworkPolicy;
  contained_egress_mode?: ContainedEgressMode;
  contained_egress_assurance?: ContainedEgressAssurance;
  contained_credential_mode?: ContainedCredentialMode;
  runtime_credential_bindings?: RuntimeCredentialBindingDocument[];
  contained_secret_env_bindings?: ContainedSecretEnvBinding[];
  contained_secret_file_bindings?: ContainedSecretFileBinding[];
  contained_proxy_allowlist_hosts?: string[];
  config_path?: string;
  capability_snapshot?: DockerCapabilitySnapshot;
}

export interface ConfigBackupDocument extends ProductStateDocument {
  backup_id: string;
  workspace_root: string;
  target_path: string;
  target_existed_before?: boolean;
  target_digest_before: string;
  backup_path: string;
}

export interface DemoRunDocument extends ProductStateDocument {
  demo_run_id: string;
  workspace_root: string;
  demo_workspace_root: string;
  run_id: string;
  dangerous_action_id: string;
  restore_boundary_id: string;
  deleted_path: string;
}

export interface RestoreShortcutDocument extends ProductStateDocument {
  shortcut_id: string;
  workspace_root: string;
  governed_workspace_root: string;
  run_id: string;
  action_id: string;
  preferred_restore_target: RecoveryTarget;
  restore_boundary_id: string;
  display_path?: string;
}

export interface RunCheckpointDocument extends ProductStateDocument {
  checkpoint_id: string;
  workspace_root: string;
  governed_workspace_root: string;
  run_id: string;
  run_checkpoint: string;
  snapshot_id: string;
  sequence: number;
  checkpoint_kind: RunCheckpointKind;
  trigger: "explicit_run_flag" | "default_policy";
  checkpoint_policy?: DefaultCheckpointPolicy;
  checkpoint_intent?: CheckpointIntent;
  reason?: string;
}

export type ProductStateCollections = {
  runtime_profiles: RuntimeProfileDocument;
  runtime_installs: RuntimeInstallDocument;
  config_backups: ConfigBackupDocument;
  demo_runs: DemoRunDocument;
  restore_shortcuts: RestoreShortcutDocument;
  run_checkpoints: RunCheckpointDocument;
  contained_runs: ContainedRunDocument;
};

export interface DetectionEvidence {
  kind: "binary" | "config_file" | "existing_profile" | "user_command";
  detail: string;
}

export interface DetectionResult {
  runtime_id: RuntimeId;
  confidence: number;
  workspace_root: string;
  install_scope_candidates: InstallScope[];
  evidence: DetectionEvidence[];
  assurance_ceiling: AssuranceLevel;
  runtime_display_name: string;
  launch_command?: string;
  runtime_config_path?: string;
  adapter_metadata?: Record<string, unknown>;
}

export interface SetupPreferences {
  experience: SetupExperience;
  policy_strictness: PolicyStrictness;
  install_scope: InstallScope;
  assurance_target?: AssuranceLevel;
  default_checkpoint_policy?: DefaultCheckpointPolicy;
  checkpoint_intent?: CheckpointIntent;
  checkpoint_reason_template?: string;
  containment_backend?: ContainmentBackend;
  container_image?: string;
  container_network_policy?: ContainerNetworkPolicy;
  contained_egress_mode?: ContainedEgressMode;
  contained_egress_assurance?: ContainedEgressAssurance;
  contained_credential_mode?: ContainedCredentialMode;
  runtime_credential_bindings?: RuntimeCredentialBindingDocument[];
  credential_passthrough_env_keys?: string[];
  contained_secret_env_bindings?: ContainedSecretEnvBinding[];
  contained_secret_file_bindings?: ContainedSecretFileBinding[];
  contained_proxy_allowlist_hosts?: string[];
}

export interface InstallPlan {
  runtime_id: RuntimeId;
  runtime_display_name: string;
  integration_method: IntegrationMethod;
  files_to_create: string[];
  files_to_modify: string[];
  env_to_inject: Record<string, string>;
  commands_to_run: string[];
  backup_targets: string[];
  user_confirmation_required: boolean;
  launch_command: string;
  install_scope: InstallScope;
  assurance_level: AssuranceLevel;
  governance_mode: GovernanceMode;
  guarantees: GovernanceGuarantee[];
  execution_mode: RuntimeExecutionMode;
  governed_surfaces: string[];
  degraded_reasons: string[];
  default_checkpoint_policy?: DefaultCheckpointPolicy;
  checkpoint_intent?: CheckpointIntent;
  checkpoint_reason_template?: string;
  containment_backend?: ContainmentBackend;
  container_image?: string;
  container_network_policy?: ContainerNetworkPolicy;
  contained_egress_mode?: ContainedEgressMode;
  contained_egress_assurance?: ContainedEgressAssurance;
  contained_credential_mode?: ContainedCredentialMode;
  runtime_credential_bindings?: RuntimeCredentialBindingDocument[];
  credential_passthrough_env_keys?: string[];
  contained_secret_env_bindings?: ContainedSecretEnvBinding[];
  contained_secret_file_bindings?: ContainedSecretFileBinding[];
  contained_proxy_allowlist_hosts?: string[];
  capability_snapshot?: DockerCapabilitySnapshot;
  runtime_config_path?: string;
  adapter_metadata?: Record<string, unknown>;
  applied_mutations: RuntimeInstallMutation[];
}

export interface HealthCheckResult {
  label: string;
  ok: boolean;
  detail: string;
}

export interface VerifyResult {
  ready: boolean;
  health_checks: HealthCheckResult[];
  recommended_next_command: string;
  assurance_ceiling: AssuranceLevel;
  degraded_reasons: string[];
}

export interface ApplyResult {
  changed: boolean;
  profile: RuntimeProfileDocument;
  install: RuntimeInstallDocument;
  backup?: ConfigBackupDocument;
}

export interface RollbackResult {
  changed: boolean;
  preserved_user_changes: string[];
  removed_profile: boolean;
  removed_install: boolean;
}

export interface ContainedRunDocument extends ProductStateDocument {
  contained_run_id: string;
  workspace_root: string;
  run_id: string;
  projection_root: string;
  baseline_manifest_path: string;
  status: "projection_ready" | "published" | "publish_conflict" | "publish_failed" | "discarded";
  launch_command: string;
  container_image: string;
  container_network_policy?: ContainerNetworkPolicy;
  contained_egress_mode?: ContainedEgressMode;
  contained_egress_assurance?: ContainedEgressAssurance;
  contained_credential_mode?: ContainedCredentialMode;
  runtime_credential_bindings?: RuntimeCredentialBindingDocument[];
  credential_passthrough_env_keys?: string[];
  contained_secret_env_bindings?: ContainedSecretEnvBinding[];
  contained_secret_file_bindings?: ContainedSecretFileBinding[];
  contained_proxy_allowlist_hosts?: string[];
  changed_paths: string[];
  conflicting_paths: string[];
  governed_action_ids: string[];
  publication_error?: string;
}
