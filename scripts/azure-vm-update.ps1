# Updates the installed app on the Azure VM (pre-production) to a new version. Run on the VM, elevated:
#   powershell -ExecutionPolicy Bypass -File C:\apps\approvalflow\scripts\azure-vm-update.ps1 -Version v1.0.0
#     downloads that release tag straight from GitHub (made on a dev machine with: git tag v1.0.0; git push --tags)
#   powershell -ExecutionPolicy Bypass -File C:\apps\approvalflow\scripts\azure-vm-update.ps1
#     old way: installs approvalflow.zip made by scripts\package-for-vm.ps1, read from the PC's desktop over a
#     Remote Desktop session that shares the PC's C: drive (or pass -Package <path>)
# A private repo needs a READ-ONLY GitHub token (fine-grained, this repo only, Contents: Read) in $TokenFile;
# never sign in to GitHub with your own account on this server.
#
# Stops the service, replaces the code (keeping server\.env, node_modules, dist and its service wrapper),
# reinstalls libraries, runs new migrations, then rebuilds and restarts everything via deploy-local-iis.ps1.
# The installed version is written to C:\apps\approvalflow\DEPLOYED.txt.
param(
  [string]$Version   = '',
  [string]$Repo      = 'farookgolam/workflow',
  [string]$TokenFile = 'C:\ApprovalFlowData\github-read-token.txt',
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

"== 1. Fetch the code =="
if (Test-Path $work) { Remove-Item $work -Recurse -Force -Confirm:$false }
New-Item -ItemType Directory $work | Out-Null
if ($Version) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $ProgressPreference = 'SilentlyContinue'
  $headers = @{ 'User-Agent' = 'approvalflow-update'; 'Accept' = 'application/vnd.github+json' }
  if (Test-Path $TokenFile) { $headers['Authorization'] = 'Bearer ' + (Get-Content $TokenFile -Raw).Trim(); "  using the read-only token in $TokenFile" }
  try { $ref = Invoke-RestMethod -UseBasicParsing -Headers $headers "https://api.github.com/repos/$Repo/git/ref/tags/$Version" }
  catch { throw "release tag '$Version' not found on GitHub ($Repo) - on a dev machine run: git tag $Version; git push --tags" }
  "  downloading $Version from github.com/$Repo"
  Invoke-WebRequest -UseBasicParsing -Headers $headers "https://api.github.com/repos/$Repo/zipball/$Version" -OutFile "$work\approvalflow.zip"
  Expand-Archive "$work\approvalflow.zip" "$work\unzipped"
  # GitHub wraps everything in one folder named <owner>-<repo>-<commit>
  $top = @(Get-ChildItem "$work\unzipped" -Directory)
  if ($top.Count -ne 1 -or -not (Test-Path (Join-Path $top[0].FullName 'server\package.json'))) { throw 'the downloaded archive does not look like ApprovalFlow' }
  Move-Item $top[0].FullName "$work\src"
  $deployed = "$Version (ref $($ref.object.sha.Substring(0, 7)))"
}
else {
  if (-not (Test-Path $Package)) { throw "package not found: $Package (is the PC's C: drive shared in Remote Desktop?) - or use -Version <tag>" }
  Copy-Item $Package "$work\approvalflow.zip"
  "  SHA-256: " + (Get-FileHash "$work\approvalflow.zip").Hash
  Expand-Archive "$work\approvalflow.zip" "$work\src"
  $deployed = "zip package $((Get-FileHash "$work\approvalflow.zip").Hash.Substring(0, 12))"
}
"  got $deployed"

"== 2. Stop the service (it holds the native SQL driver open) =="
Stop-Service 'approvalflowapi.exe' -Force
"  stopped"

"== 3. Replace the code =="
# /MIR also removes files deleted from the source; the excluded folders and .env are neither copied nor removed
robocopy "$work\src" $AppRoot /MIR /XD node_modules dist storage /XF .env /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed (exit code $LASTEXITCODE)" }
Remove-Item $work -Recurse -Force -Confirm:$false
"$deployed - installed $(Get-Date -Format 'yyyy-MM-dd HH:mm')" | Set-Content (Join-Path $AppRoot 'DEPLOYED.txt') -Encoding ascii
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
# a real domain in server\.env APP_DOMAIN (not *.localhost) means the site is public: https, redirect, port 80 bindings
$envDomain = (Get-Content (Join-Path $server '.env') | Where-Object { $_ -match '^\s*APP_DOMAIN\s*=' } | Select-Object -First 1) -replace '^\s*APP_DOMAIN\s*=\s*', ''
$public = @{}
if ($envDomain -and $envDomain.Trim() -notmatch '(^|\.)localhost$') { $public.PublicDomain = $envDomain.Trim(); "  public site: $($public.PublicDomain)" }
& (Join-Path $AppRoot 'scripts\deploy-local-iis.ps1') -SitePort $SitePort -ApiPort $ApiPort -Hosts $hosts @public
