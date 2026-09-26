# One-time DEVELOPMENT setup on the Azure VM, next to (never inside) the installed app in C:\apps\approvalflow.
# Run on the VM, elevated, in a Remote Desktop session that shares the development PC's C: drive:
#   powershell -ExecutionPolicy Bypass -File azure-vm-dev-setup.ps1
#
#   Git for Windows (latest, if missing) -> clone into C:\dev\approvalflow (a GitHub sign-in window appears once)
#   -> database ApprovalFlow_Dev restored from the rehearsal backup -> server\.env on port 4200 (the installed
#   service owns 4100) and client\.env.local pointing the UI's proxy at it -> npm ci + migrate
#   -> Claude Code's notes about this project copied from the PC.
# Safe to re-run: existing clone, database and .env files are kept.
param(
  [string]$Repo       = 'https://github.com/farookgolam/workflow.git',
  [string]$DevRoot    = 'C:\dev\approvalflow',
  [string]$BackupFile = 'C:\apps\ApprovalFlow.bak',
  [string]$DevDb      = 'ApprovalFlow_Dev',
  [int]$DevApiPort    = 4200,
  [string]$PcMemory   = '\\tsclient\C\Users\Administrator\.claude\projects\C--Claude-Learning-Claude-Code-WF\memory'
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'
function Invoke-Npm { npm.cmd @args; if ($LASTEXITCODE -ne 0) { throw "npm $($args -join ' ') failed" } }
function Sql($q) { $out = sqlcmd -S . -E -C -b -h -1 -W -Q "SET NOCOUNT ON; $q"; if ($LASTEXITCODE -ne 0) { throw "SQL failed: $q`n$out" }; $out }

"== 1. Git =="
if (Get-Command git -ErrorAction SilentlyContinue) { "  already installed: $(git --version)" }
else {
  $rel   = Invoke-RestMethod -UseBasicParsing 'https://api.github.com/repos/git-for-windows/git/releases/latest'
  $asset = $rel.assets | Where-Object { $_.name -match '^Git-[\d.]+-64-bit\.exe$' } | Select-Object -First 1
  if (-not $asset) { throw 'could not find the Git for Windows 64-bit installer in the latest release' }
  $exe = Join-Path $env:TEMP $asset.name
  "  downloading $($asset.browser_download_url)"
  Invoke-WebRequest -UseBasicParsing $asset.browser_download_url -OutFile $exe
  $sig = Get-AuthenticodeSignature $exe
  if ($sig.Status -ne 'Valid') { throw "installer signature is $($sig.Status) - not installing it" }
  "  signature valid: $($sig.SignerCertificate.Subject)"
  $p = Start-Process $exe -ArgumentList '/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES' -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "Git installer exit code $($p.ExitCode)" }
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  "  installed: $(git --version)"
}

"== 2. Clone =="
if (Test-Path (Join-Path $DevRoot '.git')) { "  $DevRoot already cloned - run 'git pull' there to update" }
else {
  New-Item -ItemType Directory -Force (Split-Path $DevRoot) | Out-Null
  "  a GitHub sign-in window may appear: choose 'Sign in with your browser'"
  git clone $Repo $DevRoot
  if ($LASTEXITCODE -ne 0) { throw 'git clone failed' }
}

"== 3. Dev database $DevDb =="
if ((Sql "SELECT COUNT(*) FROM sys.databases WHERE name = '$DevDb'").Trim() -ne '0') { "  already exists - kept" }
else {
  if (-not (Test-Path $BackupFile)) { throw "backup not found: $BackupFile" }
  $dataPath = (Sql "SELECT CAST(SERVERPROPERTY('InstanceDefaultDataPath') AS nvarchar(400))").Trim()
  $logPath  = (Sql "SELECT CAST(SERVERPROPERTY('InstanceDefaultLogPath') AS nvarchar(400))").Trim()
  Sql "RESTORE DATABASE [$DevDb] FROM DISK = N'$BackupFile' WITH CHECKSUM, MOVE 'ApprovalFlow' TO N'${dataPath}$DevDb.mdf', MOVE 'ApprovalFlow_log' TO N'${logPath}${DevDb}_log.ldf'" | Out-Null
  Sql "ALTER AUTHORIZATION ON DATABASE::[$DevDb] TO [sa]" | Out-Null
  "  restored from $BackupFile (a copy - the installed app's ApprovalFlow database is untouched)"
}

"== 4. Settings =="
$envFile = Join-Path $DevRoot 'server\.env'
if (Test-Path $envFile) { "  server\.env exists - kept" }
else {
  $jwt = node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
  @(
    'NODE_ENV=development', "PORT=$DevApiPort", 'APP_BASE_URL=http://localhost:5173', 'TRUST_PROXY=0', 'COOKIE_SECURE=false',
    'DB_AUTH=windows', 'DB_SERVER=.', "DB_NAME=$DevDb", 'DB_ODBC_DRIVER=ODBC Driver 17 for SQL Server',
    "JWT_SECRET=$jwt", 'APP_DOMAIN=approvalflow.localhost', 'PLATFORM_HOST=', 'TENANT_SLUG=demo',
    '# no SMTP_HOST: emails are written to server\storage\mail as .eml files'
  ) | Set-Content $envFile -Encoding ascii
  "  server\.env written (API on $DevApiPort, database $DevDb)"
}
$clientEnv = Join-Path $DevRoot 'client\.env.local'
if (Test-Path $clientEnv) { "  client\.env.local exists - kept" }
else { "API_TARGET=http://localhost:$DevApiPort" | Set-Content $clientEnv -Encoding ascii; "  client\.env.local written (UI proxies to $DevApiPort)" }

"== 5. Libraries and migrations =="
Push-Location (Join-Path $DevRoot 'server'); Invoke-Npm ci --no-audit --no-fund; Invoke-Npm run --silent migrate; Pop-Location
Push-Location (Join-Path $DevRoot 'client'); Invoke-Npm ci --no-audit --no-fund; Pop-Location

"== 6. Claude Code project notes =="
# Claude Code keys a project's notes by its folder: C:\dev\approvalflow -> C--dev-approvalflow
$memDir = Join-Path $env:USERPROFILE ('.claude\projects\' + ($DevRoot -replace '[^A-Za-z0-9]', '-') + '\memory')
if (Test-Path (Join-Path $memDir 'MEMORY.md')) { "  notes already present in $memDir - kept" }
elseif (-not (Test-Path $PcMemory)) { "  skipped: $PcMemory not reachable (share the PC's C: drive in Remote Desktop and re-run)" }
else {
  New-Item -ItemType Directory -Force $memDir | Out-Null
  # the note about other apps on the development PC does not apply to this machine
  Get-ChildItem $PcMemory -File | Where-Object Name -ne 'machine-other-approvals-apps.md' | Copy-Item -Destination $memDir
  $index = Join-Path $memDir 'MEMORY.md'
  (Get-Content $index | Where-Object { $_ -notmatch 'machine-other-approvals-apps' }) | Set-Content $index -Encoding utf8
  "  copied to $memDir"
}

""
"== Done =="
"Develop in $DevRoot (open THIS folder in Claude Code - not C:\apps\approvalflow, which is the installed app)."
"Run it with two windows:"
"  cd $DevRoot\server ; npm run dev     -> API + workers on http://localhost:$DevApiPort"
"  cd $DevRoot\client ; npm run dev     -> UI on http://localhost:5173/login"
"Sync with the PC:  git pull  (before starting)  /  git add -A ; git commit -m '...' ; git push  (when done)"
