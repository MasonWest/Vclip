import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { extname, join, resolve, normalize, sep } from 'node:path';
import mysql from 'mysql2/promise';

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

function loadMysqlEnv() {
  const filePath = resolve(process.cwd(), 'mysql.env');
  if (!existsSync(filePath)) return {};
  const content = readFileSync(filePath, 'utf8');
  const env = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

loadEnvFile(resolve(process.cwd(), '.env'));
const mysqlEnv = loadMysqlEnv();

const dbPool = mysql.createPool({
  host: mysqlEnv.url || 'localhost',
  port: Number(mysqlEnv.port || 3306),
  user: mysqlEnv.username || 'root',
  password: mysqlEnv.password || '',
  database: mysqlEnv.db_name || 'supabase',
  timezone: 'Z',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

const port = Number(process.env.PORT || 4173);
const rootDir = resolve(process.cwd(), 'dist');
const logDir = resolve(process.cwd(), 'logs');
const accessPassword = process.env.ACCESS_PASSWORD || '';

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
      console.log(`[API] GET /api/clips - Starting database query...`);
      try {
        const [rows] = await dbPool.query(
          'SELECT * FROM clips ORDER BY id DESC LIMIT 100'
        );
        console.log(`[API] GET /api/clips - Successfully retrieved ${rows.length} clips`);
        sendJSON(res, 200, rows);
      } catch (dbError) {
        console.error(`[API] GET /api/clips - Database error:`, dbError);
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
      
      try {
        const [result] = await dbPool.execute(
          'INSERT INTO clips (content, created_at, expires_at) VALUES (?, UTC_TIMESTAMP(), UTC_TIMESTAMP() + INTERVAL 1 DAY)',
          [content.trim()]
        );
        
        const insertId = result.insertId;
        const [rows] = await dbPool.execute(
          'SELECT id, content, created_at, expires_at, type FROM clips WHERE id = ?',
          [insertId]
        );
        
        if (rows && rows.length > 0) {
          console.log(`[API] POST /api/clips - Successfully inserted clip ID: ${insertId}`);
          sendJSON(res, 201, rows[0]);
        } else {
          sendJSON(res, 500, { error: 'Failed to retrieve inserted clip' });
        }
      } catch (postError) {
        console.error(`[API] POST /api/clips - Database error:`, postError);
        sendJSON(res, 500, { error: 'Internal server error' });
      }
      return;
    }

    if (method === 'DELETE' && urlPath.startsWith('/api/clips/')) {
      const idStr = urlPath.slice('/api/clips/'.length);
      const id = parseInt(idStr, 10);
      if (isNaN(id)) {
        sendJSON(res, 400, { error: 'Invalid ID' });
        return;
      }

      await dbPool.execute('DELETE FROM clips WHERE id = ?', [id]);
      sendJSON(res, 200, { success: true });
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
  
  // [DEBUG] 追踪所有请求入口
  console.log(`[Request] ${req.method} ${urlPath}`);
  
  res.on('finish', () => logAccess(req, urlPath, res.statusCode));

  if (!requireAccessPassword(req, res)) {
    console.log(`[Auth] Request to ${urlPath} failed authentication`);
    return;
  }
  
  console.log(`[Auth] Request to ${urlPath} authenticated`);

  if (urlPath === '/api/clips' || urlPath.startsWith('/api/clips/')) {
    console.log(`[Route] Routing ${urlPath} to handleClipsApi`);
    handleClipsApi(req, res, urlPath);
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
  console.log(`Access logs: ${join(logDir, 'access-YYYY-MM-DD.log')}`);
});
