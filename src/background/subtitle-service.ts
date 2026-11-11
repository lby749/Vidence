/**
 * 字幕证据落库与节点重建。
 *
 * 规则：
 * - 先落原始证据，节点与索引是可重建的派生数据；
 * - 只接受与当前会话 videoId/sessionId 匹配且代次不早于当前代的写入；
 * - 去重只针对时间邻近的重复显示；
 * - 记录范围按区间并集维护。
 */

import { getDb } from '@/db/db';
import type { RawCaption } from '@/shared/messages';
import type { Evidence, Session, SubtitleSourceState } from '@/shared/types';
import { mergeCaption, cleanOcrCaption, type CaptionRecord } from '@/pipeline/subtitle';
import { addRecordedRange } from '@/pipeline/range';
import { uid } from '@/shared/ids';
import { SUBTITLE } from '@/shared/constants';
import { rebuildDraftNodes } from './node-service';

export interface IngestResult {
  added: number;
  merged: number;
  duplicates: number;
  rejected: number;
}

function toRecord(evidence: Evidence): CaptionRecord {
  return {
    id: evidence.id,
    text: evidence.correctedText ?? evidence.text,
    startTime: evidence.startTime,
    endTime: evidence.endTime,
    source: evidence.source === 'visual' ? 'manual' : evidence.source,
    confidence: evidence.confidence,
    provenance: evidence.provenance,
    keyframeId: evidence.keyframeId,
    mergedCount: 0,
  };
}

export async function ingestCaptions(params: {
  videoId: string;
  sessionId: string;
  epoch: number;
  sessionEpoch: number;
  items: RawCaption[];
  duration: number;
  source: SubtitleSourceState;
}): Promise<IngestResult> {
  const result: IngestResult = { added: 0, merged: 0, duplicates: 0, rejected: 0 };
  if (params.items.length === 0) return result;
  const db = getDb();
  const session = await db.sessions.get(params.sessionId);
  if (!session || session.videoId !== params.videoId || session.status !== 'recording') {
    result.rejected += params.items.length;
    return result;
  }
  if (params.epoch < Math.max(params.sessionEpoch, session.captureEpoch)) {
    // 旧代次：seek/换视频后迟到的任务，丢弃
    result.rejected += params.items.length;
    return result;
  }

  const sortedItems = [...params.items].sort((a, b) => a.startTime - b.startTime);
  const windowStart = Math.max(0, Math.min(...sortedItems.map((i) => i.startTime)) - 30);
  const windowEnd = Math.max(...sortedItems.map((i) => i.endTime)) + 30;

  const nearby = await db.evidence
    .where('[videoId+startTime]')
    .between([params.videoId, windowStart], [params.videoId, windowEnd])
    .toArray();
  const nearbySorted = nearby.filter(row => row.source !== 'visual').sort((a, b) => a.startTime - b.startTime);
  const records = nearbySorted.map(toRecord);
  const existingById = new Map(nearbySorted.map((e) => [e.id, e]));

  for (const item of sortedItems) {
    const cleaned =
      item.source === 'ocr' ? cleanOcrCaption(item.text, item.confidence) : { text: item.text, confidence: item.confidence };
    if (!cleaned.text.trim() || item.startTime < 0 || item.endTime < item.startTime) {
      result.rejected += 1;
      continue;
    }
    const mergeResult = mergeCaption(
      records,
      {
        text: cleaned.text,
        startTime: Math.min(item.startTime, item.endTime),
        endTime: Math.max(item.startTime, item.endTime),
        source: item.source,
        confidence: item.confidence,
        provenance: item.provenance,
        keyframeId: item.keyframeId,
      },
      { duplicateWindowSeconds: SUBTITLE.duplicateWindowSeconds, makeId: () => uid('ev') },
    );
    records.splice(0, records.length, ...mergeResult.records);
    if (mergeResult.action === 'added') result.added += 1;
    else if (mergeResult.action === 'merged') result.merged += 1;
    else result.duplicates += 1;
  }

  const toAdd: Evidence[] = [];
  const toUpdate: Evidence[] = [];
  for (const record of records) {
    const existing = existingById.get(record.id);
    if (!existing) {
      toAdd.push({
        id: record.id,
        videoId: params.videoId,
        sessionId: params.sessionId,
        startTime: record.startTime,
        endTime: record.endTime,
        text: record.text,
        source: record.source,
        confidence: record.confidence,
        provenance: record.provenance,
        keyframeId: record.keyframeId,
        capturedAt: Date.now(),
        captureEpoch: params.epoch,
      });
    } else if (
      existing.text !== record.text ||
      Math.abs(existing.endTime - record.endTime) > 0.15 ||
      existing.confidence !== record.confidence
    ) {
      toUpdate.push({
        ...existing,
        text: record.text,
        endTime: record.endTime,
        confidence: record.confidence,
        captureEpoch: Math.max(existing.captureEpoch, params.epoch),
      });
    }
  }

  const current = await db.sessions.get(params.sessionId);
  if (!current || current.status !== 'recording' || current.captureEpoch > params.epoch) {
    return { added: 0, merged: 0, duplicates: 0, rejected: params.items.length };
  }
  if (toAdd.length > 0) await db.evidence.bulkAdd(toAdd);
  if (toUpdate.length > 0) await db.evidence.bulkPut(toUpdate);

  const observed = addRecordedRange(
    session.observedRanges ?? [],
    [
      Math.max(0, Math.min(...sortedItems.map((i) => i.startTime))),
      Math.max(...sortedItems.map((i) => i.endTime)),
    ],
  );
  await db.sessions.update(params.sessionId, {
    observedRanges: observed,
    captureEpoch: Math.max(session.captureEpoch, params.epoch),
    subtitleSource: { ...params.source, lastTextAt: Date.now() },
  });

  if (toAdd.length > 0 || toUpdate.length > 0) {
    scheduleNodeRebuild(params.videoId, params.sessionId);
  }
  return result;
}

interface RebuildSlot {
  timer: ReturnType<typeof setTimeout> | null;
  pending: boolean;
  running: boolean;
}

const rebuildSlots = new Map<string, RebuildSlot>();

/**
 * 节流（而不是无休止防抖）：连续字幕流下也保证每 ~2.5 秒至少重建一次，
 * 否则长时间播放会让节点一直无法生成。
 */
export function scheduleNodeRebuild(videoId: string, sessionId: string): void {
  const key = `${videoId}:${sessionId}`;
  let slot = rebuildSlots.get(key);
  if (!slot) {
    slot = { timer: null, pending: false, running: false };
    rebuildSlots.set(key, slot);
  }
  if (slot.running) {
    slot.pending = true;
    return;
  }
  if (slot.timer) {
    slot.pending = true;
    return;
  }
  const current = slot;
  current.timer = setTimeout(() => {
    current.timer = null;
    current.running = true;
    void rebuildDraftNodes(videoId, sessionId)
      .catch((error) => {
        console.warn('[视频记忆] 节点重建失败', error);
      })
      .finally(() => {
        current.running = false;
        if (current.pending) {
          current.pending = false;
          scheduleNodeRebuild(videoId, sessionId);
        }
      });
  }, 2500);
}
