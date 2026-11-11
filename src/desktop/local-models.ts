let ticket: string | undefined;
export function configureDesktopModels(value?: string) { ticket = value; }
export function hasDesktopModels(): boolean { return Boolean(ticket); }
/** 独立应用由本机转发选定的 API，避免浏览器跨域限制；扩展仍直接请求。 */
export function providerFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (!ticket) return fetch(url, init);
  return fetch('/provider-request', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ticket}` }, body: JSON.stringify({ url, method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers)), body: init.body }), signal: init.signal });
}
export async function desktopModelRequest<T>(action: string, payload: unknown = {}, signal?: AbortSignal): Promise<T> {
  if (!ticket) throw new Error('请在独立应用中使用此功能');
  const response = await fetch(`/local-models/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ticket}` }, body: JSON.stringify(payload), signal });
  const result = await response.json();
  if (!response.ok || result.error) throw new Error(result.error ?? '本地计算未完成');
  return result;
}
export async function downloadDesktopModel(signal: AbortSignal, progress: (loaded: number, total: number) => void) {
  const response = await fetch('/local-models/download', { method: 'POST', headers: { Authorization: `Bearer ${ticket}` }, signal });
  if (!response.ok || !response.body) throw new Error('无法准备离线资源');
  const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '', complete = false;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split('\n'); pending = lines.pop()!;
    for (const line of lines) {
      if (!line.trim()) continue;
      const update = JSON.parse(line); if (update.error) throw new Error(update.error);
      if (typeof update.loaded === 'number') progress(update.loaded, update.total);
      if (update.done) complete = true;
    }
  }
  if (!complete) throw new Error('下载未完成，已完成的资源会保留');
}
