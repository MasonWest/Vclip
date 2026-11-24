import { readJSONBody } from './body.mjs';

export function createMaterialStore(db) {
  db.exec('PRAGMA foreign_keys = ON');
  const columns = db.prepare('PRAGMA table_info(clips)').all();
  const hasPrompt = columns.some(column => column.name === 'prompt');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!columns.some(column => column.name === 'status')) db.exec("ALTER TABLE clips ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
    if (!hasPrompt) db.exec("ALTER TABLE clips ADD COLUMN prompt TEXT NOT NULL DEFAULT ''");
    if (!columns.some(column => column.name === 'prompt_version')) db.exec('ALTER TABLE clips ADD COLUMN prompt_version INTEGER NOT NULL DEFAULT 0');
    if (!hasPrompt && db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'comments'").get()) {
      // 一次性合并旧留言正文，保留段落；原表保留作历史数据，不再开放留言接口。
      const rows = db.prepare('SELECT clip_id, content FROM comments ORDER BY clip_id, id').all();
      const prompts = new Map();
      for (const row of rows) {
        const parts = prompts.get(row.clip_id) || [];
        parts.push(row.content);
        prompts.set(row.clip_id, parts);
      }
      const migrate = db.prepare('UPDATE clips SET prompt = ?, prompt_version = 1 WHERE id = ?');
      for (const [id, parts] of prompts) migrate.run(parts.join('\n\n'), id);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }

  const live = db.prepare("SELECT id, prompt, prompt_version FROM clips WHERE id = ? AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
  const setStatus = db.prepare('UPDATE clips SET status = ? WHERE id = ? RETURNING id, status');
  const setPrompt = db.prepare('UPDATE clips SET prompt = ?, prompt_version = prompt_version + 1 WHERE id = ? RETURNING id, prompt, prompt_version');
  return async function handleMaterial(req, res, path, sendJSON) {
    const match = path.match(/^\/api\/clips\/(\d+)$/);
    if (!match || req.method !== 'PATCH') return false;
    const id = Number(match[1]);
    if (!Number.isSafeInteger(id) || !live.get(id)) {
      req.resume();
      sendJSON(res, 404, { error: '素材不存在或已过期' });
      return true;
    }
    const body = await readJSONBody(req, 1024 * 1024);
    const current = live.get(id);
    if (!current) {
      sendJSON(res, 404, { error: '素材不存在或已过期' });
      return true;
    }
    if (Object.hasOwn(body, 'prompt')) {
      if (Object.hasOwn(body, 'status') || typeof body.prompt !== 'string' || body.prompt.length > 100_000
        || !Number.isSafeInteger(body.prompt_version) || body.prompt_version < 0) {
        sendJSON(res, 400, { error: '提示词最多 100000 字，请携带有效版本号并单独保存' });
      } else if (body.prompt_version !== current.prompt_version) {
        sendJSON(res, 409, { error: '提示词已在其他设备更新，你的草稿已保留', latest: current });
      } else {
        // 与上面的版本检查之间没有 await，单进程内不会交错写入。
        sendJSON(res, 200, setPrompt.get(body.prompt, id));
      }
    } else if (['pending', 'done'].includes(body.status)) {
      sendJSON(res, 200, setStatus.get(body.status, id));
    } else {
      sendJSON(res, 400, { error: '无效的完成状态或提示词' });
    }
    return true;
  };
}
