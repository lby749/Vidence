import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const ext = path.resolve(process.env.VMA_EXTENSION_PATH ?? '.output/chrome-mv3');
fs.mkdirSync('artifacts', { recursive: true });
const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'vma-settings-')), {
  channel: process.env.E2E_BROWSER ?? 'msedge', headless: true, locale:'zh-CN', viewport: { width: 1440, height: 1020 },
  args: [`--load-extension=${ext}`, `--disable-extensions-except=${ext}`, '--disable-gpu', '--no-first-run'],
});
try {
  let [worker] = context.serviceWorkers(); worker ??= await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/library.html?tab=settings`);
  await page.getByRole('heading', { name: '给学习找个好伙伴。' }).waitFor();
  assert.equal(await page.getByPlaceholder('Base URL（可选）').count(), 0);
  assert.equal(await page.getByPlaceholder('Videos 数据库 ID').count(), 0);
  await page.screenshot({ path: 'artifacts/settings-assistant-desktop.png', fullPage: true });
  await page.getByRole('button', { name: /连接 AI 助手/ }).click();
  await page.getByLabel('连接码', { exact: true }).fill('invalid-test-pairing');
  await page.getByRole('button', { name: '连接并保存' }).click();
  await page.getByRole('alert').waitFor();
  assert.ok(await page.getByRole('alert').innerText());
  await page.getByRole('button', { name: '离线功能', exact: true }).click();
  await page.getByText('让占用，由你决定。').waitFor();
  assert.equal(await page.getByRole('radio').count(), 4);
  await page.getByRole('radio', { name: '低占用', exact: true }).check();
  await page.getByRole('button', { name: '下载并启用低占用', exact: true }).waitFor();
  assert.equal(await page.getByText('Xenova/bge-reranker-base', { exact: false }).count(), 0);
  await page.screenshot({ path: 'artifacts/settings-offline-desktop.png', fullPage: true });
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'四档选择在窄屏无横向溢出');
  await page.screenshot({path:'artifacts/settings-tiers-mobile.png',fullPage:true});
  await page.setViewportSize({width:1440,height:1020});
  await page.getByRole('button', { name: '学习偏好', exact: true }).click();
  await page.getByLabel('回答与摘要的语言').selectOption('en');
  await page.getByLabel('回答与整理的风格').selectOption('patient');
  const toggle = page.getByRole('switch', { name: /^允许发送视频截图/ });
  const before = await toggle.isChecked(); await toggle.setChecked(!before);
  await page.locator('.preferences[aria-busy="false"]').waitFor();
  await page.reload(); await page.getByRole('button', { name: '学习偏好', exact: true }).click();
  assert.equal(await toggle.isChecked(), !before);
  assert.equal(await page.getByLabel('回答与摘要的语言').inputValue(), 'en');
  assert.equal(await page.getByLabel('回答与整理的风格').inputValue(), 'patient');
  await page.getByRole('button', { name: '高级选项', exact: true }).click();
  await page.getByText('API 提供商与模型角色',{exact:true}).waitFor();
  assert.equal(await page.getByPlaceholder('Base URL（可选）').count(),0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false, '窄窗口不出现水平滚动');
  await page.screenshot({ path: 'artifacts/settings-assistant-mobile.png', fullPage: true });
  const weights = fs.readdirSync(ext, { recursive: true }).filter(file => /\.(onnx|tar)$/i.test(String(file)));
  assert.deepEqual(weights, [], '发布目录不包含模型权重');
  console.log('SETTINGS_UI_PASS', JSON.stringify({ categories: 4, plainLanguage: true, preferencesPersist: true, responsive: true, bundledWeights: 0 }));
} finally { await context.close(); }
