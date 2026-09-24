import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';

const host = {
  id: 'alpha', name: 'Tokyo production', host: '192.0.2.10', port: 22, username: 'root',
  group: '测试主机', authMethod: 'password', initialCommand: '', termType: 'xterm-256color',
  encoding: 'utf-8', fingerprint: `SHA256:${'A'.repeat(43)}`, location: null, system: null,
  hasCredential: true, updatedAt: Date.now(),
};

async function forwardingFixture(page: Page) {
  const calls: Array<Record<string, unknown>> = [];
  const sockets: WebSocketRoute[] = [];
  const closed: boolean[] = [];
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/me') return route.fulfill({ json: { account: { username: 'Administrator' }, provider: 'cloudflare' } });
    if (path === '/api/hosts') return route.fulfill({ json: { hosts: [host] } });
    if (path.endsWith('/credentials')) return route.fulfill({ json: { password: 'test-only-password' } });
    if (path === '/api/session') return route.fulfill({ json: { ticket: 'test-ticket', sessionId: 'session-forward' } });
    if (path === '/api/forwarding') {
      calls.push({ type: 'forwarding', body: route.request().postDataJSON() });
      return route.fulfill({ json: { url: 'https://preview.example.net/__edgessh/start#xxx', expiresAt: Date.now() + 3600000 } });
    }
    return route.fulfill({ json: {} });
  });
  await page.routeWebSocket('**/api/ssh?*', (ws) => {
    sockets.push(ws);
    const index = sockets.length - 1;
    closed[index] = false;
    ws.onClose(() => { closed[index] = true; void ws.close(); });
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      calls.push(message);
      if (message.type === 'connect') ws.send(JSON.stringify({ type: 'ready' }));
    });
  });
  await page.goto('/');
  await page.locator('#rail-forward').click();
  return { calls, sockets, closed };
}

async function startForward(page: Page) {
  await page.locator('.forward-page select[name="host"]').selectOption('alpha');
  await page.locator('.forward-page input[name="port"]').fill('8080');
  await page.locator('.forward-page button[type="submit"]').click();
}

test('连接转发发送 forward 协议并提供弹窗拦截回退链接，停止后解锁主机', async ({ page }, testInfo) => {
  const { calls } = await forwardingFixture(page);
  await page.evaluate(() => { window.open = () => null; });
  await startForward(page);
  await expect.poll(() => calls.find((call) => call.type === 'connect')?.mode).toBe('forward');
  await expect.poll(() => calls.find((call) => call.type === 'forwarding')?.body).toEqual({ port: 8080 });
  await expect.poll(() => page.locator('a[data-preview-link]').getAttribute('href')).toBe('https://preview.example.net/__edgessh/start#xxx');
  await expect(page.locator('a[data-preview-link]')).toBeVisible();
  await expect(page.locator('a[data-preview-link]')).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(page.locator('a[data-preview-link]')).toHaveAttribute('target', '_blank');
  await page.locator('[data-stop]').click();
  await expect(page.locator('a[data-preview-link]')).toBeHidden();
  await expect(page.locator('.forward-page select[name="host"]')).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('forwarding-desktop.png'), fullPage: true });
});

test('离开总览会关闭独立转发 WebSocket，返回页面保持未连接', async ({ page }) => {
  const { sockets, closed } = await forwardingFixture(page);
  await startForward(page);
  await expect.poll(() => sockets.length).toBe(1);
  await page.locator('#rail-overview').click();
  await expect.poll(() => closed[0]).toBe(true);
  await page.locator('#rail-forward').click();
  await expect(page.locator('[data-status]')).not.toContainText('已转发');
  await expect(page.locator('[data-stop]')).toBeDisabled();
});

test('空主机禁用连接按钮且桌面与 375px 手机布局没有横向溢出', async ({ page }, testInfo) => {
  await page.route('**/api/hosts', (route) => route.fulfill({ json: { hosts: [] } }));
  await page.goto('/');
  await page.locator('#rail-forward').click();
  await expect(page.locator('.forward-page button[type="submit"]')).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('forwarding-mobile.png'), fullPage: true });
});
