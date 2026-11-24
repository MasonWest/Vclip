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

test('original bytes, thumbnail, prompt, status, expiry and cleanup', async ({ request }) => {
  const response = await request.post('/api/clips', { headers: { 'Content-Type': 'image/png' }, data: png });
  expect(response.status()).toBe(201);
  const image = await response.json();
  const thumb = await (await request.post(`/api/clips/${image.id}/thumb`, { headers: { 'Content-Type': 'image/png' }, data: png })).json();
  expect(hash(await (await request.get(`/api/media/${image.content}`)).body())).toBe(hash(png));
  expect((await request.patch(`/api/clips/${image.id}`, { data: { prompt: '  第一行提示词\n第二行  ', prompt_version: 0 } })).status()).toBe(200);
  expect((await request.patch(`/api/clips/${image.id}`, { data: { prompt: '旧版本不该覆盖', prompt_version: 0 } })).status()).toBe(409);
  expect((await request.get(`/api/clips/${image.id}/comments`)).status()).toBe(404);
  expect((await request.post(`/api/clips/${image.id}/comments`, { data: { content: '旧留言接口' } })).status()).toBe(404);
  expect((await request.patch(`/api/clips/${image.id}`, { data: { status: 'done' } })).status()).toBe(200);
  const row = (await (await request.get('/api/clips')).json()).find(row => row.id === image.id);
  expect(row).toMatchObject({ status: 'done', prompt: '  第一行提示词\n第二行  ', prompt_version: 1, thumb: thumb.thumb, expires_at: image.expires_at });
  await request.delete(`/api/clips/${image.id}`);
  expect((await request.get(`/api/media/${image.content}`)).status()).toBe(404);
  expect((await request.get(`/api/media/${thumb.thumb}`)).status()).toBe(404);
  expect((await request.get(`/api/clips/${image.id}/comments`)).status()).toBe(404);
  const expiring = await (await request.post('/api/clips', { data: { content: '即将过期', expires_at: new Date(Date.now() + 1200).toISOString() } })).json();
  await expect.poll(async () => (await request.patch(`/api/clips/${expiring.id}`, { data: { prompt: '过期不可写', prompt_version: 0 } })).status()).toBe(404);
});

test('mobile prompt workflow: large editor, draft, full copy, completion and clear', async ({ page, request }) => {
  await request.post('/api/clips', { headers: { 'Content-Type': 'image/png' }, data: png });
  // 模拟普通内网 HTTP：必须沿用同步 execCommand 复制路径。
  await page.addInitScript(() => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    document.execCommand = command => {
      if (command !== 'copy') return false;
      window.__copiedText = document.activeElement.value;
      return true;
    };
  });
  await page.goto('/test-entry');
  await expect(page.getByLabel('留言昵称')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '回复', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '添加提示词', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '编辑提示词', exact: true });
  await expect(editor).toBeVisible();
  const bounds = await editor.boundingBox();
  expect(bounds.width).toBeGreaterThanOrEqual(389);
  expect(bounds.height).toBeGreaterThanOrEqual(843);
  const prompt = '  保留开头空格\n' + '非常长的提示词，支持逐段编辑。\n'.repeat(600) + '结尾也需要复制。  ';
  await page.getByLabel('提示词编辑区').fill(prompt);
  await page.screenshot({ path: test.info().outputPath('prompt-mobile.png') });
  await page.getByRole('button', { name: '关闭编辑器' }).click();
  await page.reload();
  await page.getByRole('button', { name: '添加提示词', exact: true }).click();
  await expect(page.getByLabel('提示词编辑区')).toHaveValue(prompt);
  await page.getByRole('button', { name: '复制全文', exact: true }).click();
  expect(await page.evaluate(() => window.__copiedText)).toBe(prompt);
  await page.getByRole('button', { name: '保存提示词', exact: true }).click();
  await expect(editor).toBeHidden();
  await page.getByRole('button', { name: '复制提示词', exact: true }).click();
  expect(await page.evaluate(() => window.__copiedText)).toBe(prompt);
  await page.getByRole('button', { name: '标记已完成', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: '已完成 · 撤回标记' })).toBeVisible();
  await page.getByRole('button', { name: '编辑提示词', exact: true }).click();
  await page.getByLabel('提示词编辑区').fill('');
  await page.getByRole('button', { name: '保存提示词', exact: true }).click();
  await expect(page.getByRole('button', { name: '添加提示词', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '复制提示词', exact: true })).toHaveCount(0);
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

test('desktop editor keeps a draft across remote refresh and resolves conflicts explicitly', async ({ page, request, context }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const row = await (await request.post('/api/clips', { headers: { 'Content-Type': 'image/png' }, data: png })).json();
  await request.patch(`/api/clips/${row.id}`, { data: { prompt: '原始提示词', prompt_version: 0 } });
  await page.goto('/test-entry');
  await page.getByRole('button', { name: '编辑提示词', exact: true }).click();
  const bounds = await page.getByRole('dialog').boundingBox();
  expect(bounds.width).toBeGreaterThan(1000);
  expect(bounds.height).toBeGreaterThan(750);
  await page.getByLabel('提示词编辑区').fill('我的修改\n保留这一段');
  await page.screenshot({ path: test.info().outputPath('prompt-desktop.png') });
  await request.patch(`/api/clips/${row.id}`, { data: { prompt: '朋友刚更新的内容', prompt_version: 1 } });
  const refreshed = page.waitForResponse(response => response.request().method() === 'GET' && response.url().endsWith('/api/clips'));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await refreshed;
  await expect(page.getByLabel('提示词编辑区')).toHaveValue('我的修改\n保留这一段');
  await page.getByRole('button', { name: '保存提示词', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('草稿已保留');
  expect((await (await request.get('/api/clips')).json())[0].prompt).toBe('朋友刚更新的内容');
  await page.getByText('查看其他设备的最新提示词', { exact: true }).click();
  await expect(page.getByRole('dialog').getByText('朋友刚更新的内容', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '保存我的版本', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.getByRole('button', { name: '复制提示词', exact: true }).click();
  // Windows 系统剪贴板使用 CRLF，按相同的逻辑换行比较内容。
  expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n')).toBe('我的修改\n保留这一段');
});

test('failed prompt save preserves the complete draft and can be retried after reopening', async ({ page, request }) => {
  const row = await (await request.post('/api/clips', { headers: { 'Content-Type': 'image/png' }, data: png })).json();
  await page.goto('/test-entry');
  await page.route(`**/api/clips/${row.id}`, route => route.fulfill({ status: 500, json: { error: '保存失败，你的草稿已保留' } }));
  await page.getByRole('button', { name: '添加提示词', exact: true }).click();
  await page.getByLabel('提示词编辑区').fill('还没有保存成功的长提示词\n第二行');
  await page.getByRole('button', { name: '保存提示词', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('草稿已保留');
  await page.getByRole('button', { name: '关闭编辑器' }).click();
  await page.unroute(`**/api/clips/${row.id}`);
  await page.getByRole('button', { name: '添加提示词', exact: true }).click();
  await expect(page.getByLabel('提示词编辑区')).toHaveValue('还没有保存成功的长提示词\n第二行');
  await page.getByLabel('提示词编辑区').press('Control+Enter');
  await expect(page.getByRole('dialog')).toBeHidden();
  expect((await (await request.get('/api/clips')).json())[0].prompt).toBe('还没有保存成功的长提示词\n第二行');
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
