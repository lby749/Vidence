// 真实本地H264视频的无界面UI记录；原生桥接用测试适配器，不冒充Qt实窗验收。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';
import { installTestResources } from './test-model-resources.mjs';

const assets = path.resolve('.output/chrome-mv3'), movie = process.env.E2E_VIDEO ?? 'D:/Desktop/梵高_介绍.mp4';
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://fixture');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Access-Control-Allow-Origin', '*');
  if (url.pathname === '/qwebchannel.js') { response.setHeader('Content-Type', 'text/javascript'); response.end('window.QWebChannel=function(_,ready){ready({objects:{native:window.qaNative}})}'); return; }
  if (url.pathname === '/movie.mp4') {
    const size = fs.statSync(movie).size, range = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? '');
    const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
    response.writeHead(range ? 206 : 200, { 'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
    const stream = fs.createReadStream(movie, { start, end }); response.on('close', () => stream.destroy()); stream.pipe(response); return;
  }
  const file = path.resolve(assets, '.' + url.pathname);
  if (!file.startsWith(assets + path.sep) || !fs.existsSync(file)) { response.writeHead(404).end(); return; }
  response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : file.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
  fs.createReadStream(file).pipe(response);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: process.env.E2E_BROWSER ?? 'msedge', headless: true, args: ['--disable-gpu'] });
const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });
const noOcr = process.argv.includes('--no-ocr');
const report = { noOcr, scope: 'headless-desktop-ui-with-h264-and-test-native-bridge', media: process.env.E2E_VIDEO ? 'external-test-fixture' : 'local-original', nativeQtPlaybackClaim: false };
try {
  await page.addInitScript(base => {
    const source = { id: 'real-keyframe-ui', title: '本地视频画面验收', url: 'vma-local://video/real-keyframe-ui', kind: 'local' };
    const state = { attached: true, docked: true, collapsed: false, fullscreen: false };
    const reply = (callback, value) => callback(JSON.stringify(value));
    window.qt = { webChannelTransport: {} };
    window.qaNative = {
      bootstrap: callback => reply(callback, {}), currentSource: callback => reply(callback, source), presentationState: callback => reply(callback, state),
      windows: callback => reply(callback, []), browsers: callback => reply(callback, []),
      restoreWindow: callback => { state.attached = false; reply(callback, state); },
      stopCapture: callback => { window.fixtureVideo?.pause(); reply(callback, {}); },
      media: (action, value, callback) => { const video = window.fixtureVideo; if (action === 'play') void video.play(); if (action === 'pause') video.pause(); reply(callback, {}); },
      keyframe: (maxWidth, callback) => {
        const video = window.fixtureVideo, canvas = document.createElement('canvas'); canvas.width = Math.min(maxWidth, video.videoWidth); canvas.height = Math.round(video.videoHeight * canvas.width / video.videoWidth); canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        reply(callback, { dataUrl: canvas.toDataURL('image/jpeg', 0.94), width: canvas.width, height: canvas.height, mediaTime: video.currentTime, capturedAt: Date.now(), origin: 'canvas', sourceId: source.id });
      },
      frame: callback => {
        const video = window.fixtureVideo, image = {};
        if (video?.readyState >= 2) { const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720; canvas.getContext('2d').drawImage(video, 0, 0, 1280, 720); image.dataUrl = canvas.toDataURL('image/jpeg', 0.86); }
        reply(callback, { ...image, time: video?.currentTime ?? 0, duration: 365, capturedAt: Date.now(), playing: video ? !video.paused : false, sourceId: source.id });
      },
    };
    addEventListener('DOMContentLoaded', () => { const video = document.createElement('video'); video.muted = true; video.hidden = true; video.src = base + '/movie.mp4'; video.preload = 'auto'; video.addEventListener('loadedmetadata', () => { video.currentTime = 60; }); document.body.append(video); window.fixtureVideo = video; });
  }, base);
  await page.goto(base + '/desktop.html');
  await page.waitForFunction(() => window.fixtureVideo?.readyState >= 2 && window.fixtureVideo.currentTime >= 60);
  await page.getByRole('button', { name: '打开视频库', exact: true }).click();
  if (!noOcr) await installTestResources(page, false, '低占用');
  await page.getByRole('button', { name: '添加视频', exact: true }).click();
  await page.getByRole('button', { name: '开始记录', exact: true }).click();
  let saved = 0;
  for (let attempt = 0; attempt < 25; attempt++) {
    saved = await page.evaluate(() => new Promise(resolve => { const open = indexedDB.open('video-memory-assistant'); open.onsuccess = () => { const db = open.result; const read = db.transaction('keyframes').objectStore('keyframes').count(); read.onsuccess = () => { db.close(); resolve(read.result); }; }; }));
    if (saved > 0) break;
    await page.waitForTimeout(1500);
  }
  assert.ok(saved > 0, '桌面记录应真正保存画面，而非只显示正在记录');
  await page.getByRole('button', { name: '结束并保存', exact: true }).click();
  assert.equal(await page.evaluate(() => window.fixtureVideo.paused), true);
  await page.getByRole('button', { name: '打开视频库', exact: true }).click();
  await page.getByRole('button', { name: /^原文与节点/ }).click();
  const gallery = page.locator('.frame-gallery'); await gallery.waitFor(); await gallery.locator('summary').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.frame-gallery img')].some(image => image.naturalWidth === 1920));
  await page.screenshot({ path: 'artifacts/desktop-keyframe-gallery.png', fullPage: true });
  report.savedFrames = await page.evaluate(() => new Promise(resolve => { const open = indexedDB.open('video-memory-assistant'); open.onsuccess = () => { const db = open.result; const read = db.transaction('keyframes').objectStore('keyframes').getAll(); read.onsuccess = () => { db.close(); resolve(read.result.map(frame => ({ videoId: frame.videoId, time: frame.time, width: frame.width, bytes: frame.image.size, uploadAllowed: frame.uploadAllowed }))); }; }; }));
  assert.ok(report.savedFrames.every(frame => frame.videoId === 'real-keyframe-ui' && frame.time >= 60 && frame.time < 105 && frame.bytes > 1000 && !frame.uploadAllowed));
  report.evidenceCount = await page.evaluate(() => new Promise(resolve => { const open = indexedDB.open('video-memory-assistant'); open.onsuccess = () => { const db = open.result; const count = db.transaction('evidence').objectStore('evidence').count(); count.onsuccess = () => { db.close(); resolve(count.result); }; }; }));
  if (noOcr) assert.equal(report.evidenceCount, 0);
  report.galleryVisible = true; report.videoPausedAfterTest = true; report.passed = true;
  console.log('DESKTOP_KEYFRAMES_PASS', JSON.stringify(report));
} catch (error) { report.passed = false; report.error = error.message; await page.screenshot({ path: 'artifacts/desktop-keyframe-failure.png', fullPage: true }); throw error; }
finally { fs.writeFileSync(noOcr ? 'artifacts/desktop-keyframes-no-ocr.json' : 'artifacts/desktop-keyframes-check.json', JSON.stringify(report, null, 2)); await browser.close(); await new Promise(resolve => server.close(resolve)); }
