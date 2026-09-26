# One-time HTTPS certificate for the public site, on the Azure VM. Run elevated, AFTER the DNS records exist:
#   powershell -ExecutionPolicy Bypass -File C:\apps\approvalflow\scripts\azure-vm-https.ps1 -Domain vwf.filebankinc.com
#
# Downloads win-acme (the Let's Encrypt client for Windows) and its Cloudflare plugin into C:\tools\win-acme (both
# checked against pinned SHA-256 checksums), then asks for:
#   - a Cloudflare API token with Zone.DNS:Edit and Zone.Zone:Read (read from the clipboard, which is then cleared;
#     never shown or logged here), and
#   - an email address for Let's Encrypt notices.
# It requests ONE certificate for <domain> and *.<domain>, proving ownership through a temporary DNS record in
# Cloudflare (so port 80 does not have to be open), puts it in the Windows certificate store and creates the https
# bindings on port 443 of the IIS site ApprovalFlow. win-acme keeps the token encrypted and renews the certificate
# by itself (a daily scheduled task) - nothing to do every 90 days. Safe to re-run.
param(
  [Parameter(Mandatory = $true)][string]$Domain,
  [string]$Site    = 'ApprovalFlow',
  [string]$ToolDir = 'C:\tools\win-acme',
  [string]$Version = 'v2.2.9.1701'
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'
$Domain = $Domain.Trim().ToLower()
$appcmd = "$env:windir\system32\inetsrv\appcmd.exe"

"== 1. win-acme $Version =="
$wacs = Join-Path $ToolDir 'wacs.exe'
if (Test-Path $wacs) { "  already in $ToolDir" }
else {
  New-Item -ItemType Directory -Force $ToolDir | Out-Null
  $base = "https://github.com/win-acme/win-acme/releases/download/$Version"
  # wacs.exe is signed with win-acme's own self-signed (and since Feb 2026 expired) certificate, so its signature proves
  # nothing; the downloads are pinned to known SHA-256 checksums instead: the main zip's matches the one Chocolatey
  # publishes for it, the plugin's was taken from an independent download on the development PC (2026-09-26)
  $pinned = @{
    'win-acme.v2.2.9.1701.x64.pluggable.zip'           = 'A2C874E9893A1D91E0329887F72C067DCC49800A49963FA7D61C5A4E09058F0C'
    'plugin.validation.dns.cloudflare.v2.2.9.1701.zip' = '3261C9334AF67AA380C0479A5BE43E60BE46B4282CDD51C81DB0CE4ACE838CA2'
  }
  $ver = $Version.TrimStart('v')
  foreach ($zip in "win-acme.v$ver.x64.pluggable.zip", "plugin.validation.dns.cloudflare.v$ver.zip") {
    if (-not $pinned[$zip]) { throw "no known checksum for $zip - only $($pinned.Keys -join ', ') can be installed" }
    $path = Join-Path $env:TEMP $zip
    "  downloading $zip"
    Invoke-WebRequest -UseBasicParsing "$base/$zip" -OutFile $path
    $hash = (Get-FileHash $path -Algorithm SHA256).Hash
    if ($hash -ne $pinned[$zip]) { Remove-Item $path; throw "$zip has checksum $hash, expected $($pinned[$zip]) - not installing it" }
    "  checksum verified"
    Expand-Archive $path $ToolDir -Force
  }
}

"== 2. IIS site =="
$siteId = (& $appcmd list site /name:$Site /text:id)
if (-not $siteId) { throw "IIS site '$Site' not found - install the app first" }
"  $Site is site id $siteId"

"== 3. Details =="
# read from the clipboard rather than a hidden prompt: pasting into a hidden prompt over Remote Desktop can lose characters
# -AsSecureString: if the token is pasted here anyway instead of just pressing Enter, it is not echoed to the screen
Read-Host "  Copy the Cloudflare API token (Cloudflare's Copy button), then just press Enter here - do not paste" -AsSecureString | Out-Null
$token = "$(Get-Clipboard -Raw)".Trim()
Set-Clipboard -Value ' '   # do not leave the token on the clipboard
if ($token -notmatch '^[A-Za-z0-9_-]{30,}$') { throw "the clipboard does not hold a Cloudflare API token ($($token.Length) characters) - copy it again and re-run" }
"  token read from the clipboard ($($token.Length) characters) and the clipboard cleared"
# ask Cloudflare first, so a bad token gives a clear reason instead of win-acme's "No zones could be found"
$cf = @{ Authorization = "Bearer $token" }
try { $v = Invoke-RestMethod -UseBasicParsing -Headers $cf 'https://api.cloudflare.com/client/v4/user/tokens/verify' }
catch {
  $why = if ($_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
  throw "Cloudflare rejected the token ($why) - roll it again, copy the NEW value and re-run"
}
"  Cloudflare says the token is: $($v.result.status)"
$labels = $Domain.Split('.')
$zone = $null
for ($i = 0; $i -lt $labels.Count - 1 -and -not $zone; $i++) {
  $name = ($labels[$i..($labels.Count - 1)] -join '.')
  $zone = (Invoke-RestMethod -UseBasicParsing -Headers $cf "https://api.cloudflare.com/client/v4/zones?name=$name").result | Select-Object -First 1
}
if (-not $zone) {
  $all = (Invoke-RestMethod -UseBasicParsing -Headers $cf 'https://api.cloudflare.com/client/v4/zones').result
  throw "the token is valid but cannot see the zone for $Domain (it can see: $(if ($all) { ($all.name -join ', ') } else { 'no zones at all' })) - give it the Cloudflare account that holds that zone"
}
"  the token can see zone $($zone.name) (account: $($zone.account.name))"
$email = Read-Host '  Email address for Let''s Encrypt notices'
if ($email -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') { throw "'$email' is not an email address" }

"== 4. Certificate for $Domain and *.$Domain (1-3 minutes) =="
& $wacs --source manual --host "$Domain,*.$Domain" `
        --validationmode dns-01 --validation cloudflare --cloudflareapitoken $token `
        --store certificatestore --installation iis --installationsiteid $siteId `
        --accepttos --emailaddress $email --closeonfinish
$code = $LASTEXITCODE
$token = $null
if ($code -ne 0) { throw "win-acme failed (exit code $code) - read its messages above" }

"== 5. Result =="
& $appcmd list site /name:$Site /text:bindings
$task = Get-ScheduledTask | Where-Object TaskName -like 'win-acme*' | Select-Object -First 1
"  automatic renewal: " + $(if ($task) { "scheduled task '$($task.TaskName)' ($($task.State))" } else { 'NO scheduled task found - tell Claude' })
try { "  https://$Domain/api/v1/health -> " + (Invoke-WebRequest -UseBasicParsing "https://$Domain/api/v1/health").Content }
catch { "  https://$Domain/api/v1/health -> $($_.Exception.Message) (expected until the Azure firewall allows 443 - test from the VM itself works once the app settings are switched)" }
