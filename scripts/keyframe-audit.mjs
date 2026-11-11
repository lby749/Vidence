// 实际MP4解码帧重放到新旧保存链路；不使用账号、不操作正在运行的应用。
import fs from 'node:fs';
import path from 'node:path';
import 'fake-indexeddb/auto';
import { createServer } from 'vite';

const root = process.cwd(), folder = path.join(root, 'artifacts/keyframe-audit', process.argv[2] ?? '');
const source = process.argv[2] ? JSON.parse(fs.readFileSync(path.join(folder, 'source.json'), 'utf8')) : { title: '梵高_介绍.mp4', duration: 365 };
const width = 320, height = 180, bytes = width * height * 4, raw = fs.readFileSync(path.join(folder, process.argv[2] ? 'samples.rgba' : 'art.rgba'));
let clock = 1_000_000, currentFrame;
globalThis.chrome = { tabs: { sendMessage: async () => currentFrame }, storage: { session: { get: async () => ({}), set: async () => {} } }, runtime: { sendMessage: async () => ({ ok: true }) } };
const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, resolve: { alias: { '@': path.join(root, 'src') } } });
const originalNow = Date.now;
const originalUuid = crypto.randomUUID;
let seed = 2077541;
crypto.randomUUID = () => 'xxxxxxxx-xxxx-4xxx-axxx-xxxxxxxxxxxx'.replace(/x/g, () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0 & 15).toString(16); });
try {
  const { MemoryDB, setDbForTests } = await vite.ssrLoadModule('/src/db/db.ts');
  const { DEFAULT_SETTINGS } = await vite.ssrLoadModule('/src/shared/constants.ts');
  const report = { scope: 'real-video-decoded-frame-replay', source: source.title, bvid: source.bvid, duration: source.duration, originalResolution: source.originalResolution, sampleIntervalSeconds: 2.5, samples: raw.length / bytes, before: [], after: [] };
  for (const version of ['before', 'after']) {
    seed = 2077541;
    const visual = await vite.ssrLoadModule(version === 'before' ? '/artifacts/keyframe-audit/visual-before.ts' : '/src/pipeline/visual.ts');
    const service = await vite.ssrLoadModule(version === 'before' ? '/artifacts/keyframe-audit/service-before.ts' : '/src/background/visual-service.ts');
    const db = new MemoryDB(`audit-${version}-${originalNow()}`); setDbForTests(db); await db.open();
    if (version === 'before') await db.settings.put({ ...DEFAULT_SETTINGS, capture: { ...DEFAULT_SETTINGS.capture, keyframeCooldownMs: 8000, keyframePolicyVersion: 2 }, updatedAt: 1 });
    await db.sessions.put({ id: `audit-${version}`, videoId: 'real-art-video', status: 'recording', captureEpoch: 1 });
    const session = { sessionId: `audit-${version}`, videoId: 'real-art-video', epoch: 1, paused: false };
    Date.now = () => clock;
    for (let index = 0; index < raw.length / bytes; index++) {
      clock = 1_000_000 + index * 2500;
      const sig = visual.signatureFromImageData(raw.subarray(index * bytes, (index + 1) * bytes), width, height);
      currentFrame = { dataUrl: `data:image/jpeg;base64,${fs.readFileSync(path.join(folder, 'source', `${String(index).padStart(3, '0')}.jpg`)).toString('base64')}`, width, height, mediaTime: index * 2.5, capturedAt: clock, origin: 'canvas', ...(version === 'after' ? { signature: sig } : {}) };
      await service.handleSignature(session, { ...sig, sessionId: session.sessionId, epoch: 1, time: index * 2.5, duration: source.duration, ...(version === 'after' ? { frame: currentFrame } : {}) });
    }
    const frames = await db.keyframes.toArray();
    report[version] = frames.sort((a, b) => a.capturedAt - b.capturedAt).map(frame => ({ time: frame.time, actualImageTime: (frame.capturedAt - 1_000_000) / 1000, image: `source/${String(Math.round((frame.capturedAt - 1_000_000) / 2500)).padStart(3, '0')}.jpg`, reason: frame.selectionReason ?? frame.reason }));
    service.resetVisualState(session.sessionId); await db.delete(); setDbForTests(null);
  }
  fs.writeFileSync(path.join(folder, 'comparison.json'), JSON.stringify(report, null, 2));
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const gallery = frames => frames.map(frame => `<figure><a href="full/${Math.round(frame.actualImageTime / 2.5)}.jpg" target="_blank"><img loading="lazy" src="${frame.image}"></a><figcaption>画面 ${frame.actualImageTime.toFixed(1)}s · 引用 ${frame.time.toFixed(1)}s<br>${escape(frame.reason)}</figcaption></figure>`).join('');
  fs.writeFileSync(path.join(folder, 'comparison.html'), `<!doctype html><meta charset="utf-8"><title>关键画面实测</title><style>body{font:16px system-ui;background:#f5f5f7;color:#1d1d1f;max-width:1400px;margin:40px auto;padding:20px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:18px}figure{margin:0;background:white;padding:12px;border-radius:14px}img{width:100%}figcaption{font-size:13px;color:#555;margin-top:10px}</style><h1>关键画面前后对照</h1><p>${escape(source.title)} · ${source.duration}秒。按每2.5秒的实际解码帧重放完整保存链路；不是实窗播放证明，也不是知识点准确率。点击图片看原始清晰度。</p><h2>修正前 · ${report.before.length}张</h2><div class="grid">${gallery(report.before)}</div><h2>修正后 · ${report.after.length}张</h2><div class="grid">${gallery(report.after)}</div>`);
  console.log(JSON.stringify({ before: report.before.length, after: report.after.length, afterTimes: report.after.map(frame => frame.time), comparison: path.relative(root, path.join(folder, 'comparison.html')) }));
} finally { Date.now = originalNow; crypto.randomUUID = originalUuid; await vite.close(); }
