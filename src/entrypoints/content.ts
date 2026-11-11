/**
 * 内容脚本入口。
 *
 * 运行在页面中，负责：
 * - 发现视频、上报媒体状态；
 * - 观察可访问字幕（文本轨 / DOM），优先于 OCR；
 * - 在用户开始记录后按需采集画面签名与字幕 ROI 帧；
 * - 执行后台下发的跳转、暂停、ROI 设置等指令。
 *
 * 不访问数据库、不持有密钥、不执行页面或字幕中的任何指令。
 */

import { defineContentScript } from 'wxt/utils/define-content-script';
import type {
  BackgroundToContent,
  ContentMessage,
  FrameResult,
  RawCaption,
  VideoProbe,
} from '@/shared/messages';
import type { NormRect } from '@/shared/types';
import { identifyVideo } from '@/shared/video-identity';
import { addRecordedRange } from '@/pipeline/range';
import { PlayerAdapter } from '@/content/player-adapter';
import { SubtitleAdapter, type CaptionObservation } from '@/content/subtitle-adapter';
import { captureVideoFrame, sampleSignature, FrameCaptureError } from '@/content/frame';
import { diffSignatures, signatureFromImageData, subtitleMask } from '@/pipeline/visual';
import { selectRoiInteractive } from '@/content/roi-selector';
import { collapseLauncher, mountLauncher, updateLauncher } from '@/content/launcher';
import { closeDock, openDock, toggleDock } from '@/content/dock';

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_idle',
  matchAboutBlank: false,
  main(ctx) {
    // 只在包含视频的帧中工作，避免每个 iframe 都建立轮询
    const player = new PlayerAdapter();
    const subtitles = new SubtitleAdapter();
    let initialized = false;
    let hello: { sent: boolean } = { sent: false };

    interface RecordingState {
      sessionId: string;
      videoId: string;
      epoch: number;
      paused: boolean;
      subtitleMode: 'auto' | 'ocr' | 'off';
      roi?: NormRect;
      startedAt: number;
      lastTime: number;
      recordedRanges: [number, number][];
      captionsEnabled: boolean;
      ocrEnabled: boolean;
    }

    let recording: RecordingState | null = null;
    let captionQueue: RawCaption[] = [];
    let flushTimer: number | null = null;
    let stateTimer: number | null = null;
    let signatureTimer: number | null = null;
    let ocrTimer: number | null = null;
    let lastOcrSignature: ReturnType<typeof signatureFromImageData> | null = null;
    let lastOcrAt = 0;
    let lastUrlKey = '';
    let lastReportedRange: [number, number] | null = null;
    let lastSeekAt = 0;
    let launcherClock: number | null = null;
    let launcherMounted = false;
    let cachedTabId: number | null = null;

    const resolveTabId = async (): Promise<number | null> => {
      if (ctx.isInvalid) { location.reload(); return null; }
      if (cachedTabId !== null) return cachedTabId;
      const response = await sendBg<{ tabId: number }>({ type: 'content:get-tab', payload: {} });
      cachedTabId = response.ok ? (response.data?.tabId ?? null) : null;
      return cachedTabId;
    };

    const startLauncherClock = () => {
      if (launcherClock !== null) return;
      launcherClock = window.setInterval(() => {
        if (!recording) return;
        updateLauncher(recording.paused ? 'paused' : 'recording', player.element?.currentTime ?? 0);
      }, 1000);
    };

    const stopLauncherClock = () => {
      if (launcherClock !== null) window.clearInterval(launcherClock);
      launcherClock = null;
    };

    const sendBg = async <T = unknown>(
      message: Record<string, unknown>,
    ): Promise<{ ok: boolean; data?: T; error?: { message: string } }> => {
      try {
        return (await chrome.runtime.sendMessage(message)) as { ok: boolean; data?: T; error?: { message: string } };
      } catch (error) {
        return { ok: false, error: { message: (error as Error).message } };
      }
    };

    const post = (message: ContentMessage) => {
      try {
        void chrome.runtime.sendMessage(message).catch(() => {
          if (ctx.isInvalid) disconnect();
        });
      } catch {
        disconnect();
      }
    };

    const probe = (): VideoProbe | null => {
      const snap = player.snapshot();
      const video = player.element;
      if (!snap || !video) return null;
      const tracks = [...video.textTracks];
      return {
        elementId: player.videoKey(video),
        title: player.titleOf(video),
        duration: snap.duration,
        currentTime: snap.currentTime,
        paused: snap.paused,
        readyState: snap.readyState,
        hasReadableTextTracks: tracks.some((t) => t.mode === 'showing' || t.mode === 'hidden'),
        textTrackCount: tracks.length,
        subtitleDomCandidates: subtitles.hasReadableDom(video) ? 1 : 0,
        isPlaying: snap.isPlaying,
        width: snap.width,
        height: snap.height,
      };
    };



    const startCaptionFlush = () => {
      if (flushTimer !== null) return;
      flushTimer = window.setInterval(() => {
        if (!recording || captionQueue.length === 0) return;
        const items = captionQueue.splice(0, captionQueue.length);
        post({
          type: 'content:captions',
          payload: {
            videoId: recording.videoId,
            sessionId: recording.sessionId,
            epoch: recording.epoch,
            items,
          },
        });
      }, 700);
    };

    const onCaption = (caption: CaptionObservation) => {
      if (!recording || recording.paused) return;
      // 文本轨/DOM 可用时不运行字幕 OCR
      captionQueue.push({
        text: caption.text,
        startTime: caption.startTime,
        endTime: caption.endTime,
        source: caption.source,
        confidence: caption.confidence,
        provenance: caption.provenance,
      });
      if (captionQueue.length > 40) {
        // 防止极端情况无限积压
        captionQueue = captionQueue.slice(-20);
      }
    };

    const beginSubtitleObservation = () => {
      const video = player.element;
      if (!video) return;
      subtitles.start(video, {
        onCaption,
        onSourceHint: (kind) => {
          if (!recording) return;
          post({
            type: 'content:subtitle-source',
            payload: {
              sessionId: recording.sessionId,
              epoch: recording.epoch,
              source:
                kind === 'texttrack'
                  ? { kind: 'texttrack', label: '视频文本轨', detectedAt: Date.now() }
                  : kind === 'dom'
                    ? { kind: 'dom', label: '页面字幕节点', detectedAt: Date.now() }
                    : { kind: 'none', label: '未发现可读字幕' },
            },
          });
        },
      });
    };

    const stopAll = () => {
      stopLauncherClock();
      updateLauncher('idle', 0);
      subtitles.stop();
      if (flushTimer !== null) window.clearInterval(flushTimer);
      if (stateTimer !== null) window.clearInterval(stateTimer);
      if (signatureTimer !== null) window.clearInterval(signatureTimer);
      if (ocrTimer !== null) window.clearInterval(ocrTimer);
      flushTimer = null;
      stateTimer = null;
      signatureTimer = null;
      ocrTimer = null;
      lastOcrSignature = null;
      recording = null;
      captionQueue = [];
      lastReportedRange = null;
    };

    const disconnect = () => {
      stopAll(); player.stop(); closeDock();
      updateLauncher('error', 0, '扩展已更新或断开，点击刷新重连');
    };
    ctx.onInvalidated(disconnect);

    const reportPlayerState = () => {
      const snap = player.snapshot();
      if (!snap) return;
      post({
        type: 'content:player-state',
        payload: {
          currentTime: snap.currentTime,
          paused: snap.paused,
          duration: snap.duration,
          playbackRate: snap.playbackRate,
          fullscreen: snap.fullscreen,
          subtitleText: null,
        },
      });

      if (!recording) return;

      // 播放连续性 & seek 检测
      const expected = recording.lastTime + (0.7 * snap.playbackRate);
      const jump = Math.abs(snap.currentTime - expected);
      if (!snap.paused && jump > 1.6 && Date.now() - lastSeekAt > 500) {
        lastSeekAt = Date.now();
        recording.epoch += 1;
        post({
          type: 'content:seek',
          payload: {
            videoId: recording.videoId,
            sessionId: recording.sessionId,
            epoch: recording.epoch,
            from: recording.lastTime,
            to: snap.currentTime,
            reason: 'seek',
          },
        });
        lastReportedRange = null;
      }
      recording.lastTime = snap.currentTime;

      // 记录区间：连续播放观察到的范围
      if (!snap.paused && snap.isPlaying) {
        const start = Math.max(0, snap.currentTime - 0.7);
        recording.recordedRanges = addRecordedRange(recording.recordedRanges, [start, snap.currentTime]);
        if (!lastReportedRange || snap.currentTime - lastReportedRange[1] >= 2 || start < lastReportedRange[0]) {
          const mergedStart = Math.min(lastReportedRange?.[0] ?? start, start);
          lastReportedRange = [mergedStart, snap.currentTime];
          post({
            type: 'content:record-range',
            payload: {
              sessionId: recording.sessionId,
              epoch: recording.epoch,
              range: [start, snap.currentTime],
            },
          });
        }
      }

      // 页面/视频身份变化（同页换集、单页应用切换）。
      // 只用 URL 判断：标题可能因通知、未读数等动态变化，不能据此判定换视频。
      const urlKey = location.href;
      if (urlKey !== lastUrlKey && lastUrlKey !== '') {
        lastUrlKey = urlKey;
        const next = identifyVideo(location.href, document.title);
        if (next.id !== recording.videoId) {
          post({
            type: 'content:video-changed',
            payload: {
              sessionId: recording.sessionId,
              fromVideoId: recording.videoId,
              toVideoId: next.id,
              title: next.title,
              url: location.href,
            },
          });
        }
      } else {
        lastUrlKey = urlKey;
      }
    };

    const captureSignature = () => {
      if (!recording || recording.paused) return;
      const video = player.element;
      if (!video) return;
      try {
        const sig = sampleSignature(video, {
          mask: subtitleMask(recording.roi),
          cols: 48,
          rows: 27,
        });
        post({
          type: 'content:signature',
          payload: {
            videoId: recording.videoId,
            sessionId: recording.sessionId,
            epoch: recording.epoch,
            time: video.currentTime,
            duration: Number.isFinite(video.duration) ? video.duration : undefined,
            cols: sig.cols,
            rows: sig.rows,
            cells: sig.cells,
            channels: sig.channels,
            contrast: sig.contrast,
            width: sig.width,
            height: sig.height,
          },
        });
      } catch (error) {
        if (error instanceof FrameCaptureError && error.reason === 'tainted') {
          post({ type: 'content:error', payload: { code: 'not_authorized', message: error.message } });
          // 画面不可读时停止签名采样，交由后台决定是否使用标签页捕获
          if (signatureTimer !== null) window.clearInterval(signatureTimer);
          signatureTimer = null;
        }
      }
    };

    const captureOcrFrame = () => {
      if (!recording || recording.paused || !recording.ocrEnabled || !recording.roi) return;
      const video = player.element;
      if (!video) return;
      try {
        const sig = sampleSignature(video, { roi: recording.roi, cols: 20, rows: 4 });
        const changed = !lastOcrSignature || diffSignatures(lastOcrSignature, sig).maxCell > 0.05;
        const now = Date.now();
        if (!changed && now - lastOcrAt < 5000) return;
        lastOcrSignature = sig;
        lastOcrAt = now;
        const frame = captureVideoFrame(video, { roi: recording.roi, maxWidth: 900, format: 'png' });
        post({
          type: 'content:ocr-frame',
          payload: {
            videoId: recording.videoId,
            sessionId: recording.sessionId,
            epoch: recording.epoch,
            time: video.currentTime,
            kind: 'subtitle',
            dataUrl: frame.dataUrl,
            width: frame.width,
            height: frame.height,
            change: changed ? 1 : 0,
          },
        });
      } catch {
        // 采帧失败不重试；后台会在诊断中记录
      }
    };

    const applyRecording = (payload: Extract<BackgroundToContent, { type: 'capture:start' }>['payload']) => {
      const el = player.element;
      if (!el) return;
      const identity = identifyVideo(location.href, document.title);
      recording = {
        sessionId: payload.sessionId,
        videoId: payload.videoId || identity.id,
        epoch: payload.epoch,
        paused: false,
        subtitleMode: payload.subtitleMode,
        roi: payload.roi,
        startedAt: Date.now(),
        lastTime: el.currentTime,
        recordedRanges: [],
        captionsEnabled: payload.subtitleMode !== 'off',
        ocrEnabled: payload.subtitleMode === 'ocr',
      };
      lastUrlKey = location.href;
      if (recording.captionsEnabled) beginSubtitleObservation();
      updateLauncher('recording', el.currentTime);
      startLauncherClock();
      startCaptionFlush();
      if (stateTimer === null) stateTimer = window.setInterval(reportPlayerState, 700);
      if (signatureTimer === null) signatureTimer = window.setInterval(captureSignature, 1500);
      if (recording.ocrEnabled && ocrTimer === null) {
        ocrTimer = window.setInterval(captureOcrFrame, 800);
      }
      post({
        type: 'content:probe-result',
        payload: { probe: probe(), title: document.title, url: location.href },
      });
    };

    const handle = async (
      message: BackgroundToContent,
    ): Promise<FrameResult | { error: string } | { ok: true } | { roi: NormRect | null } | { probe: VideoProbe | null }> => {
      switch (message.type) {
        case 'capture:start': {
          player.refresh();
          applyRecording(message.payload);
          return { ok: true };
        }
        case 'capture:pause': {
          if (recording) recording.paused = true;
          updateLauncher('paused', player.element?.currentTime ?? 0);
          return { ok: true };
        }
        case 'capture:resume': {
          if (recording) recording.paused = false;
          updateLauncher('recording', player.element?.currentTime ?? 0);
          return { ok: true };
        }
        case 'capture:stop': {
          stopAll();
          return { ok: true };
        }
        case 'capture:seek': {
          if (recording) recording.epoch += 1;
          player.seek(message.payload.time);
          return { ok: true };
        }
        case 'capture:manual-roi': {
          if (recording) {
            recording.roi = message.payload.roi;
            recording.ocrEnabled = true;
            if (ocrTimer === null) ocrTimer = window.setInterval(captureOcrFrame, 800);
          }
          return { ok: true };
        }
        case 'capture:ocr-config': {
          if (recording) {
            recording.ocrEnabled = message.payload.enabled;
            if (message.payload.roi) recording.roi = message.payload.roi;
            if (recording.ocrEnabled && ocrTimer === null) {
              ocrTimer = window.setInterval(captureOcrFrame, 800);
            }
            if (!recording.ocrEnabled && ocrTimer !== null) {
              window.clearInterval(ocrTimer);
              ocrTimer = null;
            }
          }
          return { ok: true };
        }
        case 'capture:signature-config': {
          if (message.payload.enabled && signatureTimer === null) {
            signatureTimer = window.setInterval(captureSignature, message.payload.intervalMs ?? 1500);
          }
          if (!message.payload.enabled && signatureTimer !== null) {
            window.clearInterval(signatureTimer);
            signatureTimer = null;
          }
          return { ok: true };
        }
        case 'capture:frame': {
          const video = player.element;
          try {
            const frame = captureVideoFrame(video, {
              roi: message.payload.mode === 'subtitle' ? (message.payload.roi ?? recording?.roi) : message.payload.roi,
              maxWidth: message.payload.maxWidth ?? 1280,
              format: message.payload.mode === 'subtitle' ? 'png' : 'jpeg',
              signatureMask: message.payload.mode === 'content' ? subtitleMask(recording?.roi) : undefined,
            });
            return {
              dataUrl: frame.dataUrl,
              width: frame.width,
              height: frame.height,
              origin: 'canvas',
              capturedAt: Date.now(),
              mediaTime: player.element?.currentTime ?? 0,
              signature: frame.signature,
            };
          } catch (error) {
            return { error: (error as Error).message };
          }
        }
        case 'capture:manual-keyframe': {
          const video = player.element;
          try {
            const frame = captureVideoFrame(video, { maxWidth: 1280, format: 'jpeg' });
            return {
              dataUrl: frame.dataUrl,
              width: frame.width,
              height: frame.height,
              origin: 'canvas',
              capturedAt: Date.now(),
              mediaTime: video?.currentTime ?? 0,
            };
          } catch (error) {
            return { error: (error as Error).message };
          }
        }
        case 'capture:probe': {
          player.refresh();
          return { probe: probe() };
        }
        case 'capture:pick-roi': {
          player.refresh();
          const video = player.element;
          if (!video) return { roi: null };
          const roi = await selectRoiInteractive(video);
          if (roi && recording) {
            recording.roi = roi;
            recording.ocrEnabled = true;
            if (ocrTimer === null) ocrTimer = window.setInterval(captureOcrFrame, 800);
          }
          return { roi };
        }
        default:
          return { ok: true };
      }
    };

    chrome.runtime.onMessage.addListener((message: BackgroundToContent, _sender, sendResponse) => {
      if (!message || typeof message.type !== 'string' || !message.type.startsWith('capture:')) return false;
      void handle(message).then(sendResponse);
      return true;
    });

    const mountPageLauncher = () => {
      const video = player.element;
      if (launcherMounted || !video) return;
      const rect = video.getBoundingClientRect();
      if (rect.width < 240 || rect.height < 135) return;
      launcherMounted = true;
      mountLauncher({
        onStart: async () => {
          if (ctx.isInvalid) { location.reload(); return; }
          updateLauncher('starting');
          const response = await sendBg({ type: 'content:quick-start', payload: { title: document.title, url: location.href } });
          if (!response.ok) {
            updateLauncher('error', 0, response.error?.message ?? '无法开始记录');
            setTimeout(() => updateLauncher('idle'), 4000);
          } else {
            collapseLauncher();
          }
        },
        onPause: async () => {
          updateLauncher('paused', player.element?.currentTime ?? 0);
          await sendBg({ type: 'content:quick-action', payload: { action: 'pause' } });
        },
        onResume: async () => {
          updateLauncher('recording', player.element?.currentTime ?? 0);
          await sendBg({ type: 'content:quick-action', payload: { action: 'resume' } });
        },
        onStop: async () => {
          await sendBg({ type: 'content:quick-action', payload: { action: 'stop' } });
          stopAll();
          collapseLauncher();
        },
        onOpenPanel: () => {
          if (ctx.isInvalid) { location.reload(); return; }
          void (async () => {
            const tabId = await resolveTabId();
            if (tabId !== null) {
              toggleDock(tabId, 'nodes');
              return;
            }
            // 极端情况下退化为浏览器原生侧边栏
            await sendBg({ type: 'content:quick-action', payload: { action: 'open-panel' } });
          })();
        },
        onAsk: () => {
          if (ctx.isInvalid) { location.reload(); return; }
          void (async () => {
            const tabId = await resolveTabId();
            if (tabId !== null) {
              openDock(tabId, 'ask');
              return;
            }
            await sendBg({ type: 'content:quick-action', payload: { action: 'ask' } });
          })();
        },
      });
    };

    // 初始化：只在页面确实包含视频时上报，减少无关页面开销
    const init = () => {
      if (initialized) return;
      player.refresh();
      if (!player.element) return;
      initialized = true;
      player.start();
      mountPageLauncher();
      void resolveTabId();
      player.onChange(() => {
        if (!launcherMounted) mountPageLauncher();
        if (!recording) return;
        const next = identifyVideo(location.href, document.title);
        if (next.id !== recording.videoId) {
          post({
            type: 'content:video-changed',
            payload: {
              sessionId: recording.sessionId,
              fromVideoId: recording.videoId,
              toVideoId: next.id,
              title: next.title,
              url: location.href,
            },
          });
        } else if (player.element) {
          subtitles.setVideo(player.element);
        }
      });

      if (!hello.sent) {
        hello = { sent: true };
        post({
          type: 'content:hello',
          payload: {
            url: location.href,
            title: document.title,
            probe: probe(),
            probeCount: document.querySelectorAll('video').length,
            subtitleDomCandidates: document.querySelectorAll('[class*="caption"], [class*="subtitle"]').length,
          },
        });
      }
    };

    init();
    // 页面动态插入视频（SPA）时再次尝试
    const retry = window.setInterval(() => {
      if (initialized) {
        window.clearInterval(retry);
        return;
      }
      init();
    }, 2000);
    window.setTimeout(() => window.clearInterval(retry), 30000);

  },
});
