import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryDB, getSettings, saveSettings, setDbForTests } from '@/db/db';
import { isKnowledgeFrame, isUncertainFrame, reviewKnowledgeFrames } from '@/agent/knowledge-frames';
import type { Keyframe, Video } from '@/shared/types';

const { chat } = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock('@/providers', () => ({ createAdapter: () => ({ chat }), recordUsage: vi.fn() }));
let db: MemoryDB;
const verdict = (id: string, kind = 'knowledge', confidence = 0.95) => ({ id, kind, confidence, title: '画面内容', summary: '可见图示', visibleText: '' });
const reply = (frames: ReturnType<typeof verdict>[]) => chat.mockImplementation(async function* () { yield { type: 'text', delta: JSON.stringify({ frames }) }; });
beforeEach(async () => {
  chat.mockReset();
  db = new MemoryDB(`knowledge-${Math.random()}`); setDbForTests(db); await db.open();
  await db.videos.put({ id: 'v' } as Video);
  await db.keyframes.bulkPut(['diagram', 'speaker', 'outro'].map((id, index) => ({ id, videoId: 'v', sessionId: 's', time: index, image: new Blob(['pixels'], { type: 'image/jpeg' }), reason: 'auto-change', fingerprint: id, capturedAt: 1, uploadAllowed: false })) as Keyframe[]);
  const settings = await getSettings();
  await saveSettings({ providers: [{ id: 'test', label: 'test', kind: 'openai-compatible', apiKey: 'test' }], roles: { answerModel: { providerId: 'test', modelId: 'vision-test' } }, privacy: { ...settings.privacy, allowVisionUpload: true } });
});
afterEach(async () => { await db.delete(); setDbForTests(null); });

it('读真实图片后筛选，纯讲者/片尾不展示，原图与授权标志保留，重复操作不再调用', async () => {
  reply([verdict('diagram'), verdict('speaker', 'speaker'), verdict('outro', 'outro')]);
  expect(await reviewKnowledgeFrames('v')).toEqual({ reviewed: 3, filtered: 2 });
  expect(chat.mock.calls[0][0].messages[1].content.filter((part: { type: string }) => part.type === 'image')).toHaveLength(3);
  expect((await db.keyframes.toArray()).filter(isKnowledgeFrame).map(frame => frame.id)).toEqual(['diagram']);
  expect((await db.keyframes.get('outro'))?.uploadAllowed).toBe(false);
  expect(await db.keyframes.count()).toBe(3);
  await reviewKnowledgeFrames('v'); expect(chat).toHaveBeenCalledTimes(1);
});
it('低置信度和无法判断的画面保留待确认，用户保留优先', async () => {
  await db.keyframes.update('outro', { reason: 'user' });
  reply([verdict('diagram', 'uncertain'), verdict('speaker', 'speaker', 0.6)]);
  expect(await reviewKnowledgeFrames('v')).toEqual({ reviewed: 2, filtered: 0 });
  expect((await db.keyframes.toArray()).filter(isKnowledgeFrame).map(frame => frame.id)).toEqual(['outro']);
  expect((await db.keyframes.toArray()).filter(isUncertainFrame)).toHaveLength(2);
  expect(await db.keyframes.count()).toBe(3);
});
it('不能用错视频ID、缺项或重复结果部分覆盖本批画面', async () => {
  reply([verdict('foreign'), verdict('speaker'), verdict('outro')]);
  await expect(reviewKnowledgeFrames('v')).rejects.toThrow('格式');
  expect((await db.keyframes.toArray()).some(frame => frame.knowledge)).toBe(false);
});
it('取消和没有图片授权时不保存、不发送图片', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(reviewKnowledgeFrames('v', controller.signal)).rejects.toThrow('取消');
  await saveSettings({ privacy: { ...(await getSettings()).privacy, allowVisionUpload: false } });
  await expect(reviewKnowledgeFrames('v')).rejects.toThrow('允许发送');
  expect(chat).not.toHaveBeenCalled();
});

it('真实出现过的多余括号只做一次文字修复，不再次上传图片', async () => {
  chat.mockImplementationOnce(async function* () { yield { type: 'text', delta: '{"frames":[{"id":"diagram","title":"图示"},"summary":"内容"}]}' }; });
  reply([verdict('diagram'), verdict('speaker', 'speaker'), verdict('outro', 'outro')]);
  expect(await reviewKnowledgeFrames('v')).toEqual({ reviewed: 3, filtered: 2 });
  expect(chat).toHaveBeenCalledTimes(2);
  expect(chat.mock.calls[1][0].messages[0].content.every((part: { type: string }) => part.type === 'text')).toBe(true);
});
