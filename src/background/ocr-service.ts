/**
 * Offscreen 文档管理 + OCR 调用（后台侧）。
 */

import type { OffscreenRequest, OffscreenResponse, OcrResultPayload, OcrStatusPayload } from '@/shared/offscreen';

let creating: Promise<void> | null = null;

export async function ensureOffscreen(): Promise<boolean> {
  const existing = await chrome.runtime.getContexts?.({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
  });
  if (existing && existing.length > 0) return true;
  if (creating) {
    await creating;
    return true;
  }
  creating = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.USER_MEDIA],
        justification: '在本地运行 OCR 与向量计算，不上传视频内容',
      });
    } catch (error) {
      if (!String((error as Error).message).includes('single offscreen')) throw error;
    }
  })();
  try {
    await creating;
    return true;
  } catch {
    return false;
  } finally {
    creating = null;
  }
}

export async function offscreenRequest<T>(request: Omit<OffscreenRequest, 'target'> & Record<string, unknown>, timeoutMs = 45000): Promise<T> {
  const ready = await ensureOffscreen();
  if (!ready) throw new Error('无法创建 offscreen 文档（浏览器不支持或已达到数量限制）');
  const payload = { ...request, target: 'offscreen' } as OffscreenRequest;
  const response = (await Promise.race([
    chrome.runtime.sendMessage(payload),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ])) as OffscreenResponse<T> | null;
  if (!response) throw new Error('OCR/向量服务无响应或超时');
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
  return response.data;
}

export async function ocrStatus(): Promise<OcrStatusPayload> {
  try {
    return await offscreenRequest<OcrStatusPayload>({ type: 'ocr:status' }, 5000);
  } catch (error) {
    return {
      state: 'error',
      engine: 'none',
      modelId: null,
      backend: null,
      webgpuAvailable: false,
      error: (error as Error).message,
    };
  }
}

export async function recognize(dataUrl: string, kind: 'subtitle' | 'content' = 'subtitle'): Promise<OcrResultPayload> {
  return offscreenRequest<OcrResultPayload>({ type: 'ocr:recognize', dataUrl, kind }, 60000);
}

/** 把 OCR 结果中的归一化框转换为字幕 ROI 候选 */
export function estimateSubtitleRoi(
  results: OcrResultPayload[],
): { roi: { x: number; y: number; w: number; h: number }; confidence: number; text: string } | null {
  const candidates: Array<{ x: number; y: number; w: number; h: number; text: string; score: number }> = [];
  for (const result of results) {
    for (const item of result.items) {
      const text = item.text.trim();
      if (text.length < 1) continue;
      // 底部 55% 的文本优先；单行、宽度不超过 92%
      if (item.rect.y < 0.45) continue;
      if (item.rect.w > 0.95) continue;
      if (item.rect.h > 0.25) continue;
      candidates.push({ ...item.rect, text, score: item.score });
    }
  }
  if (candidates.length === 0) return null;

  // 按 y 聚类（同一行字幕）
  const sorted = [...candidates].sort((a, b) => a.y - b.y);
  const clusters: Array<typeof candidates> = [];
  for (const item of sorted) {
    const cluster = clusters.find((c) => Math.abs(c[0]!.y - item.y) < 0.05);
    if (cluster) cluster.push(item);
    else clusters.push([item]);
  }
  const ranked = clusters
    .map((cluster) => {
      const x = Math.min(...cluster.map((c) => c.x));
      const y = Math.min(...cluster.map((c) => c.y));
      const right = Math.max(...cluster.map((c) => c.x + c.w));
      const bottom = Math.max(...cluster.map((c) => c.y + c.h));
      const text = cluster.map((c) => c.text).join(' ');
      const bottomBias = y; // 越靠下越像字幕
      const score = (cluster.reduce((sum, c) => sum + c.score, 0) / cluster.length) * 0.5 + bottomBias * 0.5;
      return { x, y, w: right - x, h: bottom - y, text, score, count: cluster.length };
    })
    .filter((c) => c.w > 0.08 && c.h < 0.3)
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best) return null;
  const padX = 0.02;
  const padY = 0.015;
  return {
    roi: {
      x: Math.max(0, best.x - padX),
      y: Math.max(0, best.y - padY),
      w: Math.min(1 - Math.max(0, best.x - padX), best.w + padX * 2),
      h: Math.min(1 - Math.max(0, best.y - padY), best.h + padY * 2),
    },
    confidence: Math.min(0.95, 0.55 + best.count * 0.12),
    text: best.text,
  };
}
