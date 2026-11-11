// 真实公开视频画面 + 当前配置的真实 V4.1 Flash；结论落独立测试库和可复核报告。
import fs from 'node:fs';
import path from 'node:path';
import 'fake-indexeddb/auto';
import { createServer } from 'vite';
globalThis.chrome = { runtime: { sendMessage: async () => ({ ok: true }) } };
const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, resolve: { alias: { '@': path.resolve('src') } } });
try {
  const { MemoryDB, setDbForTests, saveSettings, getSettings } = await vite.ssrLoadModule('/src/db/db.ts');
  const { reviewKnowledgeFrames, isKnowledgeFrame } = await vite.ssrLoadModule('/src/agent/knowledge-frames.ts');
  for (const code of process.argv.slice(2).length ? process.argv.slice(2) : ['BV1G7jJ6nEbV', 'BV1hvi1YVE2Z', 'BV1ge4y1V7RS']) {
    const folder = path.resolve('artifacts/keyframe-audit', code), comparison = JSON.parse(fs.readFileSync(path.join(folder, 'comparison.json'), 'utf8'));
    const output = path.join(folder, 'knowledge-review.json');
    const previous = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')).frames ?? [] : [];
    const db = new MemoryDB(`review-${code}-${Date.now()}`); setDbForTests(db); await db.open();
    await saveSettings({ preferredQaRoute: 'local-agent', localAgent: { backend: 'opencode-go', model: 'deepseek-v4.1-flash', token: fs.readFileSync('.local-agent/token', 'utf8').trim() }, privacy: { ...(await getSettings()).privacy, allowVisionUpload: true } });
    await db.videos.put({ id: code, title: comparison.source, recordedRanges: [[0, comparison.duration]], duration: comparison.duration, createdAt: 1, updatedAt: 1 });
    await db.keyframes.bulkPut(comparison.after.map((frame, index) => ({ id: `${code}-${index}`, videoId: code, sessionId: 'audit', time: frame.actualImageTime, image: new Blob([fs.readFileSync(path.join(folder, 'full', `${Math.round(frame.actualImageTime / 2.5)}.jpg`))], { type: 'image/jpeg' }), width: comparison.originalResolution?.[0] ?? 1280, height: comparison.originalResolution?.[1] ?? 720, uploadAllowed: false, fingerprint: `sample-${frame.actualImageTime}`, reason: 'auto-change', selectionReason: frame.reason, evidenceIds: [], capturedAt: index + 1, captureEpoch: 1, knowledge: previous.find(row => row.time === frame.actualImageTime)?.knowledge })));
    const save = async () => {
      const frames = (await db.keyframes.toArray()).sort((a,b) => a.time-b.time).map(frame => ({ id: frame.id, time: frame.time, full: `full/${Math.round(frame.time / 2.5)}.jpg`, kept: isKnowledgeFrame(frame), knowledge: frame.knowledge }));
      const usage = await db.usage.toArray();
      fs.writeFileSync(output, JSON.stringify({ at: new Date().toISOString(), code, title: comparison.source, model: 'deepseek-v4.1-flash', realModel: true, captionInput: false, completed: frames.every(frame => frame.knowledge), frames, usage: usage.map(({ inputTokens, outputTokens, images, calls }) => ({ inputTokens, outputTokens, images, calls })) }, null, 2));
    };
    try { await reviewKnowledgeFrames(code, AbortSignal.timeout(1800000), message => { console.log(code, message); void save(); }); }
    finally { await save(); }
    console.log(JSON.stringify({ code, reviewed: (await db.keyframes.toArray()).filter(f => f.knowledge).length, output }));
    await db.delete(); setDbForTests(null);
  }
} finally { await vite.close(); }
