/** 区间并集（后台内部使用，复用管线实现） */
import { unionRanges, type Range } from '@/pipeline/range';

export function mergeRanges(ranges: Range[]): Range[] {
  return unionRanges(ranges);
}
