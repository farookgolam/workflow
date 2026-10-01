# FileBank WorkFlow

(Product name since v1.0.21. "ApprovalFlow" remains the internal name: this repository, the database, the IIS site, the
Windows service approvalflowapi.exe and C:\apps\approvalflow on the servers.)

Multi-step approval workflow, hosted for one or many customer organisations: a submitter fills in a form, each approver in an ordered chain
gets a secure emailed link, and the outcome (approved **or** rejected) is rendered to a PDF and archived to SharePoint. Each customer has its
own address, its own administrators and its own data; a global administrator creates and manages the customers.

* **Backend:** Node.js 24 · Express 5 · TypeScript · SQL Server (`mssql`, hand-written parameterised SQL)
* **Frontend:** React 19 · Vite · React Router
* **Hosting:** Windows Server + IIS reverse proxy, API as a Windows service - see [docs/DEPLOYMENT-IIS.md](docs/DEPLOYMENT-IIS.md)

## Quick start (development)

```bash
cd server
cp .env.example .env            # set JWT_SECRET (command is in the file); defaults target .\SQLEXPRESS with Windows auth
npm install
npm run migrate                 # creates the ApprovalFlow database and schema
SEED_ADMIN_KEY=482615 npm run seed:tenant -- --slug demo --name "Demo" --email admin@demo.test --displayName "Demo Admin"
SEED_PLATFORM_KEY=704913 npm run seed:platform-admin -- --email you@example.com --displayName "You"   # global admin (optional)
npm run seed:demo               # sample users, a Purchase Request form, 3-step chain (dev only)
npm run dev                     # API + workers on http://localhost:4100

cd ../client
npm install
npm run dev                     # UI on http://localhost:5173/login  (demo users: 6-digit key 482615)
```

With no SMTP/Graph settings, emails are written to `server/storage/mail/*.eml` and "SharePoint" uploads are copied to
`server/storage/sharepoint-dryrun/`, so the whole loop works offline. `npm run demo:walkthrough` creates one approved and one
rejected request. Set `SHAREPOINT_DRYRUN_FAIL=true` to rehearse the upload-retry path.

Local IIS trial: `powershell -ExecutionPolicy Bypass -File scripts\deploy-local-iis.ps1` -> http://localhost:8088 (`-Remove` to undo; `-Hosts acme.example.localhost` adds customer sub-sites). The global console is at `/global`.
The API is a background process unless it is installed as a **Windows service** (`node scripts\windows-service.cjs install --local-service --depends-on MSSQL$SQLEXPRESS`, see [docs/DEPLOYMENT-IIS.md](docs/DEPLOYMENT-IIS.md) section 4) - which is what keeps the workers running after a reboot. The deploy script restarts that service instead of starting a second copy when it exists.

| Command (in `server/`) | |
|---|---|
| `npm test` | 155 integration tests against a throw-away `ApprovalFlow_Test` database (re-created every run) |
| `npm run typecheck` / `npm run build` | |
| `npm run migrate` | apply pending `migrations/NNN_*.sql` |
| `npm run seed:tenant -- --name … --email … --displayName … [--host …]` | one-time: a customer + its first admin (the same thing the global console does) |
| `npm run seed:platform-admin -- --email … --displayName …` | one-time: the first **global** administrator, who creates customers (`--reset-key` to re-key an existing one) |
| `npm run grant-role -- --email you@example.com --role Admin` | make an existing account an admin / approver from the server (add `--remove` to take a role away) |
| `npm run seed:demo -- --reset-keys` | dev only: give every user the demo key again |

## How it works

```
submit ─> InProgress ─ approve (not last) ─> next step Active, approver emailed
              │        approve (last) ─────> Approved  ┐
              │        reject (reason) ────> Rejected  ┼─> PdfPending ─> PendingUpload ─> Uploaded
              └─────── admin cancel ───────> Cancelled ┘        (retry with back-off; Failed after 8 attempts)
```

* **One transaction per transition** - state change, audit rows and outbox emails commit together (`src/workflow/engine.ts`).
  PDF + upload happen afterwards in a worker, so a SharePoint outage can never delay the submitter's email.
* **Who gets the next step:** a required *Lookup (Excel)* control can be marked "the person chosen here receives the next approval step"
  (`props.approverEmailColumn` / `approverNameColumn`): on the submission form it routes step 1, in a step's controls the step after it. The
  spreadsheet - not the user list - decides who can be chosen; a person without an account is provisioned on being chosen (Approver role, no key;
  verified first-sign-in sets it). Steps nothing chooses for keep a fixed approver. Applied inside the transition's transaction, before the step is
  activated and emailed, and audited as `step.approver_chosen` (`src/workflow/approvers.ts`). Older Send-to / approver-list / approver-from-lookup
  settings are still honoured by the server for chains that have them, but the chain editor no longer offers them.
* **Rejection is final** at any step: reason mandatory, later approvers never notified, enforced again by database triggers.
* **Tenant isolation:** every table has `TenantId`; child rows use composite foreign keys `(TenantId, ParentId)`; application code can
  only query through `tenantQuery()`, which binds `@TenantId` and refuses SQL that does not reference it (`src/db/query.ts`).
* **Approval links** are random tokens (stored hashed), bound to one step **and one user**, expiring after 14 days, and only usable
  after signing in. Reassigning/reminding supersedes the old link. A step can be decided exactly once (guarded update + trigger).
* **Accounts:** nobody is created by an admin. At first sign-in a person proves their email with a one-time code and chooses their own
  **6-digit password key** (Argon2id-hashed; obvious keys refused). A forgotten key is **self-service** (emailed code, then a new key); an admin reset remains as a
  fallback and sends the user back through verified setup. Lock-out after 5 wrong keys; 15-minute JWT access tokens (memory only); rotating httpOnly refresh
  cookie with reuse detection. `FIRST_LOGIN_EMAIL_VERIFICATION` and `ALLOWED_EMAIL_DOMAINS` control sign-up.
* **Customers (multi-tenant):** each customer is reached at its own address - its `Tenants.Host`, or `<slug>.<APP_DOMAIN>` - and **the host
  alone decides** which customer a request belongs to; a body naming a different one is refused rather than honoured (`src/tenant.ts`). Emailed
  links are built from that customer's own address. With a single customer and no host routing, `TENANT_SLUG` (or the only active organisation)
  still applies, so an existing single-org deployment is unchanged.
* **Global administrators** create and manage customers in the console at **`/global`** (API: `/api/v1/global/*`, code: `src/platform/` and
  `client/src/global/`). They are **not** rows in `Users` and carry no `TenantId`, so no customer administrator can see, deactivate or reset one;
  their token has its own audience, so a platform token is rejected by the customer API and a customer token here. Creating a customer -
  organisation, request counter, settings and first administrator - is one transaction, the same one `npm run seed:tenant` runs. Suspending one
  stops sign-in and revokes its sessions at once. Everything a global administrator does is written to the append-only `PlatformAuditLog` **and**
  to that customer's own audit log, so nothing done from outside is invisible from inside.
* **Support access** instead of a back door: the console mints an **ordinary** customer token for one of that customer's administrators (30
  minutes, no refresh cookie), so every tenant check still applies and nothing bypasses `tenantQuery()`. The portal shows a banner while it lasts,
  and every audit row it produces carries `impersonatedByPlatformAdmin`.
* **Per-customer settings** (`src/settings/`, Settings page): branding (name, logo, accent colour - on the sign-in page and the portal header),
  who may register (`allowedEmailDomains`, email verification on/off), the sender address, and the SharePoint/Graph target. Each is NULL by
  default, meaning "inherit the server-wide environment value", so an existing single-organisation deployment behaves exactly as before. A
  customer's Graph client secret is stored encrypted (AES-256-GCM, `SETTINGS_KEY`) and can only be replaced, never read back.
* **Per-customer storage:** PDFs, dry-run SharePoint uploads and dry-run emails are written under `tenant-<id>/`, so one customer's files are
  never mixed with another's. Every API response is `Cache-Control: no-store` - no proxy may hold a customer's data.
* **Form builder:** live preview on a 12-column grid; click a control to edit its properties, drag its right edge to resize (¼ ⅓ ½ ⅔ ¾ full),
  drag a text area's bottom edge for height. Controls: text, long text, email, phone, web address, number, currency, slider, date, time,
  date & time, month, week, drop-down, radio, multi tick boxes, tick box, data grid, colour, signature (drawn with finger / stylus / mouse, or typed), plus heading / paragraph / divider. The same
  definitions drive server-side validation, the submitter form, the approver section and the PDF.
* **Data grid:** a repeating-rows control (people add rows as needed) whose columns are text / number / currency / date / time / drop-down or
  **calculated** from a formula over the other columns (`quantity * unitPrice`, `timeOut - timeIn` - a time reads as hours), with optional column totals.
  Formulas are parsed into a tree and walked (`src/forms/formula.ts`, never `eval`); calculated cells and totals are worked out **server-side
  at submit** (client values ignored) and stored as a self-describing JSON snapshot that the read-only views and the PDF render as a table.
* **Drawn signature:** pointer events on an SVG pad (`client/src/sigpad.tsx`); stored as pen strokes on a fixed 600 x 200 pad, not as an image, so the
  server can validate every number (`src/forms/sigpad.ts`) and the PDF draws it as vector lines. Never pre-filled or copied from an earlier request.
* **Excel lookups:** import an .xlsx as a lookup table (Lookups page), then add a *Lookup (Excel)* control and mark other controls as
  auto-filled from one of its columns. Auto-filled values are computed **server-side at submit** (client values ignored), snapshotted with the
  request, and only the columns a form uses are ever sent to the browser. Samples: `docs/samples/lookups/*.xlsx`;
  `npm run sample:lookups -- --import && npm run sample:lookup-form` loads them plus a demo form.
* **Builder preview:** *Preview & test* in the form builder renders the unsaved form with live lookups; *Test submit* posts to
  `/admin/forms/preview/validate`, which runs the real validation + server-side auto-fill and returns what would be stored. Nothing is written.
* **HTML form import:** an existing `.html` form can be uploaded on the Forms page; the server parses (never renders or runs) it into a draft
  the admin reviews, then saves as a normal form and adds approval steps. Try it with `docs/samples/travel-request.html`.
* **Audit:** every state change with user, UTC timestamp and IP; append-only (trigger + `DENY`); filterable and exportable to CSV.
* **Workers** (in-process, database-leased): mail outbox, archive (PDF → SharePoint), reminder/escalation sweeper.

## Layout

```
server/
  migrations/001_init.sql      schema, constraints, immutability triggers
  src/auth                     login, refresh, password flows, role middleware
  src/db                       pool (Windows or SQL auth), tenantQuery, migrations
  src/forms                    field definitions + server-side validation, chain versioning
  src/workflow                 engine (state machine), read models, approver/submitter routes, sweeper
  src/notifications            transactional outbox + SMTP worker
  src/archive                  PDF builder, Graph/dry-run uploader, archive worker, download routes
  src/admin                    dashboard, request list/detail/actions, users, forms config, audit + CSV
  src/platform                 global administrators: sign-in, customer provisioning, customer management
  src/settings                 per-customer settings, with the environment as the fallback (secrets encrypted)
  scripts/                     Windows service installer, least-privilege SQL grants
  test/                        integration tests
client/
  src/pages                    login, approver page, submitter portal, admin portal (incl. Settings)
  src/global                   the global management console served at /global
  public/web.config            IIS: /api proxy + SPA fallback + security headers
docs/DEPLOYMENT-IIS.md
docs/manuals/                  three PDF manuals (user, administrator, global administrator) +
                               the content files they are built from: node docs/manuals/build-manuals.cjs
```

## Roles

| Role | Can |
|---|---|
| Submitter | submit forms; see **only their own** requests, progress, rejection reason and PDFs |
| Approver | act on steps assigned (or delegated) to them; sees the submission and earlier sections read-only |
| Admin | dashboard, all requests, reassign / delegate / remind / cancel / retry upload, configuration, roles, key resets, audit log |
| Global admin | *not a member of any customer*: create customers, rename / move / suspend them, grant or revoke a customer's Admin role, reset a customer admin's key |

Everyone starts as a Submitter when they register; admins grant Approver / Admin. A user may hold several roles. Whether submitters see approver comments in the portal is a per-form setting (off by default);
the archived PDF always contains the complete record.
