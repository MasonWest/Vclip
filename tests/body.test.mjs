import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readJSONBody, readBinaryBody } from '../server/body.mjs';

function request(chunks, headers = {}) {
  return Object.assign(Readable.from(chunks), { headers });
}

test('UTF-8 Chinese survives a multibyte character split across chunks', async () => {
  const bytes = Buffer.from(JSON.stringify({ content: '朋友，图片已完成😀' }));
  const chunks = Array.from(bytes, byte => Buffer.from([byte]));
  assert.deepEqual(await readJSONBody(request(chunks)), { content: '朋友，图片已完成😀' });
});

test('invalid JSON and non-object JSON return 400', async () => {
  for (const body of ['{', 'null', '[]', '1', '']) {
    await assert.rejects(readJSONBody(request([Buffer.from(body)])), { status: 400 });
  }
});

test('body limit works without Content-Length and drains oversized bodies', async () => {
  const req = request([Buffer.alloc(8), Buffer.alloc(9), Buffer.alloc(3)]);
  await assert.rejects(readBinaryBody(req, 16), { status: 413 });
  assert.equal(req.readableEnded, true);
});

test('Content-Length limit rejects before accumulating payload', async () => {
  await assert.rejects(readBinaryBody(request([Buffer.alloc(20)], { 'content-length': '20' }), 16), { status: 413 });
});
