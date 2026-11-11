/**
 * Dexie / IndexedDB 数据库。
 *
 * 只在扩展自身 origin 下建库，不在视频网站 origin 下创建主数据库。
 * Background、侧边栏、知识库页面共享同一个数据库。
 */

import Dexie, { type Table } from 'dexie';
import { resourceTierPatch } from '@/shared/resource-tiers';
import { DB_NAME, DEFAULT_SETTINGS } from '@/shared/constants';
import type {
  AiAppRequest,
  ChatTurn,
  Evidence,
  IndexMetadata,
  Job,
  Keyframe,
  LongTermMemory,
  MemoryNode,
  Session,
  Settings,
  SyncState,
  UsageRecord,
  VectorRecord,
  Video,
} from '@/shared/types';

export class MemoryDB extends Dexie {
  videos!: Table<Video, string>;
  sessions!: Table<Session, string>;
  evidence!: Table<Evidence, string>;
  keyframes!: Table<Keyframe, string>;
  nodes!: Table<MemoryNode, string>;
  vectors!: Table<VectorRecord, string>;
  indexMeta!: Table<IndexMetadata, string>;
  jobs!: Table<Job, string>;
  syncState!: Table<SyncState, string>;
  chats!: Table<ChatTurn, string>;
  aiRequests!: Table<AiAppRequest, string>;
  settings!: Table<Settings, string>;
  usage!: Table<UsageRecord, string>;
  longMemories!: Table<LongTermMemory, string>;

  constructor(name = DB_NAME) {
    super(name);
    this.version(1).stores({
      videos: 'id, platform, updatedAt, createdAt',
      sessions: 'id, videoId, startedAt, status',
      evidence: 'id, videoId, sessionId, nodeId, startTime, [videoId+startTime], captureEpoch',
      keyframes: 'id, videoId, sessionId, nodeId, time, [videoId+time]',
      nodes: 'id, videoId, sessionId, status, startTime, [videoId+startTime], updatedAt',
      vectors: 'id, videoId, nodeId, evidenceId, modelId',
      indexMeta: 'id, kind',
      jobs: 'id, type, status, [status+nextRetryAt], updatedAt',
      syncState: 'id, entityType, localId, remotePageId',
      chats: 'id, requestId, videoId, createdAt',
      aiRequests: 'requestId, connectorId, videoId, status, createdAt',
      settings: 'id',
      usage: 'id, at, providerId, role',
    });
    this.version(2).stores({ longMemories: 'videoId, updatedAt' });
  }
}

let instance: MemoryDB | null = null;

export function getDb(): MemoryDB {
  if (!instance) instance = new MemoryDB();
  return instance;
}

/** 测试用：替换全局实例 */
export function setDbForTests(db: MemoryDB | null) {
  instance = db;
}

export async function getSettings(): Promise<Settings> {
  const db = getDb();
  const existing = await db.settings.get('app');
  if (existing) {
    return {
      ...DEFAULT_SETTINGS,
      ...existing,
      uiLanguage: existing.uiLanguage ?? 'zh-CN',
      capture: {
        ...DEFAULT_SETTINGS.capture, ...existing.capture, keyframePolicyVersion: 2,
        keyframeCooldownMs: !existing.capture?.keyframePolicyVersion && existing.capture?.keyframeCooldownMs === 8000 ? 4000 : existing.capture?.keyframeCooldownMs ?? DEFAULT_SETTINGS.capture.keyframeCooldownMs,
        maxFrameWidth: !existing.capture?.keyframeQualityVersion && existing.capture?.maxFrameWidth === 1280 ? 3840 : existing.capture?.maxFrameWidth ?? DEFAULT_SETTINGS.capture.maxFrameWidth,
        keyframeQualityVersion: 1,
      },
      ocr: { ...DEFAULT_SETTINGS.ocr, ...existing.ocr },
      retrieval: { ...DEFAULT_SETTINGS.retrieval, ...existing.retrieval },
      budget: { ...DEFAULT_SETTINGS.budget, ...existing.budget },
      privacy: { ...DEFAULT_SETTINGS.privacy, ...existing.privacy },
      experiment: { ...DEFAULT_SETTINGS.experiment, ...existing.experiment },
    } as Settings;
  }
  const initial = { ...DEFAULT_SETTINGS, updatedAt: Date.now() } as Settings;
  await db.settings.put(initial);
  return initial;
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const db = getDb();
  const { current, next } = await db.transaction('rw', db.settings, async () => {
    const current = await getSettings();
    if (patch.resourceTier) patch = { ...patch, ...resourceTierPatch(patch.resourceTier, current) };
    const next: Settings = {
      ...current,
      ...patch,
      capture: { ...current.capture, ...(patch.capture ?? {}) },
      ocr: { ...current.ocr, ...(patch.ocr ?? {}) },
      retrieval: { ...current.retrieval, ...(patch.retrieval ?? {}) },
      budget: { ...current.budget, ...(patch.budget ?? {}) },
      privacy: { ...current.privacy, ...(patch.privacy ?? {}) },
      experiment: { ...current.experiment, ...(patch.experiment ?? {}) },
      id: 'app',
      updatedAt: Date.now(),
    };
    await db.settings.put(next);
    return { current, next };
  });
  if (current.ocr.enabled !== next.ocr.enabled || current.retrieval.vector !== next.retrieval.vector || current.retrieval.rerank !== next.retrieval.rerank || current.resourceTier !== next.resourceTier) {
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) await chrome.runtime.sendMessage({ target: 'offscreen', type: 'compute:reset' }).catch(() => {});
  }
  return next;
}

/** 知识库修订号：用于取证快照与索引一致性判断（由节点最大修订号 + 证据数推导） */
export async function libraryRevision(): Promise<number> {
  const db = getDb();
  const evidenceCount = await db.evidence.count();
  const nodeCount = await db.nodes.count();
  return evidenceCount * 1_000_000 + nodeCount;
}

/** 清空全部本地数据（用户确认后调用）。 */
export async function wipeDatabase(): Promise<void> {
  const db = getDb();
  await Promise.all([
    db.videos.clear(),
    db.sessions.clear(),
    db.evidence.clear(),
    db.keyframes.clear(),
    db.nodes.clear(),
    db.vectors.clear(),
    db.indexMeta.clear(),
    db.jobs.clear(),
    db.syncState.clear(),
    db.chats.clear(),
    db.aiRequests.clear(),
    db.usage.clear(),
    db.longMemories.clear(),
  ]);
  // 保留设置中的隐私与模型配置，但删除可能残留的密钥由调用方另行确认
}
