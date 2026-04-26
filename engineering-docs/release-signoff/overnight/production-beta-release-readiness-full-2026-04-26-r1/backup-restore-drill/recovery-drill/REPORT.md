# Recovery Drill Evidence

- Status: PASS
- Drill Start: 2026-04-26T22:06:12.766Z
- Drill Finish: 2026-04-26T22:06:15.799Z
- Measured RTO (ms): 348
- RPO Target: latest valid action boundary
- Run ID: run_019dcbd4322d76ea8e0d2436cde18f9f
- Recovery Target Action ID: act_019dcbd43396700f8a4f75bc9fad8e88
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
