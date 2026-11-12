import manifest from './model-manifest.json';
import { APPROX_MODEL_FILES, EMBEDDING_MODEL_ID, RERANK_MODEL_ID, MODEL_REVISIONS } from './model-info';
import { RESOURCE_TIERS, type ResourceTier } from '@/shared/resource-tiers';

export interface ModelFile { path: string; url: string; bytes: number; sha256: string }
export const MODEL_CACHE = 'vma-models-v1';
export const CAPABILITIES = [
  { id: 'ocr', title: '画面文字识别', description: '识别中文字幕和中英混排画面。网页已有可读字幕时无需下载。', files: manifest.ocr.map((file, index) => ({ ...file, path: `ocr/${file.name}`, url: APPROX_MODEL_FILES.ocr[index].url })) },
  { id: 'vector', title: '按意思查找', description: '适合中文内容；即使措辞不同，也能查找相关片段。', files: manifest.models[EMBEDDING_MODEL_ID].map(file => ({ ...file, path: `models/${EMBEDDING_MODEL_ID}/${file.name}`, url: `https://hf-mirror.com/${EMBEDDING_MODEL_ID}/resolve/${MODEL_REVISIONS[EMBEDDING_MODEL_ID]}/${file.name}` })) },
  { id: 'rerank', title: '提高检索准确度', description: '对中英文候选片段重新排序，占用空间较大。', files: manifest.models[RERANK_MODEL_ID].map(file => ({ ...file, path: `models/${RERANK_MODEL_ID}/${file.name}`, url: `https://hf-mirror.com/${RERANK_MODEL_ID}/resolve/${MODEL_REVISIONS[RERANK_MODEL_ID]}/${file.name}` })) },
] as const;
export const MODEL_FILES: ModelFile[] = CAPABILITIES.flatMap(capability => capability.files);
export function tierCapabilities(id: ResourceTier) {
  const tier = RESOURCE_TIERS.find(tier => tier.id === id);
  if (!tier) throw new Error('请选择有效的占用档位');
  return CAPABILITIES.filter(item => (tier.capabilities as readonly string[]).includes(item.id));
}
export function tierDownloadBytes(id: ResourceTier): number {
  return tierCapabilities(id).reduce((sum, capability) => sum + capability.files.reduce((total, file) => total + file.bytes, 0), 0);
}
export async function downloadTier(id: ResourceTier, signal: AbortSignal, progress: (loaded: number, total: number) => void): Promise<void> {
  const total = tierDownloadBytes(id); let completed = 0;
  for (const capability of tierCapabilities(id)) {
    await downloadCapability(capability.id, signal, loaded => progress(completed + loaded, total));
    completed += capability.files.reduce((sum, file) => sum + file.bytes, 0);
  }
}
const cacheKey = (file: ModelFile) => `https://vma-model-cache.invalid/${file.path}?sha256=${file.sha256}`;

export async function verifyModelFile(file: ModelFile, data: ArrayBuffer): Promise<void> {
  if (data.byteLength !== file.bytes) throw new Error('下载文件大小不符，请重新下载');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== file.sha256) throw new Error('下载文件校验失败，请重新下载');
}

/** 只读取用户已下载的文件；推理过程不自行联网或触发下载。 */
export async function cachedModelFile(path: string): Promise<Blob | undefined> {
  const file = MODEL_FILES.find(item => item.path === path);
  if (!file) return undefined;
  return (await (await caches.open(MODEL_CACHE)).match(cacheKey(file)))?.blob();
}

export async function installedCapabilities(): Promise<Record<string, boolean>> {
  const cache = await caches.open(MODEL_CACHE);
  const entries = await Promise.all(CAPABILITIES.map(async item => [item.id, (await Promise.all(item.files.map(file => cache.match(cacheKey(file))))).every(Boolean)]));
  const result = Object.fromEntries(entries);
  return result;
}

export async function downloadCapability(id: string, signal: AbortSignal, progress: (loaded: number, total: number) => void): Promise<void> {
  const capability = CAPABILITIES.find(item => item.id === id);
  if (!capability) throw new Error('未知的功能');
  const cache = await caches.open(MODEL_CACHE);
  const total = capability.files.reduce((sum, file) => sum + file.bytes, 0);
  let completed = 0;
  for (const file of capability.files) {
    signal.throwIfAborted();
    if (await cache.match(cacheKey(file))) { completed += file.bytes; progress(completed, total); continue; }
    const response = await fetch(file.url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!response.ok || !response.body) throw new Error(`下载失败（${response.status}），已完成的文件会保留`);
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      loaded += value.byteLength;
      if (loaded > file.bytes) { await reader.cancel(); throw new Error('下载文件大小异常'); }
      chunks.push(value); progress(completed + loaded, total);
    }
    const data = new Uint8Array(loaded); let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
    await verifyModelFile(file, data.buffer);
    signal.throwIfAborted();
    await cache.put(cacheKey(file), new Response(data, { headers: { 'Content-Type': file.path.endsWith('.json') ? 'application/json' : 'application/octet-stream' } }));
    completed += loaded; progress(completed, total);
  }
}
