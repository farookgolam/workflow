# Azure VM (Windows Server 2022 + SQL Server on the same machine) - one-time prerequisites for ApprovalFlow.
# Run on the VM in an elevated PowerShell:
#   powershell -ExecutionPolicy Bypass -File azure-vm-prereqs.ps1
# Safe to re-run: every step checks first and skips what is already done.
#
# Installs/configures: IIS (static content + management console), URL Rewrite 2.1, ARR 3.0 with the proxy enabled
# and the X-Forwarded-* server variables allowed, Node.js 24 LTS (hash-checked), SQL Server max memory cap,
# and the folders C:\apps\approvalflow and C:\ApprovalFlowData. It does not touch the Azure firewall (NSG),
# create a site, or install the app - those are later steps (docs/DEPLOYMENT-IIS.md).
param([int]$SqlMaxMemoryMB = 1536)   # 4 GB VM: leave the rest for Windows, IIS and Node

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar on
$tmp    = Join-Path $env:TEMP 'af-prereqs'; New-Item -ItemType Directory -Force $tmp | Out-Null
$appcmd = "$env:windir\system32\inetsrv\appcmd.exe"

function Install-Msi($url, $file) {
  $path = Join-Path $tmp $file
  "  downloading $url"
  Invoke-WebRequest -UseBasicParsing $url -OutFile $path
  $p = Start-Process msiexec.exe -ArgumentList "/i `"$path`" /qn /norestart" -Wait -PassThru
  if ($p.ExitCode -notin 0, 3010) { throw "$file failed to install (msiexec exit code $($p.ExitCode))" }
}

"== 1. IIS =="
$features = 'Web-Server','Web-Static-Content','Web-Default-Doc','Web-Http-Errors','Web-Http-Redirect',
            'Web-Filtering','Web-Stat-Compression','Web-Mgmt-Console'
$missing = $features | Where-Object { (Get-WindowsFeature $_).InstallState -ne 'Installed' }
if ($missing) { Install-WindowsFeature $missing | Out-Null; "  installed: $($missing -join ', ')" } else { "  already installed" }

"== 2. URL Rewrite 2.1 =="
if (Test-Path "$env:windir\system32\inetsrv\rewrite.dll") { "  already installed" }
else { Install-Msi 'https://download.microsoft.com/download/1/2/8/128E2E22-C1B9-44A4-BE2A-5859ED1D4592/rewrite_amd64_en-US.msi' 'rewrite_amd64.msi'; "  installed" }

"== 3. Application Request Routing 3.0 =="
if (Test-Path "$env:ProgramFiles\IIS\Application Request Routing\requestRouter.dll") { "  already installed" }
else { Install-Msi 'https://download.microsoft.com/download/E/9/8/E9849D6A-020E-47E4-9FD0-A023E99B54EB/requestRouter_amd64.msi' 'requestRouter_amd64.msi'; "  installed" }

"== 4. ARR proxy settings =="
& $appcmd set config -section:system.webServer/proxy /enabled:"True" /preserveHostHeader:"True" /includePortInXForwardedFor:"False" /commit:apphost | Out-Null
"  proxy enabled, host header preserved"
$allowed = (& $appcmd list config -section:system.webServer/rewrite/allowedServerVariables) -join "`n"
foreach ($v in 'HTTP_X_FORWARDED_PROTO', 'HTTP_X_FORWARDED_HOST') {
  if ($allowed -notlike "*$v*") {
    & $appcmd set config -section:system.webServer/rewrite/allowedServerVariables /+"[name='$v']" /commit:apphost | Out-Null
    "  allowed server variable $v"
  } else { "  $v already allowed" }
}

"== 5. Node.js 24 LTS =="
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node -and ((& node -v) -match '^v24\.')) { "  already installed: $(& node -v)" }
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
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  "  installed: $(& node -v) (hash verified)"
}

"== 6. ODBC driver (the API connects with Windows authentication through it) =="
$odbc = Get-OdbcDriver -Platform '64-bit' | Where-Object Name -match '^ODBC Driver 1[78] for SQL Server$' | Select-Object -ExpandProperty Name
if ($odbc) { $odbc | ForEach-Object { "  found: $_" } }
else { "  NOT FOUND - install 'Microsoft ODBC Driver 18 for SQL Server' (x64) from learn.microsoft.com before the app step" }

"== 7. SQL Server max memory =="
sqlcmd -S . -E -C -b -Q "SET NOCOUNT ON; EXEC sp_configure 'show advanced options', 1; RECONFIGURE; EXEC sp_configure 'max server memory (MB)', $SqlMaxMemoryMB; RECONFIGURE;" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "could not set SQL Server max memory (sqlcmd exit code $LASTEXITCODE)" }
"  capped at $SqlMaxMemoryMB MB"

"== 8. Folders =="
foreach ($d in 'C:\apps\approvalflow', 'C:\ApprovalFlowData') { New-Item -ItemType Directory -Force $d | Out-Null; "  $d" }

""
"== Done. Summary =="
"IIS:          " + (Get-WindowsFeature Web-Server).InstallState
"URL Rewrite:  " + (Test-Path "$env:windir\system32\inetsrv\rewrite.dll")
"ARR:          " + (Test-Path "$env:ProgramFiles\IIS\Application Request Routing\requestRouter.dll")
"Node:         " + (& node -v) + " / npm " + (& npm -v)
"ODBC:         " + $(if ($odbc) { $odbc -join ', ' } else { 'MISSING' })
"SQL max mem:  " + (sqlcmd -S . -E -C -h -1 -W -Q "SET NOCOUNT ON; SELECT value_in_use FROM sys.configurations WHERE name = 'max server memory (MB)'") + " MB"
