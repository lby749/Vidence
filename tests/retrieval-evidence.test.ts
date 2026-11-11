import { afterEach, beforeEach, expect, it } from 'vitest';
import { MemoryDB, setDbForTests } from '@/db/db';
import { evidenceForHits } from '@/background/index-service';
import type { ChatTurn, Evidence, MemoryNode, Video } from '@/shared/types';
import { prepareQueryContext } from '@/agent/question-agent';
import type { Hit } from '@/retrieval/fusion';
import { ToolExecutor } from '@/agent/tools';
import { DEFAULT_SETTINGS } from '@/shared/constants';

let db: MemoryDB;
beforeEach(async () => {
  db = new MemoryDB(`retrieval-${Math.random()}`); setDbForTests(db); await db.open();
  await db.evidence.bulkPut([
    { id: 'inside', videoId: 'v', nodeId: 'n', startTime: 10, endTime: 12, text: '真实字幕' },
    { id: 'outside', videoId: 'v', nodeId: 'other', startTime: 80, endTime: 90, text: '范围外字幕' },
    { id: 'foreign', videoId: 'another-video', startTime: 10, endTime: 12, text: '其他视频字幕' },
  ] as Evidence[]);
  await db.nodes.put({ id: 'n', videoId: 'v', evidenceIds: ['inside', 'outside', 'foreign'] } as MemoryNode);
});
afterEach(async () => { await db.delete(); setDbForTests(null); });
it('向量只命中节点时仍可取得原始字幕，并排除其他视频和选中范围外证据', async () => {
  const hits = [{ nodeId: 'n', kind: 'node', id: 'n', videoId: 'v' }] as Hit[];
  const rows = await evidenceForHits('v', hits, [{ nodeId: 'n', start: 10, end: 20 }]);
  expect(rows.map(row => row.id)).toEqual(['inside']);
});
it('证据与节点重复命中时只读取一份证据', async () => {
  const hits = [{ nodeId: 'n' }, { evidenceId: 'inside' }] as Hit[];
  expect((await evidenceForHits('v', hits)).map(row => row.id)).toEqual(['inside', 'outside']);
});
it('概括已选节点的问题没有命中关键词时仍提供该节点的原始证据', async () => {
  const rows = await evidenceForHits('v', [], [{ nodeId: 'n', start: 10, end: 20 }]);
  expect(rows.map(row => row.id)).toEqual(['inside']);
});
it('智能体读取邻域时不会越过用户选中的节点范围', async () => {
  await db.nodes.update('n', { startTime: 10, endTime: 20 });
  await db.nodes.put({ id: 'other', videoId: 'v', startTime: 80, endTime: 90, evidenceIds: ['outside'] } as MemoryNode);
  const executor = new ToolExecutor({ ctx: { videoId: 'v', selectedNodeIds: ['n'], scopes: [{ nodeId: 'n', start: 10, end: 20 }] } as never, settings: DEFAULT_SETTINGS as never, readNodes: new Set(), readEvidence: new Set(), imageUploads: 0, allowImages: false, source: 'ai-app' });
  const result = JSON.parse((await executor.execute('get_neighbors', { nodeId: 'n', before: 1, after: 2 })).content);
  expect(result.items.map((n: { nodeId: string }) => n.nodeId)).toEqual(['n']);
  expect(result.items[0].evidence.map((e: { evidenceId: string }) => e.evidenceId)).toEqual(['inside']);
});
it('继续追问沿用上次播放位置和节点，并携带之前的问答', async () => {
  await db.videos.put({ id: 'v', recordedRanges: [[0, 30]] } as Video);
  await db.chats.put({ id: 'turn1', requestId: 'old', videoId: 'v', status: 'completed', question: '这段讲什么', answer: '这段讲单位距离', context: { frozenTime: 12, selectedNodeIds: ['n'] } } as ChatTurn);
  const { ctx } = await prepareQueryContext({ requestId: 'new', videoId: 'v', question: '它是什么意思', frozenTime: 80, selectedNodeIds: [], allowImages: false, route: 'local-agent', followUpTo: 'old' });
  expect(ctx.frozenTime).toBe(12); expect(ctx.selectedNodeIds).toEqual(['n']);
  expect(ctx.previousTurns).toEqual([{ question: '这段讲什么', answer: '这段讲单位距离' }]);
});
it('继续追问不能借用其他视频的上下文', async () => {
  await db.videos.put({ id: 'v', recordedRanges: [] } as unknown as Video);
  await db.chats.put({ id: 'turn2', requestId: 'foreign-turn', videoId: 'foreign-video', status: 'completed', context: { frozenTime: 12, selectedNodeIds: ['n'] } } as ChatTurn);
  await expect(prepareQueryContext({ requestId: 'new', videoId: 'v', question: '追问', frozenTime: 0, selectedNodeIds: [], allowImages: false, route: 'local-agent', followUpTo: 'foreign-turn' })).rejects.toThrow('不可追问');
});
