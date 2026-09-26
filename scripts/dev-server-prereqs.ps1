# DEVELOPMENT server (Windows Server 2022) - one-time prerequisites, run BEFORE azure-vm-dev-setup.ps1.
# Run on the new server in an elevated PowerShell:
#   powershell -ExecutionPolicy Bypass -File dev-server-prereqs.ps1
#   powershell -ExecutionPolicy Bypass -File dev-server-prereqs.ps1 -InstallClaudeCode
# Safe to re-run: every step checks first and skips what is already done.
#
# Installs: SQL Server 2022 Developer edition (free for dev/test; default instance MSSQLSERVER, database engine only,
# local connections only), ODBC Driver 17 + sqlcmd (if SQL setup did not bring them), Node.js 24 LTS (hash-checked),
# Git for Windows, optionally Claude Code; caps SQL Server memory; creates C:\dev and C:\apps.
# Every Microsoft/Git download must carry a valid Authenticode signature or it is not run.
# No IIS: development runs with 'npm run dev'.
param(
  [int]$SqlMaxMemoryMB = 0,          # 0 = half of this server's RAM (min 1024)
  [switch]$InstallClaudeCode
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar on
$tmp = Join-Path $env:TEMP 'af-dev-prereqs'; New-Item -ItemType Directory -Force $tmp | Out-Null

function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }
function Get-Signed($url, $file) {
  $path = Join-Path $tmp $file
  "  downloading $url"
  Invoke-WebRequest -UseBasicParsing $url -OutFile $path
  $sig = Get-AuthenticodeSignature $path
  if ($sig.Status -ne 'Valid') { throw "$file signature is $($sig.Status) - not running it" }
  $path
}
function Install-Msi($url, $file, [string]$extra = '') {
  $path = Get-Signed $url $file
  $p = Start-Process msiexec.exe -ArgumentList "/i `"$path`" /qn /norestart $extra" -Wait -PassThru
  if ($p.ExitCode -notin 0, 3010) { throw "$file failed to install (msiexec exit code $($p.ExitCode))" }
}
function Find-Odbc { Get-OdbcDriver -Platform '64-bit' | Where-Object Name -match '^ODBC Driver 1[78] for SQL Server$' | Select-Object -ExpandProperty Name }

"== 1. SQL Server 2022 Developer =="
if (Get-Service MSSQLSERVER -ErrorAction SilentlyContinue) { "  default instance MSSQLSERVER already installed - kept" }
else {
  $ssei  = Get-Signed 'https://go.microsoft.com/fwlink/p/?linkid=2215158' 'SQL2022-SSEI-Dev.exe'
  $media = Join-Path $tmp 'sqlmedia'; New-Item -ItemType Directory -Force $media | Out-Null
  "  downloading the installation media (about 1.1 GB, several minutes)"
  $p = Start-Process $ssei -ArgumentList '/ACTION=Download', "/MEDIAPATH=`"$media`"", '/MEDIATYPE=CAB', '/QUIET' -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "SQL media download failed (exit code $($p.ExitCode))" }
  $pkg = Get-ChildItem $media -Filter 'SQLServer2022-*.exe' | Select-Object -First 1
  if (-not $pkg) { throw "no SQLServer2022-*.exe found in $media after the download" }
  $sig = Get-AuthenticodeSignature $pkg.FullName
  if ($sig.Status -ne 'Valid') { throw "$($pkg.Name) signature is $($sig.Status) - not running it" }
  $src = Join-Path $media 'setup'
  "  extracting $($pkg.Name)"
  $p = Start-Process $pkg.FullName -ArgumentList '/q', "/x:`"$src`"" -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "extracting SQL media failed (exit code $($p.ExitCode))" }
  "  installing the database engine (10-20 minutes)"
  $me = "$env:USERDOMAIN\$env:USERNAME"
  $setupArgs = '/Q', '/ACTION=Install', '/FEATURES=SQLENGINE', '/INSTANCENAME=MSSQLSERVER',
               "/SQLSYSADMINACCOUNTS=`"$me`" `"BUILTIN\Administrators`"", '/SQLSVCSTARTUPTYPE=Automatic',
               '/TCPENABLED=0', '/UPDATEENABLED=False', '/IACCEPTSQLSERVERLICENSETERMS', '/SUPPRESSPRIVACYSTATEMENTNOTICE'
  $p = Start-Process (Join-Path $src 'setup.exe') -ArgumentList $setupArgs -Wait -PassThru
  if ($p.ExitCode -notin 0, 3010) {
    throw "SQL Server setup failed (exit code $($p.ExitCode)) - see C:\Program Files\Microsoft SQL Server\160\Setup Bootstrap\Log\Summary.txt"
  }
  "  installed (sysadmins: $me, BUILTIN\Administrators; TCP off - this machine only)"
  if ($p.ExitCode -eq 3010) { "  NOTE: SQL setup asks for a restart - restart the server before azure-vm-dev-setup.ps1" }
  Refresh-Path
}

"== 2. ODBC driver (the API connects with Windows authentication through it) =="
$odbc = Find-Odbc
if ($odbc) { $odbc | ForEach-Object { "  found: $_" } }
else {
  Install-Msi 'https://go.microsoft.com/fwlink/?linkid=2266337' 'msodbcsql17.msi' 'IACCEPTMSODBCSQLLICENSETERMS=YES'
  $odbc = Find-Odbc
  "  installed: $($odbc -join ', ')"
}

"== 3. sqlcmd =="
if (Get-Command sqlcmd -ErrorAction SilentlyContinue) { "  already installed" }
else {
  Install-Msi 'https://go.microsoft.com/fwlink/?linkid=2230791' 'MsSqlCmdLnUtils.msi' 'IACCEPTMSSQLCMDLNUTILSLICENSETERMS=YES'
  Refresh-Path
  if (-not (Get-Command sqlcmd -ErrorAction SilentlyContinue)) { throw 'sqlcmd still not on PATH - open a new PowerShell window and re-run' }
  "  installed"
}

"== 4. SQL Server max memory =="
if ($SqlMaxMemoryMB -le 0) {
  $ramMB = [int]((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1MB)
  $SqlMaxMemoryMB = [Math]::Max(1024, [int]($ramMB / 2))
}
sqlcmd -S . -E -C -b -Q "SET NOCOUNT ON; EXEC sp_configure 'show advanced options', 1; RECONFIGURE; EXEC sp_configure 'max server memory (MB)', $SqlMaxMemoryMB; RECONFIGURE;" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "could not set SQL Server max memory (sqlcmd exit code $LASTEXITCODE)" }
"  capped at $SqlMaxMemoryMB MB"

"== 5. Node.js 24 LTS (the app needs 24.7 or later) =="
$nodeOk = $false
if (Get-Command node -ErrorAction SilentlyContinue) {
  $v = [version]((& node -v).TrimStart('v'))
  $nodeOk = $v -ge [version]'24.7'
}
if ($nodeOk) { "  already installed: $(& node -v)" }
else {
  $base = 'https://nodejs.org/dist/latest-v24.x'
  $sums = (Invoke-WebRequest -UseBasicParsing "$base/SHASUMS256.txt").Content -split "`n"
  $line = $sums | Where-Object { $_ -match '\s(node-v24\.\d+\.\d+-x64\.msi)\s*$' } | Select-Object -First 1
  if (-not $line) { throw "could not find the Node 24 x64 MSI in $base/SHASUMS256.txt" }
  $expected, $file = ($line.Trim() -split '\s+')
  $path = Join-Path $tmp $file
  "  downloading $base/$file"
  Invoke-WebRequest -UseBasicParsing "$base/$file" -OutFile $path
  if ((Get-FileHash $path -Algorithm SHA256).Hash -ne $expected.ToUpper()) { throw "$file failed its SHA-256 check - not installing it" }
  $p = Start-Process msiexec.exe -ArgumentList "/i `"$path`" /qn /norestart" -Wait -PassThru
  if ($p.ExitCode -notin 0, 3010) { throw "Node failed to install (msiexec exit code $($p.ExitCode))" }
  Refresh-Path
  "  installed: $(& node -v) (hash verified)"
}

"== 6. Git for Windows =="
if (Get-Command git -ErrorAction SilentlyContinue) { "  already installed: $(git --version)" }
else {
  $rel   = Invoke-RestMethod -UseBasicParsing 'https://api.github.com/repos/git-for-windows/git/releases/latest'
  $asset = $rel.assets | Where-Object { $_.name -match '^Git-[\d.]+-64-bit\.exe$' } | Select-Object -First 1
  if (-not $asset) { throw 'could not find the Git for Windows 64-bit installer in the latest release' }
  $exe = Get-Signed $asset.browser_download_url $asset.name
  $p = Start-Process $exe -ArgumentList '/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES' -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "Git installer exit code $($p.ExitCode)" }
  Refresh-Path
  "  installed: $(git --version)"
}

"== 7. Claude Code =="
if (-not $InstallClaudeCode) { "  skipped (re-run with -InstallClaudeCode to add it)" }
elseif (Get-Command claude -ErrorAction SilentlyContinue) { "  already installed: $(claude --version)" }
else {
  Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
  Refresh-Path
  "  installed for $env:USERNAME - run 'claude' in C:\dev\approvalflow and sign in"
}

"== 8. Folders =="
foreach ($d in 'C:\dev', 'C:\apps') { New-Item -ItemType Directory -Force $d | Out-Null; "  $d" }

""
"== Done. Summary =="
"SQL Server:   " + (sqlcmd -S . -E -C -h -1 -W -Q "SET NOCOUNT ON; SELECT CAST(SERVERPROPERTY('Edition') AS nvarchar(100)) + ' ' + CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(50))")
"SQL max mem:  $SqlMaxMemoryMB MB"
"ODBC:         " + $(if ($odbc) { $odbc -join ', ' } else { 'MISSING' })
"Node:         " + (& node -v) + " / npm " + (& npm -v)
"Git:          " + (git --version)
""
"Next: put the database backup at C:\apps\ApprovalFlow.bak (or pass -BackupFile), then run"
"  powershell -ExecutionPolicy Bypass -File azure-vm-dev-setup.ps1"
