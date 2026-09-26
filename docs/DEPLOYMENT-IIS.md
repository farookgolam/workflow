# Deploying to Windows Server + IIS

**Recommended topology:** IIS serves the built React app as static files and reverse-proxies `/api/*`
to the Node API, which runs as a **Windows service**.

```
Browser ──HTTPS──> IIS site (client/dist + web.config)
                     ├── static files, SPA fallback      (IIS)
                     └── /api/*  ──http://localhost:4100──> "ApprovalFlow API" Windows service (Node)
                                                              ├── Express API
                                                              └── workers: mail outbox · PDF archive · reminders
                                                                   └── SQL Server (Windows auth)
```

### Why not iisnode?
The API hosts three background workers (email outbox, PDF archive into the database, reminder /
escalation sweeper). Under iisnode the Node process lives and dies with the IIS application pool: idle
time-outs and recycles would silently stop retries and reminders until the next web request arrives.
A Windows service runs continuously and restarts on failure. iisnode is also no longer maintained.
If you must use it anyway, see [Appendix A](#appendix-a-iisnode).

---

> **Trying it on one machine?** `powershell -ExecutionPolicy Bypass -File scripts\deploy-local-iis.ps1` builds everything and creates a
> local site on http://localhost:8088 (API on 4110, plain HTTP, runs as a background process). `-Remove` undoes it.

## 1. Prerequisites (once per server)

| Component | Notes |
|---|---|
| Node.js 24 LTS (x64) | `node -v` ≥ 24.7 - the API uses Node's built-in Argon2 |
| SQL Server 2019+ | TCP/IP enabled if you use `DB_AUTH=sql`; any protocol for `DB_AUTH=windows` |
| Microsoft ODBC Driver 17 (or 18) for SQL Server | needed for Windows authentication; set `DB_ODBC_DRIVER` to match |
| IIS with **URL Rewrite 2.1** and **Application Request Routing 3.0** | both from iis.net |
| A TLS certificate bound to the site | the refresh cookie is `Secure` in production. Hosting several customers: a **wildcard** certificate (`*.approvals.example.com`) |
| A wildcard DNS record | `*.approvals.example.com` -> this server, so adding a customer needs no DNS work |
| Arial fonts (`C:\Windows\Fonts\arial*.ttf`) | present by default; used for Unicode text in PDFs |

Enable the ARR proxy (elevated prompt). ARR appends the client TCP port to X-Forwarded-For by default; the API strips it, so `/includePortInXForwardedFor` is optional and can be left out if other sites on the server rely on the default:

```bat
%windir%\system32\inetsrv\appcmd set config -section:system.webServer/proxy /enabled:"True" /preserveHostHeader:"True" /includePortInXForwardedFor:"False" /commit:apphost
%windir%\system32\inetsrv\appcmd set config -section:system.webServer/rewrite/allowedServerVariables /+"[name='HTTP_X_FORWARDED_PROTO']" /commit:apphost
%windir%\system32\inetsrv\appcmd set config -section:system.webServer/rewrite/allowedServerVariables /+"[name='HTTP_X_FORWARDED_HOST']" /commit:apphost
```

`HTTP_X_FORWARDED_HOST` is what makes **multi-customer** hosting work: the API picks the customer from the host name,
and without that header every customer would arrive at the API as `localhost`. `web.config` sets it on the proxy rule
and `TRUST_PROXY=1` tells the API to believe it.

## 2. Service account and database

1. Create a dedicated account for the service (a gMSA or a plain domain/local account), e.g. `DOMAIN\svc-approvalflow`.
2. As an administrator, create the schema:
   ```bat
   cd C:\apps\approvalflow\server
   copy .env.example .env        &  rem then edit - see section 3
   npm ci
   npm run migrate
   ```
3. Grant the service account least-privilege access: edit the two placeholders in
   [`server/scripts/grant-app-permissions.sql`](../server/scripts/grant-app-permissions.sql) and run it in SSMS.
   (The runtime account gets read/write only, and is explicitly denied rewriting the audit log.)
4. Create the organisation and its first administrator (once):
   ```bat
   npm run seed:tenant -- --name "Acme Corp" --email admin@acme.com --displayName "Acme Admin"
   ```
   A random 6-digit password key is printed once; alternatively set `SEED_ADMIN_KEY` first. Do **not** run `seed:demo` in production (it refuses to).
   Everyone else registers themselves at first sign-in; the administrator then grants roles on the Users page.
   To make an already-registered account an administrator from the server: `npm run grant-role -- --email you@example.com --role Admin`.

## 3. Configure `server/.env`

```ini
NODE_ENV=production
PORT=4100
APP_BASE_URL=https://approvals.example.com      # used for every link in emails
TRUST_PROXY=1                                   # exactly one proxy (IIS) in front - makes audit IPs the real client IPs
COOKIE_SECURE=true

DB_AUTH=windows
DB_SERVER=SQLHOST\INSTANCE
DB_NAME=ApprovalFlow

# Accounts: users create their own 6-digit key at first sign-in, after proving their address with an emailed code
FIRST_LOGIN_EMAIL_VERIFICATION=true             # keep true: without it anyone can claim a colleague's address
ALLOWED_EMAIL_DOMAINS=example.com               # only these domains may register (comma separated; empty = anyone)

JWT_SECRET=<48+ random chars: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))">

SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false                               # true only for implicit TLS (465)
SMTP_USER=...
SMTP_PASSWORD=...
MAIL_FROM=Approvals <approvals@example.com>

STORAGE_DIR=D:\ApprovalFlowData                 # dry-run mail and logs; PDFs are kept in the database
MANUALS_DIR=D:\ApprovalFlow\docs\manuals        # the PDF manuals behind Help (default ..\docs\manuals); signed-in people only
```

* Lock the file down: `icacls .env /inheritance:r /grant:r "DOMAIN\svc-approvalflow:R" "Administrators:F"`.
* Give the service account **Modify** on `STORAGE_DIR` and **Read** on the `server` folder and on `MANUALS_DIR`.
* Rotating `JWT_SECRET` signs everyone out (access tokens become invalid; refresh cookies still work, so users are re-issued tokens silently).

### PDF archive
The PDF of every approved or rejected request is kept in the database (table `RequestDocuments`), where it can never be changed or
deleted, and is downloaded from the portal. There is nothing to configure. Earlier versions could also upload it to SharePoint; that
option and its stored settings have been removed (migrations 021 and 022).

## 4. Build and install the API service

```bat
cd C:\apps\approvalflow\server
npm ci
npm run build
npm install --no-save node-windows
node scripts\windows-service.cjs install --local-service --depends-on MSSQL$SQLEXPRESS
```
Check it: `curl http://localhost:4100/api/v1/health` → `{"status":"ok","db":"ok"}`. Service output is written to `server\dist\daemon\*.log`.

The service starts automatically at boot and restarts on failure, which is the point of it: the workers
(email outbox, PDF archive, reminders) then keep running when nobody is signed in and after a reboot.

**`--depends-on` matters when SQL Server is on the same machine.** Without it the API can win the race at boot,
find the database not yet accepting connections, and log `Cannot open database` until the restart backoff
happens to catch up. Name the SQL service (`MSSQL$SQLEXPRESS`, or `MSSQLSERVER` for a default instance) and
Windows simply starts the API afterwards. Leave it off when the database is on another server - a dependency
cannot wait for a machine that is not this one, so build the delay into SQL availability instead.

### Which account it runs as

The installer always enables a **service SID**, so the process token carries `NT SERVICE\approvalflowapi.exe`
whatever account it logs on as. Grant the file permissions and the SQL login to **that** name and the identity
stops mattering:

```bat
icacls "C:\apps\approvalflow\server" /grant "NT SERVICE\approvalflowapi.exe:(OI)(CI)(RX)" /T
icacls "D:\ApprovalFlowData"         /grant "NT SERVICE\approvalflowapi.exe:(OI)(CI)(M)"  /T
rem then run grant-app-permissions.sql (§2.3) with NT SERVICE\approvalflowapi.exe as the account
```

| Logon account | When |
|---|---|
| `NT AUTHORITY\LocalService` (`--local-service`) | **Recommended** when SQL Server is on the same machine: no password, and far less privilege than the default. |
| A domain account or gMSA | When the API must reach SQL Server **on another machine**. Set it in `services.msc` → *Log On*, then restart. |
| `LocalSystem` (the default without the flag) | Not recommended - it is a local administrator in all but name. |

A true *virtual account* (`NT SERVICE\…` as the logon account) is refused by the Service Control Manager here,
because node-windows registers the service with a `.exe` suffix in its name. The service SID above gives the same
per-service isolation for permissions, which is what actually matters.

> Whatever it logs on as **must** be able to open the database: a service that starts with no access simply
> logs `Cannot open database "ApprovalFlow"` to `dist\daemon\*.err.log` and answers 502 through IIS.

Settings set in the installing shell are baked into the service, so one checkout can run a service on
different settings from `npm run dev` — useful when the site is not on the API's default port:

```bat
set PORT=4110 & set APP_BASE_URL=http://localhost:8088 & set TRUST_PROXY=1
node scripts\windows-service.cjs install
```

`PORT`, `APP_BASE_URL`, `TRUST_PROXY`, `COOKIE_SECURE`, `STORAGE_DIR`, `TENANT_SLUG`, `APP_DOMAIN` and
`PLATFORM_HOST` are carried over this way; everything else comes from `server\.env`. Re-run `install` after
changing them, and `node scripts\windows-service.cjs uninstall` to remove the service.

> Prefer NSSM or a scheduled task? Anything that runs `node dist\index.js` with `server\` as the working directory works.

## 5. Build the client and create the IIS site

```bat
cd C:\apps\approvalflow\client
npm ci
npm run build          &  rem output: client\dist (includes web.config)
```
1. IIS Manager → Add Website → physical path `C:\apps\approvalflow\client\dist` → HTTPS binding with your certificate.
2. Application pool: **No Managed Code**. (The pool only serves static files; recycling it is harmless.)
3. If `PORT` is not 4100, change the proxy URL in `client\dist\web.config` (source: `client\public\web.config`).
4. Add an HTTP→HTTPS redirect (or do not bind port 80 at all).

5. **One site serves every customer.** Give it a blank host name (or `*`) with the wildcard certificate, so
   `acme.approvals.example.com` and `globex.approvals.example.com` both reach it. Set `APP_DOMAIN=approvals.example.com`
   in `server/.env`, and creating a customer in the console is then all it takes - no IIS work per customer. A customer
   that wants its own name (`approvals.acme.com`) gets a `Host` on its record, a CNAME, and a binding + certificate for it.

Each customer signs in at its own address, e.g. `https://acme.approvals.example.com/`. The **global management console**
is at `/global`; give it its own host (`admin.approvals.example.com`, `PLATFORM_HOST` in `.env`) to keep it off customer
addresses. Create the first global administrator with:

```bat
npm run seed:platform-admin -- --email you@example.com --displayName "You"
```

## 6. Verify

| Check | Expected |
|---|---|
| `https://…/api/v1/health` | `{"status":"ok","db":"ok"}` through IIS |
| Deep link `https://…/admin/requests`, then F5 | the app loads (SPA fallback works) |
| Sign in → Audit log | your `auth.login` row shows your **real** IP, not `127.0.0.1` (else re-check `TRUST_PROXY=1` and the ARR command in §1) |
| Sign in with a brand-new address | the verification code email **arrives** (working SMTP is now required for anyone to get in) |
| Two customers' addresses side by side | each shows its own name and branding, and one customer's key never works on the other's address |
| `/global` -> sign in as a global administrator | the customer list appears; a customer administrator's token is rejected there |
| Approve a test request end to end | within a minute the request shows *Stored in the database*, and *Download PDF* works for the admin and the submitter |

## 7. Operations

* **Upgrades:** stop the service → deploy code → `npm ci` → `npm run migrate` (as admin) → `npm run build` → start the service → rebuild the client and copy `dist`. Migrations are forward-only and tracked in `SchemaMigrations`.
* **Backups:** the SQL database - it holds the archived PDFs too. SQL Server Express databases are limited to 10 GB; at about 60 KB per PDF that is room for well over 100,000 requests.
* **Monitoring:** `GET /api/v1/health`; the *Overdue* dashboard tile; the failed-email banner on the dashboard.
* **Workers and timing:** email outbox every 10 s · archive every 15 s · reminders/escalations every 5 min. All claim work with database leases, so an overlapping or restarted process never double-sends.
* **Run exactly one instance of the service per database.** Leases make a second instance safe, but it is not a supported scale-out design.
* **Housekeeping (optional SQL Agent job):** `DELETE FROM RefreshTokens WHERE ExpiresAt < DATEADD(DAY,-30,SYSUTCDATETIME())`, same for `ApprovalTokens`. Never purge `AuditLog` from the app account - it cannot (by design).
* **Alternative single-process hosting:** set `CLIENT_DIR=..\client\dist` and Node serves the UI as well; IIS then only needs one rule proxying everything to `http://localhost:4100/{R:0}`.

## Appendix A: iisnode

Not recommended (see above). If required: install iisnode, point the site at `server\`, and use a `web.config` with
`<add name="iisnode" path="dist/index.js" verb="*" modules="iisnode" />` plus a rewrite of all requests to `dist/index.js`, set
`CLIENT_DIR` so Node serves the UI, and configure the application pool with **Start Mode = AlwaysRunning**, **Idle Time-out = 0**,
**Regular recycle = 0** and site **Preload Enabled = true** so the workers keep running. `PORT` is supplied by iisnode as a named pipe,
which the API accepts. Set `nodeProcessCountPerApplication="1"`.
