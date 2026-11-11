/**
 * 活动记录会话的状态管理。
 *
 * Service Worker 随时可能被停止，因此：
 * - 活动会话持久化到 chrome.storage.session（重启后可恢复）；
 * - 会话本身在 IndexedDB 中有对应记录（事实源）；
 * - 全局变量只作为缓存，不作为唯一状态源。
 */

import type { Session, SubtitleSourceState, Video } from '@/shared/types';
import { getDb } from '@/db/db';

const KEY = 'vma.activeSession';

export interface ActiveSession {
  sessionId: string;
  videoId: string;
  tabId: number;
  frameId: number;
  epoch: number;
  paused: boolean;
  /** 是否因视频本身暂停而自动暂停（区别于用户手动暂停） */
  autoPausedByVideo?: boolean;
  startedAt: number;
  title: string;
  url: string;
  subtitleSource: SubtitleSourceState;
  /** 采集路线：canvas（页面可读）或 tab-capture（用户授权） */
  captureMode: 'canvas' | 'tab-capture' | 'none';
  /** 已请求但尚未完成的关键帧预算计数 */
  keyframeCount: number;
  lastWarning?: string;
}

let cached: ActiveSession | null = null;
let loaded = false;

export async function loadActiveSession(): Promise<ActiveSession | null> {
  if (loaded) return cached;
  try {
    const stored = await chrome.storage.session.get(KEY);
    cached = (stored?.[KEY] as ActiveSession | undefined) ?? null;
  } catch {
    cached = null;
  }
  loaded = true;
  return cached;
}

export async function setActiveSession(session: ActiveSession | null): Promise<void> {
  cached = session;
  loaded = true;
  try {
    if (session) await chrome.storage.session.set({ [KEY]: session });
    else await chrome.storage.session.remove(KEY);
  } catch {
    /* storage.session 在部分旧版本不可用；缓存仍可用 */
  }
}

export function getActiveSessionSync(): ActiveSession | null {
  return cached;
}

export async function updateActiveSession(patch: Partial<ActiveSession>): Promise<ActiveSession | null> {
  const current = await loadActiveSession();
  if (!current) return null;
  const next = { ...current, ...patch };
  await setActiveSession(next);
  return next;
}

/** 会话开始：建立 DB 记录 */
export async function createSession(params: {
  sessionId: string;
  videoId: string;
  tabId: number;
  frameId: number;
  epoch: number;
  subtitleSource: SubtitleSourceState;
}): Promise<Session> {
  const db = getDb();
  const session: Session = {
    id: params.sessionId,
    videoId: params.videoId,
    startedAt: Date.now(),
    captureEpoch: params.epoch,
    status: 'recording',
    subtitleSource: params.subtitleSource,
    observedRanges: [],
    gaps: [],
    tabId: params.tabId,
    frameId: params.frameId,
  };
  await db.sessions.put(session);
  return session;
}

export async function finishSession(sessionId: string, status: 'stopped' = 'stopped'): Promise<void> {
  const db = getDb();
  const existing = await db.sessions.get(sessionId);
  if (!existing) return;
  await db.sessions.update(sessionId, { status, endedAt: Date.now() });
}

/** 确保 Video 记录存在（同页换集时更新标题/URL，不覆盖记录区间） */
export async function upsertVideo(params: {
  id: string;
  url: string;
  canonicalUrl: string;
  platform: string;
  title: string;
  episodeId?: string;
  duration: number;
}): Promise<Video> {
  const db = getDb();
  const now = Date.now();
  const existing = await db.videos.get(params.id);
  if (existing) {
    const updated: Video = {
      ...existing,
      url: params.url,
      canonicalUrl: params.canonicalUrl,
      title: params.title || existing.title,
      episodeId: params.episodeId ?? existing.episodeId,
      duration: Math.max(existing.duration, params.duration),
      updatedAt: now,
    };
    await db.videos.put(updated);
    return updated;
  }
  const video: Video = {
    id: params.id,
    url: params.url,
    canonicalUrl: params.canonicalUrl,
    platform: params.platform,
    title: params.title,
    episodeId: params.episodeId,
    duration: params.duration,
    lastPosition: 0,
    recordedRanges: [],
    createdAt: now,
    updatedAt: now,
    sessionCount: 0,
  };
  await db.videos.put(video);
  return video;
}

export async function countKeyframes(videoId: string): Promise<number> {
  return getDb().keyframes.where('videoId').equals(videoId).count();
}

/** SW 冷启动后恢复：确认会话仍然有效，返回可用于恢复的内容脚本目标 */
export async function recoverActiveSession(): Promise<{
  active: ActiveSession;
  session: Session | null;
  video: Video | null;
} | null> {
  const active = await loadActiveSession();
  if (!active) return null;
  const db = getDb();
  const session = await db.sessions.get(active.sessionId);
  const video = await db.videos.get(active.videoId);
  return { active, session: session ?? null, video: video ?? null };
}
