import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getSettings, MemoryDB, setDbForTests } from '@/db/db';
import { handleSignature, resetVisualState } from '@/background/visual-service';
import { requestCanvasFrame } from '@/background/capture-client';
import type { ActiveSession } from '@/background/session-store';

vi.mock('@/background/capture-client', () => ({ requestCanvasFrame: vi.fn() }));
vi.mock('@/background/index-service', () => ({ markIndexDirty: vi.fn() }));
let db: MemoryDB, now: number;
const active = { sessionId: 'frame-session', videoId: 'video-a', epoch: 1, paused: false } as ActiveSession;
const pattern = (): number[] => Array.from({ length: 96 }, (_, index) => index % 2 ? 200 : 40);
const frame = { dataUrl: 'data:image/png;base64,iVBORw0KGgo=', width: 1280, height: 720, origin: 'canvas' as const, capturedAt: 100, mediaTime: 13 };
async function feed(cells: number[], elapsed: number, epoch = 1) {
  now = 100_000 + elapsed;
  await handleSignature(active, { sessionId: active.sessionId, epoch, time: elapsed / 1000, cols: 12, rows: 8, width: 320, height: 180, cells });
}
beforeEach(async () => {
  now = 100_000; vi.spyOn(Date, 'now').mockImplementation(() => now);
  db = new MemoryDB(`frames-${Math.random()}`); setDbForTests(db); await db.open();
  await db.sessions.put({ id: active.sessionId, videoId: active.videoId, status: 'recording', captureEpoch: 1 } as never);
  vi.mocked(requestCanvasFrame).mockResolvedValue({ frame });
});
afterEach(async () => { resetVisualState(active.sessionId); vi.restoreAllMocks(); await db.delete(); setDbForTests(null); });

it('黑屏和无内容白屏不作为记录起点保存', async () => {
  await feed(new Array(96).fill(0), 0); await feed(new Array(96).fill(0), 2500);
  await feed(new Array(96).fill(255), 5000); await feed(new Array(96).fill(255), 7500);
  expect(await db.keyframes.count()).toBe(0);
});
it('起点也必须稳定，不能等两秒就截转场', async () => {
  await feed(pattern(), 0); await feed(pattern().map(value => 255 - value), 2500);
  expect(await db.keyframes.count()).toBe(0);
});
it('局部公式变化通过保存门限后不再被全图平均去重吞掉', async () => {
  const base = pattern(), changed = pattern(); changed[30] = 150;
  await feed(base, 0); await feed(base, 2500); await feed(changed, 11000); await feed(changed, 13500);
  expect(await db.keyframes.count()).toBe(2);
});
it('引用时间来自真正截图时刻', async () => {
  await feed(pattern(), 0); await feed(pattern(), 2500);
  expect((await db.keyframes.toArray())[0].time).toBe(13);
});
it('已停止或不同代次的任务不能迟到落库', async () => {
  await feed(pattern(), 0); await db.sessions.update(active.sessionId, { status: 'stopped' });
  await feed(pattern(), 2500); expect(await db.keyframes.count()).toBe(0);
  await db.sessions.update(active.sessionId, { status: 'recording', captureEpoch: 2 });
  await feed(pattern(), 5000); await feed(pattern(), 7500, 2);
  expect(await db.keyframes.count()).toBe(0);
});

it('桌面直接提供原生画面，不依赖浏览器标签页捕获', async () => {
  vi.mocked(requestCanvasFrame).mockClear();
  for (const elapsed of [0, 2500]) {
    now = 100_000 + elapsed;
    await handleSignature(active, { sessionId: active.sessionId, epoch: 1, time: elapsed / 1000, cols: 12, rows: 8, width: 320, height: 180, cells: pattern(), frame });
  }
  expect(requestCanvasFrame).not.toHaveBeenCalled();
  expect((await db.keyframes.toArray())[0]).toMatchObject({ videoId: 'video-a', time: 13, width: 1280, uploadAllowed: false });
});

it('只有入选时才取高清原图，保存原图而不是低清预览', async () => {
  const captureFrame = vi.fn(async () => ({ ...frame, width: 3840, height: 2160, mediaTime: 25 }));
  for (const elapsed of [0, 2500]) {
    now = 100_000 + elapsed;
    await handleSignature(active, { sessionId: active.sessionId, epoch: 1, time: elapsed / 1000, cols: 12, rows: 8, width: 320, height: 180, cells: pattern(), frame, captureFrame });
    expect(captureFrame).toHaveBeenCalledTimes(elapsed ? 1 : 0);
  }
  expect(captureFrame).toHaveBeenCalledWith(3840);
  expect((await db.keyframes.toArray())[0]).toMatchObject({ width: 3840, height: 2160, time: 25 });
});

it('旧截图默认1280升级到3840，明确设置过的宽度保留', async () => {
  const settings = await getSettings(); const capture = { ...settings.capture, maxFrameWidth: 1280 }; delete capture.keyframeQualityVersion;
  await db.settings.put({ ...settings, capture });
  expect((await getSettings()).capture.maxFrameWidth).toBe(3840);
  expect((await db.settings.get('app'))?.capture.maxFrameWidth).toBe(1280);
  await db.settings.put({ ...settings, capture: { ...capture, keyframeQualityVersion: 1 } });
  expect((await getSettings()).capture.maxFrameWidth).toBe(1280);
});

it('旧默认间隔迁移到4秒，已标记版本的自定义间隔保留', async () => {
  const settings = await getSettings();
  const capture = { ...settings.capture, keyframeCooldownMs: 8000 }; delete capture.keyframePolicyVersion;
  await db.settings.put({ ...settings, capture });
  expect((await getSettings()).capture.keyframeCooldownMs).toBe(4000);
  expect((await db.settings.get('app'))?.capture.keyframeCooldownMs).toBe(8000);
  await db.settings.put({ ...settings, capture: { ...capture, keyframePolicyVersion: 2 } });
  expect((await getSettings()).capture.keyframeCooldownMs).toBe(8000);
});

it('地球旋转这类持续动画不能一直等到静止才留画面', async () => {
  for (let index = 0; index <= 4; index++) {
    const cells = pattern().map((value, cell) => value + (cell % 3 === 0 && index % 2 ? 60 : 0));
    await feed(cells, index * 2500);
  }
  expect(await db.keyframes.count()).toBeGreaterThan(0);
});
