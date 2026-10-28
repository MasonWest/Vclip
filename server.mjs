import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, statSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { extname, join, resolve, normalize, sep } from 'node:path';
import { networkInterfaces } from 'node:os';
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

// ---------------------------------------------------------------------------
// 会话（Cookie）认证
//
// 目标：密码可以设得很复杂，但同设备只需输入一次。
// - 会话 Cookie 的值由 HMAC(密码 + 入口路径) 派生，不含明文密码
// - 改密码后派生值随之变化，所有旧 Cookie 立即失效
// - 一次性登录链接（?k=）用于手机首次登录，省去在手机上敲密码
// ---------------------------------------------------------------------------
const SESSION_COOKIE = 'vclip_session';
const SESSION_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

function deriveKey(purpose) {
  if (!accessPassword) return '';
  return createHmac('sha256', `${accessPassword}|${secretPath}`)
    .update(purpose)
    .digest('base64url');
}

const sessionValue = deriveKey('session-v1');
const loginKey = deriveKey('login-v1');

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

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

// ---------------------------------------------------------------------------
// 局域网免密
//
// VR 头显、手机这类设备打字成本极高。开启后，来自局域网私有地址的请求
// 直接放行，不需要密码也不需要入口路径，头显里存一个 http://IP:端口 书签即用。
//
// 刻意只采信 socket 地址，不读 X-Forwarded-For：该请求头可被客户端伪造，
// 若采信它，任何能连上端口的人加个头就能冒充局域网。
// ---------------------------------------------------------------------------
const lanFreeAccess = (process.env.LAN_FREE_ACCESS || '').toLowerCase() === 'true';

function getSocketIp(req) {
  const remoteAddress = req.socket.remoteAddress || '';
  return remoteAddress.replace(/^::ffff:/, '');
}

function isPrivateAddress(ip) {
  if (!ip) return false;
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('169.254.')) return true;

  const match = ip.match(/^172\.(\d{1,3})\./);
  if (match) {
    const second = Number(match[1]);
    return second >= 16 && second <= 31;
  }

  return false;
}

function isLanTrusted(req) {
  if (!lanFreeAccess) return false;
  return isPrivateAddress(getSocketIp(req));
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

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};

  const cookies = {};
  for (const part of header.split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) continue;

    const key = part.slice(0, separatorIndex).trim();
    if (!key) continue;

    try {
      cookies[key] = decodeURIComponent(part.slice(separatorIndex + 1).trim());
    } catch {
      cookies[key] = part.slice(separatorIndex + 1).trim();
    }
  }
  return cookies;
}

function isSecureRequest(req) {
  if (req.socket.encrypted) return true;
  const forwarded = String(req.headers['x-forwarded-proto'] || '');
  return forwarded.split(',')[0].trim() === 'https';
}

function buildSessionCookie(req) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(sessionValue)}; Path=/; `
    + `Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${secure}`;
}

function buildLogoutCookie(req) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`;
}

// 认证通过的条件（任一满足）：
// 1. Cookie 会话有效 —— 浏览器日常访问走这条，无需重复输密码
// 2. HTTP Basic Auth 有效 —— 保留给 curl、file-share-server 等程序化调用
function isAuthenticated(req) {
  if (!accessPassword) return true;

  const credentials = parseBasicAuth(req.headers.authorization);
  if (credentials && safeEqual(credentials.password, accessPassword)) {
    return true;
  }

  const cookies = parseCookies(req);
  if (cookies[SESSION_COOKIE] && safeEqual(cookies[SESSION_COOKIE], sessionValue)) {
    return true;
  }

  return false;
}

function sendUnauthorized(res) {
  res.writeHead(401, {
    'Content-Type': 'text/plain; charset=utf-8',
    'WWW-Authenticate': 'Basic realm="Vclip", charset="UTF-8"',
  });
  res.end('Authentication required');
}

function redirect(res, location, extraHeaders = {}) {
  res.writeHead(302, { Location: location, ...extraHeaders });
  res.end();
}

// 只允许站内相对路径，避免登录后被重定向到外部站点
function safeRedirectTarget(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) {
    return '/';
  }
  return raw;
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 8192) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendLoginPage(res, nextPath, hasError) {
  const next = escapeHtml(nextPath || '');
  const errorBlock = hasError
    ? '<p class="err">密码不正确，请重试</p>'
    : '';
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<title>Vclip</title>
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center;
    background: #050505; color: #e4e4e7;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    padding: 24px;
  }
  .card { width: 100%; max-width: 340px; }
  h1 { font-size: 15px; font-weight: 500; letter-spacing: .08em;
       text-transform: uppercase; color: #71717a; margin: 0 0 28px; }
  input[type=password] {
    width: 100%; padding: 14px 16px; font-size: 16px;
    background: #0c0c0e; color: #e4e4e7;
    border: 1px solid #27272a; border-radius: 10px; outline: none;
    transition: border-color .15s;
  }
  input[type=password]:focus { border-color: #6366f1; }
  button {
    width: 100%; margin-top: 12px; padding: 14px; font-size: 15px;
    background: #6366f1; color: #fff; border: 0; border-radius: 10px;
    cursor: pointer; transition: background .15s;
  }
  button:hover { background: #4f46e5; }
  .err { color: #f87171; font-size: 13px; margin: 0 0 14px; }
  .tip { color: #52525b; font-size: 12px; line-height: 1.6; margin-top: 22px; }
</style>
</head>
<body>
  <form class="card" method="POST" action="/__login">
    <h1>Vclip</h1>
    ${errorBlock}
    <input type="password" name="password" placeholder="访问密码"
           autocomplete="current-password" autofocus required>
    <input type="hidden" name="next" value="${next}">
    <button type="submit">进入</button>
    <p class="tip">登录后本设备一年内免密。</p>
  </form>
</body>
</html>`;

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

async function handleLoginRoute(req, res, requestUrl) {
  if (!accessPassword) {
    redirect(res, '/');
    return;
  }

  if (req.method === 'GET') {
    // 已登录时不必再看登录页
    if (isAuthenticated(req)) {
      redirect(res, safeRedirectTarget(requestUrl.searchParams.get('next') || '/'));
      return;
    }
    sendLoginPage(
      res,
      requestUrl.searchParams.get('next') || '',
      requestUrl.searchParams.get('error') === '1',
    );
    return;
  }

  if (req.method !== 'POST') {
    sendUnauthorized(res);
    return;
  }

  let body;
  try {
    body = await readRawBody(req);
  } catch {
    redirect(res, '/__login?error=1');
    return;
  }

  const params = new URLSearchParams(body);
  const password = params.get('password') || '';
  const next = safeRedirectTarget(params.get('next') || '/');

  if (!safeEqual(password, accessPassword)) {
    console.log('[Auth] Login failed (wrong password)');
    const nextParam = next === '/' ? '' : `&next=${encodeURIComponent(next)}`;
    redirect(res, `/__login?error=1${nextParam}`);
    return;
  }

  console.log('[Auth] Login succeeded, session cookie issued');
  redirect(res, next, { 'Set-Cookie': buildSessionCookie(req) });
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

  // 登录 / 登出路由必须在鉴权之前处理
  if (urlPath === '/__login') {
    handleLoginRoute(req, res, requestUrl).catch(err => {
      console.error('[Auth] Login handler error:', err);
      if (!res.headersSent) sendUnauthorized(res);
    });
    return;
  }

  if (urlPath === '/__logout') {
    redirect(res, '/__login', { 'Set-Cookie': buildLogoutCookie(req) });
    return;
  }

  const lanTrusted = isLanTrusted(req);

  if (!lanTrusted && !isAuthenticated(req)) {
    // 一次性登录链接：手机首次访问时带上 ?k=xxx，免去在小屏上敲密码
    const loginParam = requestUrl.searchParams.get('k');
    if (loginParam && loginKey && safeEqual(loginParam, loginKey)) {
      const cleanUrl = new URL(requestUrl);
      cleanUrl.searchParams.delete('k');
      console.log('[Auth] Login link accepted, session cookie issued');
      redirect(res, urlPath + cleanUrl.search, { 'Set-Cookie': buildSessionCookie(req) });
      return;
    }

    console.log(`[Auth] Unauthenticated request to ${urlPath}`);

    // API 保持 401 + WWW-Authenticate，兼容 curl 与 file-share-server 的程序化调用
    if (urlPath === '/api/clips' || urlPath.startsWith('/api/clips/') || !isPageRequest(urlPath)) {
      sendUnauthorized(res);
      return;
    }

    // 页面请求改为跳转登录页，不再弹浏览器的原生 Basic Auth 框
    const nextParam = urlPath === '/' ? '' : `?next=${encodeURIComponent(urlPath)}`;
    redirect(res, `/__login${nextParam}`);
    return;
  }

  if (urlPath === '/api/clips' || urlPath.startsWith('/api/clips/')) {
    handleClipsApi(req, res, urlPath);
    return;
  }

  if (!lanTrusted && !matchesSecretPath(urlPath)) {
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

function getLanAddresses() {
  const addresses = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        addresses.push(entry.address);
      }
    }
  }
  return addresses;
}

server.listen(port, () => {
  console.log(`Vclip server running on http://localhost:${port}`);
  console.log(`SQLite database: ${dbPath}`);
  console.log(`Access logs: ${join(logDir, 'access-YYYY-MM-DD.log')}`);

  if (!secretPath) {
    console.warn('[Warn] SECRET_PATH is empty, every page path is reachable.');
  } else {
    console.log(`Entry: http://localhost:${port}/${secretPath}`);
    for (const address of getLanAddresses()) {
      console.log(`   LAN: http://${address}:${port}/${secretPath}`);
    }
  }

  if (lanFreeAccess) {
    console.log('');
    console.log('局域网免密已开启 —— 同网段设备直接访问，无需密码和入口路径:');
    for (const address of getLanAddresses()) {
      console.log(`   http://${address}:${port}/`);
    }
    console.log('VR 头显把这个地址存成书签即可，零输入进入。');
    console.log('非局域网来源（公网）仍需密码 + 入口路径。');
  }

  if (accessPassword) {
    const suffixes = [`localhost:${port}`, ...getLanAddresses().map(a => `${a}:${port}`)];
    console.log('');
    console.log('免密登录链接（手机首次访问用，之后一年内免密）:');
    for (const suffix of suffixes) {
      const path = secretPath ? `/${secretPath}` : '/';
      console.log(`   http://${suffix}${path}?k=${loginKey}`);
    }
    console.log('修改 ACCESS_PASSWORD 会让所有已登录设备立即失效。');
  } else {
    console.warn('[Warn] ACCESS_PASSWORD is empty, authentication is DISABLED.');
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
