/**
 * 规则节点切分（本地规则层，不依赖任何云模型）。
 * 按时间间隙、字数或时长切块，生成可浏览、可选中、可检索的基础节点。
 */

import { SEGMENT } from '@/shared/constants';
import type { Evidence, MemoryNode } from '@/shared/types';

export interface Segment {
  evidenceIds: string[];
  startTime: number;
  endTime: number;
  text: string;
  charCount: number;
}

export interface SegmentOptions {
  gapSeconds?: number;
  maxChars?: number;
  minChars?: number;
  maxDurationSeconds?: number;
}

export function segmentEvidence(
  items: Array<Pick<Evidence, 'id' | 'startTime' | 'endTime' | 'text'>>,
  options: SegmentOptions = {},
): Segment[] {
  const cfg = { ...SEGMENT, ...options };
  const sorted = [...items]
    .filter((e) => e.text.trim().length > 0)
    .sort((a, b) => a.startTime - b.startTime);

  // 单条证据过长时先按字数拆分（同一条证据 ID 可出现在多个分段中，
  // 便于切分超长 DOM 字幕；原始证据本身不被修改）
  const expanded: Array<Pick<Evidence, 'id' | 'startTime' | 'endTime' | 'text'>> = [];
  for (const item of sorted) {
    const text = item.text.trim();
    if (text.length <= cfg.maxChars) {
      expanded.push(item);
      continue;
    }
    const parts = Math.ceil(text.length / cfg.maxChars);
    const duration = Math.max(0.01, item.endTime - item.startTime);
    for (let index = 0; index < parts; index++) {
      const from = Math.floor((text.length / parts) * index);
      const to = Math.floor((text.length / parts) * (index + 1));
      expanded.push({
        id: item.id,
        text: text.slice(from, to),
        startTime: item.startTime + (duration / parts) * index,
        endTime: item.startTime + (duration / parts) * (index + 1),
      });
    }
  }

  const segments: Segment[] = [];
  let current: Segment | null = null;

  const flush = () => {
    if (current && current.charCount >= 1) segments.push(current);
    current = null;
  };

  for (const item of expanded) {
    const text = item.text.trim();
    if (!current) {
      current = {
        evidenceIds: [item.id],
        startTime: item.startTime,
        endTime: item.endTime,
        text,
        charCount: text.length,
      };
      continue;
    }
    const gap = item.startTime - current.endTime;
    const projectedChars = current.charCount + text.length + 1;
    const projectedDuration = item.endTime - current.startTime;
    if (
      gap > cfg.gapSeconds ||
      projectedChars > cfg.maxChars ||
      projectedDuration > cfg.maxDurationSeconds
    ) {
      flush();
      current = {
        evidenceIds: [item.id],
        startTime: item.startTime,
        endTime: item.endTime,
        text,
        charCount: text.length,
      };
    } else {
      current.evidenceIds.push(item.id);
      current.endTime = Math.max(current.endTime, item.endTime);
      current.text = `${current.text}\n${text}`;
      current.charCount = projectedChars;
    }
  }
  flush();

  // 太短的尾段并入前一段，避免产生大量碎片节点
  const merged: Segment[] = [];
  for (const seg of segments) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      seg.charCount < cfg.minChars &&
      seg.startTime - prev.endTime <= cfg.gapSeconds &&
      prev.charCount + seg.charCount <= cfg.maxChars * 1.5
    ) {
      prev.evidenceIds.push(...seg.evidenceIds);
      prev.endTime = Math.max(prev.endTime, seg.endTime);
      prev.text += `\n${seg.text}`;
      prev.charCount += seg.charCount;
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

/** 用首句/前若干字生成占位标题（不是 AI 摘要，不冒充整理结果） */
export function draftTitle(text: string, maxLen = 28): string {
  const firstLine = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ');
  if (!firstLine) return '未命名片段';
  // 优先取第一句，避免把下一句混进标题
  const sentenceMatch = firstLine.match(/^[^。！？!?；;]+/);
  const firstSentence = (sentenceMatch?.[0] ?? firstLine).trim();
  const hasMore = firstSentence.length < firstLine.length;
  const cut = firstSentence.slice(0, maxLen).replace(/[，、：,.!?;:]+$/, '');
  return hasMore || cut.length < firstSentence.length ? `${cut}…` : cut;
}

export function nodeFromSegment(
  segment: Segment,
  videoId: string,
  sessionId: string,
  makeId: () => string,
): MemoryNode {
  const now = Date.now();
  return {
    id: makeId(),
    videoId,
    sessionId,
    title: draftTitle(segment.text),
    startTime: segment.startTime,
    endTime: segment.endTime,
    evidenceIds: [...segment.evidenceIds],
    keyframeIds: [],
    tags: [],
    relatedNodeIds: [],
    status: 'draft',
    searchText: segment.text,
    createdAt: now,
    updatedAt: now,
    revision: 1,
  };
}

/** 将节点按时间排序并返回给侧边栏的轻量结构 */
export function timelineOf(nodes: MemoryNode[]): MemoryNode[] {
  return [...nodes].sort((a, b) => a.startTime - b.startTime);
}
