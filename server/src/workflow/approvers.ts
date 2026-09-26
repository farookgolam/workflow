// Who receives each step. A step is either fixed (it always goes to the chain's approver) or chosen: the person
// handing the request on - the submitter for step 1, each approver for the step after theirs - picks its approver,
// from the step's lookup file of approvers or, with no file, from everyone with the Approver role.
import { audit, type Actor } from '../audit/audit';
import { unusablePasswordHash } from '../auth/password';
import { config } from '../config';
import { tenantQuery, type Tx } from '../db/query';
import { AppError } from '../http/errors';
import { createUser } from '../users/service';

export interface ApproverOption {
  userId: number | null; // null: a person in the step's spreadsheet who has no account yet - one is created when they are chosen
  displayName: string; email: string;
  /** When the step's people come from a lookup table: this person's key value there (what the drop-down shows)... */
  listKey?: string;
  /** ...and the columns the administrator chose to show next to them, read-only. */
  info?: Record<string, string>;
}
export interface StepHandOff {
  stepOrder: number;
  name: string;
  /** 'fixed': the step always goes to `approver`. 'chosen': the person handing on must pick one of `candidates`. */
  mode: 'fixed' | 'chosen';
  approver: ApproverOption | null; // the fixed approver; null on a chosen step
  candidates: ApproverOption[]; // who may be chosen; empty on a fixed step
  /** A chosen step's people come from this lookup table; `columns` are shown, filled in, for whoever is chosen. */
  list?: { name: string; keyColumn: string; nameColumn: string | null; columns: string[] } | null;
}

const APPROVER_SQL = `SELECT u.UserId, u.DisplayName, u.Email FROM Users u
  WHERE u.TenantId = @TenantId AND u.IsActive = 1
    AND EXISTS (SELECT 1 FROM UserRoles r WHERE r.TenantId = u.TenantId AND r.UserId = u.UserId AND r.Role IN ('Approver','Admin'))`;

/**
 * A chosen step whose people come from a lookup table - a spreadsheet of approvers. The SPREADSHEET decides who can be
 * chosen, not the user list: someone in it who has no account yet gets one (with the Approver role) the moment they
 * are chosen, and sets their password key through the ordinary first-sign-in check of their email address.
 */
interface ListConfig { ListLookupId: number | null; ListEmailColumn: string | null; ListNameColumn: string | null; ListColumnsJson: string | null }
const LIST_COLUMNS = 's.ApproverListLookupId AS ListLookupId, s.ApproverListEmailColumn AS ListEmailColumn, s.ApproverListNameColumn AS ListNameColumn, s.ApproverListColumnsJson AS ListColumnsJson';
interface ListPerson { key: string; email: string; name: string; data: Record<string, string> }
interface ApproverList { name: string; keyColumn: string; nameColumn: string | null; columns: string[]; people: ListPerson[] }
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The table's rows that carry a usable email, in spreadsheet order. The key column is stored apart from the rest of the row. */
async function loadList(tenantId: number, cfg: ListConfig, tx?: Tx): Promise<ApproverList | null> {
  if (!cfg.ListLookupId || !cfg.ListEmailColumn) return null;
  const [table] = await tenantQuery<{ Name: string; KeyColumn: string }>(tenantId, 'SELECT Name, KeyColumn FROM LookupTables WHERE TenantId = @TenantId AND LookupId = @L', { L: cfg.ListLookupId }, tx);
  if (!table) return null; // the table was deleted: the step falls back to every approver
  const rows = await tenantQuery<{ KeyValue: string; DataJson: string }>(tenantId, 'SELECT KeyValue, DataJson FROM LookupRows WHERE TenantId = @TenantId AND LookupId = @L ORDER BY SortOrder', { L: cfg.ListLookupId }, tx);
  const people: ListPerson[] = [];
  for (const r of rows) {
    const data = { ...(JSON.parse(r.DataJson) as Record<string, string>), [table.KeyColumn]: r.KeyValue };
    const email = (data[cfg.ListEmailColumn] ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 320) continue;
    people.push({ key: r.KeyValue, email, name: ((cfg.ListNameColumn ? data[cfg.ListNameColumn] : '') || r.KeyValue).trim().slice(0, 200), data });
  }
  return { name: table.Name, keyColumn: table.KeyColumn, nameColumn: cfg.ListNameColumn, columns: JSON.parse(cfg.ListColumnsJson ?? '[]') as string[], people };
}

type StepRow = { StepOrder: number; Name: string; Chosen: boolean; UserId: number; DisplayName: string; Email: string } & ListConfig;

/** What the person handing the request on is shown for the step after them. Nobody may choose themselves or the submitter. */
async function handOff(tenantId: number, excludeUserIds: number[], s: StepRow): Promise<StepHandOff> {
  if (!s.Chosen) return { stepOrder: s.StepOrder, name: s.Name, mode: 'fixed', approver: { userId: s.UserId, displayName: s.DisplayName, email: s.Email }, candidates: [] };

  const list = await loadList(tenantId, s);
  if (!list) {
    const rows = await tenantQuery<{ UserId: number; DisplayName: string; Email: string }>(tenantId, `${APPROVER_SQL} ORDER BY u.DisplayName, u.UserId`, {});
    return {
      stepOrder: s.StepOrder, name: s.Name, mode: 'chosen', approver: null,
      candidates: rows.filter((u) => !excludeUserIds.includes(u.UserId)).map((u) => ({ userId: u.UserId, displayName: u.DisplayName, email: u.Email })),
    };
  }
  // everyone in the spreadsheet, except the person sending, the submitter, and anyone whose account was deactivated here
  const users = await tenantQuery<{ UserId: number; Email: string; IsActive: boolean }>(tenantId, 'SELECT UserId, Email, IsActive FROM Users WHERE TenantId = @TenantId', {});
  const byEmail = new Map(users.map((u) => [u.Email.toLowerCase(), u]));
  const candidates = list.people
    .filter((p) => { const u = byEmail.get(p.email); return !u || (u.IsActive && !excludeUserIds.includes(u.UserId)); })
    .map((p): ApproverOption => ({
      userId: byEmail.get(p.email)?.UserId ?? null, displayName: p.name, email: p.email, listKey: p.key,
      info: Object.fromEntries(list.columns.map((c) => [c, p.data[c] ?? ''])),
    }));
  return {
    stepOrder: s.StepOrder, name: s.Name, mode: 'chosen', approver: null, candidates,
    list: { name: list.name, keyColumn: list.keyColumn, nameColumn: list.nameColumn, columns: list.columns },
  };
}

/** How an unsaved step is configured - the fields of a chain step that decide who receives it. */
export interface StepConfig {
  name: string; approverUserId: number | null;
  chosen: { lookupId: number | null; emailColumn: string | null; nameColumn: string | null; columns: string[] } | null;
}

/**
 * The chain builder's "Preview & test": what the person handing on would be shown for an UNSAVED step, worked out
 * exactly as for a real request. Settings that publishing would refuse are reported instead. Nothing is written.
 */
export async function previewHandOff(tenantId: number, step: StepConfig, stepOrder: number, excludeUserIds: number[]): Promise<StepHandOff> {
  const fail = (message: string) => new AppError(400, 'validation_failed', 'Invalid input', [{ path: 'step', message }]);
  const base = { StepOrder: stepOrder, Name: step.name, ListLookupId: null, ListEmailColumn: null, ListNameColumn: null, ListColumnsJson: null };
  if (!step.chosen) {
    if (!step.approverUserId) throw fail('Choose the approver.');
    const [u] = await tenantQuery<{ UserId: number; DisplayName: string; Email: string }>(tenantId, `${APPROVER_SQL} AND u.UserId = @UserId`, { UserId: step.approverUserId });
    if (!u) throw fail('The chosen approver is inactive or no longer has the Approver role.');
    return handOff(tenantId, excludeUserIds, { ...base, Chosen: false, ...u });
  }
  const c = step.chosen;
  if (c.lookupId) {
    const [table] = await tenantQuery<{ ColumnsJson: string }>(tenantId, 'SELECT ColumnsJson FROM LookupTables WHERE TenantId = @TenantId AND LookupId = @L', { L: c.lookupId });
    if (!table) throw fail('The lookup file this step uses no longer exists.');
    const columns = JSON.parse(table.ColumnsJson) as string[];
    if (!c.emailColumn || !columns.includes(c.emailColumn)) throw fail('Choose the column with each approver\'s email.');
    const missing = [...c.columns, ...(c.nameColumn ? [c.nameColumn] : [])].find((col) => !columns.includes(col));
    if (missing) throw fail(`The lookup file has no column "${missing}".`);
  }
  return handOff(tenantId, excludeUserIds, {
    ...base, Chosen: true, UserId: 0, DisplayName: '', Email: '',
    ...(c.lookupId ? { ListLookupId: c.lookupId, ListEmailColumn: c.emailColumn, ListNameColumn: c.nameColumn, ListColumnsJson: JSON.stringify(c.columns) } : {}),
  });
}

/** Step 1 of a form's current chain, for the person about to submit. Null when the form has no chain yet. */
export async function firstStepHandOff(tenantId: number, formId: number, chooserUserId: number): Promise<StepHandOff | null> {
  const [s] = await tenantQuery<StepRow>(
    tenantId,
    `SELECT s.StepOrder, s.Name, s.ApproverChosen AS Chosen, u.UserId, u.DisplayName, u.Email, ${LIST_COLUMNS}
       FROM ApprovalChains c
       JOIN ApprovalSteps s ON s.TenantId = c.TenantId AND s.ChainId = c.ChainId AND s.StepOrder = 1
       JOIN Users u ON u.TenantId = s.TenantId AND u.UserId = s.ApproverUserId
      WHERE c.TenantId = @TenantId AND c.FormId = @FormId AND c.IsCurrent = 1`,
    { FormId: formId },
  );
  return s ? handOff(tenantId, [chooserUserId], s) : null;
}

/** The step after `stepOrder` of a request in progress, for the approver about to approve. Null on the last step. */
export async function nextStepHandOff(tenantId: number, requestId: number, stepOrder: number, chooserUserId: number): Promise<StepHandOff | null> {
  const [s] = await tenantQuery<StepRow & { SubmitterUserId: number }>(
    tenantId,
    `SELECT r.SubmitterUserId, rs.StepOrder, rs.StepName AS Name, s.ApproverChosen AS Chosen, u.UserId, u.DisplayName, u.Email, ${LIST_COLUMNS}
       FROM RequestSteps rs
       JOIN Requests r ON r.TenantId = rs.TenantId AND r.RequestId = rs.RequestId
       JOIN ApprovalSteps s ON s.TenantId = rs.TenantId AND s.StepId = rs.StepId
       JOIN Users u ON u.TenantId = rs.TenantId AND u.UserId = rs.AssignedUserId
      WHERE rs.TenantId = @TenantId AND rs.RequestId = @RequestId AND rs.StepOrder = @Next AND rs.Status = 'Waiting'`,
    { RequestId: requestId, Next: stepOrder + 1 },
  );
  return s ? handOff(tenantId, [chooserUserId, s.SubmitterUserId], s) : null;
}

/**
 * Hands a Waiting step to its approver, inside the caller's transaction and before the step is activated.
 * A fixed step needs nothing (a choice naming anyone else is refused); a chosen step needs `chosen`: a user id, or -
 * for a step whose people come from a spreadsheet - the key of a row in it. `path` names the input for errors.
 */
export async function handOverStep(
  tenantId: number, actor: Actor, chooserUserId: number, requestId: number, stepOrder: number, chosen: number | { listKey: string } | undefined, path: string, tx: Tx,
): Promise<void> {
  const [step] = await tenantQuery<{ RequestStepId: number; StepName: string; AssignedUserId: number; Chosen: boolean; SubmitterUserId: number } & ListConfig>(
    tenantId,
    `SELECT r.SubmitterUserId, rs.RequestStepId, rs.StepName, rs.AssignedUserId, s.ApproverChosen AS Chosen, ${LIST_COLUMNS}
       FROM RequestSteps rs
       JOIN Requests r ON r.TenantId = rs.TenantId AND r.RequestId = rs.RequestId
       JOIN ApprovalSteps s ON s.TenantId = rs.TenantId AND s.StepId = rs.StepId
      WHERE rs.TenantId = @TenantId AND rs.RequestId = @RequestId AND rs.StepOrder = @StepOrder AND rs.Status = 'Waiting'`,
    { RequestId: requestId, StepOrder: stepOrder },
    tx,
  );
  if (!step) return;
  const fail = (message: string) => new AppError(400, 'validation_failed', 'Invalid input', [{ path, message }]);

  if (!step.Chosen) {
    if (chosen !== undefined && chosen !== step.AssignedUserId) throw fail(`The approver for "${step.StepName}" is fixed and cannot be changed`);
    return;
  }
  if (chosen === undefined) throw fail(`Choose who approves "${step.StepName}"`);

  const list = await loadList(tenantId, step, tx);
  let chosenUserId: number;
  let person: ListPerson | undefined;
  if (typeof chosen === 'number') {
    if (list) throw fail(`Choose the approver for "${step.StepName}" from the "${list.name}" list`);
    chosenUserId = chosen;
    const [user] = await tenantQuery<{ UserId: number }>(tenantId, `${APPROVER_SQL} AND u.UserId = @UserId`, { UserId: chosenUserId }, tx);
    if (!user) throw fail('The selected person is not an active approver');
  } else {
    person = list?.people.find((p) => p.key === chosen.listKey);
    if (!list || !person) throw fail(`The selected person is not in the list for "${step.StepName}"`);
    chosenUserId = await accountFor(tenantId, actor, person, list.name, requestId, fail, tx);
  }
  if (chosenUserId === chooserUserId) throw fail('You cannot choose yourself - choose someone else');
  if (chosenUserId === step.SubmitterUserId) throw fail('A request cannot be sent to the person who submitted it');

  await tenantQuery(
    tenantId,
    `UPDATE RequestSteps SET AssignedUserId = @New, DelegateUserId = NULL
      WHERE TenantId = @TenantId AND RequestStepId = @S AND Status = 'Waiting'`,
    { New: chosenUserId, S: step.RequestStepId },
    tx,
  );
  await audit(
    tenantId,
    actor,
    { action: 'step.approver_chosen', entityType: 'RequestStep', entityId: step.RequestStepId, requestId, detail: { stepOrder, toUserId: chosenUserId, chosenByUserId: chooserUserId, fromList: list && person ? { lookup: list.name, key: person.key } : undefined } },
    tx,
  );
}

/**
 * The account of a person picked from a step's spreadsheet. Being in that spreadsheet is what authorises them: a new
 * account is created without a password key (they choose one at first sign-in, after proving the email address is
 * theirs), and an existing account is given the Approver role if it lacks it. A deactivated account stays out.
 */
async function accountFor(tenantId: number, actor: Actor, person: ListPerson, listName: string, requestId: number, fail: (m: string) => AppError, tx: Tx): Promise<number> {
  const [existing] = await tenantQuery<{ UserId: number; IsActive: boolean; CanApprove: number }>(
    tenantId,
    `SELECT u.UserId, u.IsActive,
            CASE WHEN EXISTS (SELECT 1 FROM UserRoles r WHERE r.TenantId = u.TenantId AND r.UserId = u.UserId AND r.Role IN ('Approver','Admin')) THEN 1 ELSE 0 END AS CanApprove
       FROM Users u WITH (UPDLOCK, HOLDLOCK) WHERE u.TenantId = @TenantId AND u.Email = @Email`,
    { Email: person.email },
    tx,
  );
  if (existing && !existing.IsActive) throw fail(`${person.name} has been deactivated and cannot receive requests`);
  if (existing?.CanApprove) return existing.UserId;
  if (existing) {
    await tenantQuery(tenantId, "INSERT INTO UserRoles (TenantId, UserId, Role) VALUES (@TenantId, @UserId, 'Approver')", { UserId: existing.UserId }, tx);
    await audit(tenantId, actor, { action: 'user.role_granted', entityType: 'User', entityId: existing.UserId, requestId, detail: { role: 'Approver', reason: `chosen from the approver list "${listName}"` } }, tx);
    return existing.UserId;
  }
  const allowed = config.signup.allowedDomains;
  if (allowed.length && !allowed.includes(person.email.split('@')[1])) throw fail(`${person.name} cannot be chosen: ${person.email.split('@')[1]} is not an email domain this system accepts`);
  const userId = await createUser(tenantId, { email: person.email, displayName: person.name, roles: ['Approver'], passwordHash: await unusablePasswordHash(), passwordSet: false }, tx);
  await audit(tenantId, actor, { action: 'user.created_from_list', entityType: 'User', entityId: userId, requestId, detail: { email: person.email, lookup: listName, key: person.key } }, tx);
  return userId;
}
