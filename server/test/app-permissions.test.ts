import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Tests run as a database administrator, but the live service runs with scripts/grant-app-permissions.sql, which
// DENYs it UPDATE or DELETE on the tables that hold history. A statement the tests pass can therefore fail in
// production with "permission denied" (resubmit once deleted RequestData rows). This keeps the app's own SQL
// within those DENYs. Scripts run by an administrator (src/scripts) are not the runtime account and are skipped.
const root = path.join(__dirname, '..');

function denied(): { verb: 'UPDATE' | 'DELETE'; table: string }[] {
  const sql = fs.readFileSync(path.join(root, 'scripts', 'grant-app-permissions.sql'), 'utf8');
  const out: { verb: 'UPDATE' | 'DELETE'; table: string }[] = [];
  for (const m of sql.matchAll(/^DENY\s+([A-Z, ]+?)\s+ON\s+dbo\.(\w+)/gm)) {
    for (const verb of m[1].split(',').map((v) => v.trim())) if (verb === 'UPDATE' || verb === 'DELETE') out.push({ verb, table: m[2] });
  }
  return out;
}

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'scripts' ? [] : sources(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

describe('runtime SQL stays within the live account\'s permissions', () => {
  it('finds the DENYs', () => {
    expect(denied()).toContainEqual({ verb: 'DELETE', table: 'RequestData' });
  });

  it('never updates or deletes a table the service account is denied', () => {
    const problems: string[] = [];
    for (const file of sources(path.join(root, 'src'))) {
      const text = fs.readFileSync(file, 'utf8');
      for (const { verb, table } of denied()) {
        const re = verb === 'DELETE'
          ? new RegExp(`DELETE\\s+(?:FROM\\s+)?(?:dbo\\.)?${table}\\b`, 'i')
          : new RegExp(`UPDATE\\s+(?:dbo\\.)?${table}\\s+SET\\b`, 'i');
        if (re.test(text)) problems.push(`${path.relative(root, file)}: ${verb} ${table}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
