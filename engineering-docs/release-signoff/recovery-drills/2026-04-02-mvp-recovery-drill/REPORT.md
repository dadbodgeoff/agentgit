# Recovery Drill Evidence

- Status: PASS
- Drill Start: 2026-04-02T02:05:30.670Z
- Drill Finish: 2026-04-02T02:05:32.656Z
- Measured RTO (ms): 192
- RPO Target: latest valid action boundary
- Run ID: run_019d4bf0495b7398808c973ed557cdb0
- Recovery Target Action ID: act_019d4bf04a4572fb837c178ca8b3104f
- Recovery Strategy: restore_snapshot
- Restored: true
- Target Exists After Recovery: true
- Target Content After Recovery: "drill-v1"

Artifacts:
- 01-ping.json
- 02-doctor.json
- 03-register-run.json
- 04-submit-filesystem-write.json
- 05-submit-filesystem-delete.json
- 06-timeline-before.json
- 07-plan-recovery.json
- 08-execute-recovery.json
- 09-run-summary.json
- 10-timeline-after.json
- summary.json
