/**
 * 与内容脚本通信：超时、错误归一化、帧请求。
 */

import type { BackgroundToContent, ContentMessage, FrameResult } from '@/shared/messages';
import type { NormRect } from '@/shared/types';
import type { ActiveSession } from './session-store';

export interface SendOptions {
  timeoutMs?: number;
}

export async function sendToFrame<T = unknown>(
  tabId: number,
  frameId: number | undefined,
  message: BackgroundToContent,
  options: SendOptions = {},
): Promise<T | null> {
  const timeout = options.timeoutMs ?? 4000;
  try {
    const send = frameId === undefined
      ? chrome.tabs.sendMessage(tabId, message)
      : chrome.tabs.sendMessage(tabId, message, { frameId });
    const result = await Promise.race([
      send,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeout)),
    ]);
    return (result as T) ?? null;
  } catch {
    return null;
  }
}

export async function sendToSession<T = unknown>(
  session: Pick<ActiveSession, 'tabId' | 'frameId'>,
  message: BackgroundToContent,
  options?: SendOptions,
): Promise<T | null> {
  return sendToFrame<T>(session.tabId, session.frameId, message, options);
}

export interface FrameAttempt {
  frame: FrameResult | null;
  error?: string;
}

/** 请求内容脚本抓取一帧（canvas 路线） */
export async function requestCanvasFrame(
  session: Pick<ActiveSession, 'tabId' | 'frameId'>,
  mode: 'subtitle' | 'content' | 'full',
  options: { roi?: NormRect; maxWidth?: number } = {},
): Promise<FrameAttempt> {
  const response = await sendToSession<FrameResult | { error: string }>(
    session,
    {
      type: 'capture:frame',
      payload: { mode, roi: options.roi, maxWidth: options.maxWidth },
    },
    { timeoutMs: 8000 },
  );
  if (!response) return { frame: null, error: '内容脚本无响应（页面可能已刷新或不受支持）' };
  if ('error' in response) return { frame: null, error: response.error };
  return { frame: response };
}

/** 让用户在页面上框选字幕区域 */
export async function pickRoiOnPage(
  session: Pick<ActiveSession, 'tabId' | 'frameId'>,
): Promise<NormRect | null> {
  const response = await sendToSession<{ roi: NormRect | null }>(session, { type: 'capture:pick-roi', payload: {} }, {
    timeoutMs: 120000,
  });
  return response?.roi ?? null;
}

export async function broadcastContentMessage(
  message: ContentMessage,
): Promise<void> {
  // 供诊断/事件使用：不阻塞
  void message;
}
