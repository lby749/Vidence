/**
 * 视频帧采集（内容脚本侧）。
 *
 * 优先从 video 元素绘制到 canvas，这是浏览器允许的安全读取路线；
 * 跨域视频可能污染 canvas，此时不绕过安全策略，改为由后台走用户授权的标签页捕获。
 */

import type { NormRect } from '@/shared/types';
import { signatureFromImageData, type FrameSignature } from '@/pipeline/visual';

export interface CapturedFrame {
  dataUrl: string;
  width: number;
  height: number;
  signature?: FrameSignature;
}

export class FrameCaptureError extends Error {
  reason: 'no_video' | 'tainted' | 'not_ready' | 'empty';
  constructor(reason: CapturedFrameErrorReason, message: string) {
    super(message);
    this.name = 'FrameCaptureError';
    this.reason = reason;
  }
}
export type CapturedFrameErrorReason = 'no_video' | 'tainted' | 'not_ready' | 'empty';

let sharedCanvas: HTMLCanvasElement | null = null;

function canvas(): HTMLCanvasElement {
  if (!sharedCanvas) sharedCanvas = document.createElement('canvas');
  return sharedCanvas;
}

function sourceRect(video: HTMLVideoElement, roi?: NormRect) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!roi) return { sx: 0, sy: 0, sw: vw, sh: vh };
  return {
    sx: Math.round(vw * roi.x),
    sy: Math.round(vh * roi.y),
    sw: Math.max(1, Math.round(vw * roi.w)),
    sh: Math.max(1, Math.round(vh * roi.h)),
  };
}

export function captureVideoFrame(
  video: HTMLVideoElement | null,
  options: { roi?: NormRect; maxWidth?: number; format?: 'jpeg' | 'png'; quality?: number; signatureMask?: NormRect | null } = {},
): CapturedFrame {
  if (!video) throw new FrameCaptureError('no_video', '没有可用的视频元素');
  if (video.readyState < 2 || video.videoWidth === 0) {
    throw new FrameCaptureError('not_ready', '视频尚未就绪');
  }
  const { sx, sy, sw, sh } = sourceRect(video, options.roi);
  const maxWidth = options.maxWidth ?? 1280;
  const scale = Math.min(1, maxWidth / sw);
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));

  const c = canvas();
  c.width = dw;
  c.height = dh;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new FrameCaptureError('empty', '无法创建 2D 画布');
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, dw, dh);

  try {
    const format = options.format ?? 'jpeg';
    const dataUrl = c.toDataURL(`image/${format}`, options.quality ?? 0.94);
    if (dataUrl.length < 32) throw new FrameCaptureError('empty', '截图为空');
    let signature: FrameSignature | undefined;
    if (options.signatureMask !== undefined) {
      const thumbnail = document.createElement('canvas'); thumbnail.width = Math.min(320, dw); thumbnail.height = Math.max(1, Math.round(dh * thumbnail.width / dw));
      const context = thumbnail.getContext('2d', { willReadFrequently: true })!;
      context.drawImage(c, 0, 0, thumbnail.width, thumbnail.height);
      signature = signatureFromImageData(context.getImageData(0, 0, thumbnail.width, thumbnail.height).data, thumbnail.width, thumbnail.height, { mask: options.signatureMask });
    }
    return { dataUrl, width: dw, height: dh, signature };
  } catch (error) {
    // SecurityError：跨域画面污染 canvas。不得修改安全策略或读取受保护内容。
    throw new FrameCaptureError('tainted', `画面不可读取（可能跨域或受保护）：${(error as Error).message}`);
  }
}

/**
 * 采样低分辨率亮度签名。只读取像素用于差分，不持久化、不上传。
 */
export function sampleSignature(
  video: HTMLVideoElement | null,
  options: { roi?: NormRect | null; mask?: NormRect | null; cols?: number; rows?: number } = {},
): FrameSignature {
  if (!video) throw new FrameCaptureError('no_video', '没有可用的视频元素');
  if (video.readyState < 2) throw new FrameCaptureError('not_ready', '视频尚未就绪');
  const cols = options.cols ?? 48;
  const rows = options.rows ?? 27;
  const { sx, sy, sw, sh } = sourceRect(video, options.roi ?? undefined);
  // 采样宽度保持在 320 左右：足够分辨公式符号，又远小于原始帧
  const scale = Math.min(1, 320 / sw);
  const dw = Math.max(8, Math.round(sw * scale));
  const dh = Math.max(8, Math.round(sh * scale));
  const c = canvas();
  c.width = dw;
  c.height = dh;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new FrameCaptureError('empty', '无法创建 2D 画布');
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, dw, dh);
  let data: ImageData;
  try {
    data = ctx.getImageData(0, 0, dw, dh);
  } catch (error) {
    throw new FrameCaptureError('tainted', `画面不可读取（可能跨域或受保护）：${(error as Error).message}`);
  }
  return signatureFromImageData(data.data, dw, dh, {
    cols,
    rows,
    mask: options.mask ?? null,
  });
}

/** 判断视频是否可能被 canvas 读取（仅作提示，真实结果以绘制为准） */
export function canReadVideoPixels(video: HTMLVideoElement): boolean {
  try {
    const c = canvas();
    c.width = 8;
    c.height = 8;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return false;
    ctx.drawImage(video, 0, 0, 8, 8);
    ctx.getImageData(0, 0, 8, 8);
    return true;
  } catch {
    return false;
  }
}
