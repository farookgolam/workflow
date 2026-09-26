import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../src/db/pool';
import { tenantQuery } from '../src/db/query';
import { app, bearer, login, makeTenant, makeUser } from './helpers';

const api = '/api/v1';
let t: { tenantId: number; slug: string };
let formId: number;
const ids: Record<string, number> = {};
const tok: Record<string, string> = {};

const fields = [
  { key: 'intro', label: 'About this form', type: 'heading' },
  { key: 'blurb', label: 'Intro text', type: 'paragraph', props: { text: 'Fill in every section.' } },
  { key: 'phone', label: 'Phone', type: 'tel', props: { width: 6, placeholder: '+1 555 0100' } },
  { key: 'site', label: 'Website', type: 'url', props: { width: 6 } },
  { key: 'startTime', label: 'Start time', type: 'time', props: { width: 3 } },
  { key: 'meeting', label: 'Meeting', type: 'datetime', props: { width: 9 } },
  { key: 'period', label: 'Period', type: 'month', props: { width: 4 } },
  { key: 'isoWeek', label: 'Week', type: 'week', props: { width: 4 } },
  { key: 'tag', label: 'Tag colour', type: 'color', props: { width: 4, defaultValue: '#1d4ed8' } },
  { key: 'rule', label: 'Divider', type: 'divider' },
  { key: 'score', label: 'Score', type: 'range', rules: { min: 1, max: 5 }, props: { step: 1 } },
  { key: 'size', label: 'Size', type: 'radio', required: true, options: ['S', 'M', 'L'], props: { inline: true } },
  { key: 'extras', label: 'Extras', type: 'multiselect', options: ['Hotel', 'Car', 'Visa'], rules: { max: 2 } },
  { key: 'notes', label: 'Notes', type: 'textarea', props: { rows: 8, helpText: 'Anything else we should know' } },
  { key: 'sign', label: 'Signature', type: 'signature', required: true },
];
const good = {
  phone: '+1 (555) 010-0199', site: 'https://example.com/a?b=1', startTime: '08:30', meeting: '2026-11-02T14:45', period: '2026-11', isoWeek: '2026-W45',
  tag: '#FFAA00', score: 4, size: 'M', extras: ['Visa', 'Hotel'], notes: 'ok', sign: 'Sam Submitter',
};
const submit = (values: Record<string, unknown>) => request(app).post(`${api}/forms/${formId}/requests`).set(bearer(tok.sam)).send({ values });

beforeAll(async () => {
  t = await makeTenant();
  for (const [name, roles] of Object.entries({ admin: ['Admin'], sam: ['Submitter'], ann: ['Approver'] } as const)) {
    ids[name] = await makeUser(t.tenantId, `${name}@ft.test`, [...roles], name.toUpperCase());
    tok[name] = (await login(t.slug, `${name}@ft.test`)).body.accessToken;
  }
  const created = await request(app).post(`${api}/admin/forms`).set(bearer(tok.admin)).send({ name: 'Everything', slug: 'everything', fields });
  expect(created.status).toBe(201);
  formId = created.body.formId;
  await request(app).put(`${api}/admin/forms/${formId}/chain`).set(bearer(tok.admin))
    .send({ steps: [{ name: 'Check', approverUserId: ids.ann }] });
});
afterAll(closePool);

describe('modern control types', () => {
  it('definitions round-trip with their layout properties, for submitters and in the admin editor', async () => {
    const forSubmitter = (await request(app).get(`${api}/forms/${formId}`).set(bearer(tok.sam))).body.fields;
    expect(forSubmitter.map((f: { key: string }) => f.key)).toEqual(fields.map((f) => f.key));
    const by = Object.fromEntries(forSubmitter.map((f: { key: string }) => [f.key, f]));
    expect(by.phone.props).toEqual({ width: 6, placeholder: '+1 555 0100' });
    expect(by.blurb.props.text).toBe('Fill in every section.');
    expect(by.notes.props).toEqual({ rows: 8, helpText: 'Anything else we should know' });
    expect(by.size).toMatchObject({ type: 'radio', options: ['S', 'M', 'L'], props: { inline: true } });

    const editor = (await request(app).get(`${api}/admin/forms/${formId}`).set(bearer(tok.admin))).body;
    expect(editor.fields.find((f: { key: string }) => f.key === 'tag').props).toEqual({ width: 4, defaultValue: '#1d4ed8' });

    // resizing = saving a new width
    const resized = fields.map((f) => (f.key === 'phone' ? { ...f, props: { ...f.props, width: 12 } } : f));
    expect((await request(app).put(`${api}/admin/forms/${formId}/fields`).set(bearer(tok.admin)).send({ fields: resized })).status).toBe(204);
    expect((await request(app).get(`${api}/forms/${formId}`).set(bearer(tok.sam))).body.fields.find((f: { key: string }) => f.key === 'phone').props.width).toBe(12);
  });

  it('rejects bad definitions', async () => {
    const make = (field: Record<string, unknown>) => request(app).post(`${api}/admin/forms`).set(bearer(tok.admin)).send({ name: 'Bad', slug: `bad-${Math.random().toString(36).slice(2)}`, fields: [field] });
    expect((await make({ key: 'a', label: 'A', type: 'radio' })).status).toBe(400); // needs options
    expect((await make({ key: 'a', label: 'A', type: 'multiselect', options: ['x', 'x'] })).status).toBe(400); // duplicate options
    expect((await make({ key: 'a', label: 'A', type: 'text', props: { width: 5 } })).status).toBe(400); // not a grid width
    expect((await make({ key: 'a', label: 'A', type: 'text', props: { onclick: 'x' } })).status).toBe(400); // unknown property
    expect((await make({ key: 'a', label: 'Only a heading', type: 'heading' })).status).toBe(400); // nothing to fill in
    expect((await make({ key: 'a', label: 'A', type: 'file' })).status).toBe(400);
  });

  it('accepts valid values, normalises them, and never stores layout elements', async () => {
    const res = await submit(good);
    expect(res.status).toBe(201);
    const stored = Object.fromEntries((await tenantQuery<{ FieldKey: string; Value: string | null }>(t.tenantId, 'SELECT FieldKey, Value FROM RequestData WHERE TenantId = @TenantId AND RequestId = @R', { R: res.body.requestId })).map((r) => [r.FieldKey, r.Value]));
    expect(stored).toEqual({
      phone: '+1 (555) 010-0199', site: 'https://example.com/a?b=1', startTime: '08:30', meeting: '2026-11-02T14:45', period: '2026-11', isoWeek: '2026-W45',
      tag: '#ffaa00', score: '4', size: 'M', extras: '["Hotel","Visa"]', notes: 'ok', sign: 'Sam Submitter',
    });
    expect(Object.keys(stored)).not.toContain('intro');
  });

  it('rejects invalid values for each new type', async () => {
    const bad: Record<string, unknown> = {
      phone: 'call me', site: 'javascript:alert(1)', startTime: '25:00', meeting: '2026-02-30T10:00', period: '2026-13', isoWeek: '2026-W54', tag: 'red',
      score: 9, size: 'XL', extras: ['Hotel', 'Car', 'Visa'], sign: '',
    };
    const res = await submit({ ...good, ...bad });
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(Object.keys(bad).sort());

    expect((await submit({ ...good, extras: ['Spa'] })).body.error.details[0].path).toBe('extras');
    expect((await submit({ ...good, extras: 'Hotel' })).body.error.details[0].path).toBe('extras');
    expect((await submit({ ...good, intro: 'x' })).body.error.details[0].path).toBe('intro'); // layout elements take no value
    expect((await submit({ ...good, site: 'ftp://example.com' })).status).toBe(400);
  });

  it('pictures and alignment: saved with the form, shown to submitters, never stored with a request', async () => {
    // a 1x1 transparent PNG
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const designed = [
      { key: 'logo', label: 'Logo', type: 'image', props: { width: 4, imageDataUrl: png, imageAlt: 'Acme logo', imageHeight: 80, align: 'center' } },
      { key: 'title', label: 'Expense claim', type: 'heading', props: { width: 8, align: 'right', headingSize: 'xlarge' } },
      { key: 'terms', label: 'Terms', type: 'paragraph', props: { text: 'Keep every receipt.', align: 'justify' } },
      { key: 'amount', label: 'Amount', type: 'currency', props: { align: 'right' } },
    ];
    const created = await request(app).post(`${api}/admin/forms`).set(bearer(tok.admin)).send({ name: 'Branded', slug: 'branded', fields: designed });
    expect(created.status).toBe(201);
    await request(app).put(`${api}/admin/forms/${created.body.formId}/chain`).set(bearer(tok.admin)).send({ steps: [{ name: 'Check', approverUserId: ids.ann }] });

    const shown =(await request(app).get(`${api}/forms/${created.body.formId}`).set(bearer(tok.sam))).body.fields;
    expect(shown.map((f: { key: string; props: unknown }) => [f.key, f.props])).toEqual(designed.map((f) => [f.key, f.props]));

    const res = await request(app).post(`${api}/forms/${created.body.formId}/requests`).set(bearer(tok.sam)).send({ values: { amount: 12.5 } });
    expect(res.status).toBe(201);
    const stored = await tenantQuery<{ FieldKey: string }>(t.tenantId, 'SELECT FieldKey FROM RequestData WHERE TenantId = @TenantId AND RequestId = @R', { R: res.body.requestId });
    expect(stored.map((r) => r.FieldKey)).toEqual(['amount']);
  });

  it('refuses a picture that is not a safe, reasonably sized image', async () => {
    const make = (props: Record<string, unknown>, type = 'image') => request(app).post(`${api}/admin/forms`).set(bearer(tok.admin)).send({
      name: 'Pic', slug: `pic-${Math.random().toString(36).slice(2)}`, fields: [{ key: 'p', label: 'P', type, props }, { key: 'x', label: 'X', type: 'text' }],
    });
    expect((await make({})).status).toBe(400); // a picture control needs a picture
    expect((await make({ imageDataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' })).status).toBe(400); // SVG can carry script
    expect((await make({ imageDataUrl: 'https://example.com/logo.png' })).status).toBe(400); // only an uploaded picture
    expect((await make({ imageDataUrl: `data:image/png;base64,${'A'.repeat(400_001)}` })).status).toBe(400); // over 300 KB
    expect((await make({ imageDataUrl: 'data:image/png;base64,AAAA' }, 'text')).status).toBe(400); // only a picture control has one
    expect((await make({ align: 'diagonal' }, 'heading')).status).toBe(400);
    expect((await make({ headingSize: 'huge' }, 'heading')).status).toBe(400);
  });

  it('applies a pattern and length limits to phone and web address boxes too, not only plain text', async () => {
    const created = await request(app).post(`${api}/admin/forms`).set(bearer(tok.admin)).send({
      name: 'Patterns', slug: 'patterns', fields: [
        { key: 'mobile', label: 'Mobile', type: 'tel', rules: { pattern: String.raw`^\+1 \d{3}-\d{3}-\d{4}$` } },
        { key: 'site', label: 'Site', type: 'url', rules: { pattern: '^https://', maxLength: 40 } },
        { key: 'ext', label: 'Extension', type: 'tel', rules: { minLength: 4 } },
      ],
    });
    expect(created.status).toBe(201);
    await request(app).put(`${api}/admin/forms/${created.body.formId}/chain`).set(bearer(tok.admin)).send({ steps: [{ name: 'Check', approverUserId: ids.ann }] });
    const send = (values: Record<string, unknown>) => request(app).post(`${api}/forms/${created.body.formId}/requests`).set(bearer(tok.sam)).send({ values });

    const wrong = await send({ mobile: '555 0100', site: 'http://example.com', ext: '12' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(['ext', 'mobile', 'site']);
    expect((await send({ site: 'https://example.com/a-very-long-path-that-is-too-long' })).body.error.details[0].path).toBe('site');

    expect((await send({ mobile: '+1 555-010-0199', site: 'https://example.com', ext: '1234' })).status).toBe(201);
  });

  it('the approver sees multi-select answers as submitted', async () => {
    const { body } = await submit(good);
    const [step] = await tenantQuery<{ RequestStepId: number }>(t.tenantId, 'SELECT RequestStepId FROM RequestSteps WHERE TenantId = @TenantId AND RequestId = @R', { R: body.requestId });
    const page = (await request(app).get(`${api}/approvals/${step.RequestStepId}`).set(bearer(tok.ann))).body;
    expect(page.submission.find((f: { key: string }) => f.key === 'extras')).toMatchObject({ type: 'multiselect', value: '["Hotel","Visa"]' });
    expect((await request(app).post(`${api}/approvals/${step.RequestStepId}/decision`).set(bearer(tok.ann)).send({ decision: 'approve' })).body.requestStatus).toBe('Approved');
  });
});
