/**
 * 检索文档切块。
 * 索引是派生数据：切块版本变化时允许整体重建，不影响原始证据。
 */

export const CHUNK_VERSION = 'chunk-v1';
export const CHUNK_TARGET_CHARS = 240;
export const CHUNK_OVERLAP_CHARS = 40;

export interface IndexDoc {
  id: string;
  kind: 'node' | 'evidence';
  nodeId?: string;
  evidenceId?: string;
  videoId: string;
  videoTitle: string;
  text: string;
  startTime: number;
  endTime: number;
  source?: string;
  status?: string;
}

const SENTENCE_BREAK = /([。！？!?；;\n])/;

/** 把长文本切成带重叠的块，尽量在句末断开 */
export function chunkText(text: string, target = CHUNK_TARGET_CHARS, overlap = CHUNK_OVERLAP_CHARS): string[] {
  const normalized = text.trim();
  if (!normalized) return [];
  if (normalized.length <= target) return [normalized];

  const sentences: string[] = [];
  let buffer = '';
  for (const part of normalized.split(SENTENCE_BREAK)) {
    buffer += part;
    if (SENTENCE_BREAK.test(part) || buffer.length >= target) {
      if (buffer.trim()) sentences.push(buffer.trim());
      buffer = '';
    }
  }
  if (buffer.trim()) sentences.push(buffer.trim());

  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (sentence.length > target * 1.6) {
      // 过长句：硬切
      for (let i = 0; i < sentence.length; i += target - overlap) {
        chunks.push(sentence.slice(i, i + target));
      }
      current = '';
      continue;
    }
    if ((current + sentence).length > target && current) {
      chunks.push(current.trim());
      current = current.slice(Math.max(0, current.length - overlap)) + sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter((c) => c.length > 0);
}

/** 按证据时间戳为块估算时间范围（无法精确到块时按字符比例分配） */
export function distributeTimes(
  start: number,
  end: number,
  chunks: string[],
  totalChars: number,
): Array<{ start: number; end: number }> {
  const duration = Math.max(0.01, end - start);
  const total = Math.max(1, totalChars);
  let cursor = 0;
  return chunks.map((chunk) => {
    const from = cursor / total;
    cursor += chunk.length;
    const to = cursor / total;
    return { start: start + duration * from, end: start + duration * to };
  });
}
