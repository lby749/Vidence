/**
 * 记录区间的并集运算。
 *
 * 实际记录范围是区间并集；不能把最大播放进度当成此前内容全部已记录。
 * 缺口要能明确显示，不能补造内容。
 */

export type Range = [number, number];

function clean(ranges: Range[]): Range[] {
  return ranges
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e >= s)
    .map(([s, e]) => [Math.max(0, s), Math.max(0, e)] as Range)
    .sort((a, b) => a[0] - b[0]);
}

export function unionRanges(ranges: Range[]): Range[] {
  const sorted = clean(ranges);
  const out: Range[] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + 0.05) {
      last[1] = Math.max(last[1], e);
    } else {
      out.push([s, e]);
    }
  }
  return out;
}

export function totalDuration(ranges: Range[]): number {
  return unionRanges(ranges).reduce((sum, [s, e]) => sum + (e - s), 0);
}

/** 判断区间是否被记录范围覆盖（允许 epsilon 容差） */
export function isRangeCovered(recorded: Range[], start: number, end: number, epsilon = 0.5): boolean {
  const merged = unionRanges([...recorded, [start, end]]);
  // 合并后如果新增区间没扩大整体覆盖范围，说明已被覆盖
  const before = totalDuration(recorded);
  const after = totalDuration(merged);
  return after - before <= epsilon;
}

/** 计算 [start,end] 中尚未记录的子区间 */
export function missingRanges(recorded: Range[], start: number, end: number): Range[] {
  if (end <= start) return [];
  const covered = unionRanges(recorded);
  const out: Range[] = [];
  let cursor = start;
  for (const [s, e] of covered) {
    if (e <= cursor) continue;
    if (s >= end) break;
    if (s > cursor) out.push([cursor, Math.min(s, end)]);
    cursor = Math.max(cursor, e);
    if (cursor >= end) break;
  }
  if (cursor < end) out.push([cursor, end]);
  return out.filter(([s, e]) => e - s > 0.5);
}

/** 给记录区间追加一小段覆盖（播放观察到的连续片段） */
export function addRecordedRange(recorded: Range[], range: Range): Range[] {
  return unionRanges([...recorded, range]);
}
