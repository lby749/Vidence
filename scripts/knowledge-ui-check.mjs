import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
const root = path.resolve('.output/chrome-mv3');
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/qwebchannel.js') { res.setHeader('Content-Type', 'text/javascript'); res.end('window.QWebChannel=function(t,callback){callback({objects:{native:window.qaNative}})}'); return; }
  const file = path.resolve(root, '.' + decodeURIComponent(pathname));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/html'); fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: 'msedge', headless: true }), page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, locale: 'zh-CN' });
const report = { scope: 'headless-desktop-ui-seeded-with-real-frame-and-model-results', nativePlaybackClaim: false };
try {
  await page.route('http://127.0.0.1:8131/**', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ backends: { 'opencode-go': { available: true } } }) }));
  await page.addInitScript(() => {
    const reply = (callback, value) => callback(JSON.stringify(value)); window.qt = { webChannelTransport: {} };
    window.qaNative = { bootstrap: c => reply(c, {}), currentSource: c => reply(c, null), presentationState: c => reply(c, { attached: false, collapsed: false, fullscreen: false }), windows: c => reply(c, []), browsers: c => reply(c, []), stopCapture: c => reply(c, {}), restoreWindow: c => reply(c, {}) };
  });
  const base = `http://127.0.0.1:${server.address().port}`; await page.goto(base + '/desktop.html');
  await page.getByRole('button', { name: '我的视频库', exact: true }).waitFor();
  const review = JSON.parse(fs.readFileSync('artifacts/keyframe-audit/BV1G7jJ6nEbV/knowledge-review.json', 'utf8'));
  const frames = review.frames.filter(frame => [5, 330, 550].includes(frame.time)).map(frame => ({ ...frame, data: fs.readFileSync(path.join('artifacts/keyframe-audit/BV1G7jJ6nEbV', frame.full)).toString('base64') }));
  const qa = JSON.parse(fs.readFileSync('artifacts/knowledge-qa-check.json', 'utf8')).cases[0];
  await page.evaluate(async ({ frames, qa, image }) => {
    const db = await new Promise((resolve, reject) => { const open = indexedDB.open('video-memory-assistant'); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    const tx = db.transaction(['videos', 'keyframes', 'settings', 'chats'], 'readwrite');
    tx.objectStore('videos').put({ id: 'review-ui', title: '数学视频：知识画面与图片引用', duration: 2020, url: 'https://www.bilibili.com/video/BV1G7jJ6nEbV/', platform: 'bilibili', lastPosition: 324, recordedRanges: [[0,2020]], createdAt: 1, updatedAt: 1 });
    for (const frame of frames) tx.objectStore('keyframes').put({ ...frame, videoId: 'review-ui', sessionId: 'ui', image: new Blob([Uint8Array.from(atob(frame.data), char => char.charCodeAt(0))], { type: 'image/jpeg' }), width: 1280, height: 720, uploadAllowed: false, reason: 'auto-change', fingerprint: frame.id, capturedAt: 1, captureEpoch: 1, evidenceIds: [] });
    tx.objectStore('keyframes').put({ id: 'actual-qa', videoId: 'review-ui', time: 324, image: new Blob([Uint8Array.from(atob(image), char => char.charCodeAt(0))], { type: 'image/jpeg' }), width: 1280, height: 720, reason: 'auto-change', uploadAllowed: false });
    tx.objectStore('settings').put({ id: 'app', uiLanguage: 'zh-CN', preferredQaRoute: 'local-agent', localAgent: { backend: 'opencode-go', token: 'ui-fixture-only', model: 'deepseek-v4.1-flash' }, privacy: { allowVisionUpload: true } });
    tx.objectStore('chats').put({ id: 'real-answer-ui', requestId: 'real-answer-ui', videoId: 'review-ui', question: '右侧是什么等式？', answer: qa.answer, citations: qa.citations.map(c => ({ ...c, keyframeId: 'actual-qa' })), route: 'local-agent', status: 'completed', createdAt: 1 });
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); db.close();
  }, { frames, qa, image: fs.readFileSync('artifacts/bili-actual-keyframe.jpg').toString('base64') });
  await page.reload(); await page.getByRole('button', { name: '我的视频库', exact: true }).click();
  const checkbox = page.getByRole('checkbox', { name: '允许读取画面', exact: true }); await checkbox.waitFor(); await checkbox.check(); assert.ok(await checkbox.isEnabled());
  assert.ok(await checkbox.isChecked()); report.openCodeGoImageOption = true;
  await page.locator('.inline-citation').first().click();
  const dialog = page.getByRole('dialog', { name: '回答引用的画面' }); await dialog.waitFor();
  await page.waitForFunction(() => document.querySelector('.frame-preview img')?.naturalWidth === 1280);
  await page.screenshot({ path: 'artifacts/knowledge-answer-image.png' });
  await dialog.getByRole('button', { name: '关闭画面' }).click(); await dialog.waitFor({ state: 'hidden' }); report.actualImageCitationPreview = true;
  await page.getByRole('button', { name: /^原文与节点/ }).click();
  await page.locator('.frame-gallery').first().locator('summary').click();
  assert.equal(await page.locator('.frame-gallery').first().locator('img').count(), 2);
  await page.locator('.frame-gallery').nth(1).locator('summary').click();
  assert.equal(await page.locator('.frame-gallery').nth(1).locator('img').count(), 2);
  assert.ok(await page.locator('.frame-gallery').nth(1).getByText('待确认', { exact: true }).count());
  await page.screenshot({ path: 'artifacts/knowledge-filter-gallery.png', fullPage: true });
  await page.locator('.frame-gallery').nth(1).getByRole('button', { name: '保留这张画面', exact: true }).first().click();
  await page.waitForFunction(() => document.querySelector('.frame-gallery')?.querySelectorAll('img').length === 3);
  report.filterAndUncertainSeparate = true; report.manualRestore = true;
  assert.equal(await page.locator('img.brand-mark').evaluate(img => img.naturalWidth), 128);
  report.suppliedBrandIcon = true; report.passed = true;
  console.log(JSON.stringify(report));
} catch (error) { report.error = error.message; throw error; }
finally { fs.writeFileSync('artifacts/knowledge-ui-check.json', JSON.stringify(report,null,2)); await browser.close(); await new Promise(resolve => server.close(resolve)); }
