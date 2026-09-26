# Azure VM rehearsal install: restores the database from a .bak, writes server\.env, builds, installs the
# Windows service and creates the IIS site. Run AFTER azure-vm-prereqs.ps1, elevated, on the VM:
#   powershell -ExecutionPolicy Bypass -File C:\apps\approvalflow\scripts\azure-vm-install.ps1
#
# Rehearsal mode: the site answers on http://localhost:<SitePort> and http://<slug>.approvalflow.localhost:<SitePort>
# ON THE VM ONLY (*.localhost resolves to the VM itself in Edge/Chrome), mail is written to disk, not sent.
# The real domain, HTTPS and SMTP come at cutover. Re-running skips what exists: the database is never
# overwritten and an existing server\.env is kept (delete them by hand to start over).
param(
  [string]$BackupFile = 'C:\apps\ApprovalFlow.bak',
  [string]$AppRoot    = 'C:\apps\approvalflow',
  [string]$DataDir    = 'C:\ApprovalFlowData',
  [string]$AppDomain  = 'approvalflow.localhost',
  [int]$SitePort      = 8088,
  [int]$ApiPort       = 4100
)

$ErrorActionPreference = 'Stop'
$server  = Join-Path $AppRoot 'server'
$envFile = Join-Path $server '.env'
$svcSid  = 'NT SERVICE\approvalflowapi.exe'
function Sql($q) { $out = sqlcmd -S . -E -C -b -h -1 -W -Q "SET NOCOUNT ON; $q"; if ($LASTEXITCODE -ne 0) { throw "SQL failed: $q`n$out" }; $out }
function Invoke-Npm { npm.cmd @args; if ($LASTEXITCODE -ne 0) { throw "npm $($args -join ' ') failed" } }

"== 1. Database =="
if ((Sql "SELECT COUNT(*) FROM sys.databases WHERE name = 'ApprovalFlow'").Trim() -ne '0') { "  ApprovalFlow already exists - not restoring" }
else {
  if (-not (Test-Path $BackupFile)) { throw "backup not found: $BackupFile" }
  $dataPath = (Sql "SELECT CAST(SERVERPROPERTY('InstanceDefaultDataPath') AS nvarchar(400))").Trim()
  $logPath  = (Sql "SELECT CAST(SERVERPROPERTY('InstanceDefaultLogPath') AS nvarchar(400))").Trim()
  Sql "RESTORE DATABASE [ApprovalFlow] FROM DISK = N'$BackupFile' WITH CHECKSUM, MOVE 'ApprovalFlow' TO N'${dataPath}ApprovalFlow.mdf', MOVE 'ApprovalFlow_log' TO N'${logPath}ApprovalFlow_log.ldf'" | Out-Null
  Sql "ALTER AUTHORIZATION ON DATABASE::[ApprovalFlow] TO [sa]" | Out-Null   # the old owner was a login on the other machine
  "  restored to $dataPath / $logPath"
}

"== 2. server\.env =="
if (Test-Path $envFile) { "  exists - kept as is" }
else {
  $jwt = node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
  @(
    'NODE_ENV=production', "PORT=$ApiPort", "APP_BASE_URL=http://localhost:$SitePort", 'TRUST_PROXY=1', 'COOKIE_SECURE=false',
    'DB_AUTH=windows', 'DB_SERVER=.', 'DB_NAME=ApprovalFlow', 'DB_ODBC_DRIVER=ODBC Driver 17 for SQL Server',
    "JWT_SECRET=$jwt", "APP_DOMAIN=$AppDomain", 'PLATFORM_HOST=', 'TENANT_SLUG=demo',
    'FIRST_LOGIN_EMAIL_VERIFICATION=true',
    '# rehearsal: no SMTP_HOST, so emails are written to STORAGE_DIR\mail as .eml files',
    'MAIL_FROM=Approvals <aw1@filebankinc.com>', "STORAGE_DIR=$DataDir"
  ) | Set-Content $envFile -Encoding ascii
  "  written (new JWT secret - everyone signs in again)"
}

"== 3. Dependencies (npm ci) =="
Push-Location $server; Invoke-Npm ci --no-audit --no-fund; Pop-Location
Push-Location (Join-Path $AppRoot 'client'); Invoke-Npm ci --no-audit --no-fund; Pop-Location

"== 4. Migrations =="
Push-Location $server; Invoke-Npm run --silent migrate; Pop-Location

"== 5. Build the API =="
Push-Location $server; Invoke-Npm run --silent build; Pop-Location

# The service must exist before anything is granted to its SID: Windows (and SQL Server's CREATE LOGIN) can only
# resolve NT SERVICE\<name> for an installed service. Until step 8 it may fail to start; step 9 restarts it.
"== 6. Windows service =="
if (Get-Service 'approvalflowapi.exe' -ErrorAction SilentlyContinue) { "  already installed" }
else {
  Push-Location $server
  Invoke-Npm install --no-save --no-audit --no-fund node-windows
  node scripts\windows-service.cjs install --local-service --depends-on MSSQLSERVER
  if ($LASTEXITCODE -ne 0) { throw 'service install failed' }
  Pop-Location
  foreach ($i in 1..30) { if (Get-Service 'approvalflowapi.exe' -ErrorAction SilentlyContinue) { break }; Start-Sleep -Seconds 1 }
  if (-not (Get-Service 'approvalflowapi.exe' -ErrorAction SilentlyContinue)) { throw 'the service did not appear after install' }
  "  installed as LocalService, starts after MSSQLSERVER"
}

"== 7. File permissions =="
icacls $server  /grant "${svcSid}:(OI)(CI)(RX)" /T /Q | Out-Null
icacls (Join-Path $AppRoot 'docs') /grant "${svcSid}:(OI)(CI)(RX)" /T /Q | Out-Null
icacls $DataDir /grant "${svcSid}:(OI)(CI)(M)" /T /Q | Out-Null
icacls $envFile /inheritance:r /grant:r "${svcSid}:R" 'Administrators:F' 'SYSTEM:F' /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'icacls failed' }
"  server + docs: read; $DataDir : modify; .env: service read-only, admins full"

"== 8. Database permissions for $svcSid =="
$grant = Join-Path $env:TEMP 'af-grant.sql'
(Get-Content (Join-Path $server 'scripts\grant-app-permissions.sql') -Raw).Replace('DOMAIN\svc-approvalflow', $svcSid) | Set-Content $grant -Encoding utf8
$out = sqlcmd -S . -E -C -b -i $grant
if ($LASTEXITCODE -ne 0) { $out; throw 'grant-app-permissions.sql failed (SQL output above)' }
"  granted (read/write, audit tables locked, EXECUTE on PurgeTenant)"

"== 9. IIS site (builds the client and manuals, restarts the service) =="
$hosts = @(Sql "SELECT COALESCE(Host, Slug + '.$AppDomain') FROM ApprovalFlow.dbo.Tenants WHERE RemovedAt IS NULL" |
           ForEach-Object { $_.Trim() } | Where-Object { $_ })
"  customer addresses: $($hosts -join ', ')"
& (Join-Path $AppRoot 'scripts\deploy-local-iis.ps1') -SitePort $SitePort -ApiPort $ApiPort -Hosts $hosts
