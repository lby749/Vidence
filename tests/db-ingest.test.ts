import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryDB, setDbForTests } from '@/db/db';
import { ingestCaptions } from '@/background/subtitle-service';
import { rebuildDraftNodes } from '@/background/node-service';

let db: MemoryDB;

async function seed() {
  await db.videos.put({
    id: 'v1',
    url: 'https://example.com/v/1',
    canonicalUrl: 'https://example.com/v/1',
    platform: 'example',
    title: '排队论 第一讲',
    duration: 300,
    lastPosition: 0,
    recordedRanges: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sessionCount: 1,
  });
  await db.sessions.put({
    id: 's1',
    videoId: 'v1',
    startedAt: Date.now(),
    captureEpoch: 1,
    status: 'recording',
    subtitleSource: { kind: 'texttrack', label: '字幕轨' },
    observedRanges: [],
    gaps: [],
  });
}

const source = { kind: 'texttrack' as const, label: '字幕轨' };

describe('字幕落库与节点重建（IndexedDB）', () => {
  beforeEach(async () => {
    db = new MemoryDB(`test-${Math.random().toString(36).slice(2)}`);
    setDbForTests(db);
    await db.open();
    await seed();
  });

  afterEach(async () => {
    await db.delete();
    setDbForTests(null);
  });

  it('同一批字幕只落一次库', async () => {
    const first = await ingestCaptions({
      videoId: 'v1',
      sessionId: 's1',
      epoch: 1,
      sessionEpoch: 1,
      duration: 300,
      source,
      items: [{ text: '先来先服务', startTime: 10, endTime: 12, source: 'texttrack' }],
    });
    expect(first.added).toBe(1);
    const second = await ingestCaptions({
      videoId: 'v1',
      sessionId: 's1',
      epoch: 1,
      sessionEpoch: 1,
      duration: 300,
      source,
      items: [{ text: '先来先服务', startTime: 10.4, endTime: 12.2, source: 'texttrack' }],
    });
    expect(second.added).toBe(0);
    expect(await db.evidence.count()).toBe(1);
  });

  it('暂停后迟到的 OCR 结果不会继续写入证据', async () => {
    await db.sessions.update('s1', { status: 'paused' });
    const result = await ingestCaptions({ videoId: 'v1', sessionId: 's1', epoch: 1, sessionEpoch: 1, duration: 300, source,
      items: [{ text: '迟到的识别结果', startTime: 10, endTime: 12, source: 'ocr' }] });
    expect(result.rejected).toBe(1); expect(await db.evidence.count()).toBe(0);
  });

  it('旧代次（seek 之后迟到）的任务被丢弃', async () => {
    await db.sessions.update('s1', { captureEpoch: 3 });
    const result = await ingestCaptions({
      videoId: 'v1',
      sessionId: 's1',
      epoch: 1,
      sessionEpoch: 3,
      duration: 300,
      source,
      items: [{ text: '旧任务文本', startTime: 10, endTime: 12, source: 'ocr' }],
    });
    expect(result.rejected).toBe(1);
    expect(await db.evidence.count()).toBe(0);
  });

  it('会话或视频不匹配时拒绝写入', async () => {
    const result = await ingestCaptions({
      videoId: 'v-other',
      sessionId: 's1',
      epoch: 1,
      sessionEpoch: 1,
      duration: 300,
      source,
      items: [{ text: '错视频', startTime: 10, endTime: 12, source: 'texttrack' }],
    });
    expect(result.rejected).toBe(1);
    expect(await db.evidence.count()).toBe(0);
  });

  it('重建节点后证据关联到节点，且有稳定 ID', async () => {
    await ingestCaptions({
      videoId: 'v1',
      sessionId: 's1',
      epoch: 1,
      sessionEpoch: 1,
      duration: 300,
      source,
      items: [
        { text: '第一段内容足够长，用于切分节点。', startTime: 0, endTime: 4, source: 'texttrack' },
        { text: '紧接着同一段讲解继续。', startTime: 4.5, endTime: 8, source: 'texttrack' },
      ],
    });
    const result = await rebuildDraftNodes('v1', 's1');
    expect(result.created).toBe(1);
    const nodes = await db.nodes.toArray();
    expect(nodes).toHaveLength(1);
    const evidence = await db.evidence.toArray();
    expect(evidence.every((e) => e.nodeId === nodes[0].id)).toBe(true);

    // 再重建一次：不重复创建，保持同一节点 ID
    const again = await rebuildDraftNodes('v1', 's1');
    expect(again.created).toBe(0);
    expect((await db.nodes.toArray())[0].id).toBe(nodes[0].id);
  });

  it('用户笔记不会被重建覆盖', async () => {
    await ingestCaptions({
      videoId: 'v1',
      sessionId: 's1',
      epoch: 1,
      sessionEpoch: 1,
      duration: 300,
      source,
      items: [{ text: '一段讲解内容，足以形成节点。', startTime: 0, endTime: 5, source: 'texttrack' }],
    });
    await rebuildDraftNodes('v1', 's1');
    const node = (await db.nodes.toArray())[0];
    await db.nodes.update(node.id, { userNote: '我的笔记', status: 'organized', summary: 'AI 摘要' });

    await ingestCaptions({
      videoId: 'v1',
      sessionId: 's1',
      epoch: 1,
      sessionEpoch: 1,
      duration: 300,
      source,
      items: [{ text: '新的讲解内容。', startTime: 30, endTime: 35, source: 'texttrack' }],
    });
    await rebuildDraftNodes('v1', 's1');
    expect((await db.nodes.get(node.id))?.userNote).toBe('我的笔记');
  });

  it('后面的关键画面不能挂到时间范围以外的早期节点', async () => {
    await ingestCaptions({ videoId: 'v1', sessionId: 's1', epoch: 1, sessionEpoch: 1, duration: 300, source,
      items: [{ text: '第一节只讲这个知识点，后面的画面属于另一段。', startTime: 0, endTime: 5, source: 'texttrack' }] });
    await db.keyframes.put({ id: 'late-frame', videoId: 'v1', time: 200, image: new Blob(['frame']), capturedAt: 100 } as never);
    await rebuildDraftNodes('v1', 's1');
    expect((await db.keyframes.get('late-frame'))?.nodeId).toBeUndefined();
    expect((await db.nodes.toArray())[0].keyframeIds).not.toContain('late-frame');
  });
});
