# Packages the app source for the Azure dev VM and puts approvalflow.zip on this PC's desktop.
#   powershell -ExecutionPolicy Bypass -File scripts\package-for-vm.ps1
# Source only: no .env (secrets), node_modules, build output or local storage - the VM builds its own.
# Then on the VM: powershell -ExecutionPolicy Bypass -File C:\apps\approvalflow\scripts\azure-vm-update.ps1
$ErrorActionPreference = 'Stop'
$root  = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $env:TEMP 'af-package\approvalflow'
$zip   = Join-Path ([Environment]::GetFolderPath('Desktop')) 'approvalflow.zip'

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force -Confirm:$false }
robocopy $root $stage /E /XD node_modules dist storage storage-test .claude .git /XF .env *.tsbuildinfo *.log /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed (exit code $LASTEXITCODE)" }
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path "$stage\*" -DestinationPath $zip
Remove-Item (Split-Path $stage) -Recurse -Force -Confirm:$false

"{0}  {1:N1} MB" -f $zip, ((Get-Item $zip).Length / 1MB)
"SHA-256: " + (Get-FileHash $zip).Hash
