import { expect, it, vi } from 'vitest';
import { VectorIndex } from '@/retrieval/engine';
import { embeddingSpec } from '@/models/model-info';
import type { VectorRecord } from '@/shared/types';
const { desktop } = vi.hoisted(() => ({ desktop: vi.fn(() => false) }));
vi.mock('@/desktop/local-models', () => ({ hasDesktopModels: desktop }));

it('独立应用选择已验证的原生模型，扩展保留现有模型及各自的输入指令', () => {
  desktop.mockReturnValue(false);
  expect(embeddingSpec().modelId).toBe('Xenova/bge-small-zh-v1.5');
  desktop.mockReturnValue(true);
  expect(embeddingSpec()).toMatchObject({ dimension: 768, dtype: 'Q4_K_M', pooling: 'mean', queryInstruction: 'task: search result | query: ', documentInstruction: 'title: none | text: ' });
  desktop.mockReturnValue(false);
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
