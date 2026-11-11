import { describe, expect, it } from 'vitest';
import {
  diffSignatures,
  evaluateChange,
  fingerprintDistance,
  fingerprintOf,
  shouldSaveKeyframe,
  signatureFromImageData,
  hasFrameContent,
  isFrameStable,
  frameBudgetAt,
  type FrameSignature,
} from '@/pipeline/visual';

function flat(cols = 12, rows = 8, value = 100): FrameSignature {
  return { cols, rows, cells: new Array(cols * rows).fill(value), width: 120, height: 80 };
}

/** 构造 RGBA 图像：指定矩形区域为亮色，其余为暗色 */
function makeImage(width: number, height: number, brightRect: { x: number; y: number; w: number; h: number }) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = x >= brightRect.x && x < brightRect.x + brightRect.w && y >= brightRect.y && y < brightRect.y + brightRect.h;
      const index = (y * width + x) * 4;
      const value = inside ? 240 : 20;
      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
      data[index + 3] = 255;
    }
  }
  return data;
}

describe('画面变化检测', () => {
  it('小区域变化（如公式负号）也能被检测到', () => {
    const base = makeImage(240, 160, { x: 0, y: 0, w: 0, h: 0 });
    const changed = makeImage(240, 160, { x: 110, y: 70, w: 8, h: 4 }); // 公式负号大小的一块
    const a = signatureFromImageData(base, 240, 160);
    const b = signatureFromImageData(changed, 240, 160);
    const diff = diffSignatures(a, b);
    expect(diff.maxCell).toBeGreaterThan(0.15);
    const decision = evaluateChange({ frame: diff });
    expect(decision.changed).toBe(true);
    expect(decision.reason.join()).toContain('局部');
  });

  it('大面积换页被检测到', () => {
    const a = signatureFromImageData(makeImage(240, 160, { x: 0, y: 0, w: 240, h: 0 }), 240, 160);
    const b = signatureFromImageData(makeImage(240, 160, { x: 0, y: 0, w: 240, h: 160 }), 240, 160);
    const decision = evaluateChange({ frame: diffSignatures(a, b) });
    expect(decision.changed).toBe(true);
  });

  it('仅字幕变化时降权，不因每句字幕保存整帧', () => {
    const diff = { global: 0.02, maxCell: 0.13, changedCells: 2, cellDiffs: [] };
    const decision = evaluateChange({ frame: diff, subtitleOnlyChange: true });
    expect(decision.changed).toBe(false);
  });

  it('与上一张已保存关键帧累计比较（慢变化可被发现）', () => {
    const a = flat(12, 8, 40);
    const b = flat(12, 8, 80); // 单次相邻差不一定大，但累计差异明显
    const diff = diffSignatures(a, b);
    expect(diff.global).toBeGreaterThan(0.1);
    const decision = evaluateChange({ frame: diff });
    expect(decision.changed).toBe(true);
  });

  it('保存门限遵守冷却与预算', () => {
    const diff = { global: 0.09, maxCell: 0.3, changedCells: 5, cellDiffs: [] };
    const base = { diff, now: 10_000, lastSavedAt: 0, cooldownMs: 8000, savedCount: 0, budget: 10 };
    expect(shouldSaveKeyframe(base).save).toBe(true);
    expect(shouldSaveKeyframe({ ...base, lastSavedAt: 9000 }).save).toBe(false);
    expect(shouldSaveKeyframe({ ...base, savedCount: 10 }).save).toBe(false);
    expect(shouldSaveKeyframe({ ...base, userRequested: true, savedCount: 10 }).save).toBe(false);
    expect(shouldSaveKeyframe({ ...base, userRequested: true }).save).toBe(true);
  });

  it('指纹可区分不同画面并识别近似重复', () => {
    const a = flat(12, 8, 40);
    const b = flat(12, 8, 200);
    expect(fingerprintDistance(fingerprintOf(a), fingerprintOf(a))).toBe(0);
    expect(fingerprintDistance(fingerprintOf(a), fingerprintOf(b))).toBeGreaterThan(0.5);
  });

  it('去重不能抹掉只占一个网格的公式或按钮变化', () => {
    const a = flat(24, 14, 220), b = flat(24, 14, 220);
    b.cells[100] = 100;
    expect(fingerprintDistance(fingerprintOf(a), fingerprintOf(b))).toBeGreaterThan(0.015);
  });

  it('同样亮度的图表颜色变化也不能漏掉', () => {
    const image = (red: number, green: number) => {
      const pixels = new Uint8Array(240 * 160 * 4);
      for (let i = 0; i < pixels.length / 2; i += 4) { pixels[i] = red; pixels[i + 1] = green; pixels[i + 3] = 255; }
      return signatureFromImageData(pixels, 240, 160);
    };
    const a = image(255, 0), b = image(0, 130);
    expect(evaluateChange({ frame: diffSignatures(a, b) }).changed).toBe(true);
    expect(fingerprintDistance(fingerprintOf(a), fingerprintOf(b))).toBeGreaterThan(0.5);
  });

  it('遮掉字幕后的空白不算内容，少量鼠标运动不阻断稳定画面', () => {
    const blank = new Uint8Array(240 * 160 * 4).fill(255);
    expect(hasFrameContent(signatureFromImageData(blank, 240, 160, { mask: { x: 0, y: 0.7, w: 1, h: 0.3 } }))).toBe(false);
    const a = flat(24, 14), b = flat(24, 14); b.cells[70] = 240;
    expect(isFrameStable(a, b)).toBe(true);
  });

  it('长视频预算留给后半段，手动截图仍由用户决定', () => {
    expect(frameBudgetAt(0, 2000, 60)).toBe(4);
    expect(frameBudgetAt(1000, 2000, 60)).toBe(32);
    expect(frameBudgetAt(1980, 2000, 60)).toBe(60);
    expect(frameBudgetAt(1000, undefined, 60)).toBe(60);
    const input = { diff: { global: 0.2, maxCell: 0.5, changedCells: 4, cellDiffs: [] }, now: 90000, lastSavedAt: null, cooldownMs: 4000, savedCount: 32, budget: 60, mediaTime: 1000, duration: 2000 };
    expect(shouldSaveKeyframe(input).save).toBe(false);
    expect(shouldSaveKeyframe({ ...input, userRequested: true }).save).toBe(true);
  });
});
