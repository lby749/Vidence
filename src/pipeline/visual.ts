/**
 * 画面变化检测（纯函数，便于测试）。
 *
 * 需求约束：
 * - 只比较相邻帧会漏掉逐步写板书、逐步画图等慢变化 → 与"上一张已保存关键帧"累计比较。
 * - 只用全图平均差异会漏掉公式负号、上下标、关键按钮 → 分块检测，取最大块差异。
 * - 字幕逐句变化、进度条、鼠标指针、控制层要降权或排除。
 */

import type { Keyframe, NormRect } from '@/shared/types';

export interface FrameSignature {
  cols: number;
  rows: number;
  /** 每个单元格的平均亮度 0..255 */
  cells: number[];
  /** 每格红、蓝通道均值；补足等亮度颜色变化。 */
  channels?: number[];
  /** 未遮罩区域的亮度跨度，用于拒绝空白画面。 */
  contrast?: number;
  width: number;
  height: number;
}

export interface SignatureOptions {
  cols?: number;
  rows?: number;
  /** 需要遮罩的区域（如字幕 ROI），归一化坐标 */
  mask?: NormRect | null;
  /** 底部边缘忽略比例（进度条/控制层） */
  ignoreBottomRatio?: number;
  /** 边缘忽略比例（鼠标、滚动条） */
  ignoreEdgeRatio?: number;
}

/**
 * 由 RGBA 像素生成网格亮度签名。
 * 只计算低分辨率亮度和颜色，不运行模型，可在 Worker 中快速执行。
 */
export function signatureFromImageData(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  options: SignatureOptions = {},
): FrameSignature {
  const cols = options.cols ?? 48;
  const rows = options.rows ?? 27;
  const mask = options.mask ?? null;
  const ignoreBottom = options.ignoreBottomRatio ?? 0.03;
  const ignoreEdge = options.ignoreEdgeRatio ?? 0.01;

  const sum = new Float64Array(cols * rows);
  const red = new Float64Array(cols * rows), blue = new Float64Array(cols * rows);
  const count = new Uint32Array(cols * rows);

  for (let y = 0; y < height; y++) {
    const ny = y / height;
    if (ny >= 1 - ignoreBottom || ny < ignoreEdge) continue;
    const row = Math.min(rows - 1, Math.floor(ny * rows));
    for (let x = 0; x < width; x++) {
      const nx = x / width;
      if (nx < ignoreEdge || nx >= 1 - ignoreEdge) continue;
      if (mask && nx >= mask.x && nx <= mask.x + mask.w && ny >= mask.y && ny <= mask.y + mask.h) {
        continue;
      }
      const idx = (y * width + x) * 4;
      const r = data[idx] ?? 0;
      const g = data[idx + 1] ?? 0;
      const b = data[idx + 2] ?? 0;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const col = Math.min(cols - 1, Math.floor(nx * cols));
      const cell = row * cols + col;
      sum[cell] += lum;
      red[cell] += r; blue[cell] += b;
      count[cell] += 1;
    }
  }

  const cells = new Array<number>(cols * rows);
  for (let i = 0; i < cells.length; i++) {
    cells[i] = count[i] > 0 ? sum[i] / count[i] : 0;
  }
  const visible = cells.filter((_, index) => count[index] > 0);
  const channels = cells.flatMap((_, index) => count[index] ? [red[index] / count[index], blue[index] / count[index]] : [0, 0]);
  return { cols, rows, cells, channels, contrast: visible.length ? Math.max(...visible) - Math.min(...visible) : 0, width, height };
}

export function hasFrameContent(sig: FrameSignature): boolean {
  return (sig.contrast ?? Math.max(...sig.cells) - Math.min(...sig.cells)) >= 6;
}

export function subtitleMask(roi?: NormRect | null): NormRect | null {
  return roi && roi.y >= 0.55 && roi.h <= 0.35 ? roi : null;
}

export interface FrameDiff {
  /** 全图平均差异 0..1 */
  global: number;
  /** 单块最大差异 0..1 */
  maxCell: number;
  /** 差异超过阈值的块数 */
  changedCells: number;
  /** 差异分布，用于调试 */
  cellDiffs: number[];
}

export function diffSignatures(a: FrameSignature, b: FrameSignature): FrameDiff {
  const n = Math.min(a.cells.length, b.cells.length);
  const cellDiffs = new Array<number>(n);
  let total = 0;
  let max = 0;
  for (let i = 0; i < n; i++) {
    let d = Math.abs((a.cells[i] ?? 0) - (b.cells[i] ?? 0)) / 255;
    if (a.channels && b.channels) d = Math.max(d, Math.abs(a.channels[i * 2] - b.channels[i * 2]) / 255, Math.abs(a.channels[i * 2 + 1] - b.channels[i * 2 + 1]) / 255);
    cellDiffs[i] = d;
    total += d;
    if (d > max) max = d;
  }
  const threshold = 0.12;
  return {
    global: n ? total / n : 0,
    maxCell: max,
    changedCells: cellDiffs.filter((d) => d >= threshold).length,
    cellDiffs,
  };
}

/** 容许鼠标/讲师小窗的少量运动，不让一两个网格阻断整张课件。 */
export function isFrameStable(a: FrameSignature, b: FrameSignature): boolean {
  const diff = diffSignatures(a, b);
  return diff.global <= 0.02 && diff.cellDiffs.filter(value => value > 0.08).length <= Math.max(2, Math.floor(diff.cellDiffs.length * 0.025));
}

export interface ChangeSignals {
  frame: FrameDiff;
  /** 内容区 OCR 文本相似度 0..1（1 = 相同） */
  textSimilarity?: number;
  /** 文字框布局变化 0..1 */
  layoutChange?: number;
  /** 是否处于字幕变化导致的变化（应降权） */
  subtitleOnlyChange?: boolean;
}

export interface ChangeDecision {
  score: number;
  changed: boolean;
  reason: string[];
}

/**
 * 多信号融合判断"是否值得进入候选保存"。
 * 阈值偏保守：宁可少保存，也不逐帧存档。
 */
export function evaluateChange(signals: ChangeSignals): ChangeDecision {
  const reasons: string[] = [];
  let score = 0;

  const { frame } = signals;
  // 小区域变化通道：公式负号、按钮、上下标
  if (frame.maxCell >= 0.18) {
    score += 0.5;
    reasons.push(`局部显著变化 ${(frame.maxCell * 100).toFixed(1)}%`);
  } else if (frame.maxCell >= 0.12) {
    score += 0.22;
    reasons.push(`局部细微变化 ${(frame.maxCell * 100).toFixed(1)}%`);
  }

  // 大面积变化通道：换页、切换镜头
  if (frame.global >= 0.08) {
    score += 0.45;
    reasons.push(`全图变化 ${(frame.global * 100).toFixed(1)}%`);
  } else if (frame.global >= 0.035) {
    score += 0.2;
    reasons.push(`全图轻微变化 ${(frame.global * 100).toFixed(1)}%`);
  }

  if (signals.textSimilarity !== undefined && signals.textSimilarity < 0.86) {
    score += 0.25;
    reasons.push('内容区文字变化');
  }
  if (signals.layoutChange !== undefined && signals.layoutChange > 0.25) {
    score += 0.2;
    reasons.push('文字布局变化');
  }
  if (signals.subtitleOnlyChange) {
    score -= 0.15;
    reasons.push('仅字幕变化（降权）');
  }

  const changed = score >= 0.4 && (frame.maxCell >= 0.12 || frame.global >= 0.035 || (signals.textSimilarity ?? 1) < 0.86);
  return { score: Math.max(0, Math.min(1, score)), changed, reason: reasons };
}

export interface SaveGateInput {
  /** 当前帧与上次保存关键帧的累计差异 */
  diff: FrameDiff;
  now: number;
  lastSavedAt: number | null;
  cooldownMs: number;
  savedCount: number;
  budget: number;
  mediaTime?: number;
  duration?: number;
  userRequested?: boolean;
}

export interface SaveGateResult {
  save: boolean;
  reason: string;
}

/** 可短时多留几张，但不能在长视频前半段耗尽全部空间。未知时长不猜测。 */
export function frameBudgetAt(time: number, duration: number | undefined, total: number): number {
  if (!duration || !Number.isFinite(duration) || duration <= 0) return total;
  const progress = Math.max(0, Math.min(1, time / duration));
  return Math.min(total, Math.ceil(total * progress + Math.min(4, total) * (1 - progress)));
}

export function shouldSaveKeyframe(input: SaveGateInput): SaveGateResult {
  if (input.userRequested) {
    if (input.savedCount >= input.budget) {
      return { save: false, reason: '存储预算已用尽，需清理后手动保存' };
    }
    return { save: true, reason: '用户手动标记' };
  }
  if (input.savedCount >= input.budget) {
    return { save: false, reason: `已达到关键帧预算（${input.budget}）` };
  }
  if (input.savedCount >= frameBudgetAt(input.mediaTime ?? 0, input.duration, input.budget)) return { save: false, reason: '为后续内容预留画面空间' };
  if (input.lastSavedAt !== null && input.now - input.lastSavedAt < input.cooldownMs) {
    return { save: false, reason: '冷却中' };
  }
  const significant = input.diff.maxCell >= 0.18 || input.diff.global >= 0.05;
  if (!significant) return { save: false, reason: '变化不足' };
  return {
    save: true,
    reason: input.diff.global >= 0.05 ? '累积画面变化' : '局部关键变化',
  };
}

/** 关键帧去重指纹：网格亮度量化后拼接 */
export function fingerprintOf(sig: FrameSignature): string {
  const q = [...sig.cells, ...(sig.channels ?? [])].map((c) => Math.round(c / 17).toString(16).padStart(2, '0')).join('');
  return `${sig.cols}x${sig.rows}${sig.channels ? 'c' : ''}:${q}`;
}

/** 比较最大局部差异，避免全图平均吞掉小范围公式变化 */
export function fingerprintDistance(a: string, b: string): number {
  if (a === b) return 0;
  const [ameta, adata] = a.split(':');
  const [bmeta, bdata] = b.split(':');
  if (ameta !== bmeta || !adata || !bdata || adata.length !== bdata.length) return 1;
  const levels = 15; // 亮度按 16 级量化
  let diff = 0;
  for (let i = 0; i < Math.min(adata.length, bdata.length); i += 2) {
    const av = parseInt(adata.slice(i, i + 2), 16) || 0;
    const bv = parseInt(bdata.slice(i, i + 2), 16) || 0;
    diff = Math.max(diff, Math.abs(av - bv) / levels);
  }
  return diff;
}

export function isKnowledgeFrame(frame: Keyframe): boolean {
  const result = frame.knowledge;
  return frame.reason === 'user' || !result || result.kind === 'knowledge';
}


export function isUncertainFrame(frame: Keyframe): boolean {
  return frame.reason !== 'user' && Boolean(frame.knowledge && (frame.knowledge.kind === 'uncertain' || (frame.knowledge.kind !== 'knowledge' && frame.knowledge.confidence < 0.8)));
}
