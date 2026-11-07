import { test, expect } from '@playwright/test';
import { createHmac } from 'node:crypto';

const entry = '/test-entry';
const password = 'test-password';
const derive = purpose => createHmac('sha256', `${password}|${entry.slice(1)}`).update(purpose).digest('base64url');

test('wrong pages return 404 before authentication and never reveal the entry', async ({ request }) => {
  for (const path of ['/', '/wrong', '/index.html', '/__login', '/test-entry/child', '/wrong.png']) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status()).toBe(404);
    expect(response.headers().location).toBeUndefined();
    expect(await response.text()).not.toContain(entry);
  }
  const response = await request.post('/wrong', { form: { password } });
  expect(response.status()).toBe(404);
  expect(response.headers()['set-cookie']).toBeUndefined();
});

test('unauthenticated APIs, images, comments, assets and manifest remain blocked', async ({ request }) => {
  for (const path of ['/api/clips', '/api/media/example.png', '/api/clips/1/comments', '/assets/example.js', '/manifest.webmanifest', '/__logout']) {
    const response = await request.get(path, { maxRedirects: 0, headers: { 'CF-Connecting-IP': '192.168.1.2', 'X-Forwarded-For': '127.0.0.1' } });
    expect(response.status()).toBe(401);
    expect(response.headers()['cache-control']).toContain('no-store');
    expect(response.headers().location).toBeUndefined();
    expect(await response.text()).not.toContain(entry);
  }
  for (const [method, path, data] of [
    ['post', '/api/clips', { content: 'forbidden' }],
    ['post', '/api/clips/1/comments', { content: 'forbidden' }],
    ['patch', '/api/clips/1', { status: 'done' }],
    ['delete', '/api/clips/1', undefined],
  ]) expect((await request[method](path, { data })).status()).toBe(401);
  expect((await request.get('/icon.svg')).status()).toBe(200);
  expect((await request.get('/apple-touch-icon-180.png')).status()).toBe(200);
});

test('old login links and old sessions no longer bypass the password', async ({ request, context, page }) => {
  const response = await request.get(`${entry}?k=${derive('login-v1')}`, { maxRedirects: 0 });
  expect(response.headers()['set-cookie']).toBeUndefined();
  expect(await response.text()).toContain('name="password"');
  expect((await request.get(`/api/clips?k=${derive('login-v1')}`)).status()).toBe(401);
  await context.addCookies([{ name: 'vclip_session', value: derive('session-v1'), url: 'http://127.0.0.1:19473' }]);
  await page.goto(entry);
  await expect(page.getByPlaceholder('访问密码')).toBeVisible();
  expect((await request.get('/api/clips')).status()).toBe(401);
});

test('first visit requires password, remembers login, protects manifest and logs out', async ({ page }) => {
  const request = page.request;
  await page.goto(entry);
  await expect(page.getByPlaceholder('访问密码')).toBeVisible();
  await expect(page.locator('link[rel=manifest]')).toHaveCount(0);
  await page.getByPlaceholder('访问密码').fill('wrong-password');
  await page.getByRole('button', { name: '进入', exact: true }).click();
  await expect(page.getByText('密码不正确，请重试')).toBeVisible();
  expect((await request.get('/api/clips')).status()).toBe(401);
  await page.getByPlaceholder('访问密码').fill(password);
  await page.getByRole('button', { name: '进入', exact: true }).click();
  await expect(page.getByLabel('新素材保留时间')).toBeVisible();
  await expect(page.locator('link[rel=manifest]')).toHaveAttribute('crossorigin', 'use-credentials');
  const manifestResponse = await request.get('/manifest.webmanifest');
  expect(manifestResponse.status()).toBe(200);
  expect(manifestResponse.headers()['cache-control']).toBe('private, no-store');
  expect(manifestResponse.headers().vary).toBe('Cookie');
  expect((await manifestResponse.json()).start_url).toBe(entry);
  const cdp = await page.context().newCDPSession(page);
  const manifest = await cdp.send('Page.getAppManifest');
  expect(manifest.errors).toEqual([]);
  expect(JSON.parse(manifest.data).start_url).toBe(entry);
  await cdp.detach();
  await page.reload();
  await expect(page.getByLabel('新素材保留时间')).toBeVisible();
  expect((await request.get('/')).status()).toBe(404);
  expect((await request.get('/index.html')).status()).toBe(404);
  await page.goto('/__logout');
  await expect(page.getByPlaceholder('访问密码')).toBeVisible();
  expect((await request.get('/manifest.webmanifest')).status()).toBe(401);
});

test('Basic Auth stays available for API integrations but cannot fetch the hidden manifest', async ({ request }) => {
  const headers = { Authorization: `Basic ${Buffer.from(`vclip:${password}`).toString('base64')}` };
  expect((await request.get('/api/clips', { headers })).status()).toBe(200);
  expect((await request.get('/manifest.webmanifest', { headers })).status()).toBe(401);
  expect(await (await request.get(entry, { headers })).text()).toContain('name="password"');
});

test('login ignores arbitrary redirect destinations and issues a protected Cookie', async ({ request }) => {
  const response = await request.post(entry, { form: { password, next: '//evil.example/' }, maxRedirects: 0 });
  expect(response.status()).toBe(302);
  expect(response.headers().location).toBe(entry);
  expect(response.headers()['set-cookie']).toContain('HttpOnly');
  expect(response.headers()['set-cookie']).toContain('SameSite=Lax');
  expect(response.headers()['set-cookie']).toContain('Max-Age=31536000');
});
