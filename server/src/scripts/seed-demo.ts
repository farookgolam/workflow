// DEV ONLY. Adds sample users, a form and a 3-step chain to an existing tenant so the workflow can be tried by hand.
//   npm run seed:demo                 (add --reset-keys to give EVERY user in the organisation the demo key again)
// All demo users get the 6-digit password key in SEED_DEMO_KEY (default 482615).
import { parseArgs } from 'node:util';
import { hashPassword, passwordKeyProblem } from '../auth/password';
import type { Role } from '../auth/middleware';
import { config } from '../config';
import { closePool } from '../db/pool';
import { tenantQuery, unscopedQuery, withTx } from '../db/query';
import { createForm, publishChain } from '../forms/service';
import { createUser } from '../users/service';

async function main() {
  if (config.isProd) throw new Error('seed:demo is disabled in production');
  const { values } = parseArgs({ options: { slug: { type: 'string', default: 'demo' }, 'reset-keys': { type: 'boolean', default: false } } });
  const [tenant] = await unscopedQuery<{ TenantId: number }>('SELECT TenantId FROM Tenants WHERE Slug = @Slug', { Slug: values.slug! });
  if (!tenant) throw new Error(`Tenant "${values.slug}" not found - run seed:tenant first`);
  const tenantId = tenant.TenantId;

  const demoKey = process.env.SEED_DEMO_KEY ?? '482615';
  const keyProblem = passwordKeyProblem(demoKey);
  if (keyProblem) throw new Error(`SEED_DEMO_KEY: ${keyProblem}`);
  const passwordHash = await hashPassword(demoKey);

  if (values['reset-keys']) {
    const rows = await tenantQuery(
      tenantId,
      'UPDATE Users SET PasswordHash = @Hash, PasswordSetAt = SYSUTCDATETIME(), FailedLoginCount = 0, LockedUntil = NULL OUTPUT inserted.Email WHERE TenantId = @TenantId',
      { Hash: passwordHash },
    );
    return console.log(`Password key set to ${demoKey} for ${rows.length} user(s).`);
  }
  const existing = await tenantQuery(tenantId, `SELECT 1 AS x FROM Forms WHERE TenantId = @TenantId AND Slug = 'purchase-request'`);
  if (existing.length) return console.log('Demo data already present.');
  const [admin] = await tenantQuery<{ UserId: number }>(
    tenantId,
    `SELECT TOP 1 u.UserId FROM Users u JOIN UserRoles r ON r.TenantId = u.TenantId AND r.UserId = u.UserId AND r.Role = 'Admin'
      WHERE u.TenantId = @TenantId ORDER BY u.UserId`,
  );

  await withTx(async (tx) => {
    const people: [string, string, Role[]][] = [
      ['submitter', 'Sam Submitter', ['Submitter']],
      ['manager', 'Maria Manager', ['Approver']],
      ['finance', 'Frank Finance', ['Approver']],
      ['director', 'Dana Director', ['Approver', 'Submitter']],
    ];
    const ids: Record<string, number> = {};
    for (const [name, displayName, roles] of people) {
      ids[name] = await createUser(tenantId, { email: `${name}@${values.slug}.test`, displayName, roles, passwordHash }, tx);
    }
    const formId = await createForm(
      tenantId,
      {
        name: 'Purchase Request',
        slug: 'purchase-request',
        description: 'Request approval to buy goods or services.',
        submittersSeeComments: false,
        fields: [
          { key: 'title', label: 'What do you need?', type: 'text', required: true },
          { key: 'justification', label: 'Business justification', type: 'textarea', required: true },
          { key: 'amount', label: 'Estimated cost', type: 'currency', required: true, rules: { min: 0.01 } },
          { key: 'category', label: 'Category', type: 'select', required: true, options: ['Hardware', 'Software', 'Services', 'Other'] },
          { key: 'neededBy', label: 'Needed by', type: 'date', required: false },
          { key: 'urgent', label: 'Urgent', type: 'checkbox', required: false },
        ],
      },
      tx,
    );
    const step = { chosen: null, reminderRepeatDays: null, escalateAfterDays: null, escalateToUserId: null, allowAttachments: false };
    await publishChain(
      tenantId,
      formId,
      {
        steps: [
          { ...step, name: 'Line manager', approverUserId: ids.manager, reminderAfterDays: 3 },
          { ...step, name: 'Finance', approverUserId: ids.finance, reminderAfterDays: 3 },
          { ...step, name: 'Director', approverUserId: ids.director, reminderAfterDays: 5 },
        ],
      },
      admin.UserId,
      tx,
    );
    console.log(`Created form ${formId} with a 3-step chain and users: ${people.map(([n]) => `${n}@${values.slug}.test`).join(', ')}`);
  });
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(closePool);
