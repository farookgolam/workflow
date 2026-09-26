module.exports = {
  file: 'ApprovalFlow-Release-Process.pdf',
  title: 'Release Process',
  subtitle: 'Moving a change from a development machine to pre-production and production',
  audience:
    'This guide is for whoever changes and releases ApprovalFlow. It covers the path every change takes: a development machine (this PC or the dev server), GitHub, the pre-production server (vc-workflow) and, later, production. It assumes each environment is already installed.',
  version: '1.0',
  date: 'September 2026',
  blocks: [
    { h1: 'The environments' },
    { table: { widths: [0.25, 0.3, 0.45], head: ['Environment', 'Machine', 'Purpose'], rows: [
      ['Development', 'This PC, and the new dev server (C:\\dev\\approvalflow)', 'Making and testing changes with npm run dev. Test data only.'],
      ['GitHub', 'github.com/farookgolam/workflow', 'The one central copy of the code. Every change and every release goes through it.'],
      ['Pre-production', 'vc-workflow (Azure VM), C:\\apps\\approvalflow', 'Installing a release and testing it before production.'],
      ['Production', 'To be decided', 'Receives exactly the release that passed pre-production.'],
    ] } },
    { note: 'A change only reaches pre-production or production when you install a release there. Nothing is copied automatically.', kind: 'important' },

    { h1: 'Release steps' },
    { table: { widths: [0.05, 0.22, 0.28, 0.45], head: ['#', 'Where', 'What', 'Command'], rows: [
      ['1', 'Dev machine (this PC or the dev server)', 'Get the latest code before starting', 'git pull'],
      ['2', 'Dev machine', 'Make the change and test it', 'cd server; npm run dev  and  cd client; npm run dev  then open http://localhost:5173'],
      ['3', 'Dev machine', 'Save the change to GitHub', 'git add -A  then  git commit -m "what changed"  then  git push'],
      ['4', 'Dev machine', 'Mark a release (a new number each time)', 'git pull  then  git tag v1.0.1  then  git push --tags'],
      ['5', 'vc-workflow (pre-production), Administrator PowerShell', 'Install the release', 'powershell -ExecutionPolicy Bypass -File C:\\apps\\approvalflow\\scripts\\azure-vm-update.ps1 -Version v1.0.1'],
      ['6', 'vc-workflow', 'Check health, then test', '(Invoke-WebRequest -UseBasicParsing http://localhost:8088/api/v1/health).Content  should print {"status":"ok","db":"ok"}; then sign in and try the change'],
      ['7', 'Production (later), Administrator PowerShell', 'Install the SAME release', 'The same command as step 5, with the same version'],
    ] } },
    { note: 'Steps 1-3 can be repeated many times before a release. Commit and push as often as you like; tag only when a set of changes is ready for pre-production.', kind: 'tip' },

    { h1: 'What an update does' },
    { table: { widths: [0.32, 0.18, 0.5], head: ['Item', 'Automatic?', 'Notes'], rows: [
      ['Code (pages, server logic)', '**Yes**', 'Downloaded from GitHub for the chosen version'],
      ['Libraries (npm packages)', '**Yes**', 'npm ci'],
      ['Database structure (migrations)', '**Yes**', 'New migrations are applied'],
      ['Build, IIS, service restart', '**Yes**', 'Through deploy-local-iis.ps1'],
      ['Installed-version record', '**Yes**', 'C:\\apps\\approvalflow\\DEPLOYED.txt'],
      ['Settings (server\\.env)', '**No**', 'Each environment keeps its own. When a change needs a new setting, edit the file by hand and restart the service.'],
      ['Customer data (customers, users, requests)', '**No**', 'Each environment has its own database; data is never copied between them.'],
    ] } },

    { h1: 'Rolling back' },
    { table: { widths: [0.35, 0.65], head: ['Situation', 'What to do'], rows: [
      ['Bad release with **no** database change', 'Run step 5 again with the previous version, for example -Version v1.0.0'],
      ['Bad release **with** a database change', 'Going back to old code does not undo the database change. Back up the database before updating, and restore that backup if needed. Database changes are announced before such a release.'],
    ] } },

    { h1: 'Rules and checks' },
    { h2: 'Rules to follow' },
    { table: { widths: [0.45, 0.55], head: ['Rule', 'Why'], rows: [
      ['Always git pull before starting work and before tagging', 'Keeps this PC and the dev server in step, so a release includes everything'],
      ['Never edit code directly on vc-workflow or production', 'The next update overwrites it; all changes go through a dev machine and GitHub'],
      ['Test on pre-production before installing on production', 'Production then gets exactly the version that was tested'],
      ['If the health check fails right after an update, wait a minute and check again', 'The service needs a few seconds to start'],
    ] } },
    { h2: 'Useful checks on vc-workflow' },
    { table: { widths: [0.3, 0.7], head: ['Check', 'Command'], rows: [
      ['Which version is installed', 'Get-Content C:\\apps\\approvalflow\\DEPLOYED.txt'],
      ['Is the service running', 'Get-Service approvalflowapi.exe'],
      ['Is the app healthy', '(Invoke-WebRequest -UseBasicParsing http://localhost:8088/api/v1/health).Content'],
      ['Recent service errors', 'Get-ChildItem C:\\apps\\approvalflow\\server\\dist\\daemon\\*.err.log | Get-Content -Tail 20'],
    ] } },
  ],
};
