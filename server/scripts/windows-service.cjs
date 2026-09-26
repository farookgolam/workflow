// Installs / removes the API as a Windows service so the background workers (mail, archive, reminders)
// run continuously and survive reboots. Run from an elevated prompt in the server folder:
//
//   npm install --no-save node-windows
//   node scripts/windows-service.cjs install      (or: uninstall)
//
// The service runs `node dist/index.js` with server/ as its working directory, so it reads server/.env.
// Afterwards set the service's "Log On" account (services.msc) to the account that has SQL access.
//
// Any of the settings below that are set in the installing shell are baked into the service, which is how
// one checkout can run a service on different settings from `npm run dev` (for example a local IIS trial
// on another port, with the site address as APP_BASE_URL):
//
//   set PORT=4110 & set APP_BASE_URL=http://localhost:8088 & set TRUST_PROXY=1
//   node scripts/windows-service.cjs install
//
// Everything else still comes from server/.env. Re-run install after changing them.
const path = require('node:path');

// settings worth pinning per service; NODE_ENV is always production for a service
const OVERRIDABLE = ['PORT', 'APP_BASE_URL', 'TRUST_PROXY', 'COOKIE_SECURE', 'STORAGE_DIR', 'TENANT_SLUG', 'APP_DOMAIN', 'PLATFORM_HOST'];

let Service;
try {
  ({ Service } = require('node-windows'));
} catch {
  console.error('node-windows is not installed. Run: npm install --no-save node-windows');
  process.exit(1);
}

const action = process.argv[2];
if (action !== 'install' && action !== 'uninstall') {
  console.error('Usage: node scripts/windows-service.cjs install|uninstall [--local-service] [--depends-on <service>]');
  process.exit(1);
}
const useLocalService = process.argv.includes('--local-service');

// With SQL Server on the same machine, name its service here (e.g. MSSQL$SQLEXPRESS, or MSSQLSERVER for a
// default instance). Windows then starts this service after it, instead of the API racing the database at
// boot, failing to open it, and relying on the restart-on-failure backoff to recover.
const dependsOnFlag = process.argv.indexOf('--depends-on');
const dependsOn = dependsOnFlag !== -1 ? process.argv[dependsOnFlag + 1] : null;

const { execFileSync } = require('node:child_process');
const sc = (...args) => execFileSync(`${process.env.windir}\\system32\\sc.exe`, args, { stdio: 'pipe' }).toString().trim();

/**
 * Two things the Service Control Manager does that node-windows does not.
 *
 * 1. A **service SID** (always). The process token then carries NT SERVICE\<service id>, so file
 *    permissions and the SQL login can be granted to that one identity instead of to whatever broad
 *    account the service happens to log on as - see scripts/grant-app-permissions.sql.
 * 2. **LocalService** (with --local-service). A built-in, low-privilege, password-less account: a good
 *    default when SQL Server is on the same machine. Without it the service stays on LocalSystem, which
 *    is far more privileged than this application needs.
 *
 * A true virtual account (NT SERVICE\... as the logon account) is rejected by the SCM here, because
 * node-windows names the service with a .exe suffix; the service SID above gives the same isolation for
 * permissions. On a domain, a gMSA or a dedicated account set in services.msc is better still.
 */
/** Blocks until the service reports `state`, or gives up after ~30s. sc.exe has no wait of its own. */
function waitForState(id, state, tries = 30) {
  for (let i = 0; i < tries; i++) {
    try {
      if (sc('query', id).includes(state)) return;
    } catch {
      // transient query failure; try again
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000); // sleep, synchronously
  }
  throw new Error(`service did not reach ${state} in time`);
}

/** node-windows reports the id without the .exe the SCM actually registers, so check both. */
function scmName(id) {
  for (const candidate of [`${id}.exe`, id]) {
    try {
      sc('query', candidate);
      return candidate;
    } catch {
      // not this one
    }
  }
  throw new Error(`no service found for "${id}"`);
}

function hardenIdentity(rawId) {
  let id;
  try {
    id = scmName(rawId);
  } catch (err) {
    console.error('Could not find the installed service:', err.message);
    return;
  }
  try {
    sc('sidtype', id, 'unrestricted');
    console.log(`Service SID enabled: grant file and database access to "NT SERVICE\\${id}".`);
  } catch (err) {
    console.error('Could not enable the service SID (run from an elevated prompt):', err.message);
    return;
  }

  if (dependsOn) {
    try {
      sc('config', id, 'depend=', dependsOn);
      console.log(`Starts after ${dependsOn}.`);
    } catch (err) {
      console.error(`Could not depend on ${dependsOn}:`, err.message);
    }
  } else {
    console.log('No start dependency set. With SQL Server on this machine, pass --depends-on MSSQL$SQLEXPRESS.');
  }
  if (!useLocalService) {
    console.log('Service is running as LocalSystem. Pass --local-service, or set a dedicated account in services.msc.');
    return;
  }
  try {
    try {
      sc('stop', id);
    } catch {
      // already stopped, or still stopping
    }
    // stopping takes a few seconds (the wrapper shuts its child down first); starting again too early fails
    waitForState(id, 'STOPPED');
    sc('config', id, 'obj=', 'NT AUTHORITY\\LocalService', 'password=', '');
    sc('start', id);
    waitForState(id, 'RUNNING');
    console.log('Service now runs as NT AUTHORITY\\LocalService.');
  } catch (err) {
    console.error('Could not switch the service to LocalService:', err.message);
    console.error(`Start it by hand once it settles: sc start ${id}`);
  }
}

const svc = new Service({
  name: 'ApprovalFlow API',
  description: 'Multi-tenant approval workflow API and background workers.',
  script: path.resolve(__dirname, '..', 'dist', 'index.js'),
  workingDirectory: path.resolve(__dirname, '..'),
  env: [
    { name: 'NODE_ENV', value: 'production' },
    ...OVERRIDABLE.filter((k) => process.env[k]).map((k) => ({ name: k, value: process.env[k] })),
  ],
  // restart on crash, backing off, but give up if it is crash-looping
  wait: 2,
  grow: 0.5,
  maxRestarts: 10,
});

svc.on('install', () => {
  console.log('Service installed. Starting...');
  svc.start();
  // the identity has to be set after the SCM knows about the service
  setTimeout(() => hardenIdentity(svc.id), 4000);
});
svc.on('alreadyinstalled', () => console.log('Service is already installed.'));
svc.on('start', () => console.log('Service started.'));
svc.on('uninstall', () => console.log('Service removed.'));
svc.on('error', (err) => console.error('Service error:', err));

if (action === 'install') svc.install();
else svc.uninstall();
