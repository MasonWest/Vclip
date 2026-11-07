import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

test('missing password or hidden entry fails before opening data; old VITE config is ignored', () => {
  const parent = resolve(tmpdir());
  const temp = mkdtempSync(join(parent, 'vclip-config-test-'));
  const server = resolve(import.meta.dirname, '..', 'server.mjs');
  try {
    for (const [overrides, message] of [
      [{ ACCESS_PASSWORD: '' }, 'ACCESS_PASSWORD is required'],
      [{ ACCESS_PASSWORD: '   ' }, 'ACCESS_PASSWORD is required'],
      [{ SECRET_PATH: '', VITE_SECRET_PATH: 'old-entry' }, 'SECRET_PATH must be'],
      [{ SECRET_PATH: 'parent/child' }, 'SECRET_PATH must be'],
    ]) {
      const result = spawnSync(process.execPath, [server], {
        cwd: temp,
        env: { ...process.env, ACCESS_PASSWORD: 'test-password', SECRET_PATH: 'test-entry', ...overrides },
        encoding: 'utf8', timeout: 5000,
      });
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(message));
      assert.equal(existsSync(join(temp, 'data')), false);
    }
  } finally {
    if (resolve(temp).startsWith(`${parent}${sep}vclip-config-test-`)) rmSync(temp, { recursive: true, force: true });
  }
});
