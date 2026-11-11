/**
 * 检索结果融合。
 *
 * 混合分数融合（本文件）与神经重排（RerankerAdapter）分开命名：
 * - 这里的 score 由关键词、向量相关度、时间邻接及选中范围融合得到。
 * - 神经重排只作用于少量候选，默认关闭。
 */

export interface Hit {
  id: string;
  /** 文档类型：节点或证据 */
  kind: 'node' | 'evidence';
  nodeId?: string;
  evidenceId?: string;
  videoId: string;
  startTime: number;
  endTime: number;
  score: number;
  text?: string;
  source?: string;
}

export interface FusionOptions {
  /** 当前播放位置（提问时冻结） */
  contextTime?: number;
  /** 选中节点范围；提供时默认严格限制在其中 */
  scopes?: Array<{ start: number; end: number; nodeId?: string }>;
  /** 时间邻接权重 */
  timeWeight?: number;
  keywordWeight?: number;
  vectorWeight?: number;
  /** 允许扩大到选中范围之外（用户显式选择） */
  allowExpand?: boolean;
  limit?: number;
}

function normalize(hits: Hit[]): Hit[] {
  if (hits.length === 0) return [];
  const scores = hits.map((h) => h.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const span = max - min;
  return hits.map((h) => ({ ...h, score: span > 0 ? (h.score - min) / span : 1 }));
}

function timeScore(contextTime: number | undefined, hit: Hit): number {
  if (contextTime === undefined) return 0;
  const distance = hit.startTime > contextTime ? hit.startTime - contextTime : contextTime - hit.endTime;
  if (distance <= 0) return 1;
  if (distance <= 30) return 1 - distance / 60;
  if (distance <= 180) return Math.max(0, 0.5 - distance / 720);
  return 0;
}

function inScopes(scopes: NonNullable<FusionOptions['scopes']>, hit: Hit): boolean {
  if (scopes.length === 0) return true;
  return scopes.some((s) => {
    if (s.nodeId && hit.nodeId === s.nodeId) return true;
    return hit.endTime >= s.start - 0.5 && hit.startTime <= s.end + 0.5;
  });
}

/**
 * 融合关键词与向量召回。
 * 选中范围内排序优先；默认过滤掉范围外结果（多选节点提问不扩大到全库）。
 */
export function fuseHits(
  keywordHits: Hit[],
  vectorHits: Hit[],
  options: FusionOptions = {},
): Hit[] {
  const kw = normalize(keywordHits);
  const vec = normalize(vectorHits);
  const timeWeight = options.timeWeight ?? 0.22;
  const keywordWeight = options.keywordWeight ?? 1;
  const vectorWeight = options.vectorWeight ?? 0.9;
  const merged = new Map<string, Hit>();

  const add = (hit: Hit, weight: number) => {
    const key = hit.kind === 'node' ? `n:${hit.id}` : `e:${hit.id}`;
    const prev = merged.get(key);
    const t = timeScore(options.contextTime, hit);
    const value = hit.score * weight + t * timeWeight;
    if (prev) {
      prev.score = Math.max(prev.score, value) + Math.min(prev.score, value) * 0.15;
      prev.text = prev.text ?? hit.text;
    } else {
      merged.set(key, { ...hit, score: value });
    }
  };

  for (const hit of kw) add(hit, keywordWeight);
  for (const hit of vec) add(hit, vectorWeight);

  let all = [...merged.values()];

  if (options.scopes && options.scopes.length > 0 && !options.allowExpand) {
    const scoped = all.filter((h) => inScopes(options.scopes!, h));
    // 范围内没有结果时也不默认扩大范围，交由调用方决定
    all = scoped;
  }

  all.sort((a, b) => b.score - a.score || a.startTime - b.startTime);
  const limit = options.limit ?? 20;
  return all.slice(0, limit);
}

/**
 * Reciprocal Rank Fusion（备选融合器），用于对比或关键词/向量分数量纲不可比时。
 */
export function reciprocalRankFusion(lists: Hit[][], k = 60, limit = 20): Hit[] {
  const acc = new Map<string, Hit>();
  for (const list of lists) {
    list.forEach((hit, index) => {
      const key = hit.kind === 'node' ? `n:${hit.id}` : `e:${hit.id}`;
      const prev = acc.get(key);
      const gain = 1 / (k + index + 1);
      if (prev) prev.score += gain;
      else acc.set(key, { ...hit, score: gain });
    });
  }
  return [...acc.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** 证据级命中整理为节点级上下文，保留证据编号用于引用核验 */
export function groupHitsByNode(hits: Hit[], limitNodes = 8): Array<{
  nodeId: string;
  score: number;
  evidenceIds: string[];
}> {
  const map = new Map<string, { nodeId: string; score: number; evidenceIds: string[] }>();
  for (const hit of hits) {
    const nodeId = hit.nodeId ?? (hit.kind === 'node' ? hit.id : undefined);
    if (!nodeId) continue;
    const entry = map.get(nodeId) ?? { nodeId, score: 0, evidenceIds: [] };
    entry.score = Math.max(entry.score, hit.score);
    if (hit.evidenceId) entry.evidenceIds.push(hit.evidenceId);
    map.set(nodeId, entry);
  }
  return [...map.values()].sort((a, b) => b.score - a.score).slice(0, limitNodes);
}
