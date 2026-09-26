// DEV / DEMO. Adds five everyday sample forms, each with a published approval chain, to a customer - by default the
// "demo" one. Safe to run again: a form whose address (slug) already exists is left alone.
//   npm run sample:forms                 (the demo customer)
//   npm run sample:forms -- --tenant acme
// Uses the customer's own approvers (Maria Manager, Frank Finance and Dana Director on the demo) and its lookup tables
// "Departments" and "Schools" when it has them.
import { closePool } from '../db/pool';
import { tenantQuery, withTx } from '../db/query';
import { chainSchema, createForm, createFormSchema, publishChain } from '../forms/service';
import { resolveTenantId } from '../tenant';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };

async function main() {
  const tenantId = await resolveTenantId(null, arg('tenant') ?? 'demo');
  const tables = Object.fromEntries((await tenantQuery<{ Name: string; LookupId: number }>(tenantId, 'SELECT Name, LookupId FROM LookupTables WHERE TenantId = @TenantId')).map((t) => [t.Name, t.LookupId]));
  const approvers = await tenantQuery<{ UserId: number; DisplayName: string }>(
    tenantId,
    `SELECT u.UserId, u.DisplayName FROM Users u
      WHERE u.TenantId = @TenantId AND u.IsActive = 1
        AND EXISTS (SELECT 1 FROM UserRoles r WHERE r.TenantId = u.TenantId AND r.UserId = u.UserId AND r.Role IN ('Approver', 'Admin'))
      ORDER BY u.UserId`,
  );
  const [admin] = await tenantQuery<{ UserId: number }>(tenantId, `SELECT TOP 1 u.UserId FROM Users u JOIN UserRoles r ON r.TenantId = u.TenantId AND r.UserId = u.UserId AND r.Role = 'Admin' WHERE u.TenantId = @TenantId ORDER BY u.UserId`);
  if (!admin || !approvers.length) throw new Error('This customer needs an administrator and at least one approver first.');
  // prefer the demo's named approvers; otherwise take whoever is there, in order
  const person = (name: string, fallback: number) => (approvers.find((a) => a.DisplayName === name) ?? approvers[fallback % approvers.length]).UserId;
  const manager = person('Maria Manager', 0), finance = person('Frank Finance', 1), director = person('Dana Director', 2);

  // a department picker: the lookup table when there is one, a drop-down otherwise
  const department = tables.Departments
    ? [
        { key: 'department', label: 'Department', type: 'lookup', required: true, props: { lookupId: tables.Departments, width: 6 } },
        { key: 'departmentCode', label: 'Department code', type: 'text', props: { lookupFrom: 'department', lookupColumn: 'Department Code', width: 6 } },
      ]
    : [{ key: 'department', label: 'Department', type: 'select', required: true, options: ['Administration', 'Finance', 'Human Resources', 'IT Services', 'Facilities'], props: { width: 6 } }];
  const school = tables.Schools
    ? [{ key: 'school', label: 'School / site', type: 'lookup', required: true, props: { lookupId: tables.Schools, width: 6 } }]
    : [{ key: 'school', label: 'School / site', type: 'text', required: true, props: { width: 6 } }];
  const remind = { reminderAfterDays: 2, reminderRepeatDays: 2, escalateAfterDays: 5 };

  const forms = [
    {
      form: {
        name: 'Leave Request', slug: 'leave-request',
        description: 'Ask for time off. Your manager approves it; the days are counted for you.',
        fields: [
          { key: 'employeeName', label: 'Your name', type: 'text', required: true, props: { width: 6 } },
          { key: 'employeeId', label: 'Employee number', type: 'text', rules: { pattern: '^[0-9]{4,8}$' }, props: { width: 6, placeholder: '4 to 8 digits', helpText: 'On your payslip.' } },
          ...department,
          { key: 'leaveType', label: 'Type of leave', type: 'radio', required: true, options: ['Annual leave', 'Sick leave', 'Personal day', 'Bereavement', 'Jury duty', 'Unpaid leave'], props: { inline: true } },
          { key: 'firstDay', label: 'First day off', type: 'date', required: true, props: { width: 4 } },
          { key: 'lastDay', label: 'Last day off', type: 'date', required: true, props: { width: 4 } },
          { key: 'calendarDays', label: 'Calendar days', type: 'number', rules: { min: 1, max: 365 }, props: { width: 4, formula: 'days(firstDay, lastDay) + 1', decimals: 0, helpText: 'Including weekends. Must be 1 or more.' } },
          { key: 'cover', label: 'Who covers your work while you are away?', type: 'textarea', props: { rows: 2 } },
          { key: 'notes', label: 'Anything else your manager should know', type: 'textarea', props: { rows: 3 } },
          { key: 'signature', label: 'Signature (type your full name)', type: 'signature', required: true, props: { width: 6 } },
        ],
      },
      steps: [{ name: 'Line manager', approverUserId: manager, ...remind, escalateToUserId: director }],
    },
    {
      form: {
        name: 'Mileage Reimbursement', slug: 'mileage-reimbursement',
        description: 'Claim business miles driven in your own vehicle, and any tolls or parking.',
        fields: [
          { key: 'employeeName', label: 'Your name', type: 'text', required: true, props: { width: 6 } },
          { key: 'claimMonth', label: 'Month of travel', type: 'month', required: true, props: { width: 6 } },
          ...department,
          { key: 'rateNote', label: 'Rate', type: 'paragraph', props: { text: 'Miles are reimbursed at $0.70 per mile. Tolls and parking are paid at cost - keep the receipts, Finance may ask for them.' } },
          { key: 'trips', label: 'Trips', type: 'grid', props: { minRows: 1, maxRows: 60, columns: [
            { key: 'date', label: 'Date', type: 'date', required: true },
            { key: 'fromPlace', label: 'From', type: 'text', required: true },
            { key: 'toPlace', label: 'To', type: 'text', required: true },
            { key: 'purpose', label: 'Purpose', type: 'text' },
            { key: 'miles', label: 'Miles', type: 'number', required: true, total: true },
            { key: 'mileage', label: 'Mileage $', type: 'calc', formula: 'round(miles * 0.70, 2)', total: true },
            { key: 'tolls', label: 'Tolls / parking', type: 'currency', total: true },
          ] } },
          { key: 'totalClaim', label: 'Total claim', type: 'currency', props: { width: 4, formula: 'trips.mileage + trips.tolls' } },
          { key: 'certify', label: 'I certify these trips were for work, in my own vehicle, and are not claimed anywhere else', type: 'checkbox', required: true },
          { key: 'signature', label: 'Signature', type: 'sigpad', required: true, props: { width: 8 } },
        ],
      },
      steps: [
        { name: 'Manager approval', approverUserId: manager, ...remind },
        { name: 'Finance payment check', approverUserId: finance, reminderAfterDays: 3, escalateAfterDays: 7 },
      ],
    },
    {
      form: {
        name: 'IT Access & Equipment Request', slug: 'it-access-request',
        description: 'Accounts, system access and equipment for yourself, a new starter or a colleague.',
        fields: [
          { key: 'requestFor', label: 'Who is this for?', type: 'radio', required: true, options: ['Me', 'A new starter', 'A colleague'], props: { inline: true } },
          { key: 'personName', label: 'Their full name', type: 'text', required: true, props: { width: 6 } },
          { key: 'personEmail', label: 'Their email (if they have one)', type: 'email', props: { width: 6 } },
          ...school,
          { key: 'startDate', label: 'Needed by', type: 'date', required: true, props: { width: 6 } },
          { key: 'access', label: 'Access needed', type: 'multiselect', options: ['Email account', 'Student information system', 'Finance system', 'Shared drives', 'VPN (remote access)', 'Guest Wi-Fi'], props: { inline: true } },
          { key: 'equipment', label: 'Equipment needed', type: 'multiselect', options: ['Laptop', 'Desktop', 'Second monitor', 'Headset', 'Document camera', 'Printer access'], props: { inline: true } },
          { key: 'justification', label: 'Why is it needed?', type: 'textarea', required: true, rules: { minLength: 10 }, props: { rows: 3 } },
        ],
      },
      steps: [
        // the submitter picks their own manager from everyone with the Approver role
        { name: 'Manager approval', chosen: {}, ...remind },
        { name: 'IT Services', approverUserId: director, reminderAfterDays: 1, reminderRepeatDays: 1, escalateAfterDays: 3 },
      ],
    },
    {
      form: {
        name: 'Records Retrieval Request', slug: 'records-retrieval',
        description: 'Get stored boxes or files back from the records centre - scanned, delivered or for pick-up.',
        fields: [
          { key: 'requester', label: 'Your name', type: 'text', required: true, props: { width: 6 } },
          { key: 'phone', label: 'Phone', type: 'tel', props: { width: 6, placeholder: '555-123-4567' } },
          ...department,
          { key: 'itemsHeading', label: 'What do you need?', type: 'heading' },
          { key: 'items', label: 'Boxes and files', type: 'grid', props: { minRows: 1, maxRows: 50, columns: [
            { key: 'boxNumber', label: 'Box number', type: 'text', required: true },
            { key: 'fileName', label: 'File or folder (if only part of the box)', type: 'text' },
            { key: 'dates', label: 'Date range of the records', type: 'text' },
            { key: 'delivery', label: 'How', type: 'select', required: true, options: ['Scan and email', 'Deliver the box', 'I will pick it up'] },
          ] } },
          { key: 'urgency', label: 'How soon', type: 'radio', required: true, options: ['Standard (3 business days)', 'Rush (next business day)', 'Emergency (same day)'], props: { inline: true } },
          { key: 'neededBy', label: 'Needed by', type: 'date', props: { width: 6 } },
          { key: 'deliverTo', label: 'Deliver to (room, building)', type: 'text', props: { width: 6 } },
          { key: 'reason', label: 'Reason for the request', type: 'textarea', required: true, props: { rows: 2, helpText: 'For example an audit, a records request from the public, or a staff matter.' } },
        ],
      },
      steps: [{ name: 'Records manager', approverUserId: manager, reminderAfterDays: 1, escalateAfterDays: 2, escalateToUserId: director }],
    },
    {
      form: {
        name: 'Secure Destruction Authorization', slug: 'records-destruction',
        description: 'Authorise the destruction of stored records that have passed their retention period.',
        fields: [
          ...department,
          { key: 'intro', label: 'Before you start', type: 'paragraph', props: { text: 'List only records whose retention period has ended. Nothing is destroyed until the department head and the records officer have both approved, and a certificate of destruction can be sent afterwards.' } },
          { key: 'boxes', label: 'Records to destroy', type: 'grid', props: { minRows: 1, maxRows: 200, columns: [
            { key: 'boxNumber', label: 'Box number', type: 'text', required: true },
            { key: 'series', label: 'Record series', type: 'text', required: true },
            { key: 'retentionEnds', label: 'Retention ended', type: 'date', required: true },
            { key: 'cubicFeet', label: 'Cubic feet', type: 'number', total: true },
          ] } },
          { key: 'method', label: 'Destruction method', type: 'radio', required: true, options: ['Shred on site', 'Shred at the records facility', 'Pulp'], props: { inline: true } },
          { key: 'noHold', label: 'No litigation hold, audit or open public-records request applies to these records', type: 'checkbox', required: true },
          { key: 'certificate', label: 'Send a certificate of destruction when it is done', type: 'checkbox', props: { defaultValue: 'yes' } },
          { key: 'signature', label: 'Signature', type: 'sigpad', required: true, props: { width: 8 } },
        ],
      },
      steps: [
        { name: 'Department head', approverUserId: manager, ...remind },
        { name: 'Records officer', approverUserId: director, ...remind },
      ],
    },
  ];

  for (const { form, steps } of forms) {
    if ((await tenantQuery(tenantId, 'SELECT 1 AS x FROM Forms WHERE TenantId = @TenantId AND Slug = @S', { S: form.slug })).length) {
      console.log(`- "${form.name}" already exists, left alone`);
      continue;
    }
    await withTx(async (tx) => {
      const formId = await createForm(tenantId, createFormSchema.parse(form), tx);
      await publishChain(tenantId, formId, chainSchema.parse({ steps }), admin.UserId, tx);
      console.log(`+ "${form.name}" (form ${formId}, ${steps.length} step(s))`);
    });
  }
}

main()
  .catch((err) => {
    console.error(err.issues ? JSON.stringify(err.issues, null, 2) : err.message);
    process.exitCode = 1;
  })
  .finally(closePool);
