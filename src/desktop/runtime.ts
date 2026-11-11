import { getDb, getSettings, saveSettings } from '@/db/db';
import { createComputeClient } from '@/ui/compute-client';
import { prepareQueryContext, askQuestion } from '@/agent/question-agent';
import { askLocalAgent } from '@/agent/local-agent';
import { searchLibrary } from '@/background/index-service';
import { exportBundle } from '@/export/bundle';
import { buildDiagnostics } from '@/background/diagnostics';
import { deleteVideoData } from '@/background/delete-video';
import type { AppEvent, UiRequest } from '@/shared/messages';
import { configureDesktopModels, desktopModelRequest } from './local-models';
import { APP_VERSION } from '@/shared/app-updates';

export interface NativeBridge { [method: string]: (...args: any[]) => void }
export function nativeCall<T>(native: NativeBridge, method: string, ...args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => native[method](...args, (raw: string) => {
    try { const result = JSON.parse(raw); if (result?.error) reject(new Error(result.error)); else resolve(result); } catch (error) { reject(error); }
  }));
}

/** 共享页面只依赖这些少量扩展接口；独立应用在本设备内实现相同消息协议。 */
export async function installDesktopRuntime(native: NativeBridge) {
  const compute = createComputeClient('/sandbox.html');
  const peers = new Set<(event: AppEvent) => void>(); const controllers = new Map<string, AbortController>();
  const emit = (event: AppEvent) => peers.forEach(listener => listener(event));
  const openSource = async (source: string, seconds: number) => {
    const sessions = await getDb().sessions.where('status').equals('recording').toArray();
    if (sessions.some(session => session.id.startsWith('desktop_'))) throw new Error('请先结束当前记录，再切换视频来源。');
    const result = await nativeCall<{ source?: { id: string; title: string; url: string } }>(native, 'openSource', source, seconds);
    if (result.source) window.dispatchEvent(new CustomEvent('desktop:source-opened', { detail: result.source }));
    return result;
  };
  const ask = async (payload: Extract<UiRequest, { type: 'ui:ask' }>['payload']) => {
    if (!payload.videoId) throw new Error('请先选择视频');
    const requestId = payload.requestId ?? crypto.randomUUID(), videoId = payload.videoId;
    if (controllers.has(requestId)) throw new Error('这个问题正在处理中');
    const controller = new AbortController(); controllers.set(requestId, controller);
    void (async () => {
      try {
        const prepared = await prepareQueryContext({ ...payload, videoId, requestId });
        const result = await (payload.route === 'local-agent' ? askLocalAgent : askQuestion)({ ...prepared, externalSignal: controller.signal, callbacks: {
          onStatus: (status, detail) => emit({ type: 'ask:status', payload: { requestId, videoId, status, detail } }),
          onDelta: text => emit({ type: 'ask:delta', payload: { requestId, videoId, text } }),
        } });
        emit({ type: 'ask:done', payload: { requestId, videoId, answer: result.answer, citations: result.citations, usage: result.usage, memoryContext: result.memoryContext } });
      } catch (error) {
        const message = (error as Error).message;
        await getDb().chats.put({ id: `failed_${requestId}`, requestId, videoId, question: payload.question, citations: [], route: payload.route, status: controller.signal.aborted ? 'canceled' : 'failed', error: message, createdAt: Date.now() });
        emit({ type: 'ask:error', payload: { requestId, videoId, code: controller.signal.aborted ? 'canceled' : 'ask_failed', message } });
      } finally { controllers.delete(requestId); }
    })();
    return { requestId };
  };
  const send = async (message: UiRequest | { target: string }) => {
    try {
      if ('target' in message && message.target === 'offscreen') {
        if ((message as { type?: string }).type === 'compute:reset') await desktopModelRequest('unload');
        return compute(message);
      }
      const request = message as UiRequest;
      let data: unknown;
      switch (request.type) {
        case 'ui:ask': data = await ask(request.payload); break;
        case 'ui:cancel-ask': controllers.get(request.payload.requestId)?.abort(); data = { ok: true }; break;
        case 'ui:search': data = await searchLibrary({ ...request.payload, useVector: (await getSettings()).retrieval.vector }); break;
        case 'ui:export': data = await exportBundle(request.payload); break;
        case 'ui:diagnostics': data = await buildDiagnostics(); break;
        case 'ui:delete-video': data = await deleteVideoData(request.payload.videoId); break;
        case 'ui:seek': {
          const video = request.payload.videoId ? await getDb().videos.get(request.payload.videoId) : undefined;
          if (!video) throw new Error('找不到这个视频');
          data = await openSource(video.url, request.payload.time); break;
        }
        default: throw new Error('此功能目前需要在浏览器扩展中使用');
      }
      return { ok: true, data };
    } catch (error) { return { ok: false, error: { code: 'desktop', message: (error as Error).message } }; }
  };
  const stub = {
    runtime: {
      sendMessage: send, getURL: (file: string) => new URL(file, location.href).href,
      getManifest: () => ({ version: APP_VERSION.split('-')[0], version_name: APP_VERSION }), getContexts: async () => [{}],
      connect: () => { const listeners = new Set<(event: AppEvent) => void>(); return { postMessage() {}, onMessage: { addListener: (listener: (event: AppEvent) => void) => { listeners.add(listener); peers.add(listener); } }, onDisconnect: { addListener() {} }, disconnect: () => listeners.forEach(listener => peers.delete(listener)) }; },
    },
    tabs: { getCurrent: async () => ({ id: 1 }), query: async () => [{ id: 1 }] },
    permissions: { getAll: async () => ({ permissions: ['selected-window', 'selected-local-video'] }) },
  };
  Object.defineProperty(window, 'chrome', { value: stub, configurable: true });
  const bootstrap = await nativeCall<{ token?: string; modelTicket?: string }>(native, 'bootstrap');
  configureDesktopModels(bootstrap.modelTicket);
  for (const session of await getDb().sessions.where('status').anyOf(['recording', 'paused']).toArray()) {
    if (session.id.startsWith('desktop_')) await getDb().sessions.update(session.id, { status: 'stopped', endedAt: Date.now() });
  }
  const config = await getSettings();
  if (!config.localAgent && bootstrap.token) await saveSettings({ localAgent: { backend: 'opencode-go', token: bootstrap.token, model: 'deepseek-v4.1-flash' } });
  const originalOpen = window.open.bind(window);
  window.open = ((url?: string | URL) => {
    const target = String(url ?? '');
    if (target.startsWith('vma-local:') || target.startsWith('vma-course:') || target.startsWith('vma-web:')) { const parsed = new URL(target); void openSource(target, Number(parsed.searchParams.get('t') ?? 0)).catch(error => window.dispatchEvent(new CustomEvent('desktop:source-error', { detail: error.message }))); return null; }
    return originalOpen(url);
  }) as typeof window.open;
}
