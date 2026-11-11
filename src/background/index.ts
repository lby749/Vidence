/**
 * 后台 Service Worker 入口逻辑（路由与调度）。
 *
 * 全局变量只是缓存；状态以 IndexedDB + storage.session 为准。
 */

import { defineBackground } from 'wxt/utils/define-background';
import { getDb, getSettings } from '@/db/db';
import type { ContentMessage, Result, UiRequest } from '@/shared/messages';
import type { VideoProbe } from '@/shared/messages';
import type { AiAppRequest } from '@/shared/types';
import { getActiveSessionSync, loadActiveSession, recoverActiveSession, updateActiveSession } from './session-store';
import {
  handleSeek,
  findVideoFrame,
  handleVideoChanged,
  pauseRecording,
  recordRange,
  recoverInto,
  resumeRecording,
  startRecording,
  stopRecording,
} from './recording';
import { broadcastState, cacheProbe, emit, registerPeer, scheduleBroadcast, updatePeerTab } from './state-service';
import { ingestCaptions } from './subtitle-service';
import { handleSignature, saveManualKeyframe } from './visual-service';
import { cancelSubtitleDiscovery, discoverSubtitleRegion, handleSubtitleOcrFrame, useManualRoi } from './discovery-service';
import { pickRoiOnPage, requestCanvasFrame, sendToFrame, sendToSession } from './capture-client';
import { identifyVideo } from '@/shared/video-identity';
import { videoUrlAt } from '@/ui/chrome';
import { ensureIndex, markIndexDirty } from './index-service';
import { askQuestion, prepareQueryContext, AskCanceledError } from '@/agent/question-agent';
import { buildDiagnostics } from './diagnostics';
import { processSyncJobs, runNotionSync, testConnection } from '@/notion/sync';
import {
  cancelAiRequest,
  confirmAndSend,
  launchAiRequest,
  openConnectorTab,
  prepareAiRequest,
  readAnswerNow,
  reconcileInterruptedRequests,
} from '@/aiapps/service';
import { buildHandoffText } from '@/aiapps/service';

import { askLocalAgent } from '@/agent/local-agent';
import { deleteVideoData } from './delete-video';

const askControllers = new Map<string, AbortController>();

export default defineBackground(() => {
  void bootstrap();
});

async function bootstrap(): Promise<void> {
  const enableSidePanel = async () => {
    try {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    } catch {
      /* Firefox 等不支持 sidePanel 的环境 */
    }
  };
  void enableSidePanel();
  chrome.runtime.onInstalled.addListener(() => void enableSidePanel());

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'ui') return;
    registerPeer(port);
    port.onMessage.addListener((message: { type?: string; payload?: { tabId?: number } }) => {
      if (message?.type === 'ui:subscribe') {
        if (message.payload?.tabId !== undefined) updatePeerTab(port, message.payload.tabId);
        void broadcastState(message.payload?.tabId);
      }
    });
  });

  chrome.runtime.onMessage.addListener((message: ContentMessage | UiRequest, sender, sendResponse) => {
    const type = (message as { type?: string })?.type ?? '';
    if (type.startsWith('content:')) {
      void handleContent(message as ContentMessage, sender)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error) => sendResponse({ ok: false, error: { code: 'internal', message: (error as Error).message } }));
      return true;
    }
    if (type.startsWith('ui:')) {
      void handleUi(message as UiRequest, sendResponse);
      return true;
    }
    return false;
  });

  chrome.alarms.create('notion-sync', { periodInMinutes: 1 });
  chrome.alarms.create('index-refresh', { periodInMinutes: 5 });
  chrome.alarms.create('background-jobs', { periodInMinutes: 2 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'notion-sync') void processSyncJobs().catch(() => undefined);
    if (alarm.name === 'index-refresh') void ensureIndex().catch(() => undefined);
    if (alarm.name === 'background-jobs') {
      void (async () => {
        const { processOrganizeJobs, organizeDraftNodes } = await import('./organizer');
        const { embedPendingNodes } = await import('./embedding-service');
        await processOrganizeJobs().catch(() => undefined);
        // 记录过程中也进行小批量整理（受每小时调用上限约束）
        if (getActiveSessionSync() && !getActiveSessionSync()?.paused) {
          await organizeDraftNodes(3).catch(() => undefined);
        }
        await embedPendingNodes(6).catch(() => undefined);
      })();
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    const active = getActiveSessionSync();
    if (active?.tabId === tabId) {
      void stopRecording()
        .then(() => scheduleBroadcast())
        .catch(() => undefined);
    }
  });

  const recovered = await recoverActiveSession();
  if (recovered) await broadcastState();
  await reconcileInterruptedRequests().catch(() => undefined);
  await ensureIndex().catch(() => undefined);
}

async function handleContent(message: ContentMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const tabId = sender.tab?.id;
  const frameId = sender.frameId ?? 0;

  switch (message.type) {
    case 'content:hello': {
      if (tabId === undefined) return null;
      cacheProbe(tabId, message.payload.probe, message.payload.title, message.payload.url);
      const active = await loadActiveSession();
      if (active && active.tabId === tabId) {
        await updateActiveSession({ frameId });
        await recoverInto({ ...active, frameId });
      }
      scheduleBroadcast(tabId);
      return { ok: true };
    }
    case 'content:probe': {
      if (tabId === undefined) return null;
      cacheProbe(tabId, message.payload.probe, message.payload.title, message.payload.url);
      scheduleBroadcast(tabId);
      return { ok: true };
    }
    case 'content:probe-result': {
      if (tabId === undefined) return null;
      cacheProbe(tabId, message.payload.probe, message.payload.title, message.payload.url);
      scheduleBroadcast(tabId);
      return { ok: true };
    }
    case 'content:player-state': {
      const active = getActiveSessionSync();
      if (!active || active.tabId !== tabId) return null;

      // 视频暂停 → 自动暂停记录；继续播放 → 自动恢复。
      // 用户手动暂停时 autoPausedByVideo=false，不会被视频播放强行恢复。
      if (active.tabId === tabId && typeof message.payload.paused === 'boolean') {
        if (message.payload.paused && !active.paused) {
          await pauseRecording('video');
          scheduleBroadcast(tabId);
        } else if (!message.payload.paused && active.paused && active.autoPausedByVideo) {
          await resumeRecording();
          scheduleBroadcast(tabId);
        }
      }

      const db = getDb();
      const video = await db.videos.get(active.videoId);
      const now = Date.now();
      if (video && now - (video.updatedAt ?? 0) > 2000) {
        await db.videos.update(active.videoId, {
          lastPosition: message.payload.currentTime,
          duration: Math.max(video.duration, message.payload.duration),
          updatedAt: now,
        });
      }
      return null;
    }
    case 'content:captions': {
      const active = getActiveSessionSync();
      if (!active || active.sessionId !== message.payload.sessionId) return null;
      const video = await getDb().videos.get(active.videoId);
      const firstSource = message.payload.items[0]?.source;
      const result = await ingestCaptions({
        videoId: message.payload.videoId,
        sessionId: message.payload.sessionId,
        epoch: message.payload.epoch,
        sessionEpoch: active.epoch,
        items: message.payload.items,
        duration: video?.duration ?? 0,
        source: {
          kind: firstSource === 'ocr' ? 'ocr' : firstSource === 'dom' ? 'dom' : 'texttrack',
          label:
            firstSource === 'ocr'
              ? '字幕区域 OCR'
              : firstSource === 'dom'
                ? '页面字幕节点'
                : '视频文本轨',
          lastTextAt: Date.now(),
        },
      });
      if (result.added > 0) scheduleBroadcast(tabId);
      return result;
    }
    case 'content:subtitle-source': {
      const active = getActiveSessionSync();
      if (!active) return null;
      const source = message.payload.source;
      if (active.sessionId !== message.payload.sessionId || active.epoch !== message.payload.epoch) return null;
      if (source.kind === 'none' && active.subtitleSource.roi) return null;
      await updateActiveSession({ subtitleSource: source });
      await getDb().sessions.update(active.sessionId, { subtitleSource: source });
      if (source.kind === 'texttrack' || source.kind === 'dom') {
        cancelSubtitleDiscovery(active.sessionId);
        await sendToSession(active, {
          type: 'capture:ocr-config',
          payload: { sessionId: active.sessionId, epoch: active.epoch, enabled: false },
        });
      }
      scheduleBroadcast(tabId);
      return { ok: true };
    }
    case 'content:record-range': {
      const active = getActiveSessionSync();
      if (!active) return null;
      recordRange(active.videoId, active.sessionId, message.payload.range);
      return null;
    }
    case 'content:seek': {
      const active = getActiveSessionSync();
      if (!active || active.sessionId !== message.payload.sessionId) return null;
      const next = await handleSeek(active, message.payload.to);
      if (message.payload.epoch > next.epoch) await updateActiveSession({ epoch: message.payload.epoch });
      scheduleBroadcast(tabId);
      return { epoch: message.payload.epoch };
    }
    case 'content:signature': {
      const active = getActiveSessionSync();
      if (!active) return null;
      const settings = await getSettings();
      if (!settings.capture.keyframeBudget) return null;
      await handleSignature(active, message.payload, (event) => {
        if (event.type === 'keyframe-saved') scheduleBroadcast(tabId);
        if (event.type === 'warning') {
          emit({ type: 'toast', payload: { level: 'warn', message: event.reason ?? '画面采集警告' } }, tabId);
        }
      });
      return null;
    }
    case 'content:ocr-frame': {
      const active = getActiveSessionSync();
      if (!active || active.sessionId !== message.payload.sessionId) return null;
      const settings = await getSettings();
      if (!settings.ocr.enabled) return null;
      try {
        const result = await handleSubtitleOcrFrame({
          session: active,
          dataUrl: message.payload.dataUrl,
          time: message.payload.time,
          epoch: message.payload.epoch,
        });
        if (result.accepted) scheduleBroadcast(tabId);
        return result;
      } catch (error) {
        const messageText = `字幕 OCR 失败：${(error as Error).message}`;
        await updateActiveSession({ lastWarning: messageText });
        emit({ type: 'toast', payload: { level: 'warn', message: messageText } }, tabId);
        return { accepted: false, reason: messageText };
      }
    }
    case 'content:video-changed': {
      const active = getActiveSessionSync();
      if (!active || active.tabId !== tabId) return null;
      // 重复的换集通知（URL 变化与视频元素变化会各触发一次）：只处理一次
      if (message.payload.fromVideoId !== active.videoId) return null;
      const result = await handleVideoChanged({
        active,
        toVideoId: message.payload.toVideoId,
        title: message.payload.title,
        url: message.payload.url,
      });
      scheduleBroadcast(tabId);
      return result ? { sessionId: result.active.sessionId } : null;
    }
    case 'content:get-tab': {
      if (tabId === undefined) throw new Error('无法定位当前标签页');
      return { tabId };
    }
    case 'content:quick-start': {
      if (tabId === undefined) throw new Error('无法定位当前标签页');
      const result = await startRecording(tabId);
      scheduleBroadcast(tabId);
      return { sessionId: result.active.sessionId, videoId: result.video.id, title: result.video.title };
    }
    case 'content:quick-action': {
      const action = message.payload.action;
      if (action === 'open-panel' || action === 'ask') {
        await openSidePanel(tabId);
        return { ok: true };
      }
      if (getActiveSessionSync()?.tabId !== tabId) throw new Error('这个标签页没有正在记录的视频');
      if (action === 'pause') await pauseRecording();
      if (action === 'resume') await resumeRecording();
      if (action === 'stop') await stopRecording();
      scheduleBroadcast(tabId);
      return { ok: true };
    }
    case 'content:error': {
      if (getActiveSessionSync()?.tabId !== tabId) return null;
      await updateActiveSession({ lastWarning: message.payload.message });
      emit({ type: 'toast', payload: { level: 'warn', message: message.payload.message } }, tabId);
      scheduleBroadcast(tabId);
      return null;
    }
    default:
      return null;
  }
}

async function handleUi(message: UiRequest, sendResponse: (response: Result<unknown>) => void): Promise<void> {
  try {
    const data = await routeUi(message);
    sendResponse({ ok: true, data });
  } catch (error) {
    const code = error instanceof AskCanceledError ? 'canceled' : 'internal';
    sendResponse({ ok: false, error: { code, message: (error as Error).message } });
  }
}

async function routeUi(message: UiRequest): Promise<unknown> {
  switch (message.type) {
    case 'ui:get-state': {
      const tabId = message.payload?.tabId ?? (await activeTabId());
      return buildStateDynamic(tabId);
    }
    case 'ui:start': {
      const result = await startRecording(message.payload.tabId);
      await broadcastState(message.payload.tabId);
      return {
        sessionId: result.active.sessionId,
        videoId: result.video.id,
        title: result.video.title,
        warning: result.warning,
      };
    }
    case 'ui:pause': {
      const paused = await pauseRecording();
      await broadcastState();
      return paused;
    }
    case 'ui:resume': {
      const resumed = await resumeRecording();
      await broadcastState();
      return resumed;
    }
    case 'ui:stop': {
      const stopped = await stopRecording();
      await broadcastState();
      return stopped;
    }
    case 'ui:seek': {
      const active = getActiveSessionSync();
      const videoId = message.payload.videoId ?? active?.videoId;
      const video = videoId ? await getDb().videos.get(videoId) : undefined;
      if (!video) throw new Error('视频记录不存在');
      const tabs = message.payload.tabId !== undefined ? [await chrome.tabs.get(message.payload.tabId)] : await chrome.tabs.query({});
      const tab = tabs.find(tab => tab.url && identifyVideo(tab.url, video.title).id === video.id);
      if (!tab?.id) { await chrome.tabs.create({ url: videoUrlAt(video.url, message.payload.time) }); return { ok: true }; }
      const found = await findVideoFrame(tab.id);
      if (!found) throw new Error('该视频页面尚未准备好');
      const result = await sendToFrame(tab.id, found.frameId, { type: 'capture:seek', payload: { time: message.payload.time } });
      if (!result) throw new Error('页面未响应跳转');
      return { ok: true };
    }
    case 'ui:frame': {
      const active = getActiveSessionSync();
      if (!active) throw new Error('当前没有活动记录会话');
      const attempt = await requestCanvasFrame(active, message.payload.mode, {
        roi: message.payload.roi,
        maxWidth: 960,
      });
      if (!attempt.frame) throw new Error(attempt.error ?? '画面采集失败');
      return attempt.frame;
    }
    case 'ui:manual-keyframe': {
      const active = getActiveSessionSync();
      if (!active) throw new Error('当前没有活动记录会话');
      const keyframe = await saveManualKeyframe(active);
      scheduleBroadcast(active.tabId);
      return { id: keyframe.id, time: keyframe.time };
    }
    case 'ui:detect-subtitles': {
      const active = getActiveSessionSync();
      if (!active) throw new Error('当前没有活动记录会话');
      if (message.payload?.manualRoi) {
        const outcome = await useManualRoi(active, message.payload.manualRoi);
        scheduleBroadcast(active.tabId);
        return outcome;
      }
      const roi = await pickRoiOnPage(active);
      if (roi) {
        const outcome = await useManualRoi(active, roi);
        scheduleBroadcast(active.tabId);
        return outcome;
      }
      const outcome = await discoverSubtitleRegion(active);
      scheduleBroadcast(active.tabId);
      return outcome;
    }
    case 'ui:ask': {
      const payload = message.payload;
      const active = getActiveSessionSync();
      const videoId = payload.videoId ?? active?.videoId;
      const targetTab = payload.tabId ?? active?.tabId;
      if (!videoId) throw new Error('请先选择一个已记录的视频');
      if (!(await getDb().videos.get(videoId))) throw new Error('视频记录不存在');
      const requestId = payload.requestId ?? `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const controller = new AbortController();
      askControllers.set(requestId, controller);
      emit({ type: 'ask:status', payload: { requestId, videoId, status: 'preparing' } }, targetTab);
      void (async () => {
        try {
          const { ctx, video, nodes } = await prepareQueryContext({
            requestId,
            videoId,
            question: payload.question,
            frozenTime: payload.frozenTime,
            selectedNodeIds: payload.selectedNodeIds,
            allowImages: payload.allowImages,
            route: payload.route,
            followUpTo: payload.followUpTo,
          });
          const result = await (payload.route === 'local-agent' ? askLocalAgent : askQuestion)({
            ctx,
            video,
            nodes,
            externalSignal: controller.signal,
            callbacks: {
              onStatus: (status, detail) => emit({ type: 'ask:status', payload: { requestId, videoId, status, detail } }, targetTab),
              onDelta: (text) => emit({ type: 'ask:delta', payload: { requestId, videoId, text } }, targetTab),
            },
          });
          emit(
            {
              type: 'ask:done',
              payload: { requestId, videoId, memoryContext: result.memoryContext, answer: result.answer, citations: result.citations, usage: result.usage },
            },
            targetTab,
          );
          if (result.warnings.length > 0) {
            emit({ type: 'toast', payload: { level: 'info', message: result.warnings.join('；') } }, targetTab);
          }
        } catch (error) {
          const messageText = error instanceof AskCanceledError ? '已取消' : (error as Error).message;
          await getDb().chats.put({ id: `failed_${requestId}`, requestId, videoId, question: payload.question, citations: [], route: payload.route === 'local-agent' ? 'local-agent' : 'api', status: controller.signal.aborted ? 'canceled' : 'failed', error: messageText, createdAt: Date.now() });
          emit({ type: 'ask:error', payload: { requestId, videoId, code: controller.signal.aborted ? 'canceled' : 'ask_failed', message: messageText } }, targetTab);
        } finally {
          askControllers.delete(requestId);
          scheduleBroadcast(targetTab);
        }
      })();
      return { requestId };
    }
    case 'ui:cancel-ask': {
      askControllers.get(message.payload.requestId)?.abort();
      return { ok: true };
    }
    case 'ui:ai-prepare': {
      const payload = message.payload;
      const prepared = await prepareAiRequest({
        connectorId: payload.connectorId,
        videoId: (await requireActiveVideoId()),
        question: payload.question,
        frozenTime: payload.frozenTime,
        selectedNodeIds: payload.selectedNodeIds,
        allowImages: payload.allowImages,
      });
      const tabId = await openConnectorTab(payload.connectorId, prepared.request.requestId);
      return {
        requestId: prepared.request.requestId,
        tabId,
        status: 'awaiting-confirm',
        promptChars: prepared.prompt.length,
        evidenceCount: prepared.evidence.length,
      };
    }
    case 'ui:ai-send': {
      return launchAiRequest(message.payload.requestId, { confirmSend: message.payload.confirmSend });
    }
    case 'ui:ai-confirm': {
      return confirmAndSend(message.payload.requestId);
    }
    case 'ui:ai-read': {
      return readAnswerNow(message.payload.requestId);
    }
    case 'ui:ai-cancel': {
      await cancelAiRequest(message.payload.requestId);
      return { ok: true };
    }
    case 'ui:handoff': {
      const active = getActiveSessionSync();
      const payload = message.payload;
      const videoId = payload.videoId ?? active?.videoId;
      if (!videoId) throw new Error('请先选择已记录的视频');
      const { video, nodes } = await prepareQueryContext({
        requestId: `handoff_${Date.now()}`,
        videoId,
        question: payload.question,
        frozenTime: payload.frozenTime,
        selectedNodeIds: payload.selectedNodeIds,
        allowImages: false,
        route: 'ai-app',
      });
      const evidenceIds = [...new Set(nodes.flatMap((n) => n.evidenceIds))];
      const evidence = await getDb().evidence.bulkGet(evidenceIds);
      return {
        text: await buildHandoffText({
          video,
          question: payload.question,
          frozenTime: payload.frozenTime,
          nodes,
          evidence: evidence.filter((e): e is NonNullable<typeof e> => Boolean(e)),
        }),
      };
    }
    case 'ui:open-connector': {
      const tabId = await openConnectorTab(message.payload.connectorId, message.payload.requestId);
      return { tabId };
    }
    case 'ui:notion-test': {
      const settings = await getSettings();
      if (!settings.notion) throw new Error('尚未配置 Notion');
      return testConnection(settings.notion);
    }
    case 'ui:notion-sync': {
      return runNotionSync({ videoId: message.payload.videoId });
    }
    case 'ui:rebuild-index': {
      markIndexDirty();
      await ensureIndex(true);
      if (message.payload.kind === 'keyword') return { ok: true, embedded: 0, message: '关键词索引已重建' };
      const { embedPendingNodes } = await import('./embedding-service');
      const embedded = await embedPendingNodes(20);
      await ensureIndex(true);
      return { ok: true, embedded: embedded.embedded, message: embedded.message };
    }
    case 'ui:delete-video': {
      return deleteVideoCascade(message.payload.videoId);
    }
    case 'ui:diagnostics': {
      return buildDiagnostics();
    }
    case 'ui:search': {
      const { searchLibrary } = await import('./index-service');
      const result = await searchLibrary({
        query: message.payload.query,
        videoId: message.payload.videoId,
        limit: message.payload.limit ?? 30,
        useVector: (await getSettings()).retrieval.vector,
      });
      return result;
    }
    case 'ui:export': {
      const { exportBundle } = await import('@/export/bundle');
      return exportBundle({ videoId: message.payload.videoId });
    }
    default:
      throw new Error(`未知的 UI 请求：${(message as { type: string }).type}`);
  }
}

async function buildStateDynamic(tabId?: number) {
  const { buildState } = await import('./state-service');
  return buildState(tabId);
}

async function requireActiveVideoId(): Promise<string> {
  const active = getActiveSessionSync();
  if (!active) throw new Error('当前没有活动记录会话');
  return active.videoId;
}

async function activeTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

/**
 * 打开侧边栏；若浏览器/手势限制导致失败，退化为独立小窗口，
 * 保证页面内“侧边栏/提问”按钮始终有可用结果。
 */
async function openSidePanel(tabId?: number): Promise<void> {
  const target = tabId ?? (await activeTabId());
  if (target === undefined) throw new Error('无法定位标签页');
  try {
    if (chrome.sidePanel?.open) {
      await chrome.sidePanel.open({ tabId: target });
      return;
    }
  } catch {
    /* 继续退化 */
  }
  await chrome.windows.create({
    url: chrome.runtime.getURL(`sidepanel.html?tabId=${target}`),
    type: 'popup',
    width: 430,
    height: 820,
  });
}

/** 删除指定视频的全部本地数据；不触碰其他视频 */
export async function deleteVideoCascade(videoId: string): Promise<{ ok: true; removed: Record<string, number> }> {
  const result = await deleteVideoData(videoId);
  await broadcastState();
  return result;
}

export type { AiAppRequest };
