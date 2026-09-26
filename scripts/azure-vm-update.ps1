# Updates the Azure dev VM to a new package made by scripts\package-for-vm.ps1 on the development PC.
# Run on the VM, elevated, in a Remote Desktop session that shares the PC's C: drive:
#   powershell -ExecutionPolicy Bypass -File C:\apps\approvalflow\scripts\azure-vm-update.ps1
#
# Stops the service, replaces the code (keeping server\.env, node_modules, dist and its service wrapper),
# reinstalls libraries, runs new migrations, then rebuilds and restarts everything via deploy-local-iis.ps1.
param(
  [string]$Package   = '\\tsclient\C\Users\Administrator\Desktop\approvalflow.zip',
  [string]$AppRoot   = 'C:\apps\approvalflow',
  [string]$AppDomain = 'approvalflow.localhost',
  [int]$SitePort     = 8088,
  [int]$ApiPort      = 4100
)

$ErrorActionPreference = 'Stop'
$server = Join-Path $AppRoot 'server'
$work   = Join-Path $env:TEMP 'af-update'
function Invoke-Npm { npm.cmd @args; if ($LASTEXITCODE -ne 0) { throw "npm $($args -join ' ') failed" } }

"== 1. Fetch the package =="
if (-not (Test-Path $Package)) { throw "package not found: $Package (is the PC's C: drive shared in Remote Desktop?)" }
if (Test-Path $work) { Remove-Item $work -Recurse -Force -Confirm:$false }
New-Item -ItemType Directory $work | Out-Null
Copy-Item $Package "$work\approvalflow.zip"
"  SHA-256: " + (Get-FileHash "$work\approvalflow.zip").Hash
Expand-Archive "$work\approvalflow.zip" "$work\src"

"== 2. Stop the service (it holds the native SQL driver open) =="
Stop-Service 'approvalflowapi.exe' -Force
"  stopped"

"== 3. Replace the code =="
# /MIR also removes files deleted from the source; the excluded folders and .env are neither copied nor removed
robocopy "$work\src" $AppRoot /MIR /XD node_modules dist storage /XF .env /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed (exit code $LASTEXITCODE)" }
Remove-Item $work -Recurse -Force -Confirm:$false
"  done (server\.env kept)"

"== 4. Libraries =="
Push-Location $server; Invoke-Npm ci --no-audit --no-fund; Invoke-Npm install --no-save --no-audit --no-fund node-windows; Pop-Location
Push-Location (Join-Path $AppRoot 'client'); Invoke-Npm ci --no-audit --no-fund; Pop-Location

"== 5. Migrations =="
Push-Location $server; Invoke-Npm run --silent migrate; Pop-Location

"== 6. Build, publish and restart (deploy-local-iis.ps1) =="
$hosts = @(sqlcmd -S . -E -C -b -h -1 -W -Q "SET NOCOUNT ON; SELECT COALESCE(Host, Slug + '.$AppDomain') FROM ApprovalFlow.dbo.Tenants WHERE RemovedAt IS NULL" |
           ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($LASTEXITCODE -ne 0) { throw 'could not read the customer list' }
& (Join-Path $AppRoot 'scripts\deploy-local-iis.ps1') -SitePort $SitePort -ApiPort $ApiPort -Hosts $hosts
