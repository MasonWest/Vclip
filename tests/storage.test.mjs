import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { createMaterialStore } from '../server/materials.mjs';

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE clips (
    id INTEGER PRIMARY KEY, content TEXT NOT NULL, type TEXT NOT NULL,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL
  )`);
  db.prepare('INSERT INTO clips VALUES (?, ?, ?, ?, ?)').run(1, 'existing-original.png', 'image', '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z');
  return db;
}

async function patch(handle, body) {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'PATCH', headers: {} });
  let result;
  await handle(req, {}, '/api/clips/1', (_res, status, value) => { result = { status, value }; });
  return result;
}

test('legacy comments migrate in order without losing originals or reapplying after edits', async () => {
  const db = database();
  try {
    db.exec("ALTER TABLE clips ADD COLUMN status TEXT NOT NULL DEFAULT 'done'");
    db.exec(`CREATE TABLE comments (id INTEGER PRIMARY KEY, clip_id INTEGER REFERENCES clips(id) ON DELETE CASCADE, author TEXT, content TEXT)`);
    db.prepare('INSERT INTO comments VALUES (?, ?, ?, ?)').run(2, 1, '不应带入提示词的昵称', '第二段\n保持换行');
    db.prepare('INSERT INTO comments VALUES (?, ?, ?, ?)').run(1, 1, '旧昵称', '  第一段  ');
    const handle = createMaterialStore(db);
    const row = db.prepare('SELECT * FROM clips WHERE id = 1').get();
    assert.equal(row.content, 'existing-original.png');
    assert.equal(row.prompt, '  第一段  \n\n第二段\n保持换行');
    assert.equal(row.prompt_version, 1);
    assert.equal(row.status, 'done');
    assert.equal((await patch(handle, { prompt: '整理后的提示词', prompt_version: 1 })).status, 200);
    createMaterialStore(db);
    assert.equal(db.prepare('SELECT prompt FROM clips WHERE id = 1').get().prompt, '整理后的提示词');
    assert.equal(db.prepare('SELECT count(*) AS n FROM comments').get().n, 2);
    db.prepare('DELETE FROM clips WHERE id = 1').run();
    assert.equal(db.prepare('SELECT count(*) AS n FROM comments').get().n, 0);
  } finally { db.close(); }
});

test('long prompts preserve formatting; stale versions cannot overwrite; status and clearing are independent', async () => {
  const db = database();
  try {
    const handle = createMaterialStore(db);
    const prompt = ' \n' + '中文提示词\n'.repeat(5000) + '  ';
    assert.equal((await patch(handle, { prompt, prompt_version: 0 })).status, 200);
    const stale = await patch(handle, { prompt: '旧稿', prompt_version: 0 });
    assert.equal(stale.status, 409);
    assert.equal(stale.value.latest.prompt, prompt);
    assert.equal((await patch(handle, { status: 'done' })).status, 200);
    assert.equal(db.prepare('SELECT prompt FROM clips').get().prompt, prompt);
    assert.equal((await patch(handle, { prompt: '', prompt_version: 1 })).status, 200);
    const row = db.prepare('SELECT * FROM clips').get();
    assert.equal(row.status, 'done');
    assert.equal(row.prompt, '');
    assert.equal(row.prompt_version, 2);
    assert.equal((await patch(handle, { prompt: 'x'.repeat(100001), prompt_version: 2 })).status, 400);
    assert.equal((await patch(handle, { prompt: 'missing version' })).status, 400);
    assert.equal((await patch(handle, { prompt: 'mixed', prompt_version: 2, status: 'pending' })).status, 400);
  } finally { db.close(); }
});
