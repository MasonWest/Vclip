import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=', 'base64');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test.beforeEach(async ({ request, context }) => {
  await request.post('/test-entry', { form: { password: 'test-password' } });
  await context.request.post('/test-entry', { form: { password: 'test-password' } });
  for (const row of await (await request.get('/api/clips')).json()) await request.delete(`/api/clips/${row.id}`);
});

test('bad URL/JSON and oversized input do not crash the service', async ({ request }) => {
  expect((await request.get('/%ZZ')).status()).toBe(400);
  expect((await request.post('/api/clips', { headers: { 'Content-Type': 'application/json' }, data: '{' })).status()).toBe(400);
  expect((await request.post('/api/clips', { data: { content: '中'.repeat(400_000) } })).status()).toBe(413);
  expect((await request.get('/api/clips')).status()).toBe(200);
});

test('original bytes, thumbnail, replies, status, expiry and cascade cleanup', async ({ request }) => {
  const response = await request.post('/api/clips', { headers: { 'Content-Type': 'image/png' }, data: png });
  expect(response.status()).toBe(201);
  const image = await response.json();
  const thumb = await (await request.post(`/api/clips/${image.id}/thumb`, { headers: { 'Content-Type': 'image/png' }, data: png })).json();
  expect(hash(await (await request.get(`/api/media/${image.content}`)).body())).toBe(hash(png));
  const first = await (await request.post(`/api/clips/${image.id}/comments`, { data: { content: '请处理这里', author: '朋友' } })).json();
  expect((await request.post(`/api/clips/${image.id}/comments`, { data: { content: '已完成', reply_to: first.id, author: '我' } })).status()).toBe(201);
  const other = await (await request.post('/api/clips', { data: { content: '另一条素材' } })).json();
  expect((await request.post(`/api/clips/${other.id}/comments`, { data: { content: '错误引用', reply_to: first.id } })).status()).toBe(400);
  expect((await request.post(`/api/clips/${image.id}/comments`, { data: { content: ' ' } })).status()).toBe(400);
  expect((await request.patch(`/api/clips/${image.id}`, { data: { status: 'done' } })).status()).toBe(200);
  const row = (await (await request.get('/api/clips')).json()).find(row => row.id === image.id);
  expect(row).toMatchObject({ status: 'done', comment_count: 2, thumb: thumb.thumb, expires_at: image.expires_at });
  await request.delete(`/api/clips/${image.id}`);
  expect((await request.get(`/api/media/${image.content}`)).status()).toBe(404);
  expect((await request.get(`/api/media/${thumb.thumb}`)).status()).toBe(404);
  expect((await request.get(`/api/clips/${image.id}/comments`)).status()).toBe(404);
  const expiring = await (await request.post('/api/clips', { data: { content: '即将过期', expires_at: new Date(Date.now() + 1200).toISOString() } })).json();
  await expect.poll(async () => (await request.post(`/api/clips/${expiring.id}/comments`, { data: { content: '过期不可写' } })).status()).toBe(404);
});

test('mobile collaboration: append, reply, preserve draft, complete and reopen', async ({ page, request }) => {
  await request.post('/api/clips', { headers: { 'Content-Type': 'image/png' }, data: png });
  await page.goto('/test-entry');
  await page.getByRole('button', { name: '追加 / 回复' }).click();
  await page.getByLabel('留言昵称').fill('朋友');
  await page.getByLabel('补充留言').fill('请把这里改亮一点\n这是第二行');
  await page.getByRole('button', { name: '发送留言', exact: true }).click();
  await expect(page.getByText('请把这里改亮一点\n这是第二行', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '回复', exact: true }).click();
  await page.getByLabel('补充留言').fill('修改中，草稿不要丢失');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByLabel('补充留言')).toHaveValue('修改中，草稿不要丢失');
  await page.getByRole('button', { name: '发送留言', exact: true }).click();
  await expect(page.locator('blockquote')).toContainText('请把这里改亮一点');
  await page.getByRole('button', { name: '标记已完成', exact: true }).click();
  await expect(page.getByRole('button', { name: '已完成 · 撤回标记' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '已完成 · 撤回标记' })).toBeVisible();
  await page.getByRole('button', { name: '已完成 · 撤回标记' }).click();
  await expect(page.getByRole('button', { name: '标记已完成', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('HEIC with empty MIME converts via local worker; download is a static JPEG', async ({ page, request }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/test-entry');
  await page.getByLabel('新素材保留时间').selectOption('7');
  await page.locator('input[type=file]').setInputFiles({ name: 'live-photo.HEIC', mimeType: '', buffer: readFileSync(new URL('../fixtures/example.heic', import.meta.url)) });
  await expect.poll(async () => (await (await request.get('/api/clips')).json()).length, { timeout: 75_000 }).toBe(1);
  const [image] = await (await request.get('/api/clips')).json();
  expect(image.type).toBe('image');
  expect(image.content).toMatch(/\.jpg$/);
  expect(Date.parse(image.expires_at) - Date.now()).toBeGreaterThan(6 * 86400_000);
  const download = await request.get(`/api/media/${image.content}`);
  expect(download.headers()['content-type']).toBe('image/jpeg');
  expect((await download.body()).subarray(0, 3)).toEqual(Buffer.from([255, 216, 255]));
  await expect(page.getByRole('button', { name: '删除素材' })).toBeEnabled();
  await page.getByRole('button', { name: '删除素材' }).click();
  await expect(page.getByText('还没有内容', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('an older list response cannot erase a newly sent clip', async ({ page }) => {
  let release;
  let captured;
  const ready = new Promise(resolve => { captured = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let first = true;
  await page.route('**/api/clips', async route => {
    if (route.request().method() !== 'GET' || !first) return route.continue();
    first = false;
    const response = await route.fetch();
    captured();
    await gate;
    await route.fulfill({ response });
  });
  await page.goto('/test-entry');
  await ready;
  const input = page.getByPlaceholder('粘贴文字回车同步，或直接粘贴截图...');
  await input.fill('刚刚发送的新素材');
  await input.press('Enter');
  await expect(page.getByRole('button', { name: '删除素材' })).toBeEnabled();
  const received = page.waitForResponse(response => response.request().method() === 'GET' && response.url().endsWith('/api/clips'));
  release();
  await received;
  await expect(page.getByText('刚刚发送的新素材', { exact: true })).toBeVisible();
});

test('failed delete restores only that item and retains concurrent additions', async ({ page, request }) => {
  const old = await (await request.post('/api/clips', { data: { content: '待删除的旧素材' } })).json();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(`**/api/clips/${old.id}`, async route => {
    if (route.request().method() !== 'DELETE') return route.continue();
    await gate;
    await route.fulfill({ status: 500, json: { error: '模拟失败' } });
  });
  await page.goto('/test-entry');
  await page.getByRole('button', { name: '删除素材' }).click();
  await expect(page.getByText('待删除的旧素材', { exact: true })).toBeHidden();
  const input = page.getByPlaceholder('粘贴文字回车同步，或直接粘贴截图...');
  await input.fill('删除过程中新增的素材');
  await input.press('Enter');
  await expect(page.getByRole('button', { name: '删除素材' })).toBeEnabled();
  release();
  await expect(page.getByText('待删除的旧素材', { exact: true })).toBeVisible();
  await expect(page.getByText('删除过程中新增的素材', { exact: true })).toBeVisible();
});

test('upload disables premature delete; failed thumbnail keeps the original', async ({ page, request }) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/clips?retention_days=*', async route => { await gate; await route.continue(); });
  await page.route('**/api/clips/*/thumb', route => route.fulfill({ status: 500, json: { error: '模拟缩略图失败' } }));
  await page.goto('/test-entry');
  const pngData = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 800;
    const context = canvas.getContext('2d');
    context.fillStyle = '#7366ff';
    context.fillRect(0, 0, 600, 800);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const bytes = Buffer.from(pngData, 'base64');
  await page.locator('input[type=file]').setInputFiles({ name: '素材.png', mimeType: '', buffer: bytes });
  await expect(page.getByRole('button', { name: '删除素材' })).toBeDisabled();
  release();
  await expect(page.getByRole('button', { name: '删除素材' })).toBeEnabled();
  const [row] = await (await request.get('/api/clips')).json();
  expect(hash(await (await request.get(`/api/media/${row.content}`)).body())).toBe(hash(bytes));
  await expect(page.getByRole('link', { name: '下载原图' })).toBeVisible();
});
