/**
 * 记录会话生命周期：开始 / 暂停 / 恢复 / 停止 / 换视频 / 恢复。
 */

import { getDb, getSettings } from '@/db/db';
import type { Session, SubtitleSourceState, Video } from '@/shared/types';
import type { VideoProbe } from '@/shared/messages';
import { identifyVideo } from '@/shared/video-identity';
import { mergeRanges } from './range-util';
import { uid } from '@/shared/ids';
import {
  createSession,
  finishSession,
  setActiveSession,
  updateActiveSession,
  upsertVideo,
  countKeyframes,
  type ActiveSession,
} from './session-store';
import { sendToFrame, sendToSession } from './capture-client';
import { cancelSubtitleDiscovery, discoverSubtitleRegion } from './discovery-service';
import { resetVisualState } from './visual-service';
import { scheduleNodeRebuild } from './subtitle-service';

const rangeWriteTimers = new Map<string, ReturnType<typeof setTimeout>>();

export interface StartResult {
  active: ActiveSession;
  video: Video;
  probe: VideoProbe | null;
  warning?: string;
}

/** 在标签页的多帧中寻找真正包含视频的帧 */
export async function findVideoFrame(tabId: number): Promise<{ frameId: number; probe: VideoProbe | null } | null> {
  const frameIds = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const probes = await Promise.all(
    frameIds.map(async (frameId) => {
      const probe = await sendToFrame<{ probe: VideoProbe | null }>(
        tabId,
        frameId,
        { type: 'capture:probe', payload: {} },
        { timeoutMs: 1500 },
      );
      return { frameId, probe: probe?.probe ?? null };
    }),
  );
  const withVideo = probes.filter((p) => p.probe);
  if (withVideo.length === 0) return null;
  // 优先正在播放、面积大的视频
  withVideo.sort((a, b) => {
    const ap = a.probe!;
    const bp = b.probe!;
    if (ap.isPlaying !== bp.isPlaying) return ap.isPlaying ? -1 : 1;
    return bp.width * bp.height - ap.width * ap.height;
  });
  return withVideo[0]!;
}

export async function startRecording(tabId: number): Promise<StartResult> {
  const existing = await getDb().sessions.where('status').equals('recording').toArray();
  // 同一时间只保留一个活动记录会话；通知旧标签页停止采集
  for (const session of existing) {
    if (session.tabId !== undefined) {
      await sendToFrame(session.tabId, session.frameId, {
        type: 'capture:stop',
        payload: { sessionId: session.id },
      });
    }
    await finishSession(session.id);
  }
  await setActiveSession(null);

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.url) throw new Error('无法读取当前标签页');
  const found = await findVideoFrame(tabId);
  if (!found) throw new Error('当前页面没有可记录的 video 元素');

  const probe = found.probe;
  const identity = identifyVideo(tab.url, probe?.title || tab.title || document?.title || '');
  const settings = await getSettings();
  const video = await upsertVideo({
    id: identity.id,
    url: identity.url,
    canonicalUrl: identity.canonicalUrl,
    platform: identity.platform,
    title: identity.title,
    episodeId: identity.episodeId,
    duration: probe?.duration ?? 0,
  });

  const sessionId = uid('ses');
  const subtitleSource: SubtitleSourceState =
    probe?.hasReadableTextTracks
      ? { kind: 'texttrack', label: '视频文本轨', detectedAt: Date.now() }
      : probe && probe.subtitleDomCandidates > 0
        ? { kind: 'dom', label: '页面字幕节点', detectedAt: Date.now() }
        : { kind: 'none', label: '正在定位字幕…' };

  const session = await createSession({
    sessionId,
    videoId: video.id,
    tabId,
    frameId: found.frameId,
    epoch: 1,
    subtitleSource,
  });
  await getDb().videos.update(video.id, {
    sessionCount: (video.sessionCount ?? 0) + 1,
    lastPosition: probe?.currentTime ?? 0,
    updatedAt: Date.now(),
  });

  const active: ActiveSession = {
    sessionId,
    videoId: video.id,
    tabId,
    frameId: found.frameId,
    epoch: 1,
    paused: false,
    startedAt: Date.now(),
    title: identity.title,
    url: tab.url,
    subtitleSource,
    captureMode: 'canvas',
    keyframeCount: 0,
  };
  await setActiveSession(active);

  const started = await sendToSession<{ ok: true }>(active, {
    type: 'capture:start',
    payload: {
      sessionId,
      epoch: 1,
      videoId: video.id,
      subtitleMode: probe?.hasReadableTextTracks || (probe?.subtitleDomCandidates ?? 0) > 0 ? 'auto' : settings.ocr.enabled ? 'auto' : 'off',
      detectionBudgetMs: 10000,
    },
  });
  if (!started) {
    await finishSession(sessionId);
    await setActiveSession(null);
    throw new Error('无法启动页面采集（内容脚本未响应）');
  }

  // 内容脚本首次订阅签名采样
  await sendToSession(active, {
    type: 'capture:signature-config',
    payload: { enabled: true, intervalMs: 1500, maskRoi: undefined },
  });

  // 有可读字幕时不启动字幕 OCR；否则在观察预算内尝试定位
  if (subtitleSource.kind === 'none') {
    void discoverSubtitleRegion(active).catch(() => undefined);
  }

  void session;
  return { active, video, probe, warning: probe ? undefined : '未读取到播放器状态' };
}

export async function pauseRecording(reason: 'manual' | 'video' = 'manual'): Promise<ActiveSession | null> {
  const { getActiveSessionSync } = await import('./session-store');
  const active = getActiveSessionSync();
  if (!active) return null;
  await sendToSession(active, { type: 'capture:pause', payload: { sessionId: active.sessionId, reason } });
  await updateActiveSession({ paused: true, autoPausedByVideo: reason === 'video' });
  await getDb().sessions.update(active.sessionId, { status: 'paused' });
  return { ...active, paused: true, autoPausedByVideo: reason === 'video' };
}

export async function resumeRecording(): Promise<ActiveSession | null> {
  const { getActiveSessionSync } = await import('./session-store');
  const active = getActiveSessionSync();
  if (!active) return null;
  await sendToSession(active, { type: 'capture:resume', payload: { sessionId: active.sessionId } });
  await updateActiveSession({ paused: false, autoPausedByVideo: false });
  await getDb().sessions.update(active.sessionId, { status: 'recording' });
  return { ...active, paused: false, autoPausedByVideo: false };
}

export async function stopRecording(): Promise<{ videoId: string; sessionId: string } | null> {
  const { getActiveSessionSync } = await import('./session-store');
  const active = getActiveSessionSync();
  if (!active) return null;
  await sendToSession(active, { type: 'capture:stop', payload: { sessionId: active.sessionId } });
  cancelSubtitleDiscovery(active.sessionId);
  resetVisualState(active.sessionId);
  await finishSession(active.sessionId);
  await setActiveSession(null);
  await scheduleNodeRebuildNow(active.videoId, active.sessionId);
  void import('@/agent/knowledge-frames').then(({ autoReviewKnowledgeFrames }) => autoReviewKnowledgeFrames(active.videoId)).catch(error => getDb().sessions.update(active.sessionId, { note: `知识画面筛选未完成：${(error as Error).message}` }).catch(() => undefined));
  // 停止后排队整理（不阻塞停止响应；失败不影响本地数据）
  const { enqueueOrganizeJob } = await import('./organizer');
  await enqueueOrganizeJob().catch(() => undefined);
  return { videoId: active.videoId, sessionId: active.sessionId };
}

async function scheduleNodeRebuildNow(videoId: string, sessionId: string): Promise<void> {
  scheduleNodeRebuild(videoId, sessionId);
}

/** 处理 seek：使旧代次任务失效 */
export async function handleSeek(active: ActiveSession, to: number): Promise<ActiveSession> {
  const nextEpoch = active.epoch + 1;
  const next = { ...active, epoch: nextEpoch };
  await setActiveSession(next);
  await getDb().sessions.update(active.sessionId, { captureEpoch: nextEpoch });
  resetVisualState(active.sessionId);
  await getDb().videos.update(active.videoId, { lastPosition: to });
  return next;
}

/** 同页换集/换视频：结束旧会话，为新视频建立新会话，旧代次全部失效 */
export async function handleVideoChanged(params: {
  active: ActiveSession;
  toVideoId: string;
  title: string;
  url: string;
}): Promise<StartResult | null> {
  await finishSession(params.active.sessionId);
  cancelSubtitleDiscovery(params.active.sessionId);
  resetVisualState(params.active.sessionId);
  await setActiveSession(null);

  const tab = await chrome.tabs.get(params.active.tabId).catch(() => null);
  if (!tab?.url) return null;
  const identity = identifyVideo(tab.url, params.title);
  const settings = await getSettings();
  const video = await upsertVideo({
    id: identity.id || params.toVideoId,
    url: identity.url,
    canonicalUrl: identity.canonicalUrl,
    platform: identity.platform,
    title: identity.title || params.title,
    episodeId: identity.episodeId,
    duration: 0,
  });
  const sessionId = uid('ses');
  const probe = await sendToFrame<{ probe: VideoProbe | null }>(params.active.tabId, params.active.frameId, {
    type: 'capture:probe',
    payload: {},
  });
  const source: SubtitleSourceState = { kind: 'none', label: '正在定位字幕…' };
  await createSession({
    sessionId,
    videoId: video.id,
    tabId: params.active.tabId,
    frameId: params.active.frameId,
    epoch: 1,
    subtitleSource: source,
  });
  const active: ActiveSession = {
    ...params.active,
    sessionId,
    videoId: video.id,
    epoch: 1,
    paused: false,
    startedAt: Date.now(),
    title: identity.title,
    url: tab.url,
    subtitleSource: source,
    keyframeCount: 0,
  };
  await setActiveSession(active);
  await sendToSession(active, {
    type: 'capture:start',
    payload: {
      sessionId,
      epoch: 1,
      videoId: video.id,
      subtitleMode: settings.ocr.enabled ? 'auto' : 'off',
      detectionBudgetMs: 10000,
    },
  });
  void discoverSubtitleRegion(active).catch(() => undefined);
  return { active, video, probe: probe?.probe ?? null };
}

/** 记录范围更新（节流写库） */
export function recordRange(videoId: string, sessionId: string, range: [number, number]): void {
  const key = `${videoId}:${sessionId}`;
  const existing = rangeWriteTimers.get(key);
  if (existing) clearTimeout(existing);
  rangeWriteTimers.set(
    key,
    setTimeout(() => {
      rangeWriteTimers.delete(key);
      void (async () => {
        const db = getDb();
        const [video, session] = await Promise.all([db.videos.get(videoId), db.sessions.get(sessionId)]);
        if (video) {
          const merged = mergeRanges([...(video.recordedRanges ?? []), range]);
          await db.videos.update(videoId, {
            recordedRanges: merged,
            updatedAt: Date.now(),
          });
        }
        if (session) {
          const observed = mergeRanges([...(session.observedRanges ?? []), range]);
          const gaps = computeGaps(observed, video?.duration ?? 0);
          await db.sessions.update(sessionId, { observedRanges: observed, gaps });
        }
      })();
    }, 1200),
  );
}

function computeGaps(observed: Array<[number, number]>, duration: number): Array<[number, number]> {
  if (duration <= 0) return [];
  const merged = mergeRanges(observed);
  const gaps: Array<[number, number]> = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start - cursor > 1) gaps.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (duration - cursor > 1) gaps.push([cursor, duration]);
  return gaps;
}

/** SW 冷启动后恢复：重新向内容脚本下发采集配置 */
export async function recoverInto(active: ActiveSession): Promise<void> {
  const settings = await getSettings();
  const kf = await countKeyframes(active.videoId).catch(() => 0);
  await updateActiveSession({ keyframeCount: kf });
  await sendToSession(active, {
    type: 'capture:start',
    payload: {
      sessionId: active.sessionId,
      epoch: active.epoch,
      videoId: active.videoId,
      subtitleMode: settings.ocr.enabled ? 'auto' : 'off',
      detectionBudgetMs: 3000,
    },
  });
  await sendToSession(active, {
    type: 'capture:signature-config',
    payload: { enabled: true, intervalMs: 1500 },
  });
  if (active.subtitleSource.roi && active.subtitleSource.kind === 'ocr') {
    await sendToSession(active, {
      type: 'capture:ocr-config',
      payload: {
        sessionId: active.sessionId,
        epoch: active.epoch,
        enabled: true,
        roi: active.subtitleSource.roi,
      },
    });
  }
}

export async function sessionRow(sessionId: string): Promise<Session | null> {
  return (await getDb().sessions.get(sessionId)) ?? null;
}
