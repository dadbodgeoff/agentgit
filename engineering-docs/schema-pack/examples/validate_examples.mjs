#!/usr/bin/env node

import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_ROOT = path.resolve(ROOT, "..");
const requireFromSchemasPackage = createRequire(new URL("../../../packages/schemas/package.json", import.meta.url));
const Ajv2020 = requireFromSchemasPackage("ajv/dist/2020").default;
const addFormats = requireFromSchemasPackage("ajv-formats");

const SCHEMA_FILE_MAP = {
  action: "action.schema.json",
  "policy-outcome": "policy-outcome.schema.json",
  "snapshot-record": "snapshot-record.schema.json",
  "execution-result": "execution-result.schema.json",
  "run-event": "run-event.schema.json",
  "recovery-plan": "recovery-plan.schema.json",
  "timeline-step": "timeline-step.schema.json",
};

const TRACE_COLLECTIONS = {
  actions: "action",
  policy_outcomes: "policy-outcome",
  snapshot_records: "snapshot-record",
  execution_results: "execution-result",
  run_events: "run-event",
  recovery_plans: "recovery-plan",
  timeline_steps: "timeline-step",
};

async function loadJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function listFiles(dirPath, predicate) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => path.join(dirPath, entry.name))
    .sort();
}

async function buildValidators() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);

  const schemas = new Map();
  const schemaPaths = await listFiles(SCHEMA_ROOT, (name) => name.endsWith(".schema.json"));
  for (const schemaPath of schemaPaths) {
    const schema = await loadJson(schemaPath);
    schemas.set(path.basename(schemaPath), schema);
    ajv.addSchema(schema, schema.$id ?? path.basename(schemaPath));
  }

  const validators = new Map();
  for (const [schemaName, fileName] of Object.entries(SCHEMA_FILE_MAP)) {
    const schema = schemas.get(fileName);
    if (!schema) {
      throw new Error(`Missing schema file ${fileName}`);
    }
    const validator = ajv.getSchema(schema.$id) ?? ajv.compile(schema);
    validators.set(schemaName, validator);
  }

  return validators;
}

function collectErrors(validator, instance) {
  const valid = validator(instance);
  if (valid) {
    return [];
  }
  return [...(validator.errors ?? [])].sort((a, b) => String(a.instancePath).localeCompare(String(b.instancePath)));
}

function errorMessage(error) {
  return error.message ?? "unknown validation error";
}

async function validateGroupedExamples(validators, subdir, expectValid) {
  const failures = [];
  const base = path.join(ROOT, subdir);
  const examplePaths = await listFiles(base, (name) => name.endsWith(".examples.json"));

  for (const examplePath of examplePaths) {
    const payload = await loadJson(examplePath);
    const validator = validators.get(payload.schema);
    if (!validator) {
      failures.push(`${path.basename(examplePath)} references unknown schema ${payload.schema}`);
      continue;
    }

    for (const [caseName, instance] of Object.entries(payload.cases)) {
      const errors = collectErrors(validator, instance);
      if (expectValid && errors.length > 0) {
        failures.push(
          `${path.basename(examplePath)}:${caseName} expected valid but failed with ${errorMessage(errors[0])}`,
        );
      }
      if (!expectValid && errors.length === 0) {
        failures.push(`${path.basename(examplePath)}:${caseName} expected invalid but passed validation`);
      }
    }
  }

  return failures;
}

function checkTraceReferentialIntegrity(traceName, records) {
  const failures = [];

  const actions = new Map((records.actions ?? []).map((item) => [item.action_id, item]));
  const policyOutcomes = new Map((records.policy_outcomes ?? []).map((item) => [item.policy_outcome_id, item]));
  const snapshots = new Map((records.snapshot_records ?? []).map((item) => [item.snapshot_id, item]));
  const executionResults = new Map(
    (records.execution_results ?? []).map((item) => [item.execution_result_id, item]),
  );
  const recoveryPlans = new Map((records.recovery_plans ?? []).map((item) => [item.recovery_plan_id, item]));
  const runEvents = records.run_events ?? [];
  const timelineSteps = records.timeline_steps ?? [];

  const runIds = new Set();
  for (const action of actions.values()) {
    runIds.add(action.run_id);
  }
  for (const event of runEvents) {
    runIds.add(event.run_id);
  }
  for (const step of timelineSteps) {
    runIds.add(step.run_id);
  }

  if (runIds.size > 1) {
    failures.push(`${traceName}: multiple run_ids present: ${JSON.stringify([...runIds].sort())}`);
  }

  for (const obj of policyOutcomes.values()) {
    if (!actions.has(obj.action_id)) {
      failures.push(`${traceName}: policy outcome ${obj.policy_outcome_id} references missing action ${obj.action_id}`);
    }
  }

  for (const obj of snapshots.values()) {
    if (!actions.has(obj.action_id)) {
      failures.push(`${traceName}: snapshot ${obj.snapshot_id} references missing action ${obj.action_id}`);
    }
  }

  for (const obj of executionResults.values()) {
    if (!actions.has(obj.action_id)) {
      failures.push(`${traceName}: execution result ${obj.execution_result_id} references missing action ${obj.action_id}`);
    }
  }

  for (const obj of recoveryPlans.values()) {
    const actionId = obj.target?.action_id;
    const snapshotId = obj.target?.snapshot_id;
    if (actionId && !actions.has(actionId)) {
      failures.push(`${traceName}: recovery plan ${obj.recovery_plan_id} references missing action ${actionId}`);
    }
    if (snapshotId && !snapshots.has(snapshotId)) {
      failures.push(`${traceName}: recovery plan ${obj.recovery_plan_id} references missing snapshot ${snapshotId}`);
    }
  }

  for (const event of runEvents) {
    const causality = event.causality ?? {};
    const refs = event.refs ?? [];
    const actionId = causality.action_id;
    const policyOutcomeId = causality.policy_outcome_id;
    const snapshotId = causality.snapshot_id;
    const executionResultId = causality.execution_result_id;
    const recoveryPlanId = causality.recovery_plan_id;

    if (actionId && !actions.has(actionId)) {
      failures.push(`${traceName}: event ${event.event_id} references missing action ${actionId}`);
    }
    if (policyOutcomeId && !policyOutcomes.has(policyOutcomeId)) {
      failures.push(`${traceName}: event ${event.event_id} references missing policy outcome ${policyOutcomeId}`);
    }
    if (snapshotId && !snapshots.has(snapshotId)) {
      failures.push(`${traceName}: event ${event.event_id} references missing snapshot ${snapshotId}`);
    }
    if (executionResultId && !executionResults.has(executionResultId)) {
      failures.push(`${traceName}: event ${event.event_id} references missing execution result ${executionResultId}`);
    }
    if (recoveryPlanId && !recoveryPlans.has(recoveryPlanId)) {
      failures.push(`${traceName}: event ${event.event_id} references missing recovery plan ${recoveryPlanId}`);
    }

    for (const ref of refs) {
      if (ref.kind === "action" && !actions.has(ref.id)) {
        failures.push(`${traceName}: event ${event.event_id} refs missing action ${ref.id}`);
      }
      if (ref.kind === "policy_outcome" && !policyOutcomes.has(ref.id)) {
        failures.push(`${traceName}: event ${event.event_id} refs missing policy outcome ${ref.id}`);
      }
      if (ref.kind === "snapshot" && !snapshots.has(ref.id)) {
        failures.push(`${traceName}: event ${event.event_id} refs missing snapshot ${ref.id}`);
      }
      if (ref.kind === "execution_result" && !executionResults.has(ref.id)) {
        failures.push(`${traceName}: event ${event.event_id} refs missing execution result ${ref.id}`);
      }
    }
  }

  for (const step of timelineSteps) {
    const related = step.related;
    const snapshotId = related?.snapshot_id;
    const executionResultId = related?.execution_result_id;
    for (const recoveryPlanId of related?.recovery_plan_ids ?? []) {
      if (!recoveryPlans.has(recoveryPlanId)) {
        failures.push(`${traceName}: timeline step ${step.step_id} references missing recovery plan ${recoveryPlanId}`);
      }
    }
    if (step.action_id !== undefined && step.action_id !== null && !actions.has(step.action_id)) {
      failures.push(`${traceName}: timeline step ${step.step_id} references missing action ${step.action_id}`);
    }
    if (snapshotId !== undefined && snapshotId !== null && !snapshots.has(snapshotId)) {
      failures.push(`${traceName}: timeline step ${step.step_id} references missing snapshot ${snapshotId}`);
    }
    if (executionResultId !== undefined && executionResultId !== null && !executionResults.has(executionResultId)) {
      failures.push(`${traceName}: timeline step ${step.step_id} references missing execution result ${executionResultId}`);
    }
  }

  return failures;
}

async function validateTraces(validators) {
  const failures = [];
  const base = path.join(ROOT, "traces");
  const tracePaths = await listFiles(base, (name) => name.endsWith(".json"));

  for (const tracePath of tracePaths) {
    const payload = await loadJson(tracePath);
    const records = payload.records;

    for (const [collectionName, schemaName] of Object.entries(TRACE_COLLECTIONS)) {
      const validator = validators.get(schemaName);
      for (const [index, instance] of (records[collectionName] ?? []).entries()) {
        const errors = collectErrors(validator, instance);
        if (errors.length > 0) {
          failures.push(
            `${path.basename(tracePath)}:${collectionName}[${index + 1}] failed schema validation: ${errorMessage(
              errors[0],
            )}`,
          );
        }
      }
    }

    failures.push(...checkTraceReferentialIntegrity(path.basename(tracePath), records));
  }

  return failures;
}

async function main() {
  const validators = await buildValidators();
  const failures = [
    ...(await validateGroupedExamples(validators, "valid", true)),
    ...(await validateGroupedExamples(validators, "invalid", false)),
    ...(await validateTraces(validators)),
  ];

  if (failures.length > 0) {
    console.log("Schema example validation failed:");
    for (const failure of failures) {
      console.log(`- ${failure}`);
    }
    return 1;
  }

  console.log("Schema example validation passed.");
  return 0;
}

process.exitCode = await main();
