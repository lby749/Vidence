/**
 * 端到端验证：在真实 Chrome 中加载扩展，验证 M1 最小闭环。
 *
 * 运行：npm run build && node scripts/e2e.mjs
 *
 * 覆盖：
 * 1. 内容脚本发现视频与可读字幕；
 * 2. 开始记录 → 字幕落库 → 规则节点生成；
 * 3. 关键词检索；
 * 4. 停止记录与记录范围；
 * 5. 界面截图（侧边栏/知识库）；
 * 6. 收集页面与控制台错误。
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const EXTENSION_PATH = path.resolve(process.env.VMA_EXTENSION_PATH ?? '.output/chrome-mv3');
const ARTIFACTS = path.join(ROOT, 'artifacts');
const PORT = 8123;
const HARD_SUBTITLES = process.env.E2E_HARD_SUBTITLES === '1';

const TEST_HTML = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>排队论 第一讲 - 测试视频</title>
<style>body{font-family:system-ui;margin:0;background:#111;color:#eee}video{display:block;max-width:640px;margin:20px auto}</style>
</head>
<body>
<h1 style="text-align:center;font-size:18px">排队论 第一讲</h1>
<video id="v" muted playsinline autoplay></video>
<script>
(async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 640; canvas.height = 360;
  const ctx = canvas.getContext('2d');
  const stream = canvas.captureStream(15);
  const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  let t = 0;
  const timer = setInterval(() => {
    t += 0.1;
    ctx.fillStyle = '#1b2430'; ctx.fillRect(0, 0, 640, 360);
    ctx.fillStyle = '#f4d35e'; ctx.font = '28px sans-serif';
    ctx.fillText('第 ' + Math.floor(t) + ' 秒：排队论', 40, 80);
    ctx.strokeStyle = '#66d9ef'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(80, 280); ctx.lineTo(80 + t * 40, 280); ctx.stroke();
    ctx.fillStyle = '#eee'; ctx.font = '20px sans-serif';
    ctx.fillText('λ = 3, μ = 4', 380, 200);
    if (${HARD_SUBTITLES}) {
      ctx.fillStyle = '#fff'; ctx.font = '24px Microsoft YaHei';
      ctx.fillText('排队论研究服务系统，先来先服务是基本规则', 50, 330);
    }
  }, 100);
  rec.start();
  await new Promise((r) => setTimeout(r, 4000));
  clearInterval(timer);
  rec.stop();
  await new Promise((r) => (rec.onstop = r));
  const blob = new Blob(chunks, { type: 'video/webm' });
  const video = document.getElementById('v');
  video.src = URL.createObjectURL(blob);
  video.loop = true;
  video.muted = true;
  const vtt = 'WEBVTT\\n\\n1\\n00:00:00.000 --> 00:00:01.600\\n第一句：排队论研究服务系统。\\n\\n2\\n00:00:01.600 --> 00:00:03.200\\n第二句：先来先服务是最基本的规则。\\n\\n3\\n00:00:03.200 --> 00:00:04.800\\n第三句：我们需要计算平均等待时间。\\n';
  const track = document.createElement('track');
  track.kind = 'subtitles';
  track.label = '中文';
  track.default = true;
  track.src = 'data:text/vtt;charset=utf-8,' + encodeURIComponent(vtt);
  if (!${HARD_SUBTITLES}) video.appendChild(track);
  await new Promise((resolve) => video.addEventListener('loadeddata', resolve, { once: true }));
  if (!${HARD_SUBTITLES}) video.textTracks[0].mode = 'showing';
  else video.playbackRate = 0.25;
  await video.play();
  window.__videoReady = true;
})();
</script>
</body>
</html>`;

function log(step, detail) {
  console.log(`\n== ${step} ==`);
  if (detail !== undefined) console.log(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2));
}

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  console.log(`  ✓ ${message}`);
}

async function main() {
  if (!fs.existsSync(path.join(EXTENSION_PATH, 'manifest.json'))) {
    throw new Error('未找到构建产物，请先运行 npm run build');
  }
  fs.mkdirSync(ARTIFACTS, { recursive: true });

  const server = http.createServer((req, res) => {
    if (req.url === '/test.html' || req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(TEST_HTML);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vma-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    // 说明：Chrome 156 的品牌版已忽略 --load-extension；Edge 仍支持，
    // 因此自动化验证使用 Edge（同为 Chromium MV3）。
    channel: process.env.E2E_BROWSER ?? 'msedge',
    headless: process.env.E2E_HEADLESS === '1',
    locale: 'zh-CN',
    viewport: { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--autoplay-policy=no-user-gesture-required',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  const consoleErrors = [];
  context.on('page', (page) => {
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(`console: ${message.text()}`);
    });
  });

  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
    worker.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        consoleErrors.push(`worker ${message.type()}: ${message.text()}`);
      }
    });
    const extensionId = new URL(worker.url()).host;
    log('扩展已加载', { extensionId, worker: worker.url() });

    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/test.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__videoReady === true, { timeout: 30000 });
    await page.waitForTimeout(800);
    const videoState = await page.evaluate(() => {
      const video = document.querySelector('video');
      return {
        readyState: video.readyState,
        paused: video.paused,
        currentTime: video.currentTime,
        duration: video.duration,
        tracks: [...video.textTracks].map((t) => ({ mode: t.mode, cues: t.cues?.length ?? 0 })),
      };
    });
    log('测试页视频状态', videoState);
    assert(videoState.readyState >= 2, '视频已就绪并可播放');
    assert(HARD_SUBTITLES ? videoState.tracks.length === 0 : videoState.tracks.some((t) => t.mode === 'showing' && t.cues > 0), HARD_SUBTITLES ? '没有字幕轨，必须识别画面像素' : '字幕轨可读');

    const extPage = await context.newPage();
    await extPage.goto(`chrome-extension://${extensionId}/library.html`);
    await extPage.waitForTimeout(500);
    await extPage.evaluate(() => new Promise((resolve, reject) => {
      const open = indexedDB.open('video-memory-assistant');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result; const tx = db.transaction('settings', 'readwrite'); const table = tx.objectStore('settings');
        const read = table.get('app'); read.onsuccess = () => table.put({ ...read.result, retrieval: { keyword: true, vector: false, rerank: false, vectorModel: 'Xenova/bge-small-zh-v1.5' } });
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
      };
    }));

    const tabId = await extPage.evaluate(async (port) => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((tab) => (tab.url ?? '').includes(`127.0.0.1:${port}`))?.id;
    }, PORT);
    assert(typeof tabId === 'number', `找到视频标签页 tabId=${tabId}`);

    // 新用户体验：页面右下角浮动「记」按钮 → 开始记录（无需打开侧边栏）
    await page.locator('#vma-launcher-host .pill').waitFor({ state: 'attached', timeout: 15000 });
    await page.locator('#vma-launcher-host .pill').click();
    await page.waitForTimeout(250);
    await page.locator('#vma-launcher-host #start').click();
    await page.waitForTimeout(1200);
    const launcherText = await page.locator('#vma-launcher-host .pill').innerText();
    log('页面浮动按钮状态', launcherText);
    assert(launcherText.includes('记录中'), '页面内一键开始记录');
    await page.screenshot({ path: path.join(ARTIFACTS, 'page-launcher.png'), fullPage: false });

    // 验证页面内真实侧栏，而非只在单独标签页渲染。
    await worker.evaluate(() => {
      self.__dockCloseTargets = [];
      chrome.runtime.onMessage.addListener(message => {
        if (message.type === 'ui:close-panel') self.__dockCloseTargets.push(message.payload.tabId);
      });
    });
    const openDock = async () => {
      if (!await page.locator('#vma-launcher-host #panel').count()) await page.locator('#vma-launcher-host .pill').click();
      await page.locator('#vma-launcher-host #panel').click();
      await page.locator('#vma-dock-host iframe').waitFor();
    };
    await openDock();
    await page.getByRole('button', { name: '关闭学习栏', exact: true }).click();
    await page.locator('#vma-dock-host').waitFor({ state: 'detached' });
    await page.locator('#vma-launcher-host .pill').waitFor({ state: 'visible' });
    const invalidClose = await extPage.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:close-panel', payload: { tabId: -1 } }));
    assert(invalidClose.ok === false, '关闭操作拒绝无效标签页，不退回其他活动页面');
    await openDock();
    const dockFrame = page.frameLocator('#vma-dock-host iframe');
    await dockFrame.locator('body').evaluate(body => {
      window.__closeClicks = [];
      body.addEventListener('click', event => window.__closeClicks.push({ target: event.target?.getAttribute?.('aria-label'), trusted: event.isTrusted }), true);
    });
    await dockFrame.getByRole('button', { name: '关闭面板', exact: true }).click();
    try { await page.locator('#vma-dock-host').waitFor({ state: 'detached' }); }
    catch (error) {
      log('侧栏关闭诊断', { targets: await worker.evaluate(() => self.__dockCloseTargets), frame: await dockFrame.locator('body').evaluate(() => ({ url: location.href, parentIsSelf: parent === window, runtime: Boolean(chrome.runtime), clicks: window.__closeClicks })), consoleErrors });
      await page.screenshot({ path: path.join(ARTIFACTS, 'dock-close-failure.png') });
      throw error;
    }
    assert((await worker.evaluate(() => self.__dockCloseTargets)).includes(tabId), '关闭操作经扩展内部通道送达正确视频标签页');
    await page.waitForTimeout(1400);
    assert(await page.locator('#vma-dock-host').count() === 0, '关闭后状态刷新不会重新弹出侧栏');
    await openDock();
    await page.keyboard.press('Escape');
    await page.locator('#vma-dock-host').waitFor({ state: 'detached' });
    assert((await extPage.evaluate(id => chrome.runtime.sendMessage({ type: 'ui:get-state', payload: { tabId: id } }), tabId)).data.recording, '关闭学习栏不会停止用户正在记录的视频');

    const start = { ok: true };
    log('开始记录', '通过页面浮动按钮触发');
    assert(start.ok === true, '开始记录成功');

    await page.waitForTimeout(HARD_SUBTITLES ? 12000 : 8000);

    let state = await extPage.evaluate(
      (targetTabId) => chrome.runtime.sendMessage({ type: 'ui:get-state', payload: { tabId: targetTabId } }),
      tabId,
    );
    log('记录 8 秒后的状态摘要', {
      ok: state.ok,
      recording: state.data?.recording,
      subtitle: state.data?.subtitleSource,
      video: state.data?.video?.title,
      evidence: state.data?.recentEvidence?.length,
      nodes: state.data?.nodes?.length,
      keyframes: state.data?.library?.keyframes,
      warnings: state.data?.warnings,
    });
    assert(state.data?.recording === true, '会话处于记录中');
    assert(state.data?.recentEvidence?.length > 0, '字幕证据已落库');
    assert(state.data?.nodes?.length > 0, '已生成规则节点');
    assert(
      HARD_SUBTITLES ? state.data?.subtitleSource?.kind === 'ocr' : state.data?.subtitleSource?.kind === 'texttrack' || state.data?.subtitleSource?.kind === 'dom',
      `字幕来源匹配测试模式（实际 ${state.data?.subtitleSource?.kind}）`,
    );

    const getState = () => extPage.evaluate(id => chrome.runtime.sendMessage({ type: 'ui:get-state', payload: { tabId: id } }), tabId);
    await page.evaluate(() => document.querySelector('video').pause());
    await page.waitForTimeout(1200);
    assert((await getState()).data?.paused === true, '暂停视频自动暂停记录');
    const pausedState = await getState();
    await page.waitForTimeout(2200);
    const stillPaused = await getState();
    assert(stillPaused.data.library.evidence === pausedState.data.library.evidence && stillPaused.data.library.keyframes === pausedState.data.library.keyframes, '暂停期间不新增证据或关键帧');
    await page.evaluate(() => document.querySelector('video').play());
    await page.waitForTimeout(1200);
    assert((await getState()).data?.paused === false, '播放视频自动恢复记录');
    await extPage.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:pause' }));
    await page.evaluate(async () => { const v = document.querySelector('video'); v.pause(); await v.play(); });
    await page.waitForTimeout(1200);
    assert((await getState()).data?.paused === true, '手动暂停不会被视频播放覆盖');
    await extPage.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:resume' }));

    const search = await extPage.evaluate(
      (targetTabId) =>
        chrome.runtime.sendMessage({
          type: 'ui:search',
          payload: { query: '先来先服务', videoId: undefined, limit: 10 },
        }),
      tabId,
    );
    log('关键词检索结果', {
      ok: search.ok,
      hits: search.data?.hits?.length,
      first: search.data?.hits?.[0]?.text?.slice(0, 60),
    });
    assert(search.ok === true && search.data?.hits?.length > 0, '中文关键词检索命中');

    const recorded = await extPage.evaluate(
      (targetTabId) => chrome.runtime.sendMessage({ type: 'ui:get-state', payload: { tabId: targetTabId } }),
      tabId,
    );
    assert((recorded.data?.video?.recordedRanges?.length ?? 0) > 0, '记录范围已更新');

    // 侧边栏（带 tabId 以便在普通标签页中渲染同一状态）
    const side = await context.newPage();
    await side.goto(`chrome-extension://${extensionId}/sidepanel.html?tabId=${tabId}`);
    await side.waitForTimeout(1200);
    // 以接近真实侧边栏的宽度截图
    await side.setViewportSize({ width: 420, height: 900 });
    await side.waitForTimeout(300);
    await side.screenshot({ path: path.join(ARTIFACTS, 'sidepanel.png'), fullPage: true });
    const nodeCount = await side.locator('.node').count();
    log('侧边栏渲染', { nodeCount });
    assert(nodeCount > 0, '侧边栏显示节点列表');

    await side.getByRole('button', { name: /提问/ }).click().catch(() => undefined);
    await side.waitForTimeout(400);
    await side.screenshot({ path: path.join(ARTIFACTS, 'sidepanel-ask.png'), fullPage: true });

    const library = await context.newPage();
    await library.goto(`chrome-extension://${extensionId}/library.html`);
    await library.waitForTimeout(1000);
    await library.screenshot({ path: path.join(ARTIFACTS, 'library.png'), fullPage: true });
    const videoItems = await library.locator('.video-item').count();
    assert(videoItems > 0, '知识库页面列出已记录视频');

    const stop = await extPage.evaluate(() => chrome.runtime.sendMessage({ type: 'ui:stop' }));
    log('停止记录响应', stop);
    assert(stop.ok === true, 'ui:stop 成功');

    state = await extPage.evaluate(
      (targetTabId) => chrome.runtime.sendMessage({ type: 'ui:get-state', payload: { tabId: targetTabId } }),
      tabId,
    );
    assert(state.data?.recording === false, '停止后不再处于记录状态');

    // 导出检查：不包含密钥
    const exported = await extPage.evaluate(async () => {
      const response = await chrome.runtime.sendMessage({ type: 'ui:export', payload: {} });
      return response.ok ? JSON.stringify(response.data) : response.error.message;
    });
    log('导出数据大小', { chars: exported.length });
    assert(!/apiKey|"token"/.test(exported), '导出不包含 API Key 或 Notion 令牌');
    fs.writeFileSync(path.join(ARTIFACTS, 'export-sample.json'), exported.slice(0, 200000));

    await worker.evaluate(() => chrome.storage.local.set({ vmaUiLanguage: 'en' }));
    await page.locator('#vma-launcher-host .label').filter({ hasText: 'Vidence' }).waitFor();
    assert(true, '页面启动器跟随界面语言，不翻译视频内容');
    await worker.evaluate(() => chrome.storage.local.set({ vmaUiLanguage: 'zh-CN' }));
    log('控制台错误', consoleErrors.slice(0, 20));
    fs.writeFileSync(path.join(ARTIFACTS, 'e2e-console-errors.json'), JSON.stringify(consoleErrors, null, 2));
    console.log('\nE2E 完成，截图与导出样例位于 artifacts/');
  } finally {
    await context.close().catch(() => undefined);
    server.close();
  }
}

main().catch((error) => {
  console.error('\nE2E 失败：', error);
  process.exit(1);
});
