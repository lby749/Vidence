import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryDB, setDbForTests } from '@/db/db';
import { memoryChunks, memorySources, questionSummary, recallVideoMemory, saveLongMemory } from '@/agent/long-term-memory';
import { getSettings } from '@/db/db';
import { buildContextBlock } from '@/agent/prompt';
import type { QueryContext } from '@/shared/types';
import { validateImport } from '@/export/bundle';
import type { Evidence, LongTermMemory } from '@/shared/types';

let db: MemoryDB;
const evidence = [
  { id: 'e-a', videoId: 'video-a', text: '排队论研究等待时间', startTime: 0, endTime: 2, source: 'ocr' },
  { id: 'e-b', videoId: 'video-b', text: '矩阵乘法通常不满足交换律', startTime: 0, endTime: 3, source: 'texttrack' },
] as Evidence[];
const draft = (videoId: string, text: string): Omit<LongTermMemory, 'revision' | 'versions'> => ({ videoId, body: text, sources: [], locked: false, model: 'test', updatedAt: Date.now() });
beforeEach(async () => { db = new MemoryDB(`memory-${Math.random()}`); setDbForTests(db); await db.open(); await db.evidence.bulkPut(evidence); await db.videos.bulkPut([{ id: 'video-a' }, { id: 'video-b' }] as never); });
afterEach(async () => { await db.delete(); setDbForTests(null); });

it('每个视频独立保存与召回，不能混入另一个视频的记忆', async () => {
  await saveLongMemory({ ...draft('video-a', '排队论[1]'), sources: [{ videoId: 'video-a', evidenceId: 'e-a', startTime: 0, endTime: 2, source: 'ocr' }] }, 0);
  await saveLongMemory(draft('video-b', '矩阵乘法'), 0);
  const a = await recallVideoMemory('video-a'); const b = await recallVideoMemory('video-b');
  expect(a.text).toBe('排队论[E:e-a]'); expect(a.evidence.map(row => row.videoId)).toEqual(['video-a']);
  expect(b.text).toBe('矩阵乘法'); expect(b.text).not.toContain('排队论');
  expect((await recallVideoMemory('unrecorded')).text).toBe('');
});
it('模型重新整理不能覆盖手工锁定的记忆', async () => {
  await saveLongMemory({ ...draft('video-a', '手工修正'), locked: true }, 0);
  await expect(saveLongMemory(draft('video-a', '模型覆盖'), 1, true)).rejects.toThrow('已锁定');
  expect((await db.longMemories.get('video-a'))?.body).toBe('手工修正');
});
it('更新保留旧版本，过期页面不能覆盖新版本', async () => {
  await saveLongMemory(draft('video-a', '第一版'), 0);
  const next = await saveLongMemory(draft('video-a', '第二版'), 1);
  expect(next.versions.at(-1)?.body).toBe('第一版');
  await expect(saveLongMemory(draft('video-a', '过期编辑'), 1)).rejects.toThrow('已发生变化');
});
it('重复生成相同内容不新增版本，锁定操作不污染正文历史', async () => {
  const original = await saveLongMemory(draft('video-a', '相同内容'), 0);
  const same = await saveLongMemory(draft('video-a', '相同内容'), original.revision, true);
  expect(same.revision).toBe(original.revision);
  const locked = await saveLongMemory({ ...same, locked: true }, same.revision);
  expect(locked.versions).toHaveLength(0);
});
it('原文已删除或伪造来源归属时不能保存长期记忆', async () => {
  await expect(saveLongMemory({ ...draft('video-a', '伪造'), sources: [{ videoId: 'video-a', evidenceId: 'e-b', source: 'ocr', startTime: 0, endTime: 1 }] }, 0)).rejects.toThrow('原始证据已失效');
  await db.videos.delete('video-a');
  await expect(saveLongMemory(draft('video-a', '延迟保存'), 0)).rejects.toThrow('视频已不存在');
});
it('拒绝跨视频来源和模型编造的引用', async () => {
  const generated = memorySources('等待时间[E:1]', [evidence[0]]);
  expect(generated.sources[0].videoId).toBe('video-a');
  expect(() => memorySources('编造[E:99]', [evidence[0]])).toThrow('没有有效来源');
  await expect(saveLongMemory({ ...draft('video-b', '混合'), sources: generated.sources }, 0)).rejects.toThrow('其他视频');
});
it('长视频分块不会丢掉后面的字幕', () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({ ...evidence[0], id: `row${index}`, text: `${index}:` + '内容'.repeat(1600) }));
  const chunks = memoryChunks(rows);
  expect(chunks.length).toBeGreaterThan(1);
  for (let i = 0; i < rows.length; i++) expect(chunks.join('')).toContain(`[E:${i + 1}]`);
});
it('模型使用括号与编号范围时逐条核验并展开，拒绝超出原文的编号', () => {
  const result = memorySources('定义（E:1–E:2）', evidence);
  expect(result.sources.map(source => source.evidenceId)).toEqual(['e-a', 'e-b']);
  expect(() => memorySources('编造（E:1–E:9）', evidence)).toThrow('编号范围不存在');
});
it('导入不能把别的视频来源放进当前视频记忆', () => {
  const bundle = { format: 'vma-export', version: 1, videos: [{ id: 'video-a' }, { id: 'video-b' }], nodes: [], evidence: [], longMemories: [{ ...draft('video-a', '错误归属'), sources: [{ videoId: 'video-b' }] }] };
  expect(validateImport(JSON.stringify(bundle)).ok).toBe(false);
});

it('问答初始上下文只携带本视频摘要和版本，不带原始字幕', async () => {
  await saveLongMemory({ ...draft('video-a', '等待时间的摘要[1]'), sources: [{ videoId: 'video-a', evidenceId: 'e-a', startTime: 0, endTime: 2, source: 'ocr' }] }, 0);
  await saveLongMemory(draft('video-b', '另一个视频的秘密'), 0);
  const ctx = { videoId: 'video-a', selectedNodeIds: [], scopes: [], recordedRanges: [], frozenTime: 0, question: '概括' } as unknown as QueryContext;
  const recalled = await questionSummary(ctx, '视频 A', [], evidence, await getSettings());
  const prompt = buildContextBlock({ ctx, videoTitle: '视频 A', nodeSummaries: [], evidence: [], summary: recalled.text });
  expect(prompt).toContain('等待时间的摘要');
  expect(prompt).not.toContain('排队论研究等待时间');
  expect(prompt).not.toContain('另一个视频的秘密');
  expect(recalled.memoryContext).toEqual({ videoId: 'video-a', revision: 1, sourceCount: 1 });
});

it('已有本视频长期记忆时不运行无用的向量检索与重排，选中片段仍检索', async () => {
  await saveLongMemory(draft('video-a', '已核验摘要'), 0);
  const ctx = { videoId: 'video-a', selectedNodeIds: [], scopes: [] } as unknown as QueryContext;
  const retrieve = vi.fn(async () => [] as Evidence[]);
  expect((await questionSummary(ctx, 'A', [], retrieve, await getSettings())).text).toBe('已核验摘要');
  expect(retrieve).not.toHaveBeenCalled();
  await questionSummary({ ...ctx, selectedNodeIds: ['node-a'] }, 'A', [], retrieve, await getSettings());
  expect(retrieve).toHaveBeenCalledOnce();
  await questionSummary({ ...ctx, videoId: 'video-b' }, 'B', [], retrieve, await getSettings());
  expect(retrieve).toHaveBeenCalledTimes(2);
});
