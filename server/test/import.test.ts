import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../src/db/pool';
import { importHtmlForm } from '../src/forms/htmlImport';
import { app, bearer, login, makeTenant, makeUser } from './helpers';

const api = '/api/v1';
const sample = fs.readFileSync(path.resolve(__dirname, '../../docs/samples/travel-request.html'), 'utf8');
let t: { tenantId: number; slug: string };
const tok: Record<string, string> = {};
const ids: Record<string, number> = {};

beforeAll(async () => {
  t = await makeTenant();
  for (const [name, roles] of Object.entries({ admin: ['Admin'], sam: ['Submitter'], ann: ['Approver'] } as const)) {
    ids[name] = await makeUser(t.tenantId, `${name}@im.test`, [...roles], name.toUpperCase());
    tok[name] = (await login(t.slug, `${name}@im.test`)).body.accessToken;
  }
});
afterAll(closePool);

describe('HTML form import: parsing', () => {
  const draft = importHtmlForm(sample);
  const byKey = Object.fromEntries(draft.fields.map((f) => [f.key, f]));

  it('takes the name and description from the page', () => {
    expect(draft.name).toBe('Travel Request');
    expect(draft.description).toBe('Request approval for business travel before booking anything.');
  });

  it('maps each kind of control, keeping document order, labels, required flags and rules', () => {
    expect(draft.fields.map((f) => f.key)).toEqual([
      'travellerName', 'contactEmail', 'destination', 'departureDate', 'returnDate', 'estimatedCost', 'nights', 'department',
      'travelClass', 'extras', 'justification', 'costCode', 'policyAck',
    ]);
    expect(byKey.travellerName).toEqual({ key: 'travellerName', label: 'Traveller name', type: 'text', required: true, rules: { maxLength: 120 } });
    expect(byKey.contactEmail).toMatchObject({ type: 'email', required: true });
    expect(byKey.destination).toMatchObject({ label: 'Destination', type: 'text', required: true, props: { placeholder: 'City, country' } }); // wrapping <label>
    expect(byKey.departureDate).toMatchObject({ type: 'date', required: true });
    expect(byKey.returnDate).toMatchObject({ type: 'date', required: false });
    expect(byKey.estimatedCost).toEqual({ key: 'estimatedCost', label: 'Estimated total cost', type: 'currency', required: true, rules: { min: 0, max: 50000 } });
    expect(byKey.nights).toMatchObject({ type: 'number', rules: { min: 0, max: 60 } });
    expect(byKey.department).toMatchObject({ type: 'select', required: true, options: ['Sales', 'Engineering', 'Operations'] }); // placeholder option dropped
    expect(byKey.travelClass).toEqual({ key: 'travelClass', label: 'Travel class', type: 'radio', required: true, options: ['Economy', 'Premium economy', 'Business'] }); // radio group + legend
    expect(byKey.extras).toEqual({ key: 'extras', label: 'Extras needed', type: 'multiselect', required: false, options: ['Hotel', 'Rental car'] }); // tick all that apply
    expect(byKey.justification).toMatchObject({ type: 'textarea', required: true, rules: { maxLength: 2000 } });
    expect(byKey.costCode.rules?.pattern).toBe('^(?:[A-Z]{2}-\\d{4})$');
    expect(byKey.policyAck).toMatchObject({ label: 'I have read the travel policy', type: 'checkbox', required: true });
  });

  it('skips what it cannot represent and says so', () => {
    expect(draft.fields.some((f) => /csrf|itinerary/i.test(f.key))).toBe(false);
    expect(draft.warnings.join(' | ')).toMatch(/file upload field\(s\) were skipped/);
  });

  it('copes with awkward input: no <form>, duplicate / missing names, script-filled selects, hostile markup', () => {
    const d = importHtmlForm(`
      <h2>Quick  form</h2>
      <input name="name"><input name="name"><input placeholder="Your phone">
      <select name="site"></select>
      <input type="time" name="start"><input type="datetime-local" name="when"><input type="color" name="tag"><input type="range" name="score" min="1" max="5"><input type="tel" name="cell"><input type="url" name="site_link">
      <select name="langs" multiple><option>EN</option><option>FR</option></select>
      <input name="x" pattern="(unclosed">
      <img src=x onerror="alert(1)"><script>document.write('<input name=injected>')</script>`);
    expect(d.name).toBe('Quick form');
    expect(d.fields.map((f) => [f.key, f.type])).toEqual([
      ['name', 'text'], ['name2', 'text'], ['yourPhone', 'text'], ['site', 'text'],
      ['start', 'time'], ['when', 'datetime'], ['tag', 'color'], ['score', 'range'], ['cell', 'tel'], ['siteLink', 'url'], ['langs', 'multiselect'], ['x', 'text'],
    ]);
    expect(d.fields.find((f) => f.key === 'score')).toMatchObject({ rules: { min: 1, max: 5 } });
    expect(d.fields.find((f) => f.key === 'x')!.rules).toBeUndefined();
    expect(d.warnings.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(d)).not.toContain('injected');
    expect(() => importHtmlForm('<p>No inputs here</p>')).toThrow(/No form fields/);
  });
});

describe('HTML form import: end to end', () => {
  it('admin imports, saves the draft unchanged, adds a step - and a submitter can use the form', async () => {
    expect((await request(app).post(`${api}/admin/forms/import-html`).set(bearer(tok.sam)).send({ html: sample })).status).toBe(403);

    const parsed = await request(app).post(`${api}/admin/forms/import-html`).set(bearer(tok.admin)).send({ html: sample });
    expect(parsed.status).toBe(200);

    // the draft is accepted as-is by the ordinary create-form endpoint
    const created = await request(app).post(`${api}/admin/forms`).set(bearer(tok.admin)).send({ name: parsed.body.name, slug: 'travel-request', description: parsed.body.description, fields: parsed.body.fields });
    expect(created.status).toBe(201);
    const formId = created.body.formId;

    // no steps yet -> not offered to submitters
    expect((await request(app).get(`${api}/forms`).set(bearer(tok.sam))).body.forms).toEqual([]);
    const chain = await request(app).put(`${api}/admin/forms/${formId}/chain`).set(bearer(tok.admin)).send({ steps: [{ name: 'Manager', approverUserId: ids.ann }] });
    expect(chain.body.version).toBe(1);

    const values = {
      travellerName: 'Sam', contactEmail: 'sam@im.test', destination: 'Lisbon, Portugal', departureDate: '2026-11-02', estimatedCost: 1250.5,
      department: 'Engineering', travelClass: 'Economy', extras: ['Hotel'], justification: 'Client workshop', costCode: 'EN-2026', policyAck: true,
    };
    const bad = await request(app).post(`${api}/forms/${formId}/requests`).set(bearer(tok.sam)).send({ values: { ...values, costCode: 'nope', estimatedCost: 99999 } });
    expect(bad.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(['costCode', 'estimatedCost']); // imported rules are enforced
    expect((await request(app).post(`${api}/forms/${formId}/requests`).set(bearer(tok.sam)).send({ values })).status).toBe(201);
  });

  it('rejects oversized and empty uploads cleanly', async () => {
    expect((await request(app).post(`${api}/admin/forms/import-html`).set(bearer(tok.admin)).send({ html: '' })).status).toBe(400);
    expect((await request(app).post(`${api}/admin/forms/import-html`).set(bearer(tok.admin)).send({ html: '<p>nothing</p>' })).body.error.code).toBe('no_fields');
    const huge = await request(app).post(`${api}/admin/forms/import-html`).set(bearer(tok.admin)).send({ html: `<form>${'<input name=a>'.repeat(90000)}</form>` });
    expect(huge.status).toBe(413);
  });
});
