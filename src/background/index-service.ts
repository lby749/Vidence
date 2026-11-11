/**
 * 后台索引服务：把 Dexie 中的证据/节点装载到 Orama 索引。
 * 索引是可重建的派生数据；重建期间关键词检索仍可用（旧索引先服务）。
 */

import { getDb, getSettings } from '@/db/db';
import type { Evidence, MemoryNode, Video } from '@/shared/types';
import { KeywordIndex, VectorIndex, buildDocs, retrieve, type RetrieveOptions } from '@/retrieval/engine';
import type { RetrieveResult } from '@/retrieval/engine';
import { CHUNK_VERSION } from '@/retrieval/chunk';
import { embeddingSpec } from '@/models/model-info';

export const engine = {
  keyword: new KeywordIndex(),
  vector: new VectorIndex(),
};

let keywordBuiltAt = 0;
let dirty = true;
let building: Promise<void> | null = null;
let lastError: string | null = null;

export function markIndexDirty(): void {
  dirty = true;
  keywordBuiltAt = 0;
}

export function indexStatus(): {
  keywordDocs: number;
  vectorReady: boolean;
  vectorModel: string | null;
  stale: boolean;
  error: string | null;
  chunkVersion: string;
} {
  return {
    keywordDocs: engine.keyword.size,
    vectorReady: engine.vector.ready,
    vectorModel: engine.vector.currentModel,
    stale: dirty || Date.now() - keywordBuiltAt > 60_000,
    error: lastError,
    chunkVersion: CHUNK_VERSION,
  };
}

export async function ensureIndex(force = false): Promise<void> {
  if (!force && !dirty && Date.now() - keywordBuiltAt < 60_000) return;
  if (building) return building;
  building = (async () => {
    try {
      const db = getDb();
      const [videos, nodes, evidence, settings] = await Promise.all([
        db.videos.toArray(),
        db.nodes.toArray(),
        db.evidence.toArray(),
        getSettings(),
      ]);
      const docs = buildDocs(videos as Video[], nodes as MemoryNode[], evidence as Evidence[]);
      await engine.keyword.rebuild(docs);
      if (settings.retrieval.vector) {
        const vectors = await db.vectors.toArray();
        await engine.vector.rebuild(vectors, docs, embeddingSpec().modelId);
      } else {
        await engine.vector.rebuild([], docs);
      }
      keywordBuiltAt = Date.now();
      dirty = false;
      lastError = null;
      await db.indexMeta.put({
        id: 'keyword',
        kind: 'keyword',
        version: (await db.indexMeta.get('keyword'))?.version ?? 1,
        chunkVersion: CHUNK_VERSION,
        indexedUpToRevision: Date.now(),
        updatedAt: Date.now(),
      });
    } catch (error) {
      lastError = (error as Error).message;
      throw error;
    } finally {
      building = null;
    }
  })();
  return building;
}

export async function searchLibrary(
  options: RetrieveOptions & { useVector?: boolean },
): Promise<RetrieveResult> {
  await ensureIndex();
  let queryVector: Float32Array | null = null;
  if (options.useVector && engine.vector.ready) {
    // 查询向量失败时静默退化为关键词检索（不阻断回答）
    const { embedQuery } = await import('./embedding-service');
    const embedded = await embedQuery(options.query).catch(() => null);
    queryVector = embedded?.modelId === engine.vector.currentModel ? embedded.vector : null;
  }
  const result = await retrieve(engine, {
    ...options,
    queryVector,
    useVector: Boolean(options.useVector && engine.vector.ready && queryVector),
  });

  // 本地神经重排：只处理少量候选，失败保留融合排序
  const settings = await getSettings();
  if (settings.retrieval.rerank && result.hits.length > 1) {
    const { rerankHits } = await import('./rerank-service');
    const reranked = await rerankHits(options.query, result.hits, 8);
    return {
      ...result,
      hits: reranked.hits,
      rerankUsed: reranked.used,
      rerankError: reranked.error,
    };
  }
  return result;
}

/** 供问答引用核验：只返回真实存在且属于指定视频的证据 */
export async function readEvidenceByIds(videoId: string, evidenceIds: string[]): Promise<Evidence[]> {
  if (evidenceIds.length === 0) return [];
  const db = getDb();
  const rows = await db.evidence.bulkGet(evidenceIds);
  return rows.filter((row): row is Evidence => Boolean(row) && row!.videoId === videoId);
}

export async function readNodesByIds(videoId: string, nodeIds: string[]): Promise<MemoryNode[]> {
  if (nodeIds.length === 0) return [];
  const db = getDb();
  const rows = await db.nodes.bulkGet(nodeIds);
  return rows.filter((row): row is MemoryNode => Boolean(row) && row!.videoId === videoId);
}

/** 节点召回也必须展开为可引用原始证据，向量命中不能只留下节点标题。 */
export async function evidenceForHits(videoId: string, hits: import('@/retrieval/fusion').Hit[], scopes: Array<{ start: number; end: number; nodeId?: string }> = []): Promise<Evidence[]> {
  const nodes = await readNodesByIds(videoId, [...new Set([...scopes.flatMap(scope => scope.nodeId ? [scope.nodeId] : []), ...hits.flatMap(hit => hit.nodeId ? [hit.nodeId] : [])])]);
  const ids = [...new Set([...hits.flatMap(hit => hit.evidenceId ? [hit.evidenceId] : []), ...nodes.flatMap(node => node.evidenceIds)])];
  const rows = await readEvidenceByIds(videoId, ids);
  return rows.filter(row => !scopes.length || scopes.some(scope => (scope.nodeId && row.nodeId === scope.nodeId) || (row.endTime >= scope.start && row.startTime <= scope.end))).slice(0, 16);
}
