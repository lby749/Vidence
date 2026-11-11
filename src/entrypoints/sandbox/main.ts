/**
 * Sandbox 文档：承载 OCR（PaddleOCR）与 embedding（Transformers.js）等本地计算。
 *
 * 仅通过父 offscreen 页面建立的 MessagePort 收发请求，无扩展 API 权限。
 */

import type {
  EmbedStatusPayload,
  OffscreenResponse,
  OcrResultPayload,
  OcrStatusPayload,
  RerankStatusPayload,
} from '@/shared/offscreen';
import { APPROX_MODEL_FILES, RERANK_MODEL_ID } from '@/models/model-info';

const MODEL_BASE = new URL('models/', location.href).href;
const ORT_WASM_PATH = new URL('ort/', location.href).href;
let assetPort: MessagePort;
const assets = new Map<string, (blob?: Blob) => void>();
function readAsset(path: string): Promise<Blob | undefined> {
  const assetId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { assets.delete(assetId); reject(new Error('读取离线资源超时')); }, 30000);
    assets.set(assetId, blob => { clearTimeout(timer); resolve(blob); });
    assetPort.postMessage({ assetId, path });
  });
}
async function ocrAsset(path: string): Promise<string> {
  const blob = await readAsset(`ocr/${path}`);
  if (!blob) throw new Error('请先在设置 → 离线功能中下载“画面文字识别”');
  return URL.createObjectURL(blob);
}
async function transformersRuntime() {
  const transformers = await import('@huggingface/transformers');
  transformers.env.allowLocalModels = true;
  transformers.env.allowRemoteModels = false;
  transformers.env.localModelPath = MODEL_BASE;
  transformers.env.useBrowserCache = false;
  transformers.env.fetch = async (input, init) => {
    const url = String(input);
    if (!url.startsWith(MODEL_BASE)) return fetch(input, init);
    const blob = await readAsset(`models/${url.slice(MODEL_BASE.length)}`);
    return blob ? new Response(blob) : new Response('请先在设置中下载对应离线功能', { status: 404 });
  };
  transformers.env.backends.onnx.wasm!.numThreads = 1;
  transformers.env.backends.onnx.wasm!.wasmPaths = new URL('ort-transformers/', location.href).href;
  return transformers;
}

interface PaddleOcrInstance {
  predict(input: Blob): Promise<
    Array<{
      items: Array<{ poly: Array<[number, number]>; text: string; score: number }>;
      metrics: { detMs: number; recMs: number; totalMs: number; detectedBoxes: number; recognizedCount: number };
      runtime: { requestedBackend: string; detProvider: string; recProvider: string; webgpuAvailable: boolean };
      image: { width: number; height: number };
    }>
  >;
}

let ocr: PaddleOcrInstance | null = null;
let ocrPromise: Promise<PaddleOcrInstance> | null = null;
let ocrStatusState: OcrStatusPayload = {
  state: 'idle',
  engine: 'paddle',
  modelId: null,
  backend: null,
  webgpuAvailable: false,
};
let ocrInitializedAt = 0;

async function loadOcr(): Promise<PaddleOcrInstance> {
  if (ocr) return ocr;
  if (ocrPromise) return ocrPromise;
  ocrStatusState = { ...ocrStatusState, state: 'loading' };
  const started = performance.now();
  ocrPromise = (async () => {
    const { PaddleOCR } = await import('@paddleocr/paddleocr-js');
    const urls = await Promise.all([ocrAsset('PP-OCRv5_mobile_det_onnx_infer.tar'), ocrAsset('PP-OCRv5_mobile_rec_onnx_infer.tar')]);
    let instance;
    try { instance = await PaddleOCR.create({
      // 只读取已下载并校验的资源；运行时仍随安装包分发。
      textDetectionModelName: 'PP-OCRv5_mobile_det',
      textRecognitionModelName: 'PP-OCRv5_mobile_rec',
      textDetectionModelAsset: { url: urls[0] },
      textRecognitionModelAsset: { url: urls[1] },
      // 显式使用 WASM/CPU：避免 WebGPU 初始化再次触发显卡驱动超时（本机曾出现 nvlddmkm 153）
      ortOptions: { backend: 'wasm', wasmPaths: ORT_WASM_PATH, numThreads: 1 },
    }); } finally { urls.forEach(url => URL.revokeObjectURL(url)); }
    ocr = instance as unknown as PaddleOcrInstance;
    ocrInitializedAt = Date.now();
    ocrStatusState = {
      state: 'ready',
      engine: 'paddle',
      modelId: 'PP-OCRv5_mobile_det + PP-OCRv5_mobile_rec',
      backend: 'wasm',
      webgpuAvailable: typeof navigator !== 'undefined' && 'gpu' in navigator,
      elapsedMs: Math.round(performance.now() - started),
    };
    return ocr;
  })();
  try {
    return await ocrPromise;
  } catch (error) {
    ocrStatusState = {
      ...ocrStatusState,
      state: 'error',
      error: (error as Error).message,
    };
    ocrPromise = null;
    throw error;
  }
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl);
  return response.blob();
}

async function recognize(dataUrl: string): Promise<OcrResultPayload> {
  const instance = await loadOcr();
  const blob = await dataUrlToBlob(dataUrl);
  const [result] = await instance.predict(blob);
  if (!result) throw new Error('OCR 没有返回结果');
  const width = result.image.width || 1;
  const height = result.image.height || 1;
  return {
    items: result.items.map((item) => {
      const xs = item.poly.map((p) => p[0]);
      const ys = item.poly.map((p) => p[1]);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      return {
        text: item.text,
        score: item.score,
        rect: {
          x: minX / width,
          y: minY / height,
          w: Math.max(0, (maxX - minX) / width),
          h: Math.max(0, (maxY - minY) / height),
        },
      };
    }),
    metrics: result.metrics,
    runtime: result.runtime,
    modelId: 'PP-OCRv5_mobile_det + PP-OCRv5_mobile_rec',
    modelFiles: APPROX_MODEL_FILES.ocr.map((f) => f.name),
    image: { width, height },
  };
}

/* --------------------------- Embedding --------------------------- */

type Extractor = (texts: string[], options?: Record<string, unknown>) => Promise<{ tolist(): number[][]; dims: number[] }>;
const extractors = new Map<string, Promise<Extractor>>();
let embedStatus: EmbedStatusPayload = { state: 'idle', modelId: null, dimension: null };

async function loadExtractor(modelId: string): Promise<Extractor> {
  const cached = extractors.get(modelId);
  if (cached) return cached;
  embedStatus = { state: 'loading', modelId, dimension: null };
  const promise = (async () => {
    const transformers = await transformersRuntime();
    const pipe = await transformers.pipeline('feature-extraction', modelId, { dtype: 'q8', device: 'wasm' });
    embedStatus = { state: 'ready', modelId, dimension: 512 };
    return pipe as unknown as Extractor;
  })();
  extractors.set(modelId, promise);
  try {
    return await promise;
  } catch (error) {
    extractors.delete(modelId);
    embedStatus = { state: 'error', modelId, dimension: null, error: (error as Error).message };
    throw error;
  }
}

async function encode(modelId: string, texts: string[]): Promise<{ vectors: number[][]; dim: number }> {
  const extractor = await loadExtractor(modelId);
  const output = await extractor(texts, { pooling: 'cls', normalize: true });
  return { vectors: output.tolist(), dim: output.dims[output.dims.length - 1] ?? 0 };
}

/* --------------------------- 本地重排 --------------------------- */

type RerankModel = {
  tokenizer: { (text: string[], options: Record<string, unknown>): Promise<unknown>; batch_decode?: unknown };
  model: (inputs: unknown) => Promise<{ logits: { tolist(): number[][] } }>;
};

let rerankModel: RerankModel | null = null;
let rerankPromise: Promise<RerankModel> | null = null;
let rerankStatus: RerankStatusPayload = { state: 'idle', modelId: RERANK_MODEL_ID, error: null };

async function loadReranker(): Promise<RerankModel> {
  if (rerankModel) return rerankModel;
  if (rerankPromise) return rerankPromise;
  rerankStatus = { state: 'loading', modelId: RERANK_MODEL_ID, error: null };
  const started = performance.now();
  rerankPromise = (async () => {
    const transformers = await transformersRuntime();
    const tokenizer = await transformers.AutoTokenizer.from_pretrained(RERANK_MODEL_ID);
    const model = await transformers.AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL_ID, {
      dtype: 'int8',
      device: 'wasm',
    });
    const wrapped: RerankModel = {
      tokenizer: tokenizer as unknown as RerankModel['tokenizer'],
      model: model as unknown as RerankModel['model'],
    };
    rerankModel = wrapped;
    rerankStatus = {
      state: 'ready',
      modelId: RERANK_MODEL_ID,
      error: null,
      elapsedMs: Math.round(performance.now() - started),
    };
    return wrapped;
  })();
  try {
    return await rerankPromise;
  } catch (error) {
    rerankStatus = { state: 'error', modelId: RERANK_MODEL_ID, error: (error as Error).message };
    rerankPromise = null;
    throw error;
  }
}

async function rerank(query: string, documents: string[]): Promise<{ scores: number[]; modelId: string }> {
  if (documents.length === 0) return { scores: [], modelId: RERANK_MODEL_ID };
  const { tokenizer, model } = await loadReranker();
  const queries = documents.map(() => query);
  const inputs = await tokenizer(queries, {
    text_pair: documents,
    padding: true,
    truncation: true,
    max_length: 512,
  });
  const output = await model(inputs);
  const rows = output.logits.tolist();
  const scores = rows.map((row) => {
    const raw = Array.isArray(row) ? row[0] ?? 0 : 0;
    // bge-reranker 输出单 logit，用 sigmoid 映射到 0..1 便于融合
    return 1 / (1 + Math.exp(-raw));
  });
  return { scores, modelId: RERANK_MODEL_ID };
}

/* --------------------------- 消息入口 --------------------------- */

function reply<T>(sendResponse: (response: OffscreenResponse<T>) => void, promise: Promise<T>): true {
  promise
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: { code: 'offscreen_error', message: (error as Error).message } }));
  return true;
}

function dispatch(message: { target?: string; type?: string }, sendResponse: (response: OffscreenResponse) => void) {
  if (message?.target !== 'offscreen') return false;
  switch (message.type) {
    case 'ping':
      sendResponse({ ok: true, data: { ok: true } });
      return false;
    case 'ocr:status':
      sendResponse({ ok: true, data: ocrStatusState });
      return false;
    case 'ocr:warmup':
      return reply(sendResponse, loadOcr().then(() => ocrStatusState));
    case 'ocr:recognize': {
      const payload = message as unknown as { dataUrl: string };
      return reply(sendResponse, recognize(payload.dataUrl));
    }
    case 'embed:status':
      sendResponse({ ok: true, data: embedStatus });
      return false;
    case 'embed:warmup': {
      const payload = message as unknown as { modelId: string };
      return reply(sendResponse, loadExtractor(payload.modelId).then(() => embedStatus));
    }
    case 'embed:encode': {
      const payload = message as unknown as { modelId: string; texts: string[] };
      return reply(sendResponse, encode(payload.modelId, payload.texts));
    }
    case 'rerank:status':
      sendResponse({ ok: true, data: rerankStatus });
      return false;
    case 'rerank:warmup':
      return reply(sendResponse, loadReranker().then(() => rerankStatus));
    case 'rerank:score': {
      const payload = message as unknown as { query: string; documents: string[] };
      return reply(sendResponse, rerank(payload.query, payload.documents));
    }
    default:
      sendResponse({ ok: false, error: { code: 'unknown', message: '未知的 offscreen 请求' } });
      return false;
  }
}

let connected = false;
window.addEventListener('message', (event) => {
  if (connected || event.source !== window.parent || event.data?.type !== 'vma:compute-connect' || event.ports.length !== 1) return;
  connected = true;
  const port = event.ports[0]!;
  assetPort = port;
  port.onmessage = (request) => {
    if (request.data?.assetId) {
      assets.get(request.data.assetId)?.(request.data.blob);
      assets.delete(request.data.assetId); return;
    }
    const { id, message } = request.data;
    dispatch(message, (response) => port.postMessage({ id, response }));
  };
  port.postMessage({ ready: true });
});

void ocrInitializedAt;
