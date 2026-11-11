/**
 * Offscreen 文档通信协议。
 * Offscreen 承载需要 DOM / 媒体流 / WASM 的后台处理（OCR、embedding）。
 */

export interface OcrItem {
  text: string;
  score: number;
  /** 归一化坐标（相对输入图像） */
  rect: { x: number; y: number; w: number; h: number };
}

export interface OcrResultPayload {
  items: OcrItem[];
  metrics: { detMs: number; recMs: number; totalMs: number; detectedBoxes: number; recognizedCount: number };
  runtime: { requestedBackend: string; detProvider: string; recProvider: string; webgpuAvailable: boolean };
  modelId: string;
  modelFiles: string[];
  image: { width: number; height: number };
}

export type OffscreenRequest =
  | { target: 'offscreen'; type: 'compute:reset' }
  | { target: 'offscreen'; type: 'ocr:status' }
  | { target: 'offscreen'; type: 'ocr:warmup' }
  | { target: 'offscreen'; type: 'ocr:recognize'; dataUrl: string; kind?: 'subtitle' | 'content' }
  | { target: 'offscreen'; type: 'embed:status' }
  | { target: 'offscreen'; type: 'embed:warmup'; modelId: string }
  | { target: 'offscreen'; type: 'embed:encode'; modelId: string; texts: string[] }
  | { target: 'offscreen'; type: 'rerank:status' }
  | { target: 'offscreen'; type: 'rerank:warmup' }
  | { target: 'offscreen'; type: 'rerank:score'; query: string; documents: string[] }
  | { target: 'offscreen'; type: 'ping' };

export type OffscreenResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

export interface OcrStatusPayload {
  state: 'idle' | 'loading' | 'ready' | 'error';
  engine: 'paddle' | 'none';
  modelId: string | null;
  backend: string | null;
  webgpuAvailable: boolean;
  elapsedMs?: number;
  error?: string;
}

export interface EmbedStatusPayload {
  state: 'idle' | 'loading' | 'ready' | 'error';
  modelId: string | null;
  dimension: number | null;
  error?: string;
}

export interface RerankStatusPayload {
  state: 'idle' | 'loading' | 'ready' | 'error';
  modelId: string;
  error: string | null;
  elapsedMs?: number;
}
