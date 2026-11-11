/**
 * 本地向量化（Transformers.js + bge-small-zh-v1.5）。
 *
 * 默认关闭；只有在用户开启向量检索后才按需加载模型。
 * 模型加载失败时保留关键词检索，不阻断记录与问答。
 */

import { getDb, getSettings } from '@/db/db';
import type { MemoryNode, VectorRecord } from '@/shared/types';
import { embeddingSpec, APPROX_MODEL_FILES } from '@/models/model-info';
import desktopEmbedding from '@/models/desktop-embedding.json';
import { hasDesktopModels, desktopModelRequest } from '@/desktop/local-models';
import { offscreenRequest } from './ocr-service';
import { markIndexDirty } from './index-service';
import { chunkText } from '@/retrieval/chunk';

let lastError: string | null = null;

export function embeddingStatus(): { modelId: string; error: string | null; spec: ReturnType<typeof embeddingSpec> } {
  const spec = embeddingSpec();
  return { modelId: spec.modelId, error: lastError, spec };
}

export async function embedTexts(texts: string[], query = false): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const spec = embeddingSpec();
  const prepared = texts.map(text => `${query ? spec.queryInstruction : spec.documentInstruction}${text}`);
  if (hasDesktopModels() && !(await getSettings()).retrieval.vector) throw new Error('当前占用档位未启用按意思查找');
  const result = hasDesktopModels() ? await desktopModelRequest<{ vectors: number[][]; dim: number }>('embed', { texts: prepared }) : await offscreenRequest<{ vectors: number[][]; dim: number }>(
    { type: 'embed:encode', modelId: spec.modelId, texts: prepared },
    180_000,
  );
  if (!Array.isArray(result.vectors) || result.vectors.length !== prepared.length) {
    throw new Error('向量服务返回数量不匹配');
  }
  return result.vectors.map((vector) => Float32Array.from(vector));
}

/** 查询向量：失败时返回 null，调用方退化为关键词检索 */
export async function embedQuery(text: string): Promise<{ vector: Float32Array; modelId: string } | null> {
  try {
    const settings = await getSettings();
    if (!settings.retrieval.vector) return null;
    const [vector] = await embedTexts([text], true);
    if (!vector || vector.length !== embeddingSpec().dimension) {
      throw new Error(`向量维度异常：${vector?.length ?? 0}`);
    }
    lastError = null;
    return { vector, modelId: embeddingSpec().modelId };
  } catch (error) {
    lastError = (error as Error).message;
    return null;
  }
}

/** 为尚未向量化的节点补齐向量（有界批处理） */
export async function embedPendingNodes(limit = 10): Promise<{ embedded: number; message: string }> {
  const settings = await getSettings();
  if (!settings.retrieval.vector) return { embedded: 0, message: '向量检索未开启' };
  const db = getDb();
  const spec = embeddingSpec();
  const MODEL_ID = spec.modelId;
  const existing = await db.vectors.where('modelId').equals(MODEL_ID).toArray();
  const done = new Set(existing.map((vector) => vector.nodeId));
  const nodes = (await db.nodes.toArray())
    .filter((node) => (node.searchText?.length ?? 0) > 8 && !done.has(node.id))
    .sort((a, b) => a.startTime - b.startTime)
    .slice(0, limit);
  if (nodes.length === 0) return { embedded: 0, message: '没有待向量化节点' };

  let embedded = 0;
  for (const node of nodes) {
    try {
      const chunks = chunkText(node.searchText ?? '');
      const vectors = await embedTexts(chunks);
      const records: VectorRecord[] = chunks.map((text, index) => ({
        id: `${node.id}#${index}`,
        videoId: node.videoId,
        nodeId: node.id,
        modelId: MODEL_ID,
        dim: vectors[index]!.length,
        vector: vectors[index]!,
        text,
        indexedAt: Date.now(),
      }));
      await db.vectors.bulkPut(records);
      await db.indexMeta.put({
        id: 'vector',
        kind: 'vector',
        version: 1,
        modelId: MODEL_ID,
        modelFiles: hasDesktopModels() ? [{ name: desktopEmbedding.name }] : APPROX_MODEL_FILES.embedding.map((file) => ({ name: file.name })),
        dimension: spec.dimension,
        quantized: true,
        pooling: spec.pooling,
        normalized: true,
        chunkVersion: 'chunk-v1',
        indexedUpToRevision: Date.now(),
        updatedAt: Date.now(),
      });
      embedded += 1;
    } catch (error) {
      lastError = (error as Error).message;
      break;
    }
  }
  if (embedded > 0) markIndexDirty();
  return { embedded, message: lastError ?? `已向量化 ${embedded} 个节点` };
}

export async function warmupEmbedding(): Promise<{ ok: boolean; error?: string }> {
  try {
    if (hasDesktopModels()) await embedTexts(['准备语义检索']);
    else await offscreenRequest({ type: 'embed:warmup', modelId: embeddingSpec().modelId }, 180_000);
    lastError = null;
    return { ok: true };
  } catch (error) {
    lastError = (error as Error).message;
    return { ok: false, error: lastError };
  }
}

export function nodeVectorText(node: MemoryNode): string {
  return [node.title, node.summary, node.searchText].filter(Boolean).join('\n');
}
