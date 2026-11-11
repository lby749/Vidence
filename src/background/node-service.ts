/**
 * 规则节点构建与增量重建。
 *
 * 同一会话的"草稿节点"可重复重建；已整理节点（organized/review）与用户笔记不被覆盖。
 */

import { getDb } from '@/db/db';
import type { Evidence, MemoryNode } from '@/shared/types';
import { draftTitle, segmentEvidence } from '@/pipeline/segmenter';
import { uid } from '@/shared/ids';
import { markIndexDirty } from './index-service';

export interface RebuildResult {
  created: number;
  updated: number;
  removed: number;
}

export async function rebuildDraftNodes(videoId: string, sessionId: string): Promise<RebuildResult> {
  const db = getDb();
  const result: RebuildResult = { created: 0, updated: 0, removed: 0 };

  const allNodes = await db.nodes.where('videoId').equals(videoId).toArray();
  const protectedEvidence = new Set<string>();
  for (const node of allNodes) {
    if (node.status !== 'draft' || node.userNote || node.summary) {
      for (const id of node.evidenceIds) protectedEvidence.add(id);
    }
  }

  const sessionEvidence = (await db.evidence.where('videoId').equals(videoId).toArray())
    .filter((e) => e.sessionId === sessionId && !protectedEvidence.has(e.id))
    .sort((a, b) => a.startTime - b.startTime);

  const segments = segmentEvidence(sessionEvidence);
  const drafts = allNodes
    .filter((n) => n.sessionId === sessionId && n.status === 'draft' && !n.userNote && !n.summary)
    .sort((a, b) => a.startTime - b.startTime);

  const usedDrafts = new Set<string>();
  const evidenceAssignments = new Map<string, string>();

  for (const segment of segments) {
    const existing = drafts.find(
      (node) =>
        !usedDrafts.has(node.id) &&
        Math.abs(node.startTime - segment.startTime) < 1.2 &&
        Math.abs(node.endTime - segment.endTime) < 4,
    );
    if (existing) {
      usedDrafts.add(existing.id);
      const changed =
        existing.endTime !== segment.endTime ||
        existing.evidenceIds.length !== segment.evidenceIds.length ||
        existing.searchText !== segment.text;
      if (changed) {
        const updated: MemoryNode = {
          ...existing,
          endTime: segment.endTime,
          evidenceIds: segment.evidenceIds,
          searchText: segment.text,
          title: existing.userEdited?.title ?? draftTitle(segment.text),
          revision: existing.revision + 1,
          updatedAt: Date.now(),
        };
        await db.nodes.put(updated);
        result.updated += 1;
      }
      for (const id of segment.evidenceIds) evidenceAssignments.set(id, existing.id);
    } else {
      const now = Date.now();
      const node: MemoryNode = {
        id: uid('node'),
        videoId,
        sessionId,
        title: draftTitle(segment.text),
        startTime: segment.startTime,
        endTime: segment.endTime,
        evidenceIds: segment.evidenceIds,
        keyframeIds: [],
        tags: [],
        relatedNodeIds: [],
        status: 'draft',
        searchText: segment.text,
        createdAt: now,
        updatedAt: now,
        revision: 1,
      };
      await db.nodes.put(node);
      for (const id of segment.evidenceIds) evidenceAssignments.set(id, node.id);
      result.created += 1;
    }
  }

  // 删除已不存在分段的空草稿节点（保留有用户笔记或摘要的节点）
  for (const node of drafts) {
    if (!usedDrafts.has(node.id) && node.evidenceIds.every((id) => !sessionEvidence.some((e) => e.id === id))) {
      await db.nodes.delete(node.id);
      result.removed += 1;
    }
  }

  // 回填证据的 nodeId
  const evidenceUpdates: Evidence[] = [];
  for (const evidence of sessionEvidence) {
    const nodeId = evidenceAssignments.get(evidence.id);
    if (nodeId && evidence.nodeId !== nodeId) {
      evidenceUpdates.push({ ...evidence, nodeId });
    }
  }
  if (evidenceUpdates.length > 0) await db.evidence.bulkPut(evidenceUpdates);

  // 只挂到时间范围覆盖该画面的节点，不能把后半节课挂到早期笔记。
  const keyframes = await db.keyframes.where('videoId').equals(videoId).toArray();
  const frameNodes = (await db.nodes.where('videoId').equals(videoId).toArray()).sort((a, b) => a.startTime - b.startTime);
  const assigned = new Map<string, string[]>();
  for (const keyframe of keyframes) {
    const covers = (node: MemoryNode) => keyframe.time >= node.startTime && keyframe.time <= node.endTime;
    const node = frameNodes.find(node => node.id === keyframe.nodeId && covers(node)) ?? frameNodes.findLast(covers);
    if (keyframe.nodeId !== node?.id) await db.keyframes.update(keyframe.id, { nodeId: node?.id });
    if (node) assigned.set(node.id, [...(assigned.get(node.id) ?? []), keyframe.id]);
  }
  for (const node of frameNodes) {
    const ids = assigned.get(node.id) ?? [];
    if (ids.length !== node.keyframeIds.length || ids.some(id => !node.keyframeIds.includes(id))) {
      await db.nodes.update(node.id, { keyframeIds: ids, updatedAt: Date.now() });
    }
  }

  if (result.created + result.updated + result.removed > 0) markIndexDirty();
  return result;
}

/** 供 UI 使用的轻量时间线 */
export async function timelineForVideo(videoId: string, limit = 500): Promise<MemoryNode[]> {
  const db = getDb();
  return db.nodes.where('[videoId+startTime]').between([videoId, 0], [videoId, Number.MAX_SAFE_INTEGER]).limit(limit).toArray();
}
