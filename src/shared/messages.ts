/**
 * 扩展内部消息协议。
 *
 * 约束：
 * - Content Script 不直接访问 IndexedDB，全部经 Background 落库。
 * - 每条采集消息携带 videoId / sessionId / captureEpoch，写库前校验代次。
 * - 所有请求-响应使用结构化错误 {code, message}，不抛裸异常给 UI。
 */

import type {
  ChatTurn,
  Evidence,
  QaRoute,
  Session,
  SubtitleSourceState,
  Video,
} from './types';
import type { NormRect } from './types';
import type { FrameSignature } from '@/pipeline/visual';

export interface ApiError {
  code:
    | 'no_video'
    | 'no_session'
    | 'stale_epoch'
    | 'not_authorized'
    | 'bad_request'
    | 'no_provider'
    | 'quota'
    | 'timeout'
    | 'canceled'
    | 'connector_unavailable'
    | 'internal';
  message: string;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };

/* --------------------------- 内容脚本 → 后台 --------------------------- */

export interface VideoProbe {
  /** 站点提供的原生 ID（如 video 元素的 data-video-id 或 YouTube ID） */
  elementId: string;
  title: string;
  duration: number;
  currentTime: number;
  paused: boolean;
  readyState: number;
  /** 是否 crossOrigin 可读 canvas（尽力判断，实际以绘制结果为准） */
  hasReadableTextTracks: boolean;
  textTrackCount: number;
  subtitleDomCandidates: number;
  isPlaying: boolean;
  width: number;
  height: number;
}

export interface RawCaption {
  text: string;
  startTime: number;
  endTime: number;
  source: 'texttrack' | 'dom' | 'ocr' | 'manual';
  confidence?: number;
  provenance?: string;
  /** OCR 时对应的关键帧 ID */
  keyframeId?: string;
}

export type ContentMessage =
  | {
      type: 'content:hello';
      payload: {
        url: string;
        title: string;
        probe: VideoProbe | null;
        probeCount: number;
        subtitleDomCandidates: number;
      };
    }
  | {
      type: 'content:probe';
      payload: { url: string; title: string; probe: VideoProbe | null };
    }
  | {
      type: 'content:player-state';
      payload: {
        videoId?: string;
        currentTime: number;
        paused: boolean;
        duration: number;
        playbackRate: number;
        fullscreen: boolean;
        subtitleText: string | null;
      };
    }
  | {
      type: 'content:captions';
      payload: {
        videoId: string;
        sessionId: string;
        epoch: number;
        items: RawCaption[];
      };
    }
  | {
      type: 'content:subtitle-source';
      payload: {
        sessionId: string;
        epoch: number;
        source: SubtitleSourceState;
        /** 前 10 秒未发现字幕 */
        notFoundYet?: boolean;
      };
    }
  | {
      type: 'content:record-range';
      payload: {
        sessionId: string;
        epoch: number;
        range: [number, number];
      };
    }
  | {
      type: 'content:error';
      payload: { code: ApiError['code']; message: string };
    }
  | {
      type: 'content:seek';
      payload: {
        videoId: string;
        sessionId: string;
        epoch: number;
        from: number;
        to: number;
        reason: 'seek' | 'video-change' | 'rate';
      };
    }
  | {
      type: 'content:signature';
      payload: {
        videoId: string;
        sessionId: string;
        epoch: number;
        time: number;
        duration?: number;
        cols: number;
        rows: number;
        cells: number[];
        channels?: number[];
        contrast?: number;
        width: number;
        height: number;
      };
    }
  | {
      type: 'content:ocr-frame';
      payload: {
        videoId: string;
        sessionId: string;
        epoch: number;
        time: number;
        kind: 'subtitle';
        dataUrl: string;
        width: number;
        height: number;
        /** ROI 变化强度，便于后台判断 */
        change: number;
      };
    }
  | {
      type: 'content:video-changed';
      payload: {
        sessionId: string;
        fromVideoId: string;
        toVideoId: string;
        title: string;
        url: string;
      };
    }
  | {
      type: 'content:probe-result';
      payload: { probe: VideoProbe | null; title: string; url: string };
    }
  | {
      /** 页面内浮动按钮：一键开始记录（后台用 sender.tab.id 定位标签页） */
      type: 'content:quick-start';
      payload: { title: string; url: string };
    }
  | {
      type: 'content:quick-action';
      payload: { action: 'pause' | 'resume' | 'stop' | 'open-panel' | 'ask' };
    }
  | { type: 'content:get-tab'; payload: Record<string, never> };

/* --------------------------- 后台 → 内容脚本 --------------------------- */

export type BackgroundToContent =
  | {
      type: 'capture:start';
      payload: {
        sessionId: string;
        epoch: number;
        videoId: string;
        subtitleMode: 'auto' | 'ocr' | 'off';
        roi?: NormRect;
        /** 自动字幕定位观察预算（毫秒） */
        detectionBudgetMs: number;
      };
    }
  | { type: 'capture:pause'; payload: { sessionId: string; reason?: 'manual' | 'video' } }
  | { type: 'capture:resume'; payload: { sessionId: string } }
  | { type: 'capture:stop'; payload: { sessionId: string } }
  | { type: 'capture:seek'; payload: { time: number } }
  | { type: 'capture:manual-roi'; payload: { roi: NormRect } }
  | {
      type: 'capture:frame';
      payload: {
        sessionId?: string;
        epoch?: number;
        mode: 'subtitle' | 'content' | 'full';
        roi?: NormRect;
        maxWidth?: number;
      };
    }
  | { type: 'capture:manual-keyframe'; payload: {} }
  | {
      type: 'capture:ocr-config';
      payload: {
        sessionId: string;
        epoch: number;
        enabled: boolean;
        roi?: NormRect;
        /** 字幕区域变化的采样阈值 */
        changeThreshold?: number;
      };
    }
  | {
      type: 'capture:signature-config';
      payload: { enabled: boolean; intervalMs?: number; maskRoi?: NormRect };
    }
  | { type: 'capture:probe'; payload: {} }
  | { type: 'capture:close-panel'; payload: {} }
  | { type: 'capture:pick-roi'; payload: {} };

export interface FrameResult {
  dataUrl: string;
  width: number;
  height: number;
  /** 来自 canvas 或 tabCapture */
  origin: 'canvas' | 'tab-capture';
  capturedAt: number;
  /** 采样瞬间的媒体时间（不是处理完成时间） */
  mediaTime: number;
  signature?: FrameSignature;
}

/* --------------------------- UI ↔ 后台 --------------------------- */

export interface AppStateSnapshot {
  tabId?: number;
  video: Video | null;
  session: Session | null;
  probe: VideoProbe | null;
  subtitleSource: SubtitleSourceState;
  recording: boolean;
  paused: boolean;
  /** 最近证据（用于侧边栏滚动条） */
  recentEvidence: Pick<Evidence, 'id' | 'text' | 'startTime' | 'endTime' | 'source'>[];
  nodes: Array<{
    id: string;
    title: string;
    startTime: number;
    endTime: number;
    status: string;
    summary?: string;
  }>;
  usage: {
    calls: number;
    unknownTokenCalls?: number;
    inputTokens: number;
    outputTokens: number;
    imageUploads: number;
    estimatedCostUsd?: number;
  };
  notion: { configured: boolean; lastSyncAt?: number; pending: number; error?: string };
  aiApps: Array<{
    id: string;
    label: string;
    status: string;
    capabilities: string[];
  }>;
  connectors: Array<{ id: string; label: string; status: string; note?: string }>;
  library: { videos: number; nodes: number; evidence: number; keyframes: number };
  warnings: string[];
  lastTurn?: Pick<ChatTurn, 'requestId' | 'answer' | 'citations' | 'status'>;
}

export type UiRequest =
  | { type: 'ui:close-panel'; payload: { tabId: number } }
  | { type: 'ui:get-state'; payload?: { tabId?: number } }
  | { type: 'ui:start'; payload: { tabId: number } }
  | { type: 'ui:pause' }
  | { type: 'ui:resume' }
  | { type: 'ui:stop' }
  | { type: 'ui:seek'; payload: { time: number; videoId?: string; tabId?: number } }
  | { type: 'ui:frame'; payload: { mode: 'subtitle' | 'content' | 'full'; roi?: NormRect } }
  | { type: 'ui:manual-keyframe' }
  | { type: 'ui:detect-subtitles'; payload: { manualRoi?: NormRect } }
  | {
      type: 'ui:ask';
      payload: {
        question: string;
        route: QaRoute;
        videoId?: string;
        tabId?: number;
        followUpTo?: string;
        connectorId?: string;
        selectedNodeIds: string[];
        frozenTime: number;
        allowImages: boolean;
        requestId?: string;
      };
    }
  | { type: 'ui:cancel-ask'; payload: { requestId: string } }
  | {
      type: 'ui:ai-prepare';
      payload: {
        connectorId: string;
        question: string;
        frozenTime: number;
        selectedNodeIds: string[];
        allowImages: boolean;
        requestId: string;
      };
    }
  | { type: 'ui:ai-send'; payload: { requestId: string; confirmSend: boolean } }
  | { type: 'ui:ai-confirm'; payload: { requestId: string } }
  | { type: 'ui:ai-read'; payload: { requestId: string } }
  | { type: 'ui:ai-cancel'; payload: { requestId: string } }
  | {
      type: 'ui:handoff';
      payload: { question: string; frozenTime: number; selectedNodeIds: string[]; videoId?: string };
    }
  | { type: 'ui:open-connector'; payload: { connectorId: string; requestId?: string } }
  | { type: 'ui:notion-test'; payload: {} }
  | { type: 'ui:notion-sync'; payload: { videoId?: string } }
  | { type: 'ui:rebuild-index'; payload: { kind: 'keyword' | 'vector' | 'all' } }
  | { type: 'ui:delete-video'; payload: { videoId: string } }
  | { type: 'ui:export'; payload: { videoId?: string } }
  | { type: 'ui:diagnostics' }
  | { type: 'ui:search'; payload: { query: string; videoId?: string; limit?: number } };

/* --------------------------- 事件流（Port） --------------------------- */

export type AppEvent =
  | { type: 'state'; payload: AppStateSnapshot }
  | { type: 'ask:delta'; payload: { requestId: string; videoId?: string; text: string } }
  | { type: 'ask:status'; payload: { requestId: string; videoId?: string; status: string; detail?: string } }
  | {
      type: 'ask:done';
      payload: {
        requestId: string;
        answer: string;
        videoId?: string;
        memoryContext?: ChatTurn['memoryContext'];
        citations: Array<{ evidenceId: string; nodeId?: string; startTime: number; endTime: number; source: string }>;
        usage: AppStateSnapshot['usage'];
      };
    }
  | { type: 'ask:error'; payload: { requestId: string; videoId?: string; code: string; message: string } }
  | { type: 'toast'; payload: { level: 'info' | 'warn' | 'error'; message: string } }
  | { type: 'capture:status'; payload: { status: string; detail?: string } };

export type PortInbound = { type: 'ui:subscribe'; payload?: { tabId?: number } } | { type: 'ping' };
