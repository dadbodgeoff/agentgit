#!/usr/bin/env python3

import json
import sys
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource


ROOT = Path(__file__).resolve().parent
SCHEMA_ROOT = ROOT.parent

SCHEMA_FILE_MAP = {
    "action": "action.schema.json",
    "policy-outcome": "policy-outcome.schema.json",
    "snapshot-record": "snapshot-record.schema.json",
    "execution-result": "execution-result.schema.json",
    "run-event": "run-event.schema.json",
    "recovery-plan": "recovery-plan.schema.json",
    "timeline-step": "timeline-step.schema.json",
}

TRACE_COLLECTIONS = {
    "actions": "action",
    "policy_outcomes": "policy-outcome",
    "snapshot_records": "snapshot-record",
    "execution_results": "execution-result",
    "run_events": "run-event",
    "recovery_plans": "recovery-plan",
    "timeline_steps": "timeline-step",
}


def load_json(path: Path):
    return json.loads(path.read_text())


def build_validators():
    schemas = {}
    registry = Registry()
    for path in sorted(SCHEMA_ROOT.glob("*.schema.json")):
        schema = load_json(path)
        schemas[path.name] = schema
        schema_id = schema.get("$id")
        if schema_id:
            registry = registry.with_resource(schema_id, Resource.from_contents(schema))
    validators = {}
    for schema_name, file_name in SCHEMA_FILE_MAP.items():
        schema = schemas[file_name]
        validators[schema_name] = Draft202012Validator(
            schema,
            registry=registry,
            format_checker=FormatChecker(),
        )
    return validators


def collect_errors(validator, instance):
    return sorted(validator.iter_errors(instance), key=lambda e: list(e.absolute_path))


def validate_grouped_examples(validators, subdir: str, expect_valid: bool):
    failures = []
    base = ROOT / subdir
    for path in sorted(base.glob("*.examples.json")):
        payload = load_json(path)
        schema_name = payload["schema"]
        validator = validators[schema_name]
        for case_name, instance in payload["cases"].items():
            errors = collect_errors(validator, instance)
            if expect_valid and errors:
                failures.append(
                    f"{path.name}:{case_name} expected valid but failed with {errors[0].message}"
                )
            if not expect_valid and not errors:
                failures.append(
                    f"{path.name}:{case_name} expected invalid but passed validation"
                )
    return failures


def check_trace_referential_integrity(trace_name: str, records: dict):
    failures = []

    actions = {item["action_id"]: item for item in records.get("actions", [])}
    policy_outcomes = {
        item["policy_outcome_id"]: item for item in records.get("policy_outcomes", [])
    }
    snapshots = {item["snapshot_id"]: item for item in records.get("snapshot_records", [])}
    execution_results = {
        item["execution_result_id"]: item for item in records.get("execution_results", [])
    }
    recovery_plans = {
        item["recovery_plan_id"]: item for item in records.get("recovery_plans", [])
    }
    run_events = records.get("run_events", [])
    timeline_steps = records.get("timeline_steps", [])

    run_ids = set()
    for action in actions.values():
        run_ids.add(action["run_id"])
    for event in run_events:
        run_ids.add(event["run_id"])
    for step in timeline_steps:
        run_ids.add(step["run_id"])

    if len(run_ids) > 1:
        failures.append(f"{trace_name}: multiple run_ids present: {sorted(run_ids)}")

    for obj in policy_outcomes.values():
        if obj["action_id"] not in actions:
            failures.append(
                f"{trace_name}: policy outcome {obj['policy_outcome_id']} references missing action {obj['action_id']}"
            )

    for obj in snapshots.values():
        if obj["action_id"] not in actions:
            failures.append(
                f"{trace_name}: snapshot {obj['snapshot_id']} references missing action {obj['action_id']}"
            )

    for obj in execution_results.values():
        if obj["action_id"] not in actions:
            failures.append(
                f"{trace_name}: execution result {obj['execution_result_id']} references missing action {obj['action_id']}"
            )

    for obj in recovery_plans.values():
        target = obj["target"]
        action_id = target.get("action_id")
        snapshot_id = target.get("snapshot_id")
        if action_id and action_id not in actions:
            failures.append(
                f"{trace_name}: recovery plan {obj['recovery_plan_id']} references missing action {action_id}"
            )
        if snapshot_id and snapshot_id not in snapshots:
            failures.append(
                f"{trace_name}: recovery plan {obj['recovery_plan_id']} references missing snapshot {snapshot_id}"
            )

    for event in run_events:
        causality = event.get("causality", {})
        refs = event.get("refs", [])
        action_id = causality.get("action_id")
        policy_outcome_id = causality.get("policy_outcome_id")
        snapshot_id = causality.get("snapshot_id")
        execution_result_id = causality.get("execution_result_id")
        recovery_plan_id = causality.get("recovery_plan_id")

        if action_id and action_id not in actions:
            failures.append(f"{trace_name}: event {event['event_id']} references missing action {action_id}")
        if policy_outcome_id and policy_outcome_id not in policy_outcomes:
            failures.append(
                f"{trace_name}: event {event['event_id']} references missing policy outcome {policy_outcome_id}"
            )
        if snapshot_id and snapshot_id not in snapshots:
            failures.append(
                f"{trace_name}: event {event['event_id']} references missing snapshot {snapshot_id}"
            )
        if execution_result_id and execution_result_id not in execution_results:
            failures.append(
                f"{trace_name}: event {event['event_id']} references missing execution result {execution_result_id}"
            )
        if recovery_plan_id and recovery_plan_id not in recovery_plans:
            failures.append(
                f"{trace_name}: event {event['event_id']} references missing recovery plan {recovery_plan_id}"
            )

        for ref in refs:
            ref_id = ref["id"]
            kind = ref["kind"]
            if kind == "action" and ref_id not in actions:
                failures.append(f"{trace_name}: event {event['event_id']} refs missing action {ref_id}")
            if kind == "policy_outcome" and ref_id not in policy_outcomes:
                failures.append(
                    f"{trace_name}: event {event['event_id']} refs missing policy outcome {ref_id}"
                )
            if kind == "snapshot" and ref_id not in snapshots:
                failures.append(f"{trace_name}: event {event['event_id']} refs missing snapshot {ref_id}")
            if kind == "execution_result" and ref_id not in execution_results:
                failures.append(
                    f"{trace_name}: event {event['event_id']} refs missing execution result {ref_id}"
                )

    for step in timeline_steps:
        action_id = step.get("action_id")
        related = step["related"]
        snapshot_id = related.get("snapshot_id")
        execution_result_id = related.get("execution_result_id")
        for recovery_plan_id in related.get("recovery_plan_ids", []):
            if recovery_plan_id not in recovery_plans:
                failures.append(
                    f"{trace_name}: timeline step {step['step_id']} references missing recovery plan {recovery_plan_id}"
                )
        if action_id is not None and action_id not in actions:
            failures.append(
                f"{trace_name}: timeline step {step['step_id']} references missing action {action_id}"
            )
        if snapshot_id is not None and snapshot_id not in snapshots:
            failures.append(
                f"{trace_name}: timeline step {step['step_id']} references missing snapshot {snapshot_id}"
            )
        if execution_result_id is not None and execution_result_id not in execution_results:
            failures.append(
                f"{trace_name}: timeline step {step['step_id']} references missing execution result {execution_result_id}"
            )

    return failures


def validate_traces(validators):
    failures = []
    base = ROOT / "traces"
    for path in sorted(base.glob("*.json")):
        payload = load_json(path)
        records = payload["records"]
        for collection_name, schema_name in TRACE_COLLECTIONS.items():
            validator = validators[schema_name]
            for index, instance in enumerate(records.get(collection_name, []), start=1):
                errors = collect_errors(validator, instance)
                if errors:
                    failures.append(
                        f"{path.name}:{collection_name}[{index}] failed schema validation: {errors[0].message}"
                    )
        failures.extend(check_trace_referential_integrity(path.name, records))
    return failures


def main():
    validators = build_validators()

    failures = []
    failures.extend(validate_grouped_examples(validators, "valid", expect_valid=True))
    failures.extend(validate_grouped_examples(validators, "invalid", expect_valid=False))
    failures.extend(validate_traces(validators))

    if failures:
      print("Schema example validation failed:")
      for failure in failures:
          print(f"- {failure}")
      return 1

    print("Schema example validation passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
