export async function readBinaryBody(req, maxBytes) {
  const declared = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    req.resume();
    throw Object.assign(new Error('Payload too large'), { status: 413 });
  }
  const chunks = [];
  let size = 0;
  let overflow = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      overflow = true;
      chunks.length = 0;
    }
    if (!overflow) chunks.push(chunk);
  }
  if (overflow) throw Object.assign(new Error('Payload too large'), { status: 413 });
  return Buffer.concat(chunks);
}

export async function readJSONBody(req, maxBytes = 1024 * 1024) {
  const bytes = await readBinaryBody(req, maxBytes);
  let body;
  try {
    body = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw Object.assign(new Error('Expected a JSON object'), { status: 400 });
  }
  return body;
}
