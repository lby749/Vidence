/**
 * 本地神经重排（bge-reranker-base，int8，随扩展打包）。
 *
 * 只作用于少量候选（默认前 8 条），不扫描整个库；
 * 失败时保留融合排序，不影响回答。
 */

import { offscreenRequest } from './ocr-service';
import type { Hit } from '@/retrieval/fusion';
import type { RerankStatusPayload } from '@/shared/offscreen';
import { RERANK_MODEL_ID } from '@/models/model-info';

export interface RerankResult {
  hits: Hit[];
  used: boolean;
  modelId?: string;
  error?: string;
}

export async function rerankHits(query: string, hits: Hit[], topN = 8): Promise<RerankResult> {
  if (hits.length <= 1) return { hits, used: false };
  const head = hits.slice(0, topN);
  const documents = head.map((hit) => (hit.text ?? '').slice(0, 1200));
  if (documents.every((doc) => !doc.trim())) return { hits, used: false };

  try {
    const result = await offscreenRequest<{ scores: number[]; modelId: string }>(
      { type: 'rerank:score', query, documents },
      180_000,
    );
    if (!Array.isArray(result.scores) || result.scores.length !== head.length) {
      return { hits, used: false, error: '重排返回数量不匹配' };
    }
    const maxOriginal = Math.max(...head.map((hit) => hit.score), 1e-6);
    const reranked = head
      .map((hit, index) => ({
        hit,
        score: (result.scores[index] ?? 0) * 0.7 + (hit.score / maxOriginal) * 0.3,
      }))
      .sort((a, b) => b.score - a.score)
      .map(({ hit, score }) => ({ ...hit, score }));
    return { hits: [...reranked, ...hits.slice(topN)], used: true, modelId: result.modelId };
  } catch (error) {
    return { hits, used: false, error: (error as Error).message };
  }
}

export async function rerankStatus(): Promise<RerankStatusPayload> {
  try {
    return await offscreenRequest<RerankStatusPayload>({ type: 'rerank:status' }, 5000);
  } catch (error) {
    return { state: 'error', modelId: RERANK_MODEL_ID, error: (error as Error).message };
  }
}

export async function warmupRerank(): Promise<RerankStatusPayload> {
  return offscreenRequest<RerankStatusPayload>({ type: 'rerank:warmup' }, 180_000);
}
