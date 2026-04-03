# Recovery Drill Evidence

- Status: PASS
- Drill Start: 2026-04-02T23:37:59.290Z
- Drill Finish: 2026-04-02T23:38:03.316Z
- Measured RTO (ms): 314
- RPO Target: latest valid action boundary
- Run ID: run_019d508f9c68701c8e7be7a5cacf2662
- Recovery Target Action ID: act_019d508f9d8c709cb20ff3b143f5dea9
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
