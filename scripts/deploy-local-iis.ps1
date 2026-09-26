# Local IIS trial deployment. Run elevated from anywhere:
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-local-iis.ps1            (deploy / redeploy)
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-local-iis.ps1 -Remove    (undo everything this script created)
#
# Creates ONLY: IIS app pool + site "ApprovalFlow" on http://localhost:<SitePort>, the folder C:\inetpub\ApprovalFlow,
# and a background Node process (production build) on <ApiPort>. It touches no other site.
# The one server-wide setting it adds (if missing) is HTTP_X_FORWARDED_HOST in the URL Rewrite allow-list: without it
# IIS refuses the proxy rule that tells the API which customer an address belongs to. It only permits a rule to set
# that header - sites that do not set it are unaffected - and it is left in place by -Remove.
# The API runs as a plain background process under the current user - fine for a trial; for a real server install the
# Windows service instead (docs/DEPLOYMENT-IIS.md section 4). If that service IS installed, this script restarts it
# rather than starting a second copy, and -Remove leaves it alone (uninstall it with windows-service.cjs).
#
# Multi-customer: pass -Hosts to add a binding per customer sub-site, e.g.
#   ... -Hosts acme.approvalflow.localhost,globex.approvalflow.localhost
# (with powershell -File, quote each one: -Hosts "acme.approvalflow.localhost","globex.approvalflow.localhost")
# (*.localhost resolves to 127.0.0.1 in Chrome and Edge without touching DNS or the hosts file.)
# The global management console is served at http://localhost:<SitePort>/global.
param([int]$SitePort = 8088, [int]$ApiPort = 4110, [string[]]$Hosts = @(), [switch]$Remove)

$ErrorActionPreference = 'Stop'
$root    = Split-Path -Parent $PSScriptRoot
$name    = 'ApprovalFlow'
$webRoot = "C:\inetpub\$name"
$pidFile = Join-Path $root 'server\storage\local-iis-api.pid'
$appcmd  = "$env:windir\system32\inetsrv\appcmd.exe"

# The Windows service, when the API has been installed as one (docs/DEPLOYMENT-IIS.md section 4).
function Get-ApiService { Get-Service -Name 'approvalflowapi.exe' -ErrorAction SilentlyContinue }

function Stop-Api {
  if (Test-Path $pidFile) {
    $apiPid = [int](Get-Content $pidFile)
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$apiPid" -ErrorAction SilentlyContinue
    # only ever stop the process we started: same PID AND it is node running dist/index.js
    if ($proc -and $proc.Name -eq 'node.exe' -and $proc.CommandLine -like '*dist/index.js*') { Stop-Process -Id $apiPid -Force -Confirm:$false; "Stopped API process $apiPid" }
    Clear-Content $pidFile
  }
}

if ($Remove) {
  Stop-Api
  if (& $appcmd list site /name:$name) { & $appcmd delete site $name | Out-Null; "Removed IIS site $name" }
  if (& $appcmd list apppool /name:$name) { & $appcmd delete apppool $name | Out-Null; "Removed app pool $name" }
  "Left in place (delete by hand if you like): $webRoot"
  if (Get-ApiService) { "Left running: the Windows service - remove it with: node server\scripts\windows-service.cjs uninstall" }
  return
}

foreach ($p in $SitePort, $ApiPort) {
  $busy = netstat -ano | Select-String 'LISTENING' | Select-String ":$p\s"
  $ours = (& $appcmd list site /name:$name) -or (Test-Path $pidFile) -or (Get-ApiService)
  if ($busy -and -not $ours) { throw "Port $p is already in use - pass -SitePort / -ApiPort" }
}

"== Building =="
Push-Location (Join-Path $root 'server'); npm run --silent build; if (-not $?) { throw 'server build failed' }; Pop-Location
node (Join-Path $root 'docs\manuals\build-manuals.cjs'); if (-not $?) { throw 'manual build failed' } # the API serves them, to signed-in people only, from docs\manuals
Push-Location (Join-Path $root 'client'); npm run --silent build; if (-not $?) { throw 'client build failed' }; Pop-Location

"== Publishing static files to $webRoot =="
New-Item -ItemType Directory -Force $webRoot | Out-Null
robocopy (Join-Path $root 'client\dist') $webRoot /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
# local trial runs over plain HTTP on a different API port: adjust the copied web.config (the source file stays production-ready)
$cfg = Join-Path $webRoot 'web.config'
(Get-Content $cfg -Raw).
  Replace('http://localhost:4100/api/', "http://localhost:$ApiPort/api/").
  Replace('<set name="HTTP_X_FORWARDED_PROTO" value="https" />', '<set name="HTTP_X_FORWARDED_PROTO" value="http" />').
  Replace('        <add name="Strict-Transport-Security" value="max-age=31536000" />' + "`r`n", '').
  Replace('        <add name="Strict-Transport-Security" value="max-age=31536000" />' + "`n", '') |
  Set-Content $cfg -Encoding ascii

"== IIS site =="
# the proxy rule passes the customer's host name through to the API; IIS will not let a rule set a
# server variable that is not on this allow-list, and answers 500 if it tries
$allowed = (& $appcmd list config -section:system.webServer/rewrite/allowedServerVariables) -join "`n"
if ($allowed -notlike '*HTTP_X_FORWARDED_HOST*') {
  & $appcmd set config -section:system.webServer/rewrite/allowedServerVariables /+"[name='HTTP_X_FORWARDED_HOST']" /commit:apphost | Out-Null
  "Allowed the server variable HTTP_X_FORWARDED_HOST (server-wide, additive)"
}
if (-not (& $appcmd list apppool /name:$name)) { & $appcmd add apppool /name:$name /managedRuntimeVersion:"" | Out-Null }
if (-not (& $appcmd list site /name:$name)) {
  & $appcmd add site /name:$name "/bindings:http/*:${SitePort}:" /physicalPath:$webRoot | Out-Null
  & $appcmd set app "$name/" /applicationPool:$name | Out-Null
}
# one binding per customer sub-site, so each customer can be reached by its own host name
# tolerate -Hosts arriving as one comma-separated string (powershell -File does not split it)
$Hosts = @($Hosts | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
foreach ($h in $Hosts) {
  $binding = "http/*:${SitePort}:$h"
  $existing = & $appcmd list site /name:$name /text:bindings
  if ($existing -notlike "*:${SitePort}:$h*") {
    & $appcmd set site /site.name:$name /+"bindings.[protocol='http',bindingInformation='*:${SitePort}:$h']" | Out-Null
    "Added binding $binding"
  }
}

& $appcmd start site $name | Out-Null

"== API (production build) on port $ApiPort =="
$logDir = Join-Path $root 'server\storage\logs'; New-Item -ItemType Directory -Force $logDir | Out-Null
$svc = Get-ApiService
if ($svc) {
  # the service carries its own PORT/APP_BASE_URL (set when it was installed), so it is simply restarted
  Stop-Api   # in case an earlier run of this script also left a background copy behind
  Restart-Service -Name $svc.Name -Force
  "Restarted the Windows service '$($svc.DisplayName)' with the new build"
} else {
Stop-Api
$env:NODE_ENV = 'production'; $env:PORT = "$ApiPort"; $env:APP_BASE_URL = "http://localhost:$SitePort"; $env:COOKIE_SECURE = 'false'; $env:TRUST_PROXY = '1'
$api = Start-Process node -ArgumentList 'dist/index.js' -WorkingDirectory (Join-Path $root 'server') -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $logDir 'local-iis-api.out.log') -RedirectStandardError (Join-Path $logDir 'local-iis-api.err.log')
$env:NODE_ENV = $null; $env:PORT = $null; $env:APP_BASE_URL = $null; $env:COOKIE_SECURE = $null; $env:TRUST_PROXY = $null
Set-Content $pidFile $api.Id
"Started a background API process (PID $($api.Id)) - install the Windows service for something long-lived"
}

Start-Sleep -Seconds 5
"== Verify =="
foreach ($u in "http://localhost:$SitePort/api/v1/health", "http://localhost:$SitePort/", "http://localhost:$SitePort/admin/requests", "http://localhost:$SitePort/global") {
  try { $r = Invoke-WebRequest -UseBasicParsing $u; "{0}  {1}  {2}" -f $r.StatusCode, $u, ($r.Content.Substring(0, [Math]::Min(40, $r.Content.Length)) -replace '\s+', ' ') }
  catch { "FAILED  $u  $($_.Exception.Message)" }
}
if (Get-ApiService) { "Service output: server\dist\daemon\*.log" } else { "Logs in $logDir" }
"Open http://localhost:$SitePort/login   (customer portal)"
"     http://localhost:$SitePort/global  (global management console)"
foreach ($h in $Hosts) { "     http://${h}:$SitePort/login  (customer sub-site)" }
