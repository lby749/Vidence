/**
 * 字幕源发现。
 *
 * 原则：
 * - 有可靠文字来源时不启动字幕 OCR；
 * - 前 10 秒是观察预算，不是成功率保证；
 * - 不把 PPT 正文误认为字幕；
 * - 找不到就明确显示"尚未发现字幕"，低频重试或等待用户框选，不暗中启用语音识别。
 */

import { getDb, getSettings } from '@/db/db';
import type { NormRect, SubtitleSourceState } from '@/shared/types';
import type { ActiveSession } from './session-store';
import { updateActiveSession } from './session-store';
import { requestCanvasFrame, sendToSession } from './capture-client';
import { estimateSubtitleRoi, recognize } from './ocr-service';
import { ingestCaptions } from './subtitle-service';
import { looksLikeSlideText } from '@/pipeline/subtitle';

interface DiscoveryState {
  sessionId: string;
  abort: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  attempts: number;
}

const discoveries = new Map<string, DiscoveryState>();
let lastSubtitleOcr = { sessionId: '', at: 0 };

export interface DiscoveryOutcome {
  found: boolean;
  source: SubtitleSourceState;
  message: string;
}

function iou(a: NormRect, b: NormRect): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

export function cancelSubtitleDiscovery(sessionId: string): void {
  const state = discoveries.get(sessionId);
  if (state) {
    state.abort = true;
    if (state.timer) clearTimeout(state.timer);
    discoveries.delete(sessionId);
  }
}

/**
 * 自动定位字幕区域。找到后配置内容脚本进入 ROI OCR 模式。
 */
export async function discoverSubtitleRegion(session: ActiveSession): Promise<DiscoveryOutcome> {
  const settings = await getSettings();
  const db = getDb();
  const sessionRow = await db.sessions.get(session.sessionId);
  const readable = sessionRow?.subtitleSource.kind === 'texttrack' || sessionRow?.subtitleSource.kind === 'dom';
  if (readable) {
    return {
      found: true,
      source: sessionRow!.subtitleSource,
      message: '已检测到可读字幕，无需 OCR',
    };
  }
  if (!settings.ocr.enabled || settings.ocr.mode === 'off' || settings.ocr.engine === 'none') {
    return {
      found: false,
      source: { kind: 'none', label: '未启用字幕 OCR' },
      message: '未启用 OCR：可通过手动框选字幕区域后启用',
    };
  }

  cancelSubtitleDiscovery(session.sessionId);
  const state: DiscoveryState = { sessionId: session.sessionId, abort: false, timer: null, attempts: 0 };
  discoveries.set(session.sessionId, state);

  const budgetMs = 10000;
  const samples: Array<{ roi: NormRect; text: string; confidence: number; mediaTime: number }> = [];
  const startedAt = Date.now();

  try {
    while (!state.abort && Date.now() - startedAt < budgetMs + 4000) {
      const attempt = await requestCanvasFrame(session, 'content', { maxWidth: 960 });
      if (!attempt.frame) {
        state.attempts += 1;
        if (state.attempts >= 2) {
          return {
            found: false,
            source: { kind: 'none', label: '画面暂不可读取' },
            message: attempt.error ?? '画面采集失败，无法自动定位字幕区域',
          };
        }
        await delay(1500);
        continue;
      }
      try {
        const result = await recognize(attempt.frame.dataUrl, 'subtitle');
        if (state.abort) return { found: false, source: session.subtitleSource, message: '字幕定位已取消' };
        const estimate = estimateSubtitleRoi([result]);
        if (estimate && !looksLikeSlideText(estimate.text)) {
          samples.push({ ...estimate, mediaTime: attempt.frame.mediaTime });
        }
      } catch (error) {
        return {
          found: false,
          source: { kind: 'none', label: 'OCR 不可用' },
          message: `OCR 初始化或识别失败：${(error as Error).message}`,
        };
      }
      if (samples.length >= 2) {
        const first = samples[0]!;
        const consistent = samples.slice(1).some((s) => iou(first.roi, s.roi) > 0.35);
        if (consistent) {
          const band = averageRoi(samples.map((s) => s.roi));
          // 同一字幕行的句子长度会变化；保留整行，避免用前两句的窄框裁掉后文。
          const roi = { ...band, x: 0.02, w: 0.96 };
          const source: SubtitleSourceState = {
            kind: 'ocr',
            label: '字幕区域 OCR',
            roi,
            roiConfidence: Math.min(0.9, first.confidence),
            detectedAt: Date.now(),
          };
          await sendToSession(session, {
            type: 'capture:ocr-config',
            payload: { sessionId: session.sessionId, epoch: session.epoch, enabled: true, roi },
          });
          await updateActiveSession({ subtitleSource: source });
          await db.sessions.update(session.sessionId, { subtitleSource: source });
          // 第一帧字幕立即入库
          const latest = samples[samples.length - 1]!;
          await ingestCaptions({
            videoId: session.videoId,
            sessionId: session.sessionId,
            epoch: session.epoch,
            sessionEpoch: session.epoch,
            duration: 0,
            source,
            items: [
              {
                text: latest.text,
                startTime: latest.mediaTime,
                endTime: latest.mediaTime + 1.2,
                source: 'ocr',
                confidence: latest.confidence,
                provenance: 'roi-discovery',
              },
            ],
          }).catch(() => undefined);
          return { found: true, source, message: `已定位字幕区域（置信度 ${(source.roiConfidence ?? 0).toFixed(2)}）` };
        }
      }
      await delay(2000);
    }
    const source: SubtitleSourceState = { kind: 'none', label: '尚未发现字幕' };
    await updateActiveSession({ subtitleSource: source });
    await db.sessions.update(session.sessionId, { subtitleSource: source });
    return {
      found: false,
      source,
      message: '前 10 秒没有发现字幕，可手动框选字幕区域或继续等待',
    };
  } finally {
    if (discoveries.get(session.sessionId) === state) cancelSubtitleDiscovery(session.sessionId);
  }
}

/** 手动框选后的确认 */
export async function useManualRoi(session: ActiveSession, roi: NormRect): Promise<DiscoveryOutcome> {
  const source: SubtitleSourceState = {
    kind: 'manual-roi',
    label: '手动框选的字幕区域',
    roi,
    roiConfidence: 1,
    detectedAt: Date.now(),
  };
  await sendToSession(session, {
    type: 'capture:ocr-config',
    payload: { sessionId: session.sessionId, epoch: session.epoch, enabled: true, roi },
  });
  await updateActiveSession({ subtitleSource: source });
  await getDb().sessions.update(session.sessionId, { subtitleSource: source });
  return { found: true, source, message: '已应用手动字幕区域' };
}

/** 内容脚本上报 OCR 字幕帧：跑识别并落库 */
export async function handleSubtitleOcrFrame(params: {
  session: ActiveSession;
  dataUrl: string;
  time: number;
  epoch: number;
}): Promise<{ accepted: boolean; text?: string; reason?: string }> {
  const db = getDb();
  const sessionRow = await db.sessions.get(params.session.sessionId);
  if (!sessionRow) return { accepted: false, reason: '会话不存在' };
  if (sessionRow.status !== 'recording') return { accepted: false, reason: '当前没有记录' };
  const kind = sessionRow.subtitleSource.kind;
  if (kind === 'texttrack' || kind === 'dom') {
    // 可读字幕优先：不为字幕额外运行 OCR
    return { accepted: false, reason: '已有可读字幕来源' };
  }
  if (params.epoch < sessionRow.captureEpoch) {
    return { accepted: false, reason: '旧代次任务已失效' };
  }
  const settings = await getSettings();
  if (!settings.ocr.enabled || settings.ocr.maxPerMinute <= 0) return { accepted: false, reason: '当前档位未启用识别' };
  if (lastSubtitleOcr.sessionId === sessionRow.id && Date.now() - lastSubtitleOcr.at < 60000 / settings.ocr.maxPerMinute) return { accepted: false, reason: '当前档位的识别间隔' };
  lastSubtitleOcr = { sessionId: sessionRow.id, at: Date.now() };
  const result = await recognize(params.dataUrl, 'subtitle');
  const text = result.items.map((item) => item.text).join('\n').trim();
  if (!text) return { accepted: false, reason: '未识别出文字' };
  if (looksLikeSlideText(text)) return { accepted: false, reason: '疑似画面正文，不是字幕' };
  const confidence =
    result.items.length > 0 ? result.items.reduce((sum, item) => sum + item.score, 0) / result.items.length : undefined;

  await ingestCaptions({
    videoId: params.session.videoId,
    sessionId: params.session.sessionId,
    epoch: params.epoch,
    sessionEpoch: sessionRow.captureEpoch,
    duration: 0,
    source: {
      kind: 'ocr',
      label: '字幕区域 OCR',
      roi: sessionRow.subtitleSource.roi,
      lastTextAt: Date.now(),
    },
    items: [
      {
        text,
        startTime: params.time,
        endTime: params.time + 1.2,
        source: 'ocr',
        confidence,
        provenance: 'subtitle-roi',
      },
    ],
  });
  return { accepted: true, text };
}

function averageRoi(rois: NormRect[]): NormRect {
  const avg = (fn: (r: NormRect) => number) => rois.reduce((sum, r) => sum + fn(r), 0) / rois.length;
  return { x: avg((r) => r.x), y: avg((r) => r.y), w: avg((r) => r.w), h: avg((r) => r.h) };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
