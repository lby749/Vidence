/**
 * 侧边栏状态快照与事件广播。
 * 每个 UI 连接只收到自己标签页的状态，避免多窗口互相干扰。
 */

import { getDb, getSettings } from '@/db/db';
import type { AppStateSnapshot, AppEvent } from '@/shared/messages';
import type { VideoProbe } from '@/shared/messages';
import type { Video } from '@/shared/types';
import { usageToday } from '@/providers';
import { notionStatus } from '@/notion/sync';
import { connectorRuntimes } from '@/aiapps/service';
import { getActiveSessionSync, loadActiveSession } from './session-store';
import { indexStatus } from './index-service';
import { identifyVideo } from '@/shared/video-identity';

const probes = new Map<number, { probe: VideoProbe | null; title: string; url: string; at: number }>();

export function cacheProbe(tabId: number, probe: VideoProbe | null, title: string, url: string): void {
  probes.set(tabId, { probe, title, url, at: Date.now() });
}

export function getProbe(tabId: number | undefined): VideoProbe | null {
  if (tabId === undefined) return null;
  return probes.get(tabId)?.probe ?? null;
}

interface Peer {
  port: chrome.runtime.Port;
  tabId?: number;
}

const peers = new Set<Peer>();
let broadcastTimer: ReturnType<typeof setTimeout> | null = null;

export function registerPeer(port: chrome.runtime.Port, tabId?: number): void {
  const peer: Peer = { port, tabId };
  peers.add(peer);
  port.onDisconnect.addListener(() => peers.delete(peer));
}

export function updatePeerTab(port: chrome.runtime.Port, tabId: number): void {
  for (const peer of peers) {
    if (peer.port === port) peer.tabId = tabId;
  }
}

export function emit(event: AppEvent, tabId?: number): void {
  for (const peer of peers) {
    if (tabId !== undefined && peer.tabId !== undefined && peer.tabId !== tabId) continue;
    try {
      peer.port.postMessage(event);
    } catch {
      peers.delete(peer);
    }
  }
}

export function scheduleBroadcast(tabId?: number): void {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    void broadcastState(tabId);
  }, 400);
}

export async function broadcastState(tabId?: number): Promise<void> {
  if (peers.size === 0) return;
  for (const peer of peers) {
    try {
      const state = await buildState(peer.tabId ?? tabId);
      peer.port.postMessage({ type: 'state', payload: state } satisfies AppEvent);
    } catch {
      peers.delete(peer);
    }
  }
}

export async function buildState(tabId?: number): Promise<AppStateSnapshot> {
  const db = getDb();
  const settings = await getSettings();
  const active = (await loadActiveSession()) ?? getActiveSessionSync();
  const activeForTab = active && (tabId === undefined || active.tabId === tabId) ? active : null;

  let video: Video | null = null;
  let session = null as AppStateSnapshot['session'];
  if (activeForTab) {
    video = (await db.videos.get(activeForTab.videoId)) ?? null;
    session = (await db.sessions.get(activeForTab.sessionId)) ?? null;
  } else if (tabId !== undefined) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.url && !tab.url.startsWith('chrome-extension:')) {
      video = (await db.videos.get(identifyVideo(tab.url, getProbe(tabId)?.title || tab.title || '').id)) ?? null;
    }
  }

  const nodes = video
    ? await db.nodes.where('[videoId+startTime]').between([video.id, 0], [video.id, Number.MAX_SAFE_INTEGER]).limit(400).toArray()
    : [];
  const recent = video
    ? await db.evidence.where('videoId').equals(video.id).sortBy('startTime')
    : [];
  const recentSorted = recent.slice(-30).reverse();
  const lastTurn = video ? (await db.chats.where('videoId').equals(video.id).sortBy('createdAt')).at(-1) : undefined;

  const [usage, notion, connectors, videoCount, nodeCount, evidenceCount, keyframeCount] = await Promise.all([
    usageToday(),
    notionStatus().catch(() => ({
      configured: false,
      enabled: false,
      pending: 0,
      lastSyncAt: undefined as number | undefined,
      error: undefined as string | undefined,
    })),
    connectorRuntimes().catch(() => []),
    db.videos.count(),
    db.nodes.count(),
    db.evidence.count(),
    db.keyframes.count(),
  ]);

  const warnings: string[] = [];
  if (!settings.localAgent?.token && !settings.roles.answerModel && !settings.providers.some((p) => p.apiKey)) {
    warnings.push('未配置 API 提供商：可使用 AI 应用问答或本地记录与检索');
  }
  if (session && session.subtitleSource.kind === 'none') {
    warnings.push('尚未发现字幕：可在页面上手动框选字幕区域，或继续等待');
  }
  if (video && video.recordedRanges.length > 0) {
    const total = video.recordedRanges.reduce((sum, [a, b]) => sum + (b - a), 0);
    if (video.lastPosition > total + 5 && video.duration > 0) {
      warnings.push(`记录范围存在缺口：已记录约 ${Math.round(total)} 秒，播放位置 ${Math.round(video.lastPosition)} 秒`);
    }
  }
  if (active?.lastWarning) warnings.push(active.lastWarning);
  const index = indexStatus();
  if (index.error) warnings.push(`检索索引异常：${index.error}`);

  return {
    tabId,
    video,
    session,
    probe: getProbe(tabId ?? activeForTab?.tabId),
    subtitleSource: session?.subtitleSource ?? { kind: 'none', label: '未开始记录' },
    recording: Boolean(activeForTab && activeForTab.sessionId),
    paused: Boolean(activeForTab?.paused),
    recentEvidence: recentSorted.map((e) => ({
      id: e.id,
      text: (e.correctedText || e.text).slice(0, 160),
      startTime: e.startTime,
      endTime: e.endTime,
      source: e.source,
    })),
    nodes: nodes.map((n) => ({
      id: n.id,
      title: n.title,
      startTime: n.startTime,
      endTime: n.endTime,
      status: n.status,
      summary: n.summary,
    })),
    usage: {
      calls: usage.calls,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      imageUploads: usage.imageUploads,
      estimatedCostUsd: usage.costUsd,
    },
    notion: {
      configured: notion.configured,
      lastSyncAt: notion.lastSyncAt,
      pending: notion.pending,
      error: notion.error,
    },
    aiApps: connectors.map((c) => ({
      id: c.id,
      label: c.label,
      status: c.status,
      capabilities: [c.statusLabel, ...c.reasons].slice(0, 3),
    })),
    connectors: [],
    library: { videos: videoCount, nodes: nodeCount, evidence: evidenceCount, keyframes: keyframeCount },
    warnings,
    lastTurn: lastTurn ? { requestId: lastTurn.requestId, answer: lastTurn.answer, citations: lastTurn.citations, status: lastTurn.status } : undefined,
  };
}
