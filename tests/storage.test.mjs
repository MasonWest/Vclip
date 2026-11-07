import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { createDiscussionStore } from '../server/discussion.mjs';

test('old database migrates without losing originals; replies cascade with material deletion', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE clips (
      id INTEGER PRIMARY KEY, content TEXT NOT NULL, type TEXT NOT NULL,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL
    )`);
    db.prepare('INSERT INTO clips VALUES (?, ?, ?, ?, ?)').run(1, 'existing-original.png', 'image', '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z');
    const handle = createDiscussionStore(db);
    createDiscussionStore(db); // 重启迁移可重复执行。
    assert.equal(db.prepare('SELECT content FROM clips WHERE id = 1').get().content, 'existing-original.png');
    assert.equal(db.prepare('SELECT status FROM clips WHERE id = 1').get().status, 'pending');
    async function comment(content, reply_to = null) {
      const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ content, reply_to }))]), { method: 'POST', headers: {} });
      let result;
      await handle(req, {}, '/api/clips/1/comments', (_res, status, body) => { result = { status, body }; });
      assert.equal(result.status, 201);
      return result.body;
    }
    const first = await comment('待处理');
    await comment('已完成', first.id);
    assert.equal(db.prepare('SELECT count(*) AS n FROM comments').get().n, 2);
    db.prepare('DELETE FROM clips WHERE id = 1').run();
    assert.equal(db.prepare('SELECT count(*) AS n FROM comments').get().n, 0);
  } finally { db.close(); }
});
