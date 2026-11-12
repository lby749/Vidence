// 仅在临时配置中加载发行包插件；不访问用户的日常浏览器。
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const [extension, profile, internal] = process.argv.slice(2).map(value => path.resolve(value));
const extensionIdForPath = internal ? (await import(pathToFileURL(path.join(internal, 'scripts/local-agent-bridge.mjs')))).extensionIdForPath : null;
const context = await chromium.launchPersistentContext(profile, {
  channel: process.env.E2E_BROWSER ?? 'msedge', headless: true, locale: 'zh-CN',
  args: [`--load-extension=${extension}`, `--disable-extensions-except=${extension}`, '--disable-gpu', '--no-first-run'],
});
try {
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  if (extensionIdForPath) assert.equal(id, extensionIdForPath(extension), '安装目录身份必须与桥接一致');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/library.html?tab=settings`);
  await page.getByRole('heading', { name: '给学习找个好伙伴。' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '离线功能', exact: true }).count(), 1);
  console.log('RELEASE_EXTENSION_LOAD_PASS');
} finally {
  await context.close();
}
