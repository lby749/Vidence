/**
 * 引用核验：只接受本次实际读取过的证据 ID。
 * 与具体模型协议无关，便于单元测试。
 */

import type { Citation, Evidence } from '@/shared/types';

export interface FinalizedAnswer {
  answer: string;
  citations: Citation[];
  unknown: number;
}

export function finalizeCitations(
  raw: string,
  allowedIds: Set<string>,
  evidenceById: Map<string, Evidence>,
): FinalizedAnswer {
  const citations: Citation[] = [];
  const seen = new Map<string, number>();
  let unknown = 0;

  const answer = raw.replace(/\[E:([^\]\s]+)\]/g, (_match, id: string) => {
    if (!allowedIds.has(id) || !evidenceById.has(id)) {
      unknown += 1;
      return '';
    }
    const existing = seen.get(id);
    if (existing !== undefined) return `[${existing}]`;
    const evidence = evidenceById.get(id)!;
    const index = citations.length + 1;
    seen.set(id, index);
    citations.push({
      evidenceId: evidence.id,
      nodeId: evidence.nodeId,
      keyframeId: evidence.keyframeId,
      startTime: evidence.startTime,
      endTime: evidence.endTime,
      source: evidence.source,
      quote: (evidence.correctedText || evidence.text).slice(0, 160),
    });
    return `[${index}]`;
  });

  return { answer: answer.trim(), citations, unknown };
}

/** 粗略 token 估算（中文按 1 字 ≈ 1 token，其他按 4 字符 ≈ 1 token） */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}
