/**
 * 整体画面链路：签名采样 → 变化判定 → 关键帧保存。
 *
 * 三种动作严格区分：
 * 1. 临时采样：只在内存做差分/OCR；
 * 2. 保存关键帧：写入本地库（默认不上传）；
 * 3. 上传图片：仅当用户明确授权且问题需要。
 */

import { getDb, getSettings } from '@/db/db';
import type { Keyframe } from '@/shared/types';
import type { FrameResult } from '@/shared/messages';
import type { ActiveSession } from './session-store';
import { updateActiveSession, countKeyframes } from './session-store';
import { requestCanvasFrame } from './capture-client';
import { recognize } from './ocr-service';
import {
  diffSignatures,
  evaluateChange,
  fingerprintOf,
  fingerprintDistance,
  shouldSaveKeyframe,
  hasFrameContent,
  isFrameStable,
  frameBudgetAt,
  type FrameSignature,
} from '@/pipeline/visual';
import { uid } from '@/shared/ids';
import { VISUAL } from '@/shared/constants';
import { dataUrlToBlob } from '@/shared/blob';
import { markIndexDirty } from './index-service';

interface VisualState {
  lastSaved: FrameSignature | null;
  lastSavedAt: number | null;
  savedCount: number;
  candidate: { sig: FrameSignature; at: number; since: number } | null;
  firstSeenAt: number;
  lastOcrAt: number;
  busy: boolean;
  warning?: string;
}

const states = new Map<string, VisualState>();

function stateFor(sessionId: string): VisualState {
  let state = states.get(sessionId);
  if (!state) {
    state = {
      lastSaved: null,
      lastSavedAt: null,
      savedCount: 0,
      candidate: null,
      firstSeenAt: 0,
      lastOcrAt: 0,
      busy: false,
    };
    states.set(sessionId, state);
  }
  return state;
}

export function resetVisualState(sessionId: string): void {
  states.delete(sessionId);
}

export interface SignatureInput {
  /** 桌面端仅在入选时取高清原图，采样预览仍保持轻量。 */
  captureFrame?: (maxWidth: number) => Promise<FrameResult>;
  duration?: number;
  frame?: FrameResult;
  channels?: number[];
  contrast?: number;
  sessionId: string;
  epoch: number;
  time: number;
  cols: number;
  rows: number;
  cells: number[];
  width: number;
  height: number;
}

export interface VisualEvent {
  type: 'keyframe-saved' | 'warning' | 'skipped';
  keyframeId?: string;
  time?: number;
  reason?: string;
}

/**
 * 处理内容脚本上报的低分辨率签名。
 * 返回事件用于 UI 通知与诊断。
 */
export async function handleSignature(
  session: ActiveSession,
  input: SignatureInput,
  onEvent?: (event: VisualEvent) => void,
): Promise<void> {
  if (session.sessionId !== input.sessionId || input.epoch !== session.epoch || session.paused) return;
  const state = stateFor(session.sessionId);
  if (state.busy) return;
  state.busy = true;
  try {
    const settings = await getSettings();
    const { cols, rows, cells, channels, contrast, width, height } = input;
    const sig: FrameSignature = { cols, rows, cells, channels, contrast, width, height };
    const now = Date.now();
    if (!state.firstSeenAt) {
      state.firstSeenAt = now;
      state.savedCount = await countKeyframes(session.videoId);
    }
    if (state.savedCount >= frameBudgetAt(input.time, input.duration, settings.capture.keyframeBudget)) { state.candidate = null; return; }
    if (!hasFrameContent(sig)) { state.candidate = null; return; }
    const diff = state.lastSaved ? diffSignatures(state.lastSaved, sig) : null;
    const decision = diff ? evaluateChange({ frame: diff }) : null;
    if (decision && !decision.changed) { state.candidate = null; return; }
    if (!state.candidate) { state.candidate = { sig, at: now, since: now }; return; }
    if (!isFrameStable(state.candidate.sig, sig)) {
      const sameScene = diffSignatures(state.candidate.sig, sig).global < 0.15;
      state.candidate = { sig, at: now, since: sameScene ? state.candidate.since : now };
    }
    const animated = now - state.candidate.since >= VISUAL.maxSettleMs;
    if ((!animated && now - state.candidate.at < VISUAL.settleMs) || (!state.lastSaved && now - state.firstSeenAt < 2000)) return;
    if (diff) {
      const gate = shouldSaveKeyframe({ diff, now, lastSavedAt: state.lastSavedAt, cooldownMs: settings.capture.keyframeCooldownMs, savedCount: state.savedCount, budget: settings.capture.keyframeBudget, mediaTime: input.time, duration: input.duration });
      if (!gate.save) {
        if (gate.reason.includes('预算')) onEvent?.({ type: 'skipped', reason: gate.reason });
        return;
      }
    }
    await saveKeyframe(session, sig, input.time, 'auto-change', animated ? '动态画面中的代表帧' : decision?.reason.join('；') || '记录起点', settings.capture.maxFrameWidth, state, onEvent, input.captureFrame ? () => input.captureFrame!(settings.capture.maxFrameWidth) : input.frame, input.duration);
    state.candidate = null;
  } finally { state.busy = false; }
}

async function saveKeyframe(
  session: ActiveSession,
  sig: FrameSignature,
  time: number,
  reason: Keyframe['reason'],
  reasonText: string,
  maxWidth: number,
  state: VisualState,
  onEvent?: (event: VisualEvent) => void,
  providedFrame?: FrameResult | (() => Promise<FrameResult>),
  duration?: number,
): Promise<void> {
  const settings = await getSettings();
  const budget = settings.capture.keyframeBudget;
  if (state.savedCount >= budget) {
    onEvent?.({ type: 'skipped', reason: `已达到关键帧预算（${budget}）` });
    return;
  }
  const attempt = providedFrame ? { frame: typeof providedFrame === 'function' ? await providedFrame() : providedFrame } : await requestCanvasFrame(session, 'content', { maxWidth });
  if (!attempt.frame) {
    onEvent?.({ type: 'warning', reason: attempt.error ?? '画面采集失败' });
    await updateActiveSession({ lastWarning: attempt.error }).catch(() => undefined);
    return;
  }

  if (attempt.frame.signature && !isFrameStable(sig, attempt.frame.signature)) return;
  sig = attempt.frame.signature ?? sig;
  if (!hasFrameContent(sig)) return;
  const fingerprint = fingerprintOf(sig), db = getDb();
  const blob = await dataUrlToBlob(attempt.frame.dataUrl);
  const keyframe: Keyframe = {
    id: uid('kf'), videoId: session.videoId, sessionId: session.sessionId,
    time: Number.isFinite(attempt.frame.mediaTime) ? attempt.frame.mediaTime : time,
    image: blob, width: attempt.frame.width, height: attempt.frame.height,
    reason, selectionReason: reasonText, fingerprint, evidenceIds: [], uploadAllowed: false,
    capturedAt: attempt.frame.capturedAt, captureEpoch: session.epoch,
  };
  const written = await db.transaction('rw', [db.sessions, db.keyframes], async () => {
    const current = await db.sessions.get(session.sessionId);
    if (!current || current.videoId !== session.videoId || current.status !== 'recording' || current.captureEpoch !== session.epoch) return false;
    const recent = await db.keyframes.where('videoId').equals(session.videoId).sortBy('capturedAt');
    state.savedCount = recent.length;
    if (recent.length >= frameBudgetAt(keyframe.time, duration, budget)) return false;
    const previous = recent.at(-1);
    if (previous && fingerprintDistance(previous.fingerprint, fingerprint) < 0.015) return false;
    await db.keyframes.put(keyframe);
    return true;
  });
  if (!written) return;
  state.lastSaved = sig;
  state.lastSavedAt = Date.now();
  state.savedCount += 1;
  markIndexDirty();
  onEvent?.({ type: 'keyframe-saved', keyframeId: keyframe.id, time: keyframe.time, reason: reasonText });

  // 内容区 OCR 作为异步补充：不阻塞关键帧落库，失败只记录不重试
  if (!providedFrame && settings.ocr.enabled && Date.now() - state.lastOcrAt > 15000) {
    state.lastOcrAt = Date.now();
    const frameData = attempt.frame.dataUrl;
    void (async () => {
      try {
        const result = await withTimeout(recognize(frameData, 'content'), 30000);
        const ocrText = result.items.map((item) => item.text).join(' ');
        const ocrBoxes = result.items.map((item) => ({ text: item.text, confidence: item.score, rect: item.rect }));
        await db.keyframes.update(keyframe.id, { ocrText, ocrBoxes });
        markIndexDirty();
      } catch (error) {
        state.warning = `关键帧 OCR 失败：${(error as Error).message}`;
        onEvent?.({ type: 'warning', reason: state.warning });
      }
    })();
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('处理超时')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function saveManualKeyframe(session: ActiveSession): Promise<Keyframe> {
  const settings = await getSettings();
  const attempt = await requestCanvasFrame(session, 'full', { maxWidth: settings.capture.maxFrameWidth });
  if (!attempt.frame) throw new Error(attempt.error ?? '画面采集失败');
  const blob = await dataUrlToBlob(attempt.frame.dataUrl);
  const saved = await countKeyframes(session.videoId);
  if (saved >= settings.capture.keyframeBudget) {
    throw new Error(`已达到关键帧预算（${settings.capture.keyframeBudget}），请先清理旧关键帧`);
  }
  const keyframe: Keyframe = {
    id: uid('kf'),
    videoId: session.videoId,
    sessionId: session.sessionId,
    time: Number.isFinite(attempt.frame.mediaTime) ? attempt.frame.mediaTime : (await previewTime(session)) ?? 0,
    image: blob,
    width: attempt.frame.width,
    height: attempt.frame.height,
    reason: 'user',
    fingerprint: `manual:${Date.now()}`,
    evidenceIds: [],
    uploadAllowed: false,
    capturedAt: Date.now(),
    captureEpoch: session.epoch,
  };
  await getDb().keyframes.put(keyframe);
  markIndexDirty();
  return keyframe;
}

async function previewTime(session: ActiveSession): Promise<number | null> {
  const db = getDb();
  const evidence = await db.evidence
    .where('videoId')
    .equals(session.videoId)
    .reverse()
    .first();
  return evidence?.endTime ?? null;
}


