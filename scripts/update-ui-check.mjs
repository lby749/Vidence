// 隔离浏览器中的模拟版本目录；不发布虚构Release，不使用真实账号或密钥。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

fs.mkdirSync('artifacts', { recursive: true });
const extension = path.resolve('.output/chrome-mv3');
const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'vma-update-ui-')), {
  channel: process.env.E2E_BROWSER ?? 'msedge', headless: true, locale: 'zh-CN', viewport: { width: 1100, height: 950 },
  args: [`--load-extension=${extension}`, `--disable-extensions-except=${extension}`, '--disable-gpu', '--no-first-run'],
});
let calls = 0, version = '0.1.0-beta.3', status = 200;
const report = { scope: 'isolated-browser-release-feed-fixture', liveReleaseClaim: false };
try {
  await context.route('https://api.github.com/repos/lby749/lby/releases?*', route => {
    calls++; return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status === 200 ? [{ tag_name: `v${version}`, html_url: `https://github.com/lby749/lby/releases/tag/v${version}`, published_at: '2026-11-11T00:00:00Z', prerelease: true, draft: false, body: '修复持续运动的画面记录。<img src=x onerror=alert(1)>' }] : {}) });
  });
  let [worker] = context.serviceWorkers(); worker ??= await context.waitForEvent('serviceworker');
  const page = await context.newPage(), url = `chrome-extension://${new URL(worker.url()).host}/library.html`;
  await page.goto(url);
  await page.locator('.app-update-banner').getByText(version, { exact: true }).waitFor();
  assert.equal(calls, 1);
  await page.getByRole('button', { name: '稍后提醒', exact: true }).click();
  await page.locator('.app-update-banner').waitFor({ state: 'hidden' });
  await page.reload(); await page.getByRole('button', { name: '设置', exact: true }).waitFor();
  assert.equal(await page.locator('.app-update-banner').count(), 0); assert.equal(calls, 1);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const card = page.locator('.app-update-card');
  version = '0.1.0-beta.10';
  await card.getByRole('button', { name: '检查更新', exact: true }).click();
  await card.getByText(version, { exact: true }).waitFor(); assert.equal(calls, 2);
  await card.getByText('更新说明', { exact: true }).click();
  assert.ok((await card.locator('.app-update-notes').innerText()).includes('<img'));
  assert.equal(await card.locator('img').count(), 0, '版本说明作为文本呈现');
  await page.evaluate(() => { window.openedUpdate = []; window.open = (...args) => { window.openedUpdate.push(args); return null; }; });
  await card.getByRole('button', { name: '查看更新', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.openedUpdate[0]), [`https://github.com/lby749/lby/releases/tag/v${version}`, '_blank', 'noopener,noreferrer']);
  await card.getByRole('button', { name: '反馈问题或建议 ↗', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.openedUpdate[1]), ['https://github.com/lby749/lby/issues/new/choose', '_blank', 'noopener,noreferrer']);
  await card.getByRole('checkbox', { name: '自动提醒新版本', exact: true }).uncheck();
  await page.evaluate(() => { const state = JSON.parse(localStorage.getItem('vma-app-updates')); state.checkedAt = 0; localStorage.setItem('vma-app-updates', JSON.stringify(state)); });
  await page.reload(); await page.getByRole('button', { name: '设置', exact: true }).click();
  await card.getByRole('checkbox', { name: '自动提醒新版本', exact: true }).waitFor();
  assert.equal(await card.getByRole('checkbox').isChecked(), false); assert.equal(calls, 2);
  await page.getByRole('button', { name: '学习偏好', exact: true }).click();
  await page.getByLabel('界面语言', { exact: true }).selectOption('en');
  await card.getByRole('heading', { name: 'App updates', exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await card.screenshot({ path: 'artifacts/app-updates-english.png' });
  await page.getByLabel('Interface language', { exact: true }).selectOption('zh-TW');
  await card.getByRole('heading', { name: '應用程式更新', exact: true }).waitFor();
  await card.getByText(version, { exact: true }).waitFor();
  status = 404;
  await page.evaluate(() => localStorage.removeItem('vma-app-updates'));
  await page.goto(url + '?tab=settings');
  await card.getByText('更新服務暫時無法使用，請稍後重試。', { exact: true }).waitFor();
  assert.equal(await card.getByText('目前已是最新版本。', { exact: true }).count(), 0);
  await card.screenshot({ path: 'artifacts/app-updates-unavailable.png' });
  Object.assign(report, { automaticDiscovery: true, dailyCache: true, deferPersists: true, manualRetry: true, autoOffPersists: true, officialLinkOnly: true, feedbackEntry: true, notesEscaped: true, threeLanguages: true, narrowLayout: true, unavailableNotLatest: true, passed: true });
  console.log('APP_UPDATES_UI_PASS', JSON.stringify(report));
} finally { fs.writeFileSync('artifacts/app-updates-ui.json', JSON.stringify(report, null, 2)); await context.close(); }
