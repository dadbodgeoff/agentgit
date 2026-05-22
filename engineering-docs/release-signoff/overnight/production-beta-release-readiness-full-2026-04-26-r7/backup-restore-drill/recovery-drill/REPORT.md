# Recovery Drill Evidence

- Status: PASS
- Drill Start: 2026-04-26T23:33:29.274Z
- Drill Finish: 2026-04-26T23:33:32.330Z
- Measured RTO (ms): 340
- RPO Target: latest valid action boundary
- Run ID: run_019dcc241950722482afab5760738c4d
- Recovery Target Action ID: act_019dcc241ac6760f80d9e5c436bfe2a9
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
