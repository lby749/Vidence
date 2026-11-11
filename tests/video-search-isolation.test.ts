import { expect, it } from 'vitest';
import { KeywordIndex, VectorIndex, type RetrievalDoc } from '@/retrieval/engine';
import type { VectorRecord } from '@/shared/types';

const docs = ['bilibili:0zlbdqa', 'bilibili:05gj8ve'].map((videoId, index) => ({
  id: `ev:row${index}`, kind: 'evidence', evidenceId: `row${index}`, videoId,
  videoTitle: '真实视频', text: '地球与鸡蛋测试共同词', startTime: 0, endTime: 2,
} as RetrievalDoc));

it('关键词检索对同平台的视频标识也必须精确隔离', async () => {
  const index = new KeywordIndex(); await index.rebuild(docs);
  const hits = await index.search('地球', { videoId: docs[0].videoId });
  expect(hits.map(hit => hit.videoId)).toEqual([docs[0].videoId]);
});
it('向量检索不能混入同平台的另一视频', async () => {
  const index = new VectorIndex();
  await index.rebuild(docs.map((doc, i) => ({ id: `v${i}`, evidenceId: doc.evidenceId, videoId: doc.videoId, modelId: 'test', dim: 2, vector: Float32Array.from([1, 0]), text: doc.text } as VectorRecord)), docs);
  const hits = await index.search([1, 0], { videoId: docs[0].videoId });
  expect(hits.map(hit => hit.videoId)).toEqual([docs[0].videoId]);
});
