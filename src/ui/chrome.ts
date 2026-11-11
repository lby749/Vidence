/** UI 与后台通信的小工具：统一错误处理与超时。 */

import type { AppEvent, Result, UiRequest } from '@/shared/messages';

export async function sendUi<T>(message: UiRequest, timeoutMs = 30000): Promise<T> {
  const response = (await Promise.race([
    chrome.runtime.sendMessage(message),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ])) as Result<T> | null;
  if (!response) throw new Error('后台无响应（可能已被浏览器停止，请重试）');
  if (!response.ok) throw new Error(response.error.message);
  return response.data;
}

export function connectUi(handlers: {
  onEvent: (event: AppEvent) => void;
  onDisconnect?: () => void;
}): { port: chrome.runtime.Port; subscribe: (tabId?: number) => void; close: () => void } {
  const port = chrome.runtime.connect({ name: 'ui' });
  port.onMessage.addListener((message: AppEvent) => handlers.onEvent(message));
  port.onDisconnect.addListener(() => handlers.onDisconnect?.());
  return {
    port,
    subscribe: (tabId) => port.postMessage({ type: 'ui:subscribe', payload: { tabId } }),
    close: () => port.disconnect(),
  };
}

export async function activeTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export function videoUrlAt(url: string, seconds: number): string {
  const target = new URL(url); target.searchParams.set('t', String(Math.max(0, Math.floor(seconds)))); return target.href;
}
