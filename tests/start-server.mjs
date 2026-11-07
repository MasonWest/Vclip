import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const parent = resolve(tmpdir());
const temp = mkdtempSync(join(parent, 'vclip-test-'));
cpSync(join(root, 'dist'), join(temp, 'dist'), { recursive: true });
Object.assign(process.env, { PORT: '19473', ACCESS_PASSWORD: 'test-password', SECRET_PATH: 'test-entry', DB_PATH: join(temp, 'review.db') });
process.chdir(temp);
process.on('exit', () => {
  if (resolve(temp).startsWith(`${parent}${sep}vclip-test-`)) {
    try { rmSync(temp, { recursive: true, force: true }); } catch { /* Windows 退出时文件可能仍被持有 */ }
  }
});
await import(pathToFileURL(join(root, 'server.mjs')).href);
