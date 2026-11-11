import type { OffscreenResponse } from '@/shared/offscreen';
import { cachedModelFile } from '@/models/downloads';
import { getSettings } from '@/db/db';
import { computeFeatureEnabled } from '@/shared/resource-tiers';

/** 扩展 offscreen 和独立应用共享同一个隔离计算通道。 */
export function createComputeClient(url: string) {
  let client: ReturnType<typeof connectCompute> | undefined;
  let generation = 0;
  return async (message: unknown): Promise<OffscreenResponse> => {
    const type = (message as { type?: string }).type ?? '';
    if (type === 'compute:reset') { generation++; client?.dispose(); client = undefined; return { ok: true, data: { released: true } }; }
    const epoch = generation, settings = await getSettings();
    if (epoch !== generation) return { ok: false, error: { code: 'compute_reset', message: '占用档位已切换。' } };
    if (!computeFeatureEnabled(type, settings)) return { ok: false, error: { code: 'feature_disabled', message: '当前占用档位未启用此本地功能，请在设置 → 离线功能中选择其他档位。' } };
    return (client ??= connectCompute(url)).send(message);
  };
}

function connectCompute(url: string) {
  const frame = document.createElement('iframe'); frame.src = url; frame.hidden = true;
  frame.setAttribute('sandbox', 'allow-scripts');
  const channel = new MessageChannel();
  const pending = new Map<string, (response: OffscreenResponse) => void>();
  let disposed = false;
  let signalReady: () => void;
  const ready = new Promise<void>(resolve => { signalReady = resolve; });
  channel.port1.onmessage = event => {
    if (event.data?.ready) { signalReady(); return; }
    if (event.data?.assetId && typeof event.data.path === 'string') {
      const { assetId, path } = event.data;
      void cachedModelFile(path).then(blob => { if (!disposed) channel.port1.postMessage({ assetId, blob }); }).catch(() => { if (!disposed) channel.port1.postMessage({ assetId }); }); return;
    }
    pending.get(event.data?.id)?.(event.data.response); pending.delete(event.data?.id);
  };
  frame.addEventListener('load', () => { if (!disposed) frame.contentWindow!.postMessage({ type: 'vma:compute-connect' }, '*', [channel.port2]); }, { once: true });
  document.body.append(frame);
  const send = (message: unknown): Promise<OffscreenResponse> => new Promise(resolve => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: { code: 'compute_timeout', message: '本地计算沙箱响应超时' } }); }, 180000);
    pending.set(id, response => { clearTimeout(timer); resolve(response); });
    void ready.then(() => { if (pending.has(id)) channel.port1.postMessage({ id, message }); });
  });
  return { send, dispose: () => {
    disposed = true;
    for (const resolve of pending.values()) resolve({ ok: false, error: { code: 'compute_reset', message: '占用档位已切换，本地计算已卸载。' } });
    pending.clear(); channel.port1.close(); channel.port2.close(); frame.remove();
  } };
}
