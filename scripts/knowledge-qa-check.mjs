// 真模型、真像素；独立内存数据库，不读取用户课程/聊天。
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { createServer } from 'vite';

globalThis.chrome = { runtime: { sendMessage: async () => ({ ok: true }) } };
const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, resolve: { alias: { '@': path.resolve('src') } } });
const report = { at: new Date().toISOString(), model: 'deepseek-v4.1-flash', realModel: true, captionsProvided: false, cases: [] };
try {
  const { MemoryDB, setDbForTests, saveSettings, getSettings } = await vite.ssrLoadModule('/src/db/db.ts');
  const { prepareQueryContext } = await vite.ssrLoadModule('/src/agent/question-agent.ts');
  const { askLocalAgent } = await vite.ssrLoadModule('/src/agent/local-agent.ts');
  const db = new MemoryDB(`knowledge-qa-${Date.now()}`); setDbForTests(db); await db.open();
  await saveSettings({ preferredQaRoute: 'local-agent', localAgent: { backend: 'opencode-go', model: report.model, token: fs.readFileSync('.local-agent/token', 'utf8').trim() }, privacy: { ...(await getSettings()).privacy, allowVisionUpload: true } });
  const video = { id: 'pixel-only', title: '测试片段', duration: 600, recordedRanges: [[0, 600]], lastPosition: 324, url: '', platform: 'test', createdAt: 1, updatedAt: 1 };
  await db.videos.put(video);
  const question = '只根据本次实际读取的图片，描述主要图示，并逐字写出右侧等式或表格前两行的文字。没有图片就说明无法读取，不用常识猜测。请引用对应画面。';
  for (const item of [
    { name: 'math-image', allowImages: true, image: 'artifacts/bili-actual-keyframe.jpg' },
    { name: 'no-image', allowImages: false, image: 'artifacts/bili-actual-keyframe.jpg' },
    { name: 'swapped-excel-image', allowImages: true, image: 'artifacts/keyframe-audit/BV1ge4y1V7RS/full/68.jpg' },
  ]) {
    await db.keyframes.clear();
    await db.keyframes.put({ id: 'pixel-frame', videoId: video.id, sessionId: 'test', time: 324, image: new Blob([fs.readFileSync(item.image)], { type: 'image/jpeg' }), width: 1280, height: 720, uploadAllowed: false, fingerprint: item.name, reason: 'auto-change', evidenceIds: [], capturedAt: 1, captureEpoch: 1 });
    const prepared = await prepareQueryContext({ requestId: item.name, videoId: video.id, question, frozenTime: 324, selectedNodeIds: [], allowImages: item.allowImages, route: 'local-agent' });
    const result = await askLocalAgent({ ...prepared, externalSignal: AbortSignal.timeout(180000), callbacks: { onStatus: (status, detail) => console.log(item.name, status, detail ?? '') } });
    const passed = item.name === 'math-image' ? /65/.test(result.answer) && /13/.test(result.answer) && result.usage.imageUploads === 1 && result.citations.some(c => c.source === 'visual') : item.name === 'no-image' ? result.usage.imageUploads === 0 && !/65|红楼梦/.test(result.answer) : /红楼梦/.test(result.answer) && /西游记/.test(result.answer) && !/65/.test(result.answer) && result.usage.imageUploads === 1;
    report.cases.push({ name: item.name, answer: result.answer, citations: result.citations, usage: result.usage, passed });
    fs.writeFileSync('artifacts/knowledge-qa-check.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ name: item.name, passed, images: result.usage.imageUploads, answer: result.answer }));
    assert.ok(passed, `${item.name}: 图片内容/引用或对照未通过`);
  }
  report.passed = true;
  fs.writeFileSync('artifacts/knowledge-qa-check.json', JSON.stringify(report, null, 2));
  await db.delete(); setDbForTests(null);
} finally { await vite.close(); }
