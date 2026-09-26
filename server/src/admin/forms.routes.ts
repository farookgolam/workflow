import { Router } from 'express';
import { z } from 'zod';
import { actorFrom, audit } from '../audit/audit';
import { tenantQuery, withTx } from '../db/query';
import { chainSchema, createForm, createFormSchema, deleteForm, formulasHold, getFormFields, publishChain, replaceFormFields } from '../forms/service';
import { importHtmlForm } from '../forms/htmlImport';
import { FORM_FIELD_TYPES, fieldDefinitionSchema, isStatic, uniqueKeys, validateValues, type FieldDef } from '../forms/validation';
import { assertLookupConfig, lookupDataForFields, resolveLookupRows } from '../lookups/service';
import { AppError } from '../http/errors';
import { previewHandOff } from '../workflow/approvers';
import { cancelRequest } from '../workflow/engine';
import { idParam } from '../workflow/routes';

// Mounted behind requireAuth + requireRole('Admin'). Editing/listing config arrives with the admin portal (Phase 5).
export const adminFormsRouter = Router();

adminFormsRouter.post('/', async (req, res) => {
  const body = createFormSchema.parse(req.body);
  const { tenantId } = req.user!;
  const formId = await withTx(async (tx) => {
    const id = await createForm(tenantId, body, tx);
    await audit(tenantId, actorFrom(req), { action: 'form.created', entityType: 'Form', entityId: id, detail: { slug: body.slug, fields: body.fields.length } }, tx);
    return id;
  });
  res.status(201).json({ formId });
});

// ---- builder preview: try a form (including unsaved changes) exactly as it will behave, without saving or submitting anything ----
const previewFields = z.array(fieldDefinitionSchema(FORM_FIELD_TYPES)).min(1).max(200).refine(uniqueKeys, 'field keys must be unique').superRefine(formulasHold);
const asDefs = (fields: z.infer<typeof previewFields>): FieldDef[] =>
  fields.map((f, i) => ({ id: 0, key: f.key, label: f.label, type: f.type, required: f.required, options: f.options ?? null, rules: f.rules ?? null, props: f.props ?? null, sortOrder: i + 1 }));

/** The lookup choices and auto-fill data the previewed form needs (same column filtering as for real submitters). */
adminFormsRouter.post('/preview/lookups', async (req, res) => {
  const { fields } = z.object({ fields: previewFields }).parse(req.body);
  const { tenantId } = req.user!;
  await withTx((tx) => assertLookupConfig(tenantId, fields, tx));
  res.json({ lookups: await lookupDataForFields(tenantId, asDefs(fields)) });
});

/** "Test submit": runs the real server-side validation and auto-fill, and reports what WOULD be stored. Nothing is written. */
adminFormsRouter.post('/preview/validate', async (req, res) => {
  const body = z.object({ fields: previewFields, values: z.record(z.string().max(100), z.unknown()) }).parse(req.body);
  const { tenantId } = req.user!;
  const defs = asDefs(body.fields);
  const stored = validateValues(defs, body.values, { enforceRequired: true }, await resolveLookupRows(tenantId, defs, body.values));
  res.json({ stored: stored.filter((s) => !isStatic(s.def.type)).map((s) => ({ key: s.def.key, label: s.def.label, type: s.def.type, value: s.value, autoFilled: !!s.def.props?.lookupFrom })) });
});

/**
 * Chain "Preview & test": who an UNSAVED step would go to - its fixed approver, or the people the one handing on could
 * choose from (never themselves or the submitter, listed in `excludeUserIds`). Nothing is written and nobody is emailed.
 */
adminFormsRouter.post('/preview/handoff', async (req, res) => {
  const body = z.object({
    step: chainSchema.shape.steps.element,
    stepOrder: z.number().int().min(1).max(20),
    excludeUserIds: z.array(z.number().int().positive()).max(5).default([]),
  }).parse(req.body);
  res.json(await previewHandOff(req.user!.tenantId, body.step, body.stepOrder, body.excludeUserIds));
});

/**
 * Step 1 of "import an HTML form": parse the uploaded HTML into a DRAFT (name, fields, warnings).
 * Nothing is saved - the administrator reviews the draft and then creates the form with POST /admin/forms,
 * and adds approval steps in the editor as for any other form.
 */
adminFormsRouter.post('/import-html', async (req, res) => {
  const body = z.object({ html: z.string().min(1).max(900_000) }).parse(req.body);
  const draft = importHtmlForm(body.html);
  await audit(req.user!.tenantId, actorFrom(req), { action: 'form.import_parsed', entityType: 'Form', detail: { name: draft.name, fields: draft.fields.length, warnings: draft.warnings.length } });
  res.json(draft);
});

adminFormsRouter.put('/:formId/chain', async (req, res) => {
  const body = chainSchema.parse(req.body);
  const { tenantId, userId } = req.user!;
  const formId = idParam(req.params.formId);
  const chain = await withTx(async (tx) => {
    const c = await publishChain(tenantId, formId, body, userId, tx);
    await audit(tenantId, actorFrom(req), { action: 'chain.published', entityType: 'ApprovalChain', entityId: c.chainId, detail: { formId, version: c.version, steps: body.steps.length } }, tx);
    return c;
  });
  res.json(chain);
});

// ---- configuration screens ----
adminFormsRouter.get('/', async (req, res) => {
  const rows = await tenantQuery<Record<string, any>>(
    req.user!.tenantId,
    `SELECT f.FormId, f.Name, f.Slug, f.Description, f.IsActive, c.Version AS ChainVersion,
            (SELECT COUNT(*) FROM ApprovalSteps s WHERE s.TenantId = c.TenantId AND s.ChainId = c.ChainId) AS Steps,
            (SELECT COUNT(*) FROM Requests r WHERE r.TenantId = f.TenantId AND r.FormId = f.FormId) AS Requests
       FROM Forms f
       LEFT JOIN ApprovalChains c ON c.TenantId = f.TenantId AND c.FormId = f.FormId AND c.IsCurrent = 1
      WHERE f.TenantId = @TenantId AND f.DeletedAt IS NULL ORDER BY f.Name`,
  );
  res.json({
    forms: rows.map((f) => ({ formId: f.FormId, name: f.Name, slug: f.Slug, description: f.Description, isActive: f.IsActive, chainVersion: f.ChainVersion, steps: f.Steps, requests: f.Requests })),
  });
});

adminFormsRouter.get('/:formId', async (req, res) => {
  const { tenantId } = req.user!;
  const formId = idParam(req.params.formId);
  const [f] = await tenantQuery<Record<string, any>>(tenantId, 'SELECT FormId, Name, Slug, Description, IsActive, SubmittersSeeComments FROM Forms WHERE TenantId = @TenantId AND FormId = @FormId AND DeletedAt IS NULL', { FormId: formId });
  if (!f) throw new AppError(404, 'not_found', 'Form not found');
  const pick = ({ key, label, type, required, options, rules, props }: FieldDef) => ({ key, label, type, required, options, rules, props });

  const steps = await tenantQuery<Record<string, any>>(
    tenantId,
    `SELECT s.StepId, s.Name, s.ApproverUserId, s.ApproverChosen, s.ApproverListLookupId, s.ApproverListEmailColumn, s.ApproverListNameColumn, s.ApproverListColumnsJson, s.ReminderAfterDays, s.ReminderRepeatDays, s.EscalateAfterDays, s.EscalateToUserId, c.Version
       FROM ApprovalChains c JOIN ApprovalSteps s ON s.TenantId = c.TenantId AND s.ChainId = c.ChainId
      WHERE c.TenantId = @TenantId AND c.FormId = @FormId AND c.IsCurrent = 1 ORDER BY s.StepOrder`,
    { FormId: formId },
  );
  res.json({
    form: { formId, name: f.Name, slug: f.Slug, description: f.Description, isActive: f.IsActive, submittersSeeComments: f.SubmittersSeeComments },
    fields: (await getFormFields(tenantId, formId)).map(pick),
    chainVersion: steps[0]?.Version ?? null,
    steps: steps.map((s) => ({
        name: s.Name, approverUserId: s.ApproverChosen ? null : s.ApproverUserId,
        chosen: s.ApproverChosen ? { lookupId: s.ApproverListLookupId, emailColumn: s.ApproverListEmailColumn, nameColumn: s.ApproverListNameColumn, columns: JSON.parse(s.ApproverListColumnsJson ?? '[]') } : null, reminderAfterDays: s.ReminderAfterDays, reminderRepeatDays: s.ReminderRepeatDays,
        escalateAfterDays: s.EscalateAfterDays, escalateToUserId: s.EscalateToUserId,
      })),
  });
});

const patchFormSchema = createFormSchema.pick({ name: true, description: true, submittersSeeComments: true }).partial().extend({ isActive: z.boolean().optional() });

adminFormsRouter.patch('/:formId', async (req, res) => {
  const body = patchFormSchema.parse(req.body);
  const { tenantId } = req.user!;
  const formId = idParam(req.params.formId);
  await withTx(async (tx) => {
    const rows = await tenantQuery(
      tenantId,
      `UPDATE Forms SET Name = COALESCE(@Name, Name), Description = CASE WHEN @SetDesc = 1 THEN @Description ELSE Description END,
              SubmittersSeeComments = COALESCE(@See, SubmittersSeeComments), IsActive = COALESCE(@Active, IsActive)
       OUTPUT inserted.FormId WHERE TenantId = @TenantId AND FormId = @FormId AND DeletedAt IS NULL`,
      {
        FormId: formId, Name: body.name ?? null, SetDesc: body.description === undefined ? 0 : 1, Description: body.description || null,
        See: body.submittersSeeComments === undefined ? null : body.submittersSeeComments ? 1 : 0,
        Active: body.isActive === undefined ? null : body.isActive ? 1 : 0,
      },
      tx,
    );
    if (!rows.length) throw new AppError(404, 'not_found', 'Form not found');
    await audit(tenantId, actorFrom(req), { action: 'form.updated', entityType: 'Form', entityId: formId, detail: body }, tx);
  });
  res.status(204).end();
});

/** Replaces the form's field list. Fields that disappear are retired (not deleted) because past requests still reference them. */
adminFormsRouter.put('/:formId/fields', async (req, res) => {
  const body = createFormSchema.pick({ fields: true }).parse(req.body);
  const { tenantId } = req.user!;
  const formId = idParam(req.params.formId);
  await withTx(async (tx) => {
    await replaceFormFields(tenantId, formId, body.fields, tx);
    await audit(tenantId, actorFrom(req), { action: 'form.fields_updated', entityType: 'Form', entityId: formId, detail: { keys: body.fields.map((x) => x.key) } }, tx);
  });
  res.status(204).end();
});

/** Delete from the repository: see deleteForm() for what happens to forms that already have requests. */
adminFormsRouter.delete('/:formId', async (req, res) => {
  const { tenantId, userId } = req.user!;
  const formId = idParam(req.params.formId);
  const result = await withTx(async (tx) => {
    const r = await deleteForm(tenantId, formId, userId, tx);
    await audit(tenantId, actorFrom(req), { action: 'form.deleted', entityType: 'Form', entityId: formId, detail: r }, tx);
    return r;
  });
  res.json(result);
});

export const adminRequestsRouter = Router();

adminRequestsRouter.post('/:id/cancel', async (req, res) => {
  const body = z.object({ reason: z.string().trim().min(1).max(1000) }).parse(req.body);
  await cancelRequest(req.user!.tenantId, actorFrom(req), req.user!.userId, idParam(req.params.id), body.reason);
  res.status(204).end();
});
