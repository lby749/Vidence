import { afterEach, beforeEach, expect, it } from 'vitest';
import { getSettings, MemoryDB, saveSettings, setDbForTests } from '@/db/db';
import { prepareQueryContext } from '@/agent/question-agent';
import { ToolExecutor } from '@/agent/tools';
import type { Keyframe, MemoryNode, Video } from '@/shared/types';

let db: MemoryDB;
const request = { requestId: 'q', videoId: 'v', question: '这个公式怎么得到的？', frozenTime: 15, selectedNodeIds: ['n'], allowImages: true, route: 'api' as const };
beforeEach(async () => {
  db = new MemoryDB(`frame-tools-${Math.random()}`); setDbForTests(db); await db.open();
  await db.videos.put({ id: 'v', title: '课程', recordedRanges: [[10, 20]] } as Video);
  await db.nodes.put({ id: 'n', videoId: 'v', sessionId: 's', title: '公式', startTime: 10, endTime: 20, evidenceIds: [], keyframeIds: ['inside'], tags: [], relatedNodeIds: [], status: 'draft', createdAt: 1, updatedAt: 1, revision: 1 } satisfies MemoryNode);
  await db.keyframes.bulkPut([
    { id: 'inside', videoId: 'v', time: 15 }, { id: 'outside', videoId: 'v', time: 35 }, { id: 'foreign', videoId: 'other', time: 15 },
  ].map(frame => ({ ...frame, image: new Blob(['real-image-bytes'], { type: 'image/png' }), width: 1280, height: 720, uploadAllowed: false })) as Keyframe[]);
});
afterEach(async () => { await db.delete(); setDbForTests(null); });
async function executor(allowImages = true) {
  const { ctx } = await prepareQueryContext({ ...request, allowImages });
  return { ctx, tool: new ToolExecutor({ ctx, settings: await getSettings(), allowImages, readEvidence: new Set(), readNodes: new Set(), imageUploads: 0, source: 'api' }) };
}
it('全局和本次都允许时，模型能发现并读取本视频选中范围的截图', async () => {
  const settings = await getSettings(); await saveSettings({ privacy: { ...settings.privacy, allowVisionUpload: true } });
  const { ctx, tool } = await executor();
  expect(ctx.allowedFrameIds).toEqual(['inside']);
  const timeline = JSON.parse((await tool.execute('get_timeline', {})).content);
  expect(timeline.keyframes.map((frame: { keyframeId: string }) => frame.keyframeId)).toEqual(['inside']);
  const result = await tool.execute('get_frame', { keyframeId: 'inside' });
  expect(result.images?.[0]).toMatch(/^data:image\/png;base64,/);
  expect((await db.keyframes.get('inside'))?.uploadAllowed).toBe(false);
  expect((await tool.execute('get_frame', { keyframeId: 'outside' })).error?.code).toBe('not_found');
  expect((await tool.execute('get_frame', { keyframeId: 'foreign' })).error?.code).toBe('not_found');
});
it('未开启全局或未勾选本次时都不读取图片', async () => {
  const first = await executor(); expect(first.ctx.allowedFrameIds).toBeUndefined();
  expect((await first.tool.execute('get_frame', { keyframeId: 'inside' })).error?.code).toBe('vision_not_authorized');
  const settings = await getSettings(); await saveSettings({ privacy: { ...settings.privacy, allowVisionUpload: true } });
  const second = await executor(false); expect(second.ctx.allowedFrameIds).toBeUndefined();
  expect((await second.tool.execute('get_frame', { keyframeId: 'inside' })).error?.code).toBe('vision_not_authorized');
});

it('图片工具按真实图片数计费，读过的图片可引用，后加入和过滤的图片不能越权读取', async () => {
  const settings = await getSettings(); await saveSettings({ privacy: { ...settings.privacy, allowVisionUpload: true } });
  const { ctx, tool } = await executor();
  expect(tool.specs('ai-app').some(spec => spec.name === 'get_frame')).toBe(true);
  await db.keyframes.put({ ...(await db.keyframes.get('inside'))!, id: 'late' });
  expect((await tool.execute('get_frame', { keyframeId: 'late' })).error?.code).toBe('vision_not_authorized');
  expect((await tool.execute('get_frame', { keyframeIds: ['inside'] })).images).toHaveLength(1);
  expect((await tool.execute('get_frame', { keyframeId: 'inside' })).images).toHaveLength(1);
  expect((await tool.execute('get_frame', { keyframeId: 'inside' })).error?.code).toBe('image_budget');
  await db.keyframes.update('inside', { knowledge: { kind: 'speaker', title: '讲者', summary: '无知识图示', visibleText: '', confidence: 0.95, reviewedAt: 1, modelId: 'test' } });
  const fresh = await executor(); expect(fresh.ctx.allowedFrameIds).not.toContain('inside');
  expect((await fresh.tool.execute('get_timeline', {})).content).not.toContain('"keyframeId":"inside"');
  expect(ctx.allowedFrameIds).toEqual(['inside']);
});
