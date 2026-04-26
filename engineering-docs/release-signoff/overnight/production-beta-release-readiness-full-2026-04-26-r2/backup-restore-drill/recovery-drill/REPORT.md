# Recovery Drill Evidence

- Status: PASS
- Drill Start: 2026-04-26T22:15:11.171Z
- Drill Finish: 2026-04-26T22:15:14.350Z
- Measured RTO (ms): 331
- RPO Target: latest valid action boundary
- Run ID: run_019dcbdc69c27136889d6dad8d1a5d3e
- Recovery Target Action ID: act_019dcbdc6b4b7526a6af0e1369475d02
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
