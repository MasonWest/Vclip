import { readJSONBody } from './body.mjs';

export function createDiscussionStore(db) {
  db.exec('PRAGMA foreign_keys = ON');
  const columns = db.prepare('PRAGMA table_info(clips)').all();
  if (!columns.some(column => column.name === 'status')) {
    db.exec("ALTER TABLE clips ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
      reply_to INTEGER REFERENCES comments(id) ON DELETE SET NULL,
      author TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_comments_clip_id ON comments(clip_id, id);
  `);
  const live = db.prepare("SELECT id, status FROM clips WHERE id = ? AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
  const list = db.prepare('SELECT * FROM comments WHERE clip_id = ? ORDER BY id');
  const getReply = db.prepare('SELECT id FROM comments WHERE id = ? AND clip_id = ?');
  const count = db.prepare('SELECT count(*) AS total FROM comments WHERE clip_id = ?');
  const insert = db.prepare('INSERT INTO comments (clip_id, reply_to, author, content) VALUES (?, ?, ?, ?) RETURNING *');
  const setStatus = db.prepare('UPDATE clips SET status = ? WHERE id = ? RETURNING id, status');

  return async function handleDiscussion(req, res, path, sendJSON) {
    const match = path.match(/^\/api\/clips\/(\d+)(\/comments)?$/);
    if (!match) return false;
    const isComments = Boolean(match[2]);
    if (!(isComments && ['GET', 'POST'].includes(req.method)) && !(req.method === 'PATCH' && !isComments)) return false;
    const id = Number(match[1]);
    if (!Number.isSafeInteger(id) || !live.get(id)) {
      req.resume();
      sendJSON(res, 404, { error: '素材不存在或已过期' });
      return true;
    }
    if (req.method === 'GET') {
      sendJSON(res, 200, list.all(id));
      return true;
    }
    const body = await readJSONBody(req, 32 * 1024);
    // 接收请求体期间素材可能被另一台设备删除或过期。
    if (!live.get(id)) {
      sendJSON(res, 404, { error: '素材不存在或已过期' });
      return true;
    }
    if (!isComments) {
      if (!['pending', 'done'].includes(body.status)) {
        sendJSON(res, 400, { error: '无效的完成状态' });
      } else {
        sendJSON(res, 200, setStatus.get(body.status, id));
      }
      return true;
    }
    if (typeof body.content !== 'string' || !body.content.trim() || body.content.length > 4000
      || (body.author !== undefined && (typeof body.author !== 'string' || body.author.length > 40))) {
      sendJSON(res, 400, { error: '留言需为 1–4000 字，昵称最多 40 字' });
      return true;
    }
    const replyTo = body.reply_to ?? null;
    if (replyTo !== null && (!Number.isSafeInteger(replyTo) || !getReply.get(replyTo, id))) {
      sendJSON(res, 400, { error: '回复的留言不属于这条素材' });
      return true;
    }
    if (count.get(id).total >= 500) {
      sendJSON(res, 409, { error: '这条素材的留言已达到 500 条上限' });
      return true;
    }
    sendJSON(res, 201, insert.get(id, replyTo, (body.author || '').trim(), body.content.trim()));
    return true;
  };
}
