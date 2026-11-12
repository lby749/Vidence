import { expect, it } from 'vitest';
import { VectorIndex } from '@/retrieval/engine';
import { embeddingSpec } from '@/models/model-info';
import type { VectorRecord } from '@/shared/types';

it('扩展独立使用浏览器模型与输入指令，不切换到桌面计算服务', () => {
  expect(embeddingSpec().modelId).toBe('Xenova/bge-small-zh-v1.5');
  expect(embeddingSpec()).toMatchObject({ dimension: 512, dtype: 'q8', pooling: 'cls', documentInstruction: '' });
});

it('换模型时不会用旧模型的向量匹配新查询，即使维度相同', async () => {
  const vectors = ['old-model', 'new-model'].map((modelId, index) => ({ id: String(index), nodeId: String(index), videoId: 'same-video', modelId, dim: 2, vector: new Float32Array([1, 0]), text: modelId, indexedAt: 1 })) as VectorRecord[];
  const index = new VectorIndex();
  await index.rebuild(vectors, [], 'new-model');
  expect(index.currentModel).toBe('new-model');
  expect((await index.search([1, 0])).map(hit => hit.text)).toEqual(['new-model']);
  await index.rebuild(vectors, [], 'missing-model');
  expect(index.ready).toBe(false);
  expect(index.currentModel).toBeNull();
});
