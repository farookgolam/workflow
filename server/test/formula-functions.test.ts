import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../src/db/pool';
import { tenantQuery } from '../src/db/query';
import { evalFormula, evalValue, parseFormula, type FormulaValue } from '../src/forms/formula';
import { app, bearer, login, makeTenant, makeUser } from './helpers';

const calc = (src: string, vars: Record<string, FormulaValue> = {}) => evalValue(parseFormula(src), vars);

describe('formula functions', () => {
  it('numbers', () => {
    expect(calc('sum(a, b, c)', { a: 1, b: 2.5, c: null })).toBe(3.5);
    expect(calc('a - b', { a: 10, b: 4 })).toBe(6);
    expect(calc('average(a, b, c)', { a: 2, b: 4, c: null })).toBe(3); // only the ones filled in
    expect(calc('floor(2.7) + ceiling(2.1)')).toBe(5);
    expect(calc('mod(17, 5)')).toBe(2);
    expect(calc('mod(-1, 5)')).toBe(4);
    expect(calc('power(2, 10)')).toBe(1024);
    expect(calc('min(3, 1, 2) + max(3, 1, 2)')).toBe(4);
    expect(calc('days(from, to)', { from: '2026-09-01', to: '2026-10-01' })).toBe(30);
    expect(calc('mod(5, 0)')).toBeNull(); // not a number: shown empty
  });

  it('text', () => {
    expect(calc('substring(code, 5, 4)', { code: 'INV-2026-0042' })).toBe('2026');
    expect(calc('mid(code, 10)', { code: 'INV-2026-0042' })).toBe('0042'); // Excel's name, and the length is optional
    expect(calc('left(code, 3) & "/" & right(code, 4)', { code: 'INV-2026-0042' })).toBe('INV/0042');
    expect(calc('concat(upper(first), " ", lower(last))', { first: 'ada', last: 'LOVELACE' })).toBe('ADA lovelace');
    expect(calc('trim(t)', { t: '  a   b  ' })).toBe('a b');
    expect(calc('len(t)', { t: 'hello' })).toBe(5);
    expect(calc('replace(t, "-", "")', { t: '555-010-0199' })).toBe('5550100199');
    expect(calc('text(a, 2) & " USD"', { a: 12.5 })).toBe('12.50 USD');
    expect(calc('"say ""hi"""')).toBe('say "hi"');
    expect(calc('a & b', { a: 0.1, b: 0.2 })).toBe('0.10.2');
    expect(calc('a + b', { a: 0.1, b: 0.2 })).toBeCloseTo(0.3);
  });

  it('comparisons and if', () => {
    expect(calc('if(amount > 1000, "Director", "Manager")', { amount: 1500 })).toBe('Director');
    expect(calc('if(amount > 1000, "Director", "Manager")', { amount: 200 })).toBe('Manager');
    expect(calc('if(dept = "finance", 1, 2)', { dept: 'Finance' })).toBe(1); // text compares ignoring capitals
    expect(calc('if(urgent, 50, 0)', { urgent: 1 })).toBe(50);
    expect(calc('if(a <> b, 1, 0) + if(a <= b, 10, 0) + if(a >= b, 100, 0)', { a: 2, b: 10 })).toBe(11); // 2 < 10 as numbers, not as text
    expect(calc('if(x > 0, 1)', { x: -1 })).toBeNull();
    expect(calc('if(b = 0, 0, a / b)', { a: 1, b: 0 })).toBe(0); // the branch not taken is never worked out
  });

  it('refuses what is not a formula', () => {
    for (const bad of ["'x'", '"x', 'a == 1', 'nope(1)', 'substring("a")', 'if()']) expect(() => parseFormula(bad), bad).toThrow();
  });

  it('number results stay numbers; text that is not a number gives an empty number', () => {
    expect(evalFormula(parseFormula('len(t) * 2'), { t: 'abc' })).toBe(6);
    expect(evalFormula(parseFormula('t * 2'), { t: 'abc' })).toBeNull();
    expect(evalFormula(parseFormula('t * 2'), { t: '21' })).toBe(42);
  });
});

describe('calculated text on a form', () => {
  let t: { tenantId: number; slug: string };
  const tok: Record<string, string> = {};
  let annId = 0;
  beforeAll(async () => {
    t = await makeTenant();
    await makeUser(t.tenantId, 'admin@fn.test', ['Admin']);
    await makeUser(t.tenantId, 'sam@fn.test', ['Submitter']);
    annId = await makeUser(t.tenantId, 'ann@fn.test', ['Approver']);
    tok.admin = (await login(t.slug, 'admin@fn.test')).body.accessToken;
    tok.sam = (await login(t.slug, 'sam@fn.test')).body.accessToken;
  });
  afterAll(closePool);

  it('joins, cuts and decides text from other controls - including drop-downs, dates and tick boxes', async () => {
    const created = await request(app).post('/api/v1/admin/forms').set(bearer(tok.admin)).send({ name: 'Leave', slug: 'leave', fields: [
      { key: 'firstName', label: 'First name', type: 'text' },
      { key: 'lastName', label: 'Last name', type: 'text' },
      { key: 'dept', label: 'Department', type: 'select', options: ['Finance', 'Sales'] },
      { key: 'from', label: 'From', type: 'date' },
      { key: 'to', label: 'To', type: 'date' },
      { key: 'urgent', label: 'Urgent', type: 'checkbox' },
      { key: 'fullName', label: 'Full name', type: 'text', props: { formula: 'trim(firstName & " " & upper(lastName))' } },
      { key: 'reference', label: 'Reference', type: 'text', props: { formula: 'upper(left(dept, 3)) & "-" & substring(from, 1, 4) & if(urgent, "-URGENT", "")' } },
      { key: 'days', label: 'Days', type: 'number', props: { formula: 'days(from, to) + 1', decimals: 0 } },
    ] });
    expect(created.status).toBe(201);
    await request(app).put(`/api/v1/admin/forms/${created.body.formId}/chain`).set(bearer(tok.admin)).send({ steps: [{ name: 'Check', approverUserId: annId }] });

    const res = await request(app).post(`/api/v1/forms/${created.body.formId}/requests`).set(bearer(tok.sam))
      .send({ values: { firstName: ' Ada ', lastName: 'Lovelace', dept: 'Finance', from: '2026-12-21', to: '2026-12-24', urgent: true, fullName: 'typed by hand' } });
    expect(res.status).toBe(201);
    const stored = Object.fromEntries((await tenantQuery<{ FieldKey: string; Value: string | null }>(t.tenantId, 'SELECT FieldKey, Value FROM RequestData WHERE TenantId = @TenantId AND RequestId = @R', { R: res.body.requestId })).map((r) => [r.FieldKey, r.Value]));
    expect(stored).toMatchObject({ fullName: 'Ada LOVELACE', reference: 'FIN-2026-URGENT', days: '4' });
  });
});
