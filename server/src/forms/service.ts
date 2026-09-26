import { z } from 'zod';
import { tenantQuery, type Tx } from '../db/query';
import { AppError } from '../http/errors';
import { assertLookupConfig } from '../lookups/service';
import { FORM_FIELD_TYPES, fieldDefinitionSchema, formulaProblem, isStatic, uniqueKeys, type FieldDef, type FieldType } from './validation';

/** A list of controls whose formulas all name controls that exist, without going round in a circle. */
export const formulasHold = (fields: Parameters<typeof formulaProblem>[0], ctx: z.RefinementCtx) => {
  const problem = formulaProblem(fields);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
};

const formField = fieldDefinitionSchema(FORM_FIELD_TYPES);

export const createFormSchema = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/, 'lowercase letters, digits and hyphens'),
  description: z.string().trim().max(1000).optional(),
  submittersSeeComments: z.boolean().default(false),
  fields: z
    .array(formField)
    .min(1)
    .max(200)
    .refine(uniqueKeys, 'field keys must be unique')
    .refine((fields) => fields.some((f) => !isStatic(f.type)), 'a form needs at least one control that collects a value')
    .superRefine(formulasHold),
});

export const chainSchema = z.object({
  steps: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        // Who approves this step - one of:
        //   approverUserId  always this person
        //   chosen          the person before chooses (the submitter for step 1, the approver of the step before for the
        //                   others): from a lookup file of approvers, or - with no lookupId - from everyone with the Approver role
        approverUserId: z.number().int().positive().nullable().default(null),
        chosen: z
          .object({
            lookupId: z.number().int().positive().nullable().default(null),
            emailColumn: z.string().min(1).max(100).nullable().default(null), // the column with each person's email
            nameColumn: z.string().min(1).max(100).nullable().default(null), // their name (the key column when empty)
            columns: z.array(z.string().min(1).max(100)).max(8).default([]), // shown, filled in, beside the chosen person
          })
          .nullable()
          .default(null),
        reminderAfterDays: z.number().int().min(1).max(365).nullable().default(null),
        reminderRepeatDays: z.number().int().min(1).max(365).nullable().default(null),
        escalateAfterDays: z.number().int().min(1).max(365).nullable().default(null),
        escalateToUserId: z.number().int().positive().nullable().default(null),
        // approvers only decide and comment: a step no longer has controls of its own (older chains' answers stay readable)
        fields: z.array(z.unknown()).max(0, 'Approvers no longer fill in controls: remove the fields from this step').optional(),
      }),
    )
    .min(1)
    .max(20),
});

interface FieldRow {
  Id: number;
  FieldKey: string;
  Label: string;
  FieldType: FieldType;
  IsRequired: boolean;
  OptionsJson: string | null;
  ValidationJson: string | null;
  PropsJson: string | null;
  SortOrder: number;
}
const toDef = (r: FieldRow): FieldDef => ({
  id: r.Id,
  key: r.FieldKey,
  label: r.Label,
  type: r.FieldType,
  required: r.IsRequired,
  options: r.OptionsJson ? JSON.parse(r.OptionsJson) : null,
  rules: r.ValidationJson ? JSON.parse(r.ValidationJson) : null,
  props: r.PropsJson ? JSON.parse(r.PropsJson) : null,
  sortOrder: r.SortOrder,
});

export async function createForm(tenantId: number, input: z.infer<typeof createFormSchema>, tx: Tx): Promise<number> {
  const clash = await tenantQuery(
    tenantId,
    'SELECT 1 AS x FROM Forms WITH (UPDLOCK, HOLDLOCK) WHERE TenantId = @TenantId AND Slug = @Slug',
    { Slug: input.slug },
    tx,
  );
  if (clash.length) throw new AppError(409, 'slug_taken', 'A form with this slug already exists');
  await assertLookupConfig(tenantId, input.fields, tx);

  const [{ FormId }] = await tenantQuery<{ FormId: number }>(
    tenantId,
    `INSERT INTO Forms (TenantId, Name, Slug, Description, SubmittersSeeComments)
     OUTPUT inserted.FormId VALUES (@TenantId, @Name, @Slug, @Description, @SeeComments)`,
    { Name: input.name, Slug: input.slug, Description: input.description ?? null, SeeComments: input.submittersSeeComments },
    tx,
  );
  for (const [i, f] of input.fields.entries()) {
    await tenantQuery(
      tenantId,
      `INSERT INTO FormFields (TenantId, FormId, FieldKey, Label, FieldType, IsRequired, OptionsJson, ValidationJson, PropsJson, SortOrder)
       VALUES (@TenantId, @FormId, @Key, @Label, @Type, @Required, @Options, @Rules, @Props, @Sort)`,
      {
        FormId,
        Key: f.key,
        Label: f.label,
        Type: f.type,
        Required: f.required,
        Options: f.options ? JSON.stringify(f.options) : null,
        Rules: f.rules ? JSON.stringify(f.rules) : null,
        Props: f.props && Object.keys(f.props).length ? JSON.stringify(f.props) : null,
        Sort: i + 1,
      },
      tx,
    );
  }
  return FormId;
}

/** Replaces a form's field list. Fields that disappear are retired (not deleted) because past requests still reference them. */
export async function replaceFormFields(tenantId: number, formId: number, fields: z.infer<typeof createFormSchema>['fields'], tx: Tx): Promise<void> {
  const form = await tenantQuery(tenantId, 'SELECT 1 AS x FROM Forms WITH (UPDLOCK, HOLDLOCK) WHERE TenantId = @TenantId AND FormId = @FormId AND DeletedAt IS NULL', { FormId: formId }, tx);
  if (!form.length) throw new AppError(404, 'not_found', 'Form not found');
  await assertLookupConfig(tenantId, fields, tx);
  await tenantQuery(tenantId, 'UPDATE FormFields SET IsActive = 0 WHERE TenantId = @TenantId AND FormId = @FormId', { FormId: formId }, tx);
  for (const [i, fld] of fields.entries()) {
    const params = {
      FormId: formId, Key: fld.key, Label: fld.label, Type: fld.type, Required: fld.required,
      Options: fld.options ? JSON.stringify(fld.options) : null, Rules: fld.rules ? JSON.stringify(fld.rules) : null,
      Props: fld.props && Object.keys(fld.props).length ? JSON.stringify(fld.props) : null, Sort: i + 1,
    };
    const updated = await tenantQuery(
      tenantId,
      `UPDATE FormFields SET Label = @Label, FieldType = @Type, IsRequired = @Required, OptionsJson = @Options, ValidationJson = @Rules, PropsJson = @Props, SortOrder = @Sort, IsActive = 1
       OUTPUT inserted.FieldId WHERE TenantId = @TenantId AND FormId = @FormId AND FieldKey = @Key`,
      params,
      tx,
    );
    if (!updated.length) {
      await tenantQuery(
        tenantId,
        `INSERT INTO FormFields (TenantId, FormId, FieldKey, Label, FieldType, IsRequired, OptionsJson, ValidationJson, PropsJson, SortOrder)
         VALUES (@TenantId, @FormId, @Key, @Label, @Type, @Required, @Options, @Rules, @Props, @Sort)`,
        params,
        tx,
      );
    }
  }
}

/** Publishes a new chain version. Requests already in flight keep the version they started on. */
export async function publishChain(
  tenantId: number,
  formId: number,
  input: z.infer<typeof chainSchema>,
  createdBy: number,
  tx: Tx,
): Promise<{ chainId: number; version: number }> {
  const form = await tenantQuery(
    tenantId,
    'SELECT 1 AS x FROM Forms WITH (UPDLOCK, HOLDLOCK) WHERE TenantId = @TenantId AND FormId = @FormId AND DeletedAt IS NULL',
    { FormId: formId },
    tx,
  );
  if (!form.length) throw new AppError(404, 'not_found', 'Form not found');

  // every step either always goes to one person, or is chosen by the person before it - never both, never neither
  input.steps.forEach((s, i) => {
    const fail = (message: string) => new AppError(400, 'validation_failed', 'Invalid input', [{ path: `steps.${i}.approverUserId`, message: `Step "${s.name}": ${message}` }]);
    if (s.approverUserId === null && !s.chosen) throw fail('choose who approves it - always the same person, or chosen by ' + (i === 0 ? 'the submitter' : 'the approver of the step before'));
    if (s.approverUserId !== null && s.chosen) throw fail('it either always goes to the same person or is chosen, not both');
  });
  const approverIds = [...new Set(input.steps.map((s) => s.approverUserId).filter((x): x is number => x !== null))];
  const escalateIds = [...new Set(input.steps.map((s) => s.escalateToUserId).filter((x): x is number => x !== null))];
  for (const [ids, needRole] of [[approverIds, true], [escalateIds, false]] as const) {
    for (const userId of ids) {
      const [u] = await tenantQuery<{ IsApprover: number }>(
        tenantId,
        `SELECT CASE WHEN EXISTS (SELECT 1 FROM UserRoles r WHERE r.TenantId = u.TenantId AND r.UserId = u.UserId AND r.Role IN ('Approver','Admin'))
                THEN 1 ELSE 0 END AS IsApprover
           FROM Users u WHERE u.TenantId = @TenantId AND u.UserId = @UserId AND u.IsActive = 1`,
        { UserId: userId },
        tx,
      );
      if (!u) throw new AppError(400, 'invalid_user', `User ${userId} does not exist or is inactive`);
      if (needRole && !u.IsApprover) throw new AppError(400, 'not_an_approver', `User ${userId} does not have the Approver role`);
    }
  }

  for (const [i, step] of input.steps.entries()) {
    const list = step.chosen;
    if (!list || (!list.lookupId && !list.emailColumn)) continue; // chosen from everyone with the Approver role
    const bad = (message: string) => new AppError(400, 'validation_failed', 'Invalid input', [{ path: `steps.${i}.chosen`, message: `Step "${step.name}": ${message}` }]);
    const [table] = await tenantQuery<{ ColumnsJson: string }>(tenantId, 'SELECT ColumnsJson FROM LookupTables WHERE TenantId = @TenantId AND LookupId = @L', { L: list.lookupId ?? 0 }, tx);
    if (!table) throw bad('choose the lookup file that lists who can approve it');
    const columns = JSON.parse(table.ColumnsJson) as string[];
    if (!list.emailColumn || !columns.includes(list.emailColumn)) throw bad('choose the column that holds each approver\'s email address');
    const missing = [...list.columns, ...(list.nameColumn ? [list.nameColumn] : [])].find((c) => !columns.includes(c));
    if (missing) throw bad(`the lookup file has no column "${missing}"`);
  }

  const [{ Next }] = await tenantQuery<{ Next: number }>(
    tenantId,
    'SELECT ISNULL(MAX(Version), 0) + 1 AS Next FROM ApprovalChains WHERE TenantId = @TenantId AND FormId = @FormId',
    { FormId: formId },
    tx,
  );
  await tenantQuery(
    tenantId,
    'UPDATE ApprovalChains SET IsCurrent = 0 WHERE TenantId = @TenantId AND FormId = @FormId AND IsCurrent = 1',
    { FormId: formId },
    tx,
  );
  const [{ ChainId }] = await tenantQuery<{ ChainId: number }>(
    tenantId,
    `INSERT INTO ApprovalChains (TenantId, FormId, Version, IsCurrent, CreatedBy)
     OUTPUT inserted.ChainId VALUES (@TenantId, @FormId, @Version, 1, @CreatedBy)`,
    { FormId: formId, Version: Next, CreatedBy: createdBy },
    tx,
  );

  for (const [i, s] of input.steps.entries()) {
    const [{ StepId }] = await tenantQuery<{ StepId: number }>(
      tenantId,
      `INSERT INTO ApprovalSteps (TenantId, ChainId, StepOrder, Name, ApproverUserId, ApproverChosen, ApproverListLookupId, ApproverListEmailColumn, ApproverListNameColumn, ApproverListColumnsJson, ReminderAfterDays, ReminderRepeatDays, EscalateAfterDays, EscalateToUserId)
       OUTPUT inserted.StepId
       VALUES (@TenantId, @ChainId, @Order, @Name, @Approver, @Chosen, @ListLookup, @ListEmail, @ListName, @ListColumns, @Remind, @Repeat, @Escalate, @EscalateTo)`,
      {
        ChainId,
        Order: i + 1,
        Name: s.name,
        // a chosen step: the column still needs someone, and it is always replaced before the step is activated
        Approver: s.approverUserId ?? createdBy,
        Chosen: !!s.chosen,
        ListLookup: s.chosen?.lookupId ?? null,
        ListEmail: s.chosen?.lookupId ? s.chosen.emailColumn : null,
        ListName: s.chosen?.lookupId ? s.chosen.nameColumn : null,
        ListColumns: s.chosen?.lookupId && s.chosen.columns.length ? JSON.stringify(s.chosen.columns) : null,
        Remind: s.reminderAfterDays,
        Repeat: s.reminderRepeatDays,
        Escalate: s.escalateAfterDays,
        EscalateTo: s.escalateToUserId,
      },
      tx,
    );
  }
  return { chainId: ChainId, version: Next };
}

export async function getFormFields(tenantId: number, formId: number, tx?: Tx): Promise<FieldDef[]> {
  const rows = await tenantQuery<FieldRow>(
    tenantId,
    `SELECT FieldId AS Id, FieldKey, Label, FieldType, IsRequired, OptionsJson, ValidationJson, PropsJson, SortOrder
       FROM FormFields WHERE TenantId = @TenantId AND FormId = @FormId AND IsActive = 1 ORDER BY SortOrder`,
    { FormId: formId },
    tx,
  );
  return rows.map(toDef);
}

/** The controls an approver of an older chain version filled in - kept only so their answers can still be read. */
export async function getStepFields(tenantId: number, stepId: number, tx?: Tx): Promise<FieldDef[]> {
  const rows = await tenantQuery<FieldRow>(
    tenantId,
    `SELECT StepFieldId AS Id, FieldKey, Label, FieldType, IsRequired, OptionsJson, ValidationJson, PropsJson, SortOrder
       FROM StepFields WHERE TenantId = @TenantId AND StepId = @StepId ORDER BY SortOrder`,
    { StepId: stepId },
    tx,
  );
  return rows.map(toDef);
}

export async function listActiveForms(tenantId: number) {
  return tenantQuery<{ FormId: number; Name: string; Slug: string; Description: string | null }>(
    tenantId,
    `SELECT f.FormId, f.Name, f.Slug, f.Description FROM Forms f
      WHERE f.TenantId = @TenantId AND f.IsActive = 1 AND f.DeletedAt IS NULL
        AND EXISTS (SELECT 1 FROM ApprovalChains c WHERE c.TenantId = f.TenantId AND c.FormId = f.FormId AND c.IsCurrent = 1)
      ORDER BY f.Name`,
  );
}

/**
 * Removes a form from the repository.
 *  - no requests yet  -> physically deleted with its fields, chain versions and step fields;
 *  - has requests     -> marked deleted and deactivated: hidden from admins and submitters, while its requests,
 *                        audit trail and archived PDFs stay intact. Requests still in progress carry on to a decision.
 * The slug is released either way, so the name can be used again.
 */
export async function deleteForm(tenantId: number, formId: number, deletedBy: number, tx: Tx): Promise<{ mode: 'deleted' | 'archived'; name: string; requests: number; inProgress: number }> {
  const [form] = await tenantQuery<{ Name: string; Slug: string }>(
    tenantId,
    'SELECT Name, Slug FROM Forms WITH (UPDLOCK, HOLDLOCK) WHERE TenantId = @TenantId AND FormId = @FormId AND DeletedAt IS NULL',
    { FormId: formId },
    tx,
  );
  if (!form) throw new AppError(404, 'not_found', 'Form not found');
  const [counts] = await tenantQuery<{ Total: number; InProgress: number }>(
    tenantId,
    `SELECT COUNT(*) AS Total, ISNULL(SUM(CASE WHEN Status = 'InProgress' THEN 1 ELSE 0 END), 0) AS InProgress
       FROM Requests WITH (UPDLOCK, HOLDLOCK) WHERE TenantId = @TenantId AND FormId = @FormId`,
    { FormId: formId },
    tx,
  );

  if (counts.Total > 0) {
    await tenantQuery(
      tenantId,
      `UPDATE Forms SET DeletedAt = SYSUTCDATETIME(), DeletedBy = @By, IsActive = 0, Slug = LEFT(Slug, 70) + '--deleted-' + CAST(FormId AS VARCHAR(12))
        WHERE TenantId = @TenantId AND FormId = @FormId`,
      { FormId: formId, By: deletedBy },
      tx,
    );
    return { mode: 'archived', name: form.Name, requests: counts.Total, inProgress: counts.InProgress };
  }

  // nothing references this form's definition yet: remove it completely, children first
  await tenantQuery(
    tenantId,
    `DELETE sf FROM StepFields sf
       JOIN ApprovalSteps s ON s.TenantId = sf.TenantId AND s.StepId = sf.StepId
       JOIN ApprovalChains c ON c.TenantId = s.TenantId AND c.ChainId = s.ChainId
      WHERE sf.TenantId = @TenantId AND c.FormId = @FormId`,
    { FormId: formId },
    tx,
  );
  await tenantQuery(
    tenantId,
    `DELETE s FROM ApprovalSteps s JOIN ApprovalChains c ON c.TenantId = s.TenantId AND c.ChainId = s.ChainId
      WHERE s.TenantId = @TenantId AND c.FormId = @FormId`,
    { FormId: formId },
    tx,
  );
  await tenantQuery(tenantId, 'DELETE FROM ApprovalChains WHERE TenantId = @TenantId AND FormId = @FormId', { FormId: formId }, tx);
  await tenantQuery(tenantId, 'DELETE FROM FormFields WHERE TenantId = @TenantId AND FormId = @FormId', { FormId: formId }, tx);
  await tenantQuery(tenantId, 'DELETE FROM Forms WHERE TenantId = @TenantId AND FormId = @FormId', { FormId: formId }, tx);
  return { mode: 'deleted', name: form.Name, requests: 0, inProgress: 0 };
}
