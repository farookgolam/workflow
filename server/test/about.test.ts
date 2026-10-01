import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { release } from '../src/about/routes';

// scripts/azure-vm-update.ps1 writes DEPLOYED.txt to the app root on every update
function root(deployed?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'about-'));
  fs.mkdirSync(path.join(dir, 'server'));
  fs.writeFileSync(path.join(dir, 'server', 'package.json'), '{}');
  if (deployed !== undefined) fs.writeFileSync(path.join(dir, 'DEPLOYED.txt'), deployed);
  return dir;
}

describe('About: version and last update', () => {
  it('reads a release tag and its install time', () => {
    const r = release(root('v1.0.22 (ref 46745b9) - installed 2026-10-02 16:05\r\n'));
    expect(r.version).toBe('v1.0.22');
    expect(r.updatedAt).toBe(new Date(2026, 9, 2, 16, 5).toISOString()); // the server's local time
  });

  it('keeps a zip-package install as it is written', () => {
    expect(release(root('zip package 0A1B2C3D4E5F - installed 2026-10-02 09:30')).version).toBe('zip package 0A1B2C3D4E5F');
  });

  it('is "development" without DEPLOYED.txt, dated by the server code', () => {
    const r = release(root());
    expect(r.version).toBe('development');
    expect(r.updatedAt).not.toBeNull();
  });
});
