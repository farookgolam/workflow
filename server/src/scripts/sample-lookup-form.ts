// DEV ONLY. Creates "Timesheet (lookup demo)": a form whose School / Department / Job description controls are
// Excel lookups, with the related boxes auto-filled. Run after `npm run sample:lookups -- --import`.
//   npm run sample:lookup-form
import { config } from '../config';
import { closePool } from '../db/pool';
import { tenantQuery, withTx } from '../db/query';
import { createForm, createFormSchema, publishChain, chainSchema } from '../forms/service';
import { resolveTenantId } from '../tenant';

async function main() {
  if (config.isProd) throw new Error('disabled in production');
  const tenantId = await resolveTenantId(null);
  const tables = Object.fromEntries((await tenantQuery<{ Name: string; LookupId: number }>(tenantId, 'SELECT Name, LookupId FROM LookupTables WHERE TenantId = @TenantId')).map((t) => [t.Name, t.LookupId]));
  for (const n of ['Schools', 'Departments', 'Job descriptions']) if (!tables[n]) throw new Error(`Lookup table "${n}" is missing - run: npm run sample:lookups -- --import`);
  if ((await tenantQuery(tenantId, `SELECT 1 AS x FROM Forms WHERE TenantId = @TenantId AND Slug = 'timesheet-lookup-demo'`)).length) return console.log('Demo form already exists.');

  const [admin] = await tenantQuery<{ UserId: number }>(tenantId, `SELECT TOP 1 u.UserId FROM Users u JOIN UserRoles r ON r.TenantId = u.TenantId AND r.UserId = u.UserId AND r.Role = 'Admin' WHERE u.TenantId = @TenantId ORDER BY u.UserId`);
  const [approver] = await tenantQuery<{ UserId: number }>(tenantId, `SELECT TOP 1 u.UserId FROM Users u JOIN UserRoles r ON r.TenantId = u.TenantId AND r.UserId = u.UserId AND r.Role = 'Approver' WHERE u.TenantId = @TenantId AND u.IsActive = 1 ORDER BY u.UserId`);

  const form = createFormSchema.parse({
    name: 'Timesheet (lookup demo)',
    slug: 'timesheet-lookup-demo',
    description: 'Shows Excel lookups: choose a School, Department or Job description and the related boxes fill in.',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'department', label: 'Department', type: 'lookup', required: true, props: { lookupId: tables.Departments, width: 6 } },
      { key: 'departmentCode', label: 'Department Code', type: 'text', props: { lookupFrom: 'department', lookupColumn: 'Department Code', width: 6 } },
      { key: 'jobDescription', label: 'Job Description', type: 'lookup', props: { lookupId: tables['Job descriptions'], width: 6 } },
      { key: 'account', label: 'Account', type: 'text', props: { lookupFrom: 'jobDescription', lookupColumn: 'Account', width: 6 } },
      { key: 'totalHours', label: 'Total hours', type: 'number', required: true, rules: { min: 0, max: 400 }, props: { width: 4 } },
      { key: 'periodEnding', label: 'Period ending', type: 'date', required: true, props: { width: 4 } },
      { key: 'signature', label: 'Signature', type: 'signature', required: true, props: { width: 4 } },
      { key: 'submitTo', label: 'Submit to', type: 'heading' },
      { key: 'school', label: 'School', type: 'lookup', required: true, props: { lookupId: tables.Schools, width: 6 } },
      { key: 'schoolDepartment', label: 'Department', type: 'text', props: { lookupFrom: 'school', lookupColumn: 'Department', width: 6 } },
      { key: 'secretary', label: 'Secretary', type: 'text', props: { lookupFrom: 'school', lookupColumn: 'Secretary', width: 6 } },
      { key: 'secretaryEmail', label: 'Email', type: 'email', props: { lookupFrom: 'school', lookupColumn: 'Email', width: 6 } },
    ],
  });
  await withTx(async (tx) => {
    const formId = await createForm(tenantId, form, tx);
    if (approver) await publishChain(tenantId, formId, chainSchema.parse({ steps: [{ name: 'Secretary review', approverUserId: approver.UserId }] }), admin.UserId, tx);
    console.log(`Created form ${formId} "Timesheet (lookup demo)"${approver ? ' with a one-step chain' : ' (no approver found - add a chain yourself)'}.`);
  });
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(closePool);
