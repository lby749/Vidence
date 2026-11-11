import { describe, expect, it } from 'vitest';
import { addRecordedRange, isRangeCovered, missingRanges, totalDuration, unionRanges } from '@/pipeline/range';

describe('记录区间并集', () => {
  it('合并重叠与相邻区间', () => {
    expect(unionRanges([[0, 5], [4, 9], [12, 15]])).toEqual([
      [0, 9],
      [12, 15],
    ]);
  });

  it('总时长按并集计算，不重复累加', () => {
    expect(totalDuration([[0, 10], [5, 15], [20, 25]])).toBe(20);
  });

  it('识别已覆盖与缺口', () => {
    const recorded = unionRanges([[0, 30], [50, 80]]);
    expect(isRangeCovered(recorded, 10, 20)).toBe(true);
    expect(isRangeCovered(recorded, 25, 55)).toBe(false);
    expect(missingRanges(recorded, 0, 100)).toEqual([
      [30, 50],
      [80, 100],
    ]);
  });

  it('追加区间保持有序并去重', () => {
    expect(addRecordedRange([[10, 20]], [15, 30])).toEqual([[10, 30]]);
  });

  it('不把最大播放进度当成全部已记录', () => {
    const recorded = unionRanges([[0, 5], [100, 110]]);
    expect(missingRanges(recorded, 0, 110)).toEqual([[5, 100]]);
  });
});
