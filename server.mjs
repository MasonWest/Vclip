import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { extname, join, resolve, normalize, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;

  const content = readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) continue;

    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

loadEnvFile(resolve(process.cwd(), '.env'));

const dataDir = resolve(process.cwd(), 'data');
mkdirSync(dataDir, { recursive: true });

const dbPath = process.env.DB_PATH
  ? resolve(process.cwd(), process.env.DB_PATH)
  : join(dataDir, 'vclip.db');

const db = new DatabaseSync(dbPath);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS clips (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    content    TEXT NOT NULL,
    type       TEXT NOT NULL DEFAULT 'text',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expires_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 day'))
  );

  CREATE INDEX IF NOT EXISTS idx_clips_expires_at ON clips (expires_at);
`);

const statements = {
  list: db.prepare(`
    SELECT id, content, type, created_at, expires_at
    FROM clips
    WHERE expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    ORDER BY id DESC
    LIMIT 100
  `),
  insert: db.prepare(`
    INSERT INTO clips (content)
    VALUES (?)
    RETURNING id, content, type, created_at, expires_at
  `),
  insertWithExpiry: db.prepare(`
    INSERT INTO clips (content, expires_at)
    VALUES (?, ?)
    RETURNING id, content, type, created_at, expires_at
  `),
  remove: db.prepare('DELETE FROM clips WHERE id = ?'),
  purge: db.prepare(`
    DELETE FROM clips
    WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `),
};

const MAX_CONTENT_LENGTH = 1024 * 1024;
const MAX_EXPIRES_DAYS = 30;
const PURGE_INTERVAL_MS = 10 * 60 * 1000;

function normalizeExpiresAt(value) {
  if (typeof value !== 'string' || !value.trim()) return null;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;

  const now = Date.now();
  const timestamp = parsed.getTime();
  if (timestamp <= now) return null;
  if (timestamp > now + MAX_EXPIRES_DAYS * 24 * 60 * 60 * 1000) return null;

  return parsed.toISOString();
}

function purgeExpiredClips(reason) {
  try {
    const info = statements.purge.run();
    if (info.changes > 0) {
      console.log(`[Cleanup] Removed ${info.changes} expired clip(s) [${reason}]`);
    }
  } catch (err) {
    console.error('[Cleanup] Failed to purge expired clips:', err);
  }
}

purgeExpiredClips('startup');

const purgeTimer = setInterval(() => purgeExpiredClips('interval'), PURGE_INTERVAL_MS);
purgeTimer.unref();

const port = Number(process.env.PORT || 4173);
const rootDir = resolve(process.cwd(), 'dist');
const logDir = resolve(process.cwd(), 'logs');
const accessPassword = process.env.ACCESS_PASSWORD || '';
const secretPath = (process.env.SECRET_PATH || process.env.VITE_SECRET_PATH || '')
  .replace(/^\/+|\/+$/g, '')
  .toLowerCase();

mkdirSync(logDir, { recursive: true });

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }

  const remoteAddress = req.socket.remoteAddress || '';
  return remoteAddress.replace(/^::ffff:/, '') || 'unknown';
}

function getLocalDateStamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isPageRequest(urlPath) {
  if (urlPath.startsWith('/assets/')) return false;
  return extname(urlPath) === '';
}

const NOT_FOUND_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>404</title>
<style>
  html, body { height: 100%; margin: 0; }
  body {
    display: flex;
    align-items: center;
    justify-content: center;
    background: #030303;
    color: #52525b;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    letter-spacing: -0.05em;
  }
</style>
</head>
<body>404 // NOT_FOUND</body>
</html>`;

function sendNotFoundPage(res) {
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(NOT_FOUND_HTML);
}

function matchesSecretPath(urlPath) {
  if (!secretPath) return true;
  if (!isPageRequest(urlPath)) return true;

  const firstSegment = urlPath.replace(/^\/+/, '').split('/')[0].toLowerCase();
  return firstSegment === secretPath;
}

function logAccess(req, urlPath, statusCode) {
  if (!isPageRequest(urlPath)) return;

  const timestamp = new Date().toISOString();
  const ip = getClientIp(req);
  const ua = String(req.headers['user-agent'] || '-').replace(/\s+/g, ' ').trim();
  const line = `${timestamp} | ${ip} | ${req.method} ${urlPath} | ${statusCode} | ${ua}\n`;
  const logFile = join(logDir, `access-${getLocalDateStamp()}.log`);
  appendFileSync(logFile, line, 'utf8');
}

function parseBasicAuth(headerValue) {
  if (!headerValue || !headerValue.startsWith('Basic ')) return null;

  try {
    const decoded = Buffer.from(headerValue.slice(6), 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');
    if (separatorIndex === -1) return null;

    return {
      username: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1),
    };
  } catch {
    return null;
  }
}

function requireAccessPassword(req, res) {
  if (!accessPassword) return true;

  const credentials = parseBasicAuth(req.headers.authorization);
  if (credentials && credentials.password === accessPassword) {
    return true;
  }

  res.writeHead(401, {
    'Content-Type': 'text/plain; charset=utf-8',
    'WWW-Authenticate': 'Basic realm="Vclip", charset="UTF-8"',
  });
  res.end('Authentication required');
  return false;
}

function safeFilePath(urlPath) {
  const normalized = normalize(urlPath).replace(/^([/\\])+/, '');
  const resolved = resolve(rootDir, normalized);
  const rootWithSep = rootDir.endsWith(sep) ? rootDir : `${rootDir}${sep}`;

  if (resolved !== rootDir && !resolved.startsWith(rootWithSep)) {
    return null;
  }

  return resolved;
}

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function getRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', err => {
      reject(err);
    });
  });
}

async function handleClipsApi(req, res, urlPath) {
  try {
    const method = req.method;

    if (method === 'GET' && urlPath === '/api/clips') {
      try {
        const rows = statements.list.all();
        console.log(`[API] GET /api/clips - Retrieved ${rows.length} clip(s)`);
        sendJSON(res, 200, rows);
      } catch (dbError) {
        console.error('[API] GET /api/clips - Database error:', dbError);
        sendJSON(res, 500, { error: 'Database query failed' });
      }
      return;
    }

    if (method === 'POST' && urlPath === '/api/clips') {
      const body = await getRequestBody(req);
      const content = body.content;
      if (typeof content !== 'string' || !content.trim()) {
        sendJSON(res, 400, { error: 'Content is required' });
        return;
      }

      const trimmed = content.trim();
      if (trimmed.length > MAX_CONTENT_LENGTH) {
        sendJSON(res, 413, { error: 'Content too large' });
        return;
      }

      const expiresAt = normalizeExpiresAt(body.expires_at);

      try {
        const row = expiresAt
          ? statements.insertWithExpiry.get(trimmed, expiresAt)
          : statements.insert.get(trimmed);
        console.log(`[API] POST /api/clips - Successfully inserted clip ID: ${row.id}`);
        sendJSON(res, 201, row);
      } catch (postError) {
        console.error('[API] POST /api/clips - Database error:', postError);
        sendJSON(res, 500, { error: 'Internal server error' });
      }
      return;
    }

    if (method === 'DELETE' && urlPath.startsWith('/api/clips/')) {
      const idStr = urlPath.slice('/api/clips/'.length);
      const id = Number(idStr);
      if (!Number.isInteger(id) || id <= 0) {
        sendJSON(res, 400, { error: 'Invalid ID' });
        return;
      }

      try {
        const info = statements.remove.run(id);
        console.log(`[API] DELETE /api/clips/${id} - Removed ${info.changes} row(s)`);
        sendJSON(res, 200, { success: true, deleted: info.changes });
      } catch (deleteError) {
        console.error(`[API] DELETE /api/clips/${id} - Database error:`, deleteError);
        sendJSON(res, 500, { error: 'Internal server error' });
      }
      return;
    }

    sendJSON(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error('API Error:', error);
    sendJSON(res, 500, { error: 'Internal server error' });
  }
}

const server = createServer((req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const urlPath = decodeURIComponent(requestUrl.pathname);

  res.on('finish', () => logAccess(req, urlPath, res.statusCode));

  if (!requireAccessPassword(req, res)) {
    console.log(`[Auth] Request to ${urlPath} failed authentication`);
    return;
  }

  if (urlPath === '/api/clips' || urlPath.startsWith('/api/clips/')) {
    handleClipsApi(req, res, urlPath);
    return;
  }

  if (!matchesSecretPath(urlPath)) {
    console.log(`[Security] Blocked ${urlPath} (secret path mismatch)`);
    sendNotFoundPage(res);
    return;
  }

  if (!existsSync(rootDir)) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('dist not found. Run npm run build first.');
    return;
  }

  const filePath = safeFilePath(urlPath);
  const indexPath = join(rootDir, 'index.html');
  let targetPath = filePath;

  if (!targetPath) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    targetPath = join(filePath, 'index.html');
  }

  if (!existsSync(targetPath)) {
    if (isPageRequest(urlPath)) {
      targetPath = indexPath;
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
  }

  const ext = extname(targetPath);
  const contentType = mimeTypes[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });

  const stream = createReadStream(targetPath);
  stream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    res.end('Internal server error');
  });

  stream.pipe(res);
});

server.listen(port, () => {
  console.log(`Vclip server running on http://localhost:${port}`);
  console.log(`SQLite database: ${dbPath}`);
  console.log(`Access logs: ${join(logDir, 'access-YYYY-MM-DD.log')}`);
  if (secretPath) {
    console.log(`Secret entry: http://localhost:${port}/${secretPath}`);
  } else {
    console.warn('[Warn] SECRET_PATH is empty, every page path is reachable.');
  }
});

function shutdown(signal) {
  console.log(`\n[Shutdown] Received ${signal}, closing database...`);
  try {
    statements.purge.run();
    db.close();
  } catch (err) {
    console.error('[Shutdown] Failed to close database cleanly:', err);
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
