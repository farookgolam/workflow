# NEW DEVELOPMENT SERVER (Windows Server 2022) - the only file you need to get onto it.
# Paste this text into Notepad on the server, save it as C:\dev-bootstrap.ps1, then in an elevated PowerShell:
#   powershell -ExecutionPolicy Bypass -File C:\dev-bootstrap.ps1
# Installs Git, clones the private repo (a GitHub sign-in window appears once), then runs the repo's own
# scripts\dev-server-prereqs.ps1 (SQL Server Developer, ODBC, sqlcmd, Node 24, Claude Code) and
# scripts\azure-vm-dev-setup.ps1 (dev database, .env, npm ci, migrations). No backup file needed: without one
# the dev database is created fresh with demo data. Safe to re-run.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'
$Repo = 'https://github.com/farookgolam/workflow.git'; $DevRoot = 'C:\dev\approvalflow'
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrators')) {
  throw 'Run this in an elevated PowerShell (Run as administrator)'
}

"== Git =="
if (Get-Command git -ErrorAction SilentlyContinue) { "  already installed: $(git --version)" }
else {
  $rel   = Invoke-RestMethod -UseBasicParsing 'https://api.github.com/repos/git-for-windows/git/releases/latest'
  $asset = $rel.assets | Where-Object { $_.name -match '^Git-[\d.]+-64-bit\.exe$' } | Select-Object -First 1
  $exe   = Join-Path $env:TEMP $asset.name
  "  downloading $($asset.browser_download_url)"
  Invoke-WebRequest -UseBasicParsing $asset.browser_download_url -OutFile $exe
  if ((Get-AuthenticodeSignature $exe).Status -ne 'Valid') { throw 'Git installer signature is not valid - not installing it' }
  $p = Start-Process $exe -ArgumentList '/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES' -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "Git installer exit code $($p.ExitCode)" }
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  "  installed: $(git --version)"
}

"== Clone =="
if (Test-Path (Join-Path $DevRoot '.git')) { git -C $DevRoot pull --ff-only }
else {
  New-Item -ItemType Directory -Force (Split-Path $DevRoot) | Out-Null
  "  a GitHub sign-in window appears: choose 'Sign in with your browser'"
  git clone $Repo $DevRoot
}
if ($LASTEXITCODE -ne 0) { throw 'git clone/pull failed' }

"== Prerequisites =="
& (Join-Path $DevRoot 'scripts\dev-server-prereqs.ps1') -InstallClaudeCode
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')

"== Development setup =="
& (Join-Path $DevRoot 'scripts\azure-vm-dev-setup.ps1')
