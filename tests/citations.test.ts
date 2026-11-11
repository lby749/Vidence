import { describe, expect, it } from 'vitest';
import { estimateTokens, finalizeCitations } from '@/agent/citations';
import type { Evidence } from '@/shared/types';

function evidence(id: string, text: string, start = 12, end = 16): Evidence {
  return {
    id,
    videoId: 'v1',
    sessionId: 's1',
    startTime: start,
    endTime: end,
    text,
    source: 'texttrack',
    confidence: 0.95,
    capturedAt: Date.now(),
    captureEpoch: 1,
  };
}

describe('引用核验', () => {
  it('只保留本次实际读取过的证据，编号连续', () => {
    const allowed = new Set(['e1', 'e2']);
    const map = new Map([
      ['e1', evidence('e1', '第一段证据')],
      ['e2', evidence('e2', '第二段证据', 20, 24)],
    ]);
    const result = finalizeCitations('结论一[E:e1]，结论二[E:e2]。', allowed, map);
    expect(result.answer).toBe('结论一[1]，结论二[2]。');
    expect(result.citations.map((c) => c.evidenceId)).toEqual(['e1', 'e2']);
    expect(result.citations[1].startTime).toBe(20);
  });

  it('移除编造的引用并计数', () => {
    const allowed = new Set(['e1']);
    const map = new Map([['e1', evidence('e1', '证据')]]);
    const result = finalizeCitations('真实[E:e1] 编造[E:made-up]', allowed, map);
    expect(result.unknown).toBe(1);
    expect(result.answer).toContain('[1]');
    expect(result.answer).not.toContain('made-up');
  });

  it('重复引用复用同一编号', () => {
    const allowed = new Set(['e1']);
    const map = new Map([['e1', evidence('e1', '证据')]]);
    const result = finalizeCitations('A[E:e1] B[E:e1]', allowed, map);
    expect(result.answer).toBe('A[1] B[1]');
    expect(result.citations).toHaveLength(1);
  });

  it('没有引用时返回空引用列表', () => {
    const result = finalizeCitations('模型自身知识回答', new Set(), new Map());
    expect(result.citations).toHaveLength(0);
  });

  it('token 估算对中文与英文分别处理', () => {
    expect(estimateTokens('你好世界')).toBe(4);
    expect(estimateTokens('hello world!')).toBe(3);
  });
});
