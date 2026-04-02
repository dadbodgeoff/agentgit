# Operator Tabletop Evidence

- Status: PASS
- Tabletop Start: 2026-04-02T02:05:30.672Z
- Tabletop Finish: 2026-04-02T02:05:32.781Z
- Run ID: run_019d4bf04b057445bf6469d7f4844aa7
- Bundle Directory: /tmp/agentgit-tabletop-pDTulo/workspace/tabletop-audit-bundle
- Tampered Artifact Path: /tmp/agentgit-tabletop-pDTulo/workspace/tabletop-audit-bundle/artifacts/artifact_stdout_1775095532391.stdout.txt
- Verify Before Tamper: {"run_id":"run_019d4bf04b057445bf6469d7f4844aa7","output_dir":"/tmp/agentgit-tabletop-pDTulo/workspace/tabletop-audit-bundle","manifest_version":"agentgit.run-audit-bundle.v2","verified":true,"files_checked":12,"exported_artifacts_checked":1,"issues":[]}
- Verify After Tamper: {"run_id":"run_019d4bf04b057445bf6469d7f4844aa7","output_dir":"/tmp/agentgit-tabletop-pDTulo/workspace/tabletop-audit-bundle","manifest_version":"agentgit.run-audit-bundle.v2","verified":false,"files_checked":12,"exported_artifacts_checked":1,"issues":[{"code":"ARTIFACT_SIZE_MISMATCH","artifact_id":"artifact_stdout_1775095532391","message":"Expected 25 bytes but found 34.","file_path":"/tmp/agentgit-tabletop-pDTulo/workspace/tabletop-audit-bundle/artifacts/artifact_stdout_1775095532391.stdout.txt"},{"code":"ARTIFACT_SHA256_MISMATCH","artifact_id":"artifact_stdout_1775095532391","message":"Expected SHA256 b3c24a5188fde0f103d35765571fcfaeadf46ef06584e32c03168a6624d80309 but found 82d8e8605f7055b9f7ebc5aa71ce64101ac7b6357af057d73e52e58bfdb1d3c6.","file_path":"/tmp/agentgit-tabletop-pDTulo/workspace/tabletop-audit-bundle/artifacts/artifact_stdout_1775095532391.stdout.txt"},{"code":"ARTIFACT_INTEGRITY_MISMATCH","artifact_id":"artifact_stdout_1775095532391","message":"Expected integrity digest b3c24a5188fde0f103d35765571fcfaeadf46ef06584e32c03168a6624d80309 but found 82d8e8605f7055b9f7ebc5aa71ce64101ac7b6357af057d73e52e58bfdb1d3c6.","file_path":"/tmp/agentgit-tabletop-pDTulo/workspace/tabletop-audit-bundle/artifacts/artifact_stdout_1775095532391.stdout.txt"}]}

Artifacts:
- 01-ping.json
- 02-doctor.json
- 03-register-run.json
- 04-submit-shell.json
- 05-run-audit-export.json
- 06-run-audit-verify-before.json
- 07-run-audit-verify-after.json
- summary.json
