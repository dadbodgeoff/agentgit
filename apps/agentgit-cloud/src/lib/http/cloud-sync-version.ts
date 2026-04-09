import { CLOUD_SYNC_SCHEMA_VERSION } from "@agentgit/cloud-sync-protocol";

export function hasExpectedCloudSyncSchemaVersion(body: unknown): boolean {
  if (!body || typeof body !== "object") {
    return false;
  }

  return Reflect.get(body, "schemaVersion") === CLOUD_SYNC_SCHEMA_VERSION;
}

export function buildCloudSyncSchemaVersionErrorMessage(): string {
  return `Connector sync schemaVersion must equal ${CLOUD_SYNC_SCHEMA_VERSION}.`;
}
