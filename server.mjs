import { createServer } from 'node:http';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  statSync,
  mkdirSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
} from 'node:fs';
import { basename, extname, join, resolve, normalize, sep } from 'node:path';
import { networkInterfaces } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { readBinaryBody, readJSONBody } from './server/body.mjs';
import { createDiscussionStore } from './server/discussion.mjs';

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

// 入口和密码始终必填；配置错误时拒绝启动，不能降级为公开访问。
const accessPassword = process.env.ACCESS_PASSWORD || '';
const secretPath = (process.env.SECRET_PATH || '').replace(/^\/+|\/+$/g, '').toLowerCase();
if (!accessPassword.trim()) throw new Error('ACCESS_PASSWORD is required');
if (!/^[a-z0-9_-]+$/.test(secretPath)) throw new Error('SECRET_PATH must be a non-empty URL segment (letters, numbers, _ or -)');

const dataDir = resolve(process.cwd(), 'data');
mkdirSync(dataDir, { recursive: true });

// 图片文件目录：数据库只存文件名，字节落在磁盘上。
// 这样列表接口不会被 base64 撑爆，图片也能被浏览器独立缓存。
const uploadsDir = join(dataDir, 'uploads');
mkdirSync(uploadsDir, { recursive: true });

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

// 缩略图列：老库没有这一列，启动时补上。
// 允许为 NULL —— 老记录（改造前上传的图）没有缩略图，前端回退到原图。
{
  const columns = db.prepare('PRAGMA table_info(clips)').all();
  if (!columns.some(column => column.name === 'thumb')) {
    db.exec('ALTER TABLE clips ADD COLUMN thumb TEXT');
    console.log('[DB] Added clips.thumb column');
  }
}

const handleDiscussion = createDiscussionStore(db);

const statements = {
  list: db.prepare(`
    SELECT id, content, thumb, type, status, created_at, expires_at,
      (SELECT count(*) FROM comments WHERE clip_id = clips.id) AS comment_count
    FROM clips
    WHERE expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    ORDER BY id DESC
    LIMIT 100
  `),
  insert: db.prepare(`
    INSERT INTO clips (content)
    VALUES (?)
    RETURNING id, content, thumb, type, status, created_at, expires_at
  `),
  insertWithExpiry: db.prepare(`
    INSERT INTO clips (content, expires_at)
    VALUES (?, ?)
    RETURNING id, content, thumb, type, status, created_at, expires_at
  `),
  // 图片：content 存的是 data/uploads 下的文件名，不是图片本身；
  // thumb 是缩略图文件名，列表只加载它，点开大图才取 content 指向的原图
  insertImage: db.prepare(`
    INSERT INTO clips (content, type, expires_at)
    VALUES (?, 'image', COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 day')))
    RETURNING id, content, thumb, type, status, created_at, expires_at
  `),
  getById: db.prepare('SELECT id, content, thumb, type FROM clips WHERE id = ?'),
  setThumb: db.prepare("UPDATE clips SET thumb = ? WHERE id = ? AND type = 'image'"),
  expiredImages: db.prepare(`
    SELECT content, thumb FROM clips
    WHERE type = 'image' AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `),
  remove: db.prepare('DELETE FROM clips WHERE id = ?'),
  purge: db.prepare(`
    DELETE FROM clips
    WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `),
};

const MAX_CONTENT_LENGTH = 1024 * 1024;
// 单张图片上限。手机原图常见 3-6MB，8MB 足够容下未压缩的直出照片。
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
// 缩略图上限。480px 的 WebP/JPEG 正常 15-60KB，512KB 是给极端噪点照片留的余量。
const MAX_THUMB_BYTES = 512 * 1024;
const MAX_EXPIRES_DAYS = 30;
const PURGE_INTERVAL_MS = 10 * 60 * 1000;

// 只认这四种位图。SVG 永远不收——它可以内嵌 <script>，
// 一旦被 <img src> 同源加载就等于在自己的域里执行任意脚本。
const IMAGE_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** 按文件头判断真实类型，不信任 Content-Type 与扩展名 */
function detectImageType(buf) {
  if (!buf || buf.length < 12) return null;

  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';

  const head6 = buf.toString('ascii', 0, 6);
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'gif';

  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';

  return null;
}

/** 删除上传文件；只接受纯文件名，防止路径穿越 */
function removeUploadedFile(filename) {
  if (typeof filename !== 'string' || !filename) return;

  const name = basename(filename);
  if (name !== filename) return;

  const target = join(uploadsDir, name);
  if (!target.startsWith(uploadsDir)) return;

  try {
    if (existsSync(target)) unlinkSync(target);
  } catch (err) {
    console.error(`[Cleanup] Failed to remove upload ${name}:`, err.message);
  }
}

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

function requestedExpiry(value, days) {
  // 新 UI 发送相对天数，避免手机与服务器时钟偏差使 30 天被误判。
  const duration = Number(days);
  if ([1, 7, 30].includes(duration)) return new Date(Date.now() + duration * 86400_000).toISOString();
  return normalizeExpiresAt(value);
}

function purgeExpiredClips(reason) {
  try {
    // 先摘出过期图片的文件名：删行之后就拿不到 content 了，
    // 不先删字节的话 data/uploads 会只进不出。
    const expiredImages = statements.expiredImages.all();
    for (const row of expiredImages) {
      removeUploadedFile(row.content);
      removeUploadedFile(row.thumb);
    }

    const info = statements.purge.run();
    if (info.changes > 0 || expiredImages.length > 0) {
      console.log(
        `[Cleanup] Removed ${info.changes} expired clip(s), ${expiredImages.length} image file(s) [${reason}]`
      );
    }
  } catch (err) {
    console.error('[Cleanup] Failed to purge expired clips:', err);
  }
}

purgeExpiredClips('startup');

/**
 * 清理 uploads 里没有任何记录引用的文件。
 * 只会出现在数据库被手工清空/回滚之后；跑一次就够了，不必进定时任务。
 */
function pruneOrphanUploads() {
  try {
    const referenced = new Set();
    for (const row of db.prepare("SELECT content, thumb FROM clips WHERE type = 'image'").all()) {
      if (row.content) referenced.add(row.content);
      if (row.thumb) referenced.add(row.thumb);
    }

    let removed = 0;
    for (const name of readdirSync(uploadsDir)) {
      if (!referenced.has(name)) {
        removeUploadedFile(name);
        removed += 1;
      }
    }

    if (removed > 0) {
      console.log(`[Cleanup] Removed ${removed} orphaned image file(s)`);
    }
  } catch (err) {
    console.error('[Cleanup] Failed to prune orphan uploads:', err.message);
  }
}

pruneOrphanUploads();

const purgeTimer = setInterval(() => purgeExpiredClips('interval'), PURGE_INTERVAL_MS);
purgeTimer.unref();

const port = Number(process.env.PORT || 4173);
const rootDir = resolve(process.cwd(), 'dist');
const logDir = resolve(process.cwd(), 'logs');
mkdirSync(logDir, { recursive: true });

// ---------------------------------------------------------------------------
// 会话（Cookie）认证
//
// 目标：密码可以设得很复杂，但同设备只需输入一次。
// - 会话 Cookie 的值由 HMAC(密码 + 入口路径) 派生，不含明文密码
// - 改密码后派生值随之变化，所有旧 Cookie 立即失效
// ---------------------------------------------------------------------------
const SESSION_COOKIE = 'vclip_session';
const SESSION_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

// 升级会话版本，使旧免密链接签发的 Cookie 也必须重新验证密码。
const sessionValue = createHmac('sha256', `${accessPassword}|${secretPath}`)
  .update('session-v2')
  .digest('base64url');

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
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// ---------------------------------------------------------------------------
// 静态资源传输层：压缩 + 强缓存 + ETag
//
// 按扩展名压缩并缓存，浏览器可复用带哈希的产物和协商缓存。
// ---------------------------------------------------------------------------
const COMPRESSIBLE_EXTS = new Set([
  '.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.svg', '.txt', '.map',
]);

const staticCache = new Map();
const MAX_STATIC_CACHE_ENTRIES = 48;

function pickEncoding(req) {
  const accept = String(req.headers['accept-encoding'] || '').toLowerCase();
  if (accept.includes('br')) return 'br';
  if (accept.includes('gzip')) return 'gzip';
  return 'identity';
}

/**
 * 读文件并（按需）压缩，结果按 path+mtime+encoding 缓存。
 * 文件被替换（mtime 变化）时旧的 key 自然不再命中。
 */
function loadStaticAsset(filePath, ext, encoding) {
  const stat = statSync(filePath);
  const key = `${filePath}|${stat.mtimeMs}|${encoding}`;

  const cached = staticCache.get(key);
  if (cached) return cached;

  let body = readFileSync(filePath);
  let usedEncoding = 'identity';

  if (encoding !== 'identity' && COMPRESSIBLE_EXTS.has(ext) && body.length >= 1024) {
    try {
      body = encoding === 'br'
        ? brotliCompressSync(body, {
          params: {
            [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
            [zlibConstants.BROTLI_PARAM_SIZE_HINT]: body.length,
          },
        })
        : gzipSync(body, { level: 6 });
      usedEncoding = encoding;
    } catch {
      // 压缩失败就退回明文，不能因此让请求挂掉
      body = readFileSync(filePath);
      usedEncoding = 'identity';
    }
  }

  const entry = {
    body,
    encoding: usedEncoding,
    // 以 mtime + size 生成弱 ETag：内容变了必然变，不必读全文算哈希
    etag: `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`,
    lastModified: stat.mtime.toUTCString(),
  };

  // 粗暴但够用的淘汰：条目极少，满了直接清空重来
  if (staticCache.size >= MAX_STATIC_CACHE_ENTRIES) staticCache.clear();
  staticCache.set(key, entry);

  return entry;
}

/**
 * 图标版本号：用文件 mtime 的 36 进制。
 * manifest 是动态生成的，把版本塞进图标 URL，换图后 URL 自动变化，
 * 图标替换后浏览器会重新加载。
 */
function assetVersion(name) {
  try {
    return Math.floor(statSync(join(rootDir, name)).mtimeMs).toString(36);
  } catch {
    return '0';
  }
}

/**
 * 缓存策略：
 * - /assets/ 下是 Vite 带 hash 的产物，内容恒定 → 一年 immutable
 * - HTML 是入口，改了就必须让客户端看见 → no-cache（每次协商）
 * - manifest 单独鉴权并设置 no-store
 * - 图标等杂项 → 一周
 */
function cacheControlFor(urlPath, ext) {
  if (urlPath.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  if (ext === '.html' || ext === '.webmanifest') return 'no-cache';
  return 'public, max-age=604800';
}

function sendStaticAsset(req, res, urlPath, filePath, ext) {
  let entry;
  try {
    entry = loadStaticAsset(filePath, ext, pickEncoding(req));
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const headers = {
    'Content-Type': mimeTypes[ext] || 'application/octet-stream',
    'Content-Length': entry.body.length,
    'Cache-Control': cacheControlFor(urlPath, ext),
    'ETag': entry.etag,
    'Last-Modified': entry.lastModified,
    'X-Content-Type-Options': 'nosniff',
    'Vary': 'Accept-Encoding',
  };

  if (entry.encoding !== 'identity') headers['Content-Encoding'] = entry.encoding;

  const inm = req.headers['if-none-match'];
  const ims = req.headers['if-modified-since'];
  if (
    (typeof inm === 'string' && inm.split(',').some(tag => tag.trim() === entry.etag)) ||
    (!inm && typeof ims === 'string' && ims === entry.lastModified)
  ) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(entry.body);
}

// 仅内网直连，不读取任何反向代理头。
function getClientIp(req) {
  return String(req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
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
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(NOT_FOUND_HTML);
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

function buildSessionCookie() {
  return `${SESSION_COOKIE}=${encodeURIComponent(sessionValue)}; Path=/; `
    + `Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax`;
}

function buildLogoutCookie() {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

function isAuthenticated(req, allowBasic = false) {
  const cookies = parseCookies(req);
  if (safeEqual(cookies[SESSION_COOKIE], sessionValue)) return true;
  // Basic Auth 仅保留给 API 联动；页面和 manifest 必须先进行密码登录。
  const credentials = allowBasic ? parseBasicAuth(req.headers.authorization) : null;
  return Boolean(credentials && safeEqual(credentials.password, accessPassword));
}

function sendUnauthorized(res) {
  res.writeHead(401, {
    'Content-Type': 'text/plain; charset=utf-8',
    'WWW-Authenticate': 'Basic realm="Vclip", charset="UTF-8"',
    'Cache-Control': 'no-store',
  });
  res.end('Authentication required');
}

function redirect(res, location, extraHeaders = {}) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...extraHeaders });
  res.end();
}

function readRawBody(req) {
  return readBinaryBody(req, 8192).then(body => body.toString('utf8'));
}

function sendLoginPage(res, hasError = false, statusCode = 200) {
  const errorBlock = hasError
    ? '<p class="err">密码不正确，请重试</p>'
    : '';
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<title>Vclip</title>
<meta name="theme-color" content="#0B0A14">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Vclip">
<!-- 图标可公开；登录前不请求包含入口的 manifest。 -->
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon-180.png">
<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">
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
  <form class="card" method="POST">
    <h1>Vclip</h1>
    ${errorBlock}
    <input type="password" name="password" placeholder="访问密码"
           autocomplete="current-password" autofocus required>
    <button type="submit">进入</button>
    <p class="tip">登录后本设备一年内免密。</p>
  </form>
</body>
</html>`;

  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(html);
}

async function handleLogin(req, res) {
  let body;
  try {
    body = await readRawBody(req);
  } catch (error) {
    sendJSON(res, error.status || 400, { error: 'Invalid login request' });
    return;
  }
  const password = new URLSearchParams(body).get('password') || '';
  if (!safeEqual(password, accessPassword)) {
    sendLoginPage(res, true, 401);
    return;
  }
  redirect(res, `/${secretPath}`, { 'Set-Cookie': buildSessionCookie() });
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
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    // 剪贴板内容不写入浏览器或中间层缓存。
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

async function handleClipsApi(req, res, urlPath) {
  try {
    const method = req.method;
    if (await handleDiscussion(req, res, urlPath, sendJSON)) return;

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

    if (method === 'GET' && urlPath.startsWith('/api/media/')) {
      const name = urlPath.slice('/api/media/'.length);
      const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
      const contentType = IMAGE_TYPES[ext] || '';

      // 文件名必须是上传时生成的形态（字母数字 + . - _），且扩展名在白名单内。
      // 这一层同时挡掉了 ../ 之类的路径穿越。
      if (!contentType || !/^[A-Za-z0-9._-]+$/.test(name)) {
        sendJSON(res, 404, { error: 'Not found' });
        return;
      }

      const filePath = join(uploadsDir, name);
      if (!existsSync(filePath)) {
        sendJSON(res, 404, { error: 'Not found' });
        return;
      }

      const fileStat = statSync(filePath);
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': fileStat.size,
        // 文件名带随机 UUID，内容永不变化，可以放心长缓存
        'Cache-Control': 'private, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      });
      createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
      return;
    }

    // 缩略图：跟原图分两次请求。
    // 不塞进 POST /api/clips 那一次，是为了不改动它的原始二进制协议
    // （配套的 fastapi 项目也在用），也省掉手写 multipart 解析。
    // 前端拿不到缩略图不影响主流程：列表会回退去加载原图。
    const thumbMatch = urlPath.match(/^\/api\/clips\/(\d+)\/thumb$/);
    if (method === 'POST' && thumbMatch) {
      const id = Number(thumbMatch[1]);

      const target = Number.isInteger(id) && id > 0 ? statements.getById.get(id) : null;
      if (!target || target.type !== 'image') {
        sendJSON(res, 404, { error: 'Not found' });
        req.resume();
        return;
      }

      const declared = Number(req.headers['content-length'] || 0);
      if (Number.isFinite(declared) && declared > MAX_THUMB_BYTES) {
        sendJSON(res, 413, { error: 'Thumbnail too large', maxBytes: MAX_THUMB_BYTES });
        req.resume();
        return;
      }

      let buf;
      try {
        buf = await readBinaryBody(req, MAX_THUMB_BYTES);
      } catch (err) {
        if (err.status === 413) {
          sendJSON(res, 413, { error: 'Thumbnail too large', maxBytes: MAX_THUMB_BYTES });
          return;
        }
        throw err;
      }

      const kind = detectImageType(buf);
      if (!kind) {
        sendJSON(res, 415, { error: 'Unsupported image type' });
        return;
      }

      const thumbName = `${Date.now().toString(36)}-${randomUUID()}-t.${kind}`;
      writeFileSync(join(uploadsDir, thumbName), buf);

      try {
        const info = statements.setThumb.run(thumbName, id);
        if (info.changes === 0) throw new Error('clip vanished');
      } catch (dbError) {
        removeUploadedFile(thumbName);
        throw dbError;
      }

      // 重试上传时把上一张删掉，别在 uploads 里堆孤儿
      if (target.thumb && target.thumb !== thumbName) removeUploadedFile(target.thumb);

      console.log(
        `[API] POST /api/clips/${id}/thumb - Stored ${kind.toUpperCase()} ${buf.length}B as ${thumbName}`
      );
      sendJSON(res, 201, { id, thumb: thumbName });
      return;
    }

    if (method === 'POST' && urlPath === '/api/clips') {
      const requestType = String(req.headers['content-type'] || '').toLowerCase();

      // 图片走原始二进制（不是 multipart）：省掉手写 boundary 解析，
      // 前端直接把 File/Blob 当 body 发过来。
      if (requestType.startsWith('image/')) {
        // Content-Length 超限就直接拒，不必先把几十 MB 读完
        const declared = Number(req.headers['content-length'] || 0);
        if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
          sendJSON(res, 413, { error: 'Image too large', maxBytes: MAX_IMAGE_BYTES });
          req.resume();
          return;
        }

        let buf;
        try {
          buf = await readBinaryBody(req, MAX_IMAGE_BYTES);
        } catch (err) {
          if (err.status === 413) {
            sendJSON(res, 413, { error: 'Image too large', maxBytes: MAX_IMAGE_BYTES });
            return;
          }
          throw err;
        }

        const kind = detectImageType(buf);
        if (!kind) {
          sendJSON(res, 415, { error: 'Unsupported image type' });
          return;
        }

        const query = new URL(req.url || '/', 'http://localhost').searchParams;
        const expiresAt = requestedExpiry(query.get('expires_at'), query.get('retention_days'));

        const filename = `${Date.now().toString(36)}-${randomUUID()}.${kind}`;
        writeFileSync(join(uploadsDir, filename), buf);

        try {
          const row = statements.insertImage.get(filename, expiresAt);
          console.log(
            `[API] POST /api/clips - Stored ${kind.toUpperCase()} ${buf.length}B as clip ID ${row.id}`
          );
          sendJSON(res, 201, row);
        } catch (dbError) {
          // 落库失败就回滚文件，不留孤儿
          removeUploadedFile(filename);
          throw dbError;
        }
        return;
      }

      const body = await readJSONBody(req);
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

      const expiresAt = requestedExpiry(body.expires_at, body.retention_days);

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
        const target = statements.getById.get(id);
        const info = statements.remove.run(id);
        // 删行之后才删文件：万一 unlink 失败，至少还能从数据库里找回文件名
        if (target && target.type === 'image') {
          removeUploadedFile(target.content);
          removeUploadedFile(target.thumb);
        }
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
    if (!res.headersSent && !res.destroyed) {
      sendJSON(res, error.status || 500, { error: error.status ? error.message : 'Internal server error' });
    }
  }
}

const server = createServer((req, res) => {
  let requestUrl;
  let urlPath;
  try {
    requestUrl = new URL(req.url || '/', 'http://localhost');
    urlPath = decodeURIComponent(requestUrl.pathname);
  } catch {
    req.resume();
    sendJSON(res, 400, { error: 'Invalid URL' });
    return;
  }

  res.on('finish', () => logAccess(req, urlPath, res.statusCode));

  res.setHeader('Referrer-Policy', 'no-referrer');
  const isEntry = urlPath === `/${secretPath}` || urlPath === `/${secretPath}/`;
  const isApiPath = urlPath.startsWith('/api/');
  const isManifest = urlPath === '/manifest.webmanifest';
  const isAsset = urlPath.startsWith('/assets/');
  const isPublicIcon = /^\/(icon\.svg|icon-maskable\.svg|icon-192\.png|icon-512\.png|icon-maskable-512\.png|apple-touch-icon(-180)?(-precomposed)?\.png|favicon\.(svg|ico))$/.test(urlPath);
  const isLogout = urlPath === '/__logout';

  // 先校验路由，错误入口即使带有效 Cookie 也不能进入页面。
  if (!isEntry && !isApiPath && !isManifest && !isAsset && !isPublicIcon && !isLogout) {
    req.resume();
    sendNotFoundPage(res);
    return;
  }

  if (isEntry && req.method === 'POST') {
    handleLogin(req, res).catch(error => {
      console.error('[Auth] Login failed:', error.message);
      if (!res.headersSent && !res.destroyed) sendJSON(res, 500, { error: 'Login failed' });
    });
    return;
  }

  if (isEntry && !['GET', 'HEAD'].includes(req.method)) {
    req.resume();
    res.writeHead(405, { Allow: 'GET, HEAD, POST', 'Cache-Control': 'no-store' });
    res.end();
    return;
  }

  if (!isPublicIcon && !isAuthenticated(req, isApiPath)) {
    req.resume();
    if (isEntry) sendLoginPage(res);
    else if (isManifest) sendJSON(res, 401, { error: 'Authentication required' });
    else sendUnauthorized(res);
    return;
  }

  if (isLogout) {
    redirect(res, `/${secretPath}`, { 'Set-Cookie': buildLogoutCookie() });
    return;
  }

  if (isApiPath) {
    handleClipsApi(req, res, urlPath);
    return;
  }

  // PWA manifest：动态生成，让 start_url 始终指向真实入口路径
  // （静态文件无法知道 SECRET_PATH，写死会让主屏幕图标打开 / 直接 404）
  if (isManifest) {
    const startUrl = `/${secretPath}`;
    res.writeHead(200, {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      // 只有通过密码登录的浏览器可读取，含隐藏入口，禁止缓存。
      'Cache-Control': 'private, no-store',
      'Vary': 'Cookie',
    });
    res.end(JSON.stringify({
      id: startUrl,
      name: 'Vclip',
      short_name: 'Vclip',
      description: '局域网剪贴板：手机发，VR 里看。',
      start_url: startUrl,
      scope: '/',
      display: 'standalone',
      orientation: 'any',
      background_color: '#0B0A14',
      theme_color: '#0B0A14',
      // 只放 PNG：iOS 对 manifest 里的 SVG 图标支持不一致，
      // 混着放会让部分版本挑到不认识的格式，最后退回灰图标。
      // URL 带 mtime 版本号，换图即自动失效边缘缓存。
      icons: [
        { src: `/icon-192.png?v=${assetVersion('icon-192.png')}`, sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: `/icon-512.png?v=${assetVersion('icon-512.png')}`, sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: `/icon-maskable-512.png?v=${assetVersion('icon-maskable-512.png')}`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    }));
    return;
  }

  if (!existsSync(rootDir)) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('dist not found. Run npm run build first.');
    return;
  }

  const filePath = isEntry ? join(rootDir, 'index.html') : safeFilePath(urlPath);
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
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('Not found');
    return;
  }

  const ext = extname(targetPath).toLowerCase();
  sendStaticAsset(req, res, urlPath, targetPath, ext);
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

  console.log(`Entry: http://localhost:${port}/${secretPath}`);
  for (const address of getLanAddresses()) {
    console.log(`   LAN: http://${address}:${port}/${secretPath}`);
  }
  console.log('首次访问需输入密码；修改 ACCESS_PASSWORD 后所有设备需重新登录。');
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
