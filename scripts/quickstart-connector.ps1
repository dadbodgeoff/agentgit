$ErrorActionPreference = "Stop"
function Fail($Message) { Write-Error $Message; exit 1 }
function Need($Command, $Message) { if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) { Fail $Message } }
function TrimValue([string]$Value) { if ($null -eq $Value) { return "" }; return $Value.Trim() }

Need "node" "Node.js is required. Install Node.js 24 or newer."
Need "npm" "npm is required. Install npm and retry."
Need "git" "git is required. Install git and retry."

$nodeMajor = [int](node -p "process.versions.node.split('.')[0]") 2>$null
if ($LASTEXITCODE -ne 0) { Fail "Could not read the Node.js version." }
if ($nodeMajor -lt 24) { Fail "Node.js 24 or newer is required. Current version: $(node -v)" }

$workspaceRoot = (& git rev-parse --show-toplevel 2>$null)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($workspaceRoot)) { $workspaceRoot = (Get-Location).Path }
Write-Host "Using workspace root: $workspaceRoot"
Write-Host "Installing @agentgit/cloud-connector globally..."
& npm install -g @agentgit/cloud-connector *> $null
if ($LASTEXITCODE -ne 0) { Fail "Global install failed. Retry with npm configured for global installs." }
Need "agentgit-cloud-connector" "The connector binary is not on PATH after install. Re-open PowerShell and retry."

$cloudUrl = TrimValue((Read-Host "Cloud URL [http://localhost:3000]"))
if ([string]::IsNullOrWhiteSpace($cloudUrl)) { $cloudUrl = "http://localhost:3000" }
$workspaceId = TrimValue((Read-Host "Workspace ID (shown in the cloud UI)"))
if ([string]::IsNullOrWhiteSpace($workspaceId)) { Fail "Workspace ID is required for connector bootstrap." }
$tokenPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR((Read-Host "Bootstrap token" -AsSecureString))
try { $bootstrapToken = TrimValue([Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPtr)) } finally { if ($tokenPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPtr) } }
if ([string]::IsNullOrWhiteSpace($bootstrapToken)) { Fail "Bootstrap token cannot be empty." }

Write-Host "Bootstrapping the connector..."
$bootstrapOutput = & agentgit-cloud-connector bootstrap --cloud-url $cloudUrl --workspace-id $workspaceId --workspace-root $workspaceRoot --bootstrap-token $bootstrapToken 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { Fail "Bootstrap failed.`n$bootstrapOutput" }
if ($bootstrapOutput -notmatch '"registration"' -or $bootstrapOutput -notmatch '"sync"') { Fail "Bootstrap completed without the expected registration output.`n$bootstrapOutput" }

Write-Host "Running a one-time sync check..."
$syncOutput = & agentgit-cloud-connector sync-once --workspace-root $workspaceRoot 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { Fail "sync-once failed.`n$syncOutput" }
if ($syncOutput -notmatch '"published"') { Fail "sync-once did not report published data.`n$syncOutput" }

Write-Host @"
Success: the first connector is online.

Next steps:
1. Open AgentGit Cloud and confirm the connector shows as active.
2. Trigger one governed action so the approval and activity views populate.
3. Start the long-running daemon with:
   agentgit-cloud-connector run --workspace-root "$workspaceRoot"
"@
