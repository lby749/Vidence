import { describe, expect, it } from 'vitest';
import { fuseHits, groupHitsByNode, reciprocalRankFusion, type Hit } from '@/retrieval/fusion';

const hit = (id: string, score: number, start = 0, end = 10, nodeId = `n_${id}`): Hit => ({
  id,
  kind: 'evidence',
  evidenceId: id,
  nodeId,
  videoId: 'v1',
  startTime: start,
  endTime: end,
  score,
  text: `text ${id}`,
});

describe('混合检索融合', () => {
  it('关键词与向量命中统一排序并去重', () => {
    const fused = fuseHits([hit('a', 10, 0, 5), hit('b', 5, 100, 110)], [hit('b', 0.9, 100, 110), hit('c', 0.8, 200, 210)], {
      contextTime: 5,
      limit: 10,
    });
    expect(fused.filter((h) => h.id === 'b')).toHaveLength(1);
    // 与当前播放位置接近的 a 应排在前
    expect(fused[0].id).toBe('a');
  });

  it('选中节点时默认严格限制范围，不扩大到全库', () => {
    const keyword = [hit('a', 10, 0, 5), hit('outside', 9, 500, 510)];
    const fused = fuseHits(keyword, [], {
      scopes: [{ start: 0, end: 10, nodeId: 'n_a' }],
      limit: 10,
    });
    expect(fused.map((h) => h.id)).toEqual(['a']);
  });

  it('显式允许扩大时才返回范围外结果', () => {
    const keyword = [hit('a', 10, 0, 5), hit('outside', 9, 500, 510)];
    const fused = fuseHits(keyword, [], {
      scopes: [{ start: 0, end: 10, nodeId: 'n_a' }],
      allowExpand: true,
      limit: 10,
    });
    expect(fused.length).toBe(2);
  });

  it('时间邻接提升当前片段附近的证据', () => {
    const near = hit('near', 1, 60, 65);
    const far = hit('far', 1, 3000, 3005);
    const fused = fuseHits([near, far], [], { contextTime: 62, limit: 10 });
    expect(fused[0].id).toBe('near');
  });

  it('RRF 对分数量纲不敏感', () => {
    const listA = [hit('a', 1000), hit('b', 1)];
    const listB = [hit('b', 0.99), hit('c', 0.5)];
    const fused = reciprocalRankFusion([listA, listB]);
    expect(fused[0].id).toBe('b');
  });

  it('证据按节点归组供上下文使用', () => {
    const grouped = groupHitsByNode([hit('a', 5, 0, 5, 'n1'), hit('b', 3, 10, 15, 'n1'), hit('c', 4, 20, 25, 'n2')]);
    expect(grouped[0].nodeId).toBe('n1');
    expect(grouped[0].evidenceIds).toEqual(['a', 'b']);
  });
});
