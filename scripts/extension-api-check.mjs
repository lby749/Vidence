// 临时浏览器和自建 API 验证配置/模型切换；不调用真实模型，不读取用户配置。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';

const requests = [];
const server = http.createServer(async (request, response) => {
  assert.equal(request.headers.authorization, 'Bearer fixture-only-key');
  let raw = ''; for await (const chunk of request) raw += chunk;
  requests.push({ path: request.url, body: raw ? JSON.parse(raw) : null });
  if (request.url === '/v1/models') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: 'deepseek-v4.1-flash' }, { id: 'chosen-chat' }, { id: 'embedding-only' }] }));
  } else if (request.url === '/v1/chat/completions') {
    response.setHeader('Content-Type', 'text/event-stream');
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  } else response.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const extension = path.resolve(process.env.VMA_EXTENSION_PATH ?? '.output/chrome-mv3');
let context;
try {
  context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'vidence-api-')), {
    channel: process.env.E2E_BROWSER ?? 'msedge', headless: true, locale: 'zh-CN', viewport: { width: 1100, height: 950 },
    args: [`--load-extension=${extension}`, `--disable-extensions-except=${extension}`, '--disable-gpu', '--no-first-run'],
  });
  let [worker] = context.serviceWorkers(); worker ??= await context.waitForEvent('serviceworker');
  const base = `chrome-extension://${new URL(worker.url()).host}`;
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  await page.goto(`${base}/library.html?tab=settings`);
  const wizard = page.locator('.api-quick-setup');
  await wizard.getByRole('button', { name: '其他服务', exact: true }).click();
  await wizard.getByLabel('API 服务地址', { exact: true }).fill(`http://127.0.0.1:${server.address().port}/v1/chat/completions`);
  await wizard.getByLabel('一键配置 API Key', { exact: true }).fill('fixture-only-key');
  await wizard.getByRole('button', { name: '自己选择模型', exact: true }).click();
  await wizard.getByLabel('自动获取的 API 模型', { exact: true }).waitFor();
  await wizard.getByLabel('自动获取的 API 模型', { exact: true }).fill('chosen-chat');
  await wizard.getByRole('button', { name: /^连接并使用所选模型/ }).click();
  await wizard.getByRole('status').filter({ hasText: '问答和摘要已配置' }).waitFor();
  assert.equal(requests.filter(item => item.path === '/v1/chat/completions').length, 1);
  assert.equal(requests.at(-1).body.model, 'chosen-chat');
  // 已保存本机连接也不能抢走用户刚选的 API 路线。
  await page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('video-memory-assistant'); open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction('settings', 'readwrite'), store = tx.objectStore('settings');
      const read = store.get('app'); read.onsuccess = () => store.put({ ...read.result, localAgent: { backend: 'opencode-go', token: 'fixture-not-a-real-token', model: 'unselected-local-model' } });
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
    };
  }));
  await page.goto(`${base}/sidepanel.html`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '选择聊天模型', exact: true }).filter({ hasText: 'chosen-chat' }).waitFor();
  await page.getByRole('button', { name: '切换智能体', exact: true }).click();
  const picker = page.getByRole('region', { name: '侧栏助手与模型', exact: true });
  await picker.locator('.model-option').first().waitFor();
  assert.equal(await picker.locator('.model-option').count(), 2, '非聊天模型不混入问答目录');
  await picker.getByRole('searchbox', { name: '搜索模型' }).fill('deepseek');
  await picker.locator('.model-option').filter({ hasText: 'deepseek-v4.1-flash' }).click();
  await picker.waitFor({ state: 'detached' });
  await page.reload();
  await page.getByRole('button', { name: '选择聊天模型', exact: true }).filter({ hasText: 'deepseek-v4.1-flash' }).waitFor();
  await page.getByRole('button', { name: '切换智能体', exact: true }).click();
  await picker.getByRole('searchbox', { name: '搜索模型' }).waitFor();
  const bounds = await picker.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 390 && bounds.y + bounds.height <= 844);
  fs.mkdirSync('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/extension-model-picker.png' });
  await picker.getByRole('searchbox', { name: '搜索模型' }).press('Escape');
  await picker.waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('dialog').count(), 0);
  fs.mkdirSync('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/extension-api-sidebar.png', fullPage: true });
  console.log('EXTENSION_API_PASS', JSON.stringify({ standalone: true, fixtureApi: true, realModelClaim: false, discovery: true, selectedModelProbe: true, sidebarSelectionPersists: true, noDesktopService: true }));
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
}
