/**
 * 本地检索：Orama 全文索引 + 向量索引 + 自定义融合。
 *
 * - 索引是派生数据：可从证据库重建。
 * - 关键词检索默认开启；向量检索在模型自检通过后开启。
 * - 不同向量模型的向量空间不混查：换模型必须重建（IndexMetadata 记录版本与模型）。
 */

import { create, insertMultiple, search, type AnyOrama } from '@orama/orama';
import { createTokenizer } from '@orama/tokenizers/mandarin';
import type { Evidence, MemoryNode, VectorRecord, Video } from '@/shared/types';
import { CHUNK_VERSION, chunkText, distributeTimes, type IndexDoc } from './chunk';
import { fuseHits, type Hit } from './fusion';

export interface RetrievalDoc extends IndexDoc {
  id: string;
}

function mandarinTokenizer() {
  try {
    return createTokenizer({ language: 'mandarin' });
  } catch {
    return undefined;
  }
}

const SCHEMA = {
  id: 'string',
  kind: 'string',
  nodeId: 'string',
  evidenceId: 'string',
  videoId: 'enum',
  videoTitle: 'string',
  text: 'string',
  start: 'number',
  end: 'number',
  source: 'string',
  status: 'string',
} as const;

export function buildDocs(
  videos: Video[],
  nodes: MemoryNode[],
  evidence: Evidence[],
): RetrievalDoc[] {
  const videoTitles = new Map(videos.map((v) => [v.id, v.title]));
  const docs: RetrievalDoc[] = [];
  const evidenceById = new Map(evidence.map((e) => [e.id, e]));

  for (const node of nodes) {
    const text = node.searchText?.trim();
    if (!text) continue;
    const chunks = chunkText(text);
    const times = distributeTimes(node.startTime, node.endTime, chunks, text.length);
    chunks.forEach((chunk, index) => {
      docs.push({
        id: `${node.id}#${index}`,
        kind: 'node',
        nodeId: node.id,
        videoId: node.videoId,
        videoTitle: videoTitles.get(node.videoId) ?? '',
        text: chunk,
        startTime: times[index]?.start ?? node.startTime,
        endTime: times[index]?.end ?? node.endTime,
        status: node.status,
      });
    });
  }

  for (const item of evidence) {
    const text = item.correctedText?.trim() || item.text.trim();
    if (!text) continue;
    docs.push({
      id: `ev:${item.id}`,
      kind: 'evidence',
      evidenceId: item.id,
      nodeId: item.nodeId,
      videoId: item.videoId,
      videoTitle: videoTitles.get(item.videoId) ?? '',
      text,
      startTime: item.startTime,
      endTime: item.endTime,
      source: item.source,
      status: 'evidence',
    });
  }

  // 避免未使用变量告警，并在未来支持按证据回填节点
  void evidenceById;
  return docs;
}

export class KeywordIndex {
  private db: AnyOrama | null = null;
  private docs: RetrievalDoc[] = [];

  get size(): number {
    return this.docs.length;
  }

  async rebuild(docs: RetrievalDoc[]): Promise<void> {
    this.docs = docs;
    const tokenizer = mandarinTokenizer();
    this.db = create({
      schema: SCHEMA,
      ...(tokenizer ? { components: { tokenizer } } : {}),
    }) as AnyOrama;
    if (docs.length > 0) {
      await insertMultiple(
        this.db,
        docs.map((doc) => ({
          id: doc.id,
          kind: doc.kind,
          nodeId: doc.nodeId ?? '',
          evidenceId: doc.evidenceId ?? '',
          videoId: doc.videoId,
          videoTitle: doc.videoTitle,
          text: doc.text,
          start: doc.startTime,
          end: doc.endTime,
          source: doc.source ?? '',
          status: doc.status ?? '',
        })),
      );
    }
  }

  async search(query: string, options: { videoId?: string; limit?: number; kinds?: Array<'node' | 'evidence'> } = {}): Promise<Hit[]> {
    if (!this.db || !query.trim() || this.docs.length === 0) return [];
    const limit = Math.min(options.limit ?? 30, 100);
    const where: Record<string, unknown> = {};
    if (options.videoId) where.videoId = { eq: options.videoId };
    if (options.kinds && options.kinds.length === 1) where.kind = options.kinds[0];

    let results: any;
    try {
      results = await search(this.db, {
        term: query,
        properties: ['text', 'videoTitle'],
        limit,
        tolerance: 1,
        ...(Object.keys(where).length > 0 ? { where } : {}),
      });
    } catch {
      return [];
    }

    return (results.hits ?? [])
      .filter((hit: any) => !options.kinds || options.kinds.length !== 1 || options.kinds.includes(hit.document.kind))
      .map((hit: any) => {
        const doc = hit.document;
        return {
          id: doc.kind === 'node' ? doc.nodeId : doc.evidenceId.replace(/^ev:/, ''),
          kind: doc.kind as 'node' | 'evidence',
          nodeId: doc.nodeId || undefined,
          evidenceId: doc.evidenceId ? doc.evidenceId.replace(/^ev:/, '') : undefined,
          videoId: doc.videoId,
          startTime: doc.start,
          endTime: doc.end,
          score: hit.score,
          text: doc.text,
          source: doc.source || undefined,
        } satisfies Hit;
      });
  }

  allDocs(): RetrievalDoc[] {
    return this.docs;
  }
}

export class VectorIndex {
  private db: AnyOrama | null = null;
  private dim = 0;
  private modelId: string | null = null;

  get ready(): boolean {
    return this.db !== null;
  }

  get dimension(): number {
    return this.dim;
  }

  get currentModel(): string | null {
    return this.modelId;
  }

  async rebuild(vectors: VectorRecord[], docs: RetrievalDoc[], activeModel?: string): Promise<void> {
    const usable = vectors.filter((v) => v.vector && v.vector.length > 0 && (!activeModel || v.modelId === activeModel));
    if (usable.length === 0) {
      this.db = null;
      this.dim = 0;
      this.modelId = null;
      return;
    }
    this.dim = usable[0]!.dim;
    this.modelId = usable[0]!.modelId;
    const sameModel = usable.filter((v) => v.modelId === this.modelId && v.dim === this.dim);
    const docById = new Map(docs.map((d) => [d.id, d]));

    const schema: Record<string, 'string' | 'enum' | 'number' | 'boolean' | `vector[${number}]`> = {
      id: 'string',
      kind: 'string',
      nodeId: 'string',
      evidenceId: 'string',
      videoId: 'enum',
      text: 'string',
      start: 'number',
      end: 'number',
      embedding: `vector[${this.dim}]`,
      modelId: 'string',
    };

    const db = create({ schema }) as AnyOrama;
    const rows = sameModel
      .map((vector) => {
        const doc = docById.get(vector.id);
        return {
          id: vector.id,
          kind: doc?.kind ?? (vector.nodeId ? 'node' : 'evidence'),
          nodeId: vector.nodeId ?? doc?.nodeId ?? '',
          evidenceId: vector.evidenceId ?? doc?.evidenceId ?? '',
          videoId: vector.videoId,
          text: vector.text,
          start: doc?.startTime ?? 0,
          end: doc?.endTime ?? 0,
          embedding: Array.from(vector.vector),
          modelId: vector.modelId,
        };
      })
      .filter((row) => Array.isArray(row.embedding) && row.embedding.length === this.dim);

    if (rows.length > 0) await insertMultiple(db, rows as any);
    this.db = db;
  }

  async search(vector: Float32Array | number[], options: { videoId?: string; limit?: number; similarity?: number } = {}): Promise<Hit[]> {
    if (!this.db) return [];
    const limit = Math.min(options.limit ?? 30, 100);
    const result: any = await search(this.db, {
      mode: 'vector',
      vector: { value: Array.from(vector), property: 'embedding' },
      similarity: options.similarity ?? 0.25,
      limit,
      ...(options.videoId ? { where: { videoId: { eq: options.videoId } } } : {}),
    });
    return (result.hits ?? []).map((hit: any) => {
      const doc = hit.document;
      return {
        id:
          doc.kind === 'node'
            ? doc.nodeId
            : String(doc.evidenceId).replace(/^ev:/, ''),
        kind: doc.kind as 'node' | 'evidence',
        nodeId: doc.nodeId || undefined,
        evidenceId: doc.evidenceId ? String(doc.evidenceId).replace(/^ev:/, '') : undefined,
        videoId: doc.videoId,
        startTime: doc.start,
        endTime: doc.end,
        score: hit.score,
        text: doc.text,
      } satisfies Hit;
    });
  }
}

export interface RetrieveOptions {
  query: string;
  videoId?: string;
  contextTime?: number;
  scopes?: Array<{ start: number; end: number; nodeId?: string }>;
  allowExpand?: boolean;
  limit?: number;
  queryVector?: Float32Array | number[] | null;
  useVector?: boolean;
}

export interface RetrieveResult {
  hits: Hit[];
  keywordCount: number;
  vectorCount: number;
  vectorUsed: boolean;
  rerankUsed?: boolean;
  rerankError?: string;
}

/**
 * 高层检索：关键词 + 可选向量，融合后返回。
 * 检索失败不阻断问答（可退化为纯关键词）。
 */
export async function retrieve(
  engine: { keyword: KeywordIndex; vector: VectorIndex },
  options: RetrieveOptions,
): Promise<RetrieveResult> {
  const keywordHits = await engine.keyword.search(options.query, {
    videoId: options.videoId,
    limit: (options.limit ?? 20) * 2,
  });

  let vectorHits: Hit[] = [];
  let vectorUsed = false;
  if (options.useVector && options.queryVector && engine.vector.ready) {
    vectorHits = await engine.vector.search(options.queryVector, {
      videoId: options.videoId,
      limit: (options.limit ?? 20) * 2,
    });
    vectorUsed = vectorHits.length > 0;
  }

  const hits = fuseHits(keywordHits, vectorHits, {
    contextTime: options.contextTime,
    scopes: options.scopes,
    allowExpand: options.allowExpand,
    limit: options.limit ?? 20,
  });

  return { hits, keywordCount: keywordHits.length, vectorCount: vectorHits.length, vectorUsed };
}

export { CHUNK_VERSION, chunkText };
