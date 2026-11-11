/**
 * 字幕文本处理：规范化、相似度、去重与时序合并。
 *
 * 规则来自需求：
 * - 稳定显示的同一句话合并为持续区间；
 * - 处理逐字出现、滚动字幕、双行与双语字幕；
 * - 去重只针对时间邻近的重复显示，很久以后重新说的一句话必须保留。
 */

export interface CaptionInput {
  text: string;
  startTime: number;
  endTime: number;
  source: 'texttrack' | 'dom' | 'ocr' | 'manual';
  confidence?: number;
  provenance?: string;
  keyframeId?: string;
}

export interface CaptionRecord extends CaptionInput {
  id: string;
  mergedCount: number;
}

const ZERO_WIDTH = /[\u200b-\u200f\u202a-\u202e\ufeff]/g;
/** 播放器时间栏曾被误当成 YouTube 字幕。 */
export function isPlayerControlText(text: string): boolean {
  return /^\s*\d{1,2}:\d{2}(?::\d{2})?\s*\/\s*\d{1,2}:\d{2}(?::\d{2})?(?:\s|直播|live|[•·])/i.test(text.trim() + ' ');
}

export function normalizeCaption(text: string): string {
  return text
    .replace(ZERO_WIDTH, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter(Boolean)
    // 双语字幕/重复行：完全相同的行只保留一次
    .filter((line, index, arr) => arr.findIndex((x) => x === line) === index)
    .join('\n')
    .trim();
}

function stripPunctuation(text: string): string {
  return text.replace(/[\s，。！？、；：,.!?;:"'“”‘’()（）\-—…·|/\\[\]]/g, '');
}

export function comparableText(text: string): string {
  return stripPunctuation(normalizeCaption(text)).toLowerCase();
}

/** 相似度：0..1，基于字符二元组 Dice 系数，对中文短句足够稳定 */
export function similarity(a: string, b: string): number {
  const x = comparableText(a);
  const y = comparableText(b);
  if (!x && !y) return 1;
  if (!x || !y) return 0;
  if (x === y) return 1;
  const shorter = x.length <= y.length ? x : y;
  const longer = x.length <= y.length ? y : x;
  // 逐字出现：短句是长句的子串
  if (shorter.length >= 2 && longer.includes(shorter)) {
    return Math.min(1, 0.75 + (shorter.length / longer.length) * 0.25);
  }
  const bigrams = (s: string) => {
    const map = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      map.set(g, (map.get(g) ?? 0) + 1);
    }
    return map;
  };
  const ga = bigrams(x);
  const gb = bigrams(y);
  let overlap = 0;
  for (const [g, count] of ga) {
    const other = gb.get(g);
    if (other) overlap += Math.min(count, other);
  }
  const total = x.length - 1 + (y.length - 1);
  return total > 0 ? (2 * overlap) / total : 0;
}

export function isSameCaption(a: string, b: string): boolean {
  return similarity(a, b) >= 0.86;
}

/**
 * 把新观察到的字幕并入已有序列。
 * 返回新的记录数组（不改动入参）。
 */
export function mergeCaption(
  existing: CaptionRecord[],
  incoming: CaptionInput,
  options: { duplicateWindowSeconds?: number; makeId: () => string } = { makeId: () => Math.random().toString(36) },
): { records: CaptionRecord[]; action: 'added' | 'merged' | 'duplicate' } {
  const text = normalizeCaption(incoming.text);
  if (!text) return { records: existing, action: 'duplicate' };
  const window = options.duplicateWindowSeconds ?? 25;
  const records = existing.slice();

  // 在时间窗口内回看最近记录：字幕循环显示、滚动重复、OCR 抖动都可能
  // 与"上一条"之外的同句重叠（例如循环播放或双语字幕交错）。
  for (let index = records.length - 1; index >= 0; index--) {
    const candidate = records[index]!;
    if (candidate.startTime < incoming.startTime - window) break;
    const same = isSameCaption(candidate.text, text);
    if (!same) continue;
    const gap = incoming.startTime - candidate.endTime;
    if (gap <= 1.6) {
      // 逐字增长/紧邻重复：保留更完整的文本，扩展时间区间
      const keepLonger = comparableText(text).length >= comparableText(candidate.text).length ? text : candidate.text;
      candidate.text = keepLonger;
      candidate.startTime = Math.min(candidate.startTime, incoming.startTime);
      candidate.endTime = Math.max(candidate.endTime, incoming.endTime);
      candidate.confidence = Math.max(candidate.confidence ?? 0, incoming.confidence ?? 0) || undefined;
      candidate.mergedCount += 1;
      return { records, action: 'merged' };
    }
    // 时间邻近的重复显示（滚动字幕重复、循环播放、OCR 抖动）
    if (Math.abs(incoming.startTime - candidate.startTime) <= window) {
      candidate.endTime = Math.max(candidate.endTime, incoming.endTime);
      if (incoming.confidence !== undefined) {
        candidate.confidence = Math.max(candidate.confidence ?? 0, incoming.confidence);
      }
      return { records, action: 'duplicate' };
    }
  }

  records.push({
    ...incoming,
    text,
    id: options.makeId(),
    mergedCount: 0,
    endTime: Math.max(incoming.endTime, incoming.startTime + 0.2),
  });
  return { records, action: 'added' };
}

/** 批量合并（用于一次消息包含多条） */
export function mergeCaptions(
  existing: CaptionRecord[],
  incoming: CaptionInput[],
  options: { duplicateWindowSeconds?: number; makeId: () => string },
): { records: CaptionRecord[]; added: CaptionRecord[] } {
  let records = existing.slice();
  const added: CaptionRecord[] = [];
  for (const item of [...incoming].sort((a, b) => a.startTime - b.startTime)) {
    const result = mergeCaption(records, item, options);
    if (result.action === 'added') {
      added.push(result.records[result.records.length - 1]);
    }
    records = result.records;
  }
  return { records, added };
}

/**
 * 字幕区域 OCR 结果清理：
 * - 去掉常见误识别噪声（纯符号、单字标点）
 * - 保留低置信度标记，不补全缺字
 */
export function cleanOcrCaption(text: string, confidence?: number): { text: string; confidence?: number } {
  const normalized = normalizeCaption(text)
    .split('\n')
    .filter((line) => /[\p{L}\p{N}]/u.test(line))
    .join('\n');
  return { text: normalized, confidence };
}

/** 判断疑似 PPT 正文而非字幕（过长的多行文本、包含大量数字/项目符号） */
export function looksLikeSlideText(text: string): boolean {
  const normalized = normalizeCaption(text);
  const lines = normalized.split('\n').filter(Boolean);
  if (lines.length >= 4 && normalized.length > 120) return true;
  const bulletLines = lines.filter((l) =>
    /^\s*([•·▪◦*\-–—]|\d+[.)、]|[一二三四五六七八九十]+[、.)]|[（(]\d+[）)])\s*/.test(l),
  ).length;
  // 三条以上项目符号行基本可判定为课件正文；长文本两条即可
  if (lines.length >= 3 && bulletLines >= 3) return true;
  return lines.length >= 2 && bulletLines >= 2 && normalized.length > 60;
}
