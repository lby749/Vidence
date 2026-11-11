import { describe, expect, it } from 'vitest';
import { draftTitle, segmentEvidence } from '@/pipeline/segmenter';

const ev = (id: string, start: number, end: number, text: string) => ({ id, startTime: start, endTime: end, text });

describe('规则节点切分', () => {
  it('按时间间隙切分', () => {
    const segments = segmentEvidence([
      ev('a', 0, 2, '第一段内容足够长一些'),
      ev('b', 3, 5, '紧接着的同一段'),
      ev('c', 20, 22, '停顿之后的另一段内容'),
    ]);
    expect(segments).toHaveLength(2);
    expect(segments[0].evidenceIds).toEqual(['a', 'b']);
    expect(segments[1].evidenceIds).toEqual(['c']);
  });

  it('超过字数上限时切分', () => {
    const long = '这是一句比较长的讲解内容。'.repeat(20);
    const segments = segmentEvidence([ev('a', 0, 10, long)], { maxChars: 120 });
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.every((s) => s.charCount <= 130)).toBe(true);
  });

  it('碎片尾段并入前一段', () => {
    const segments = segmentEvidence([
      ev('a', 0, 5, '这是一段足够长的讲解内容，用来触发节点切分阈值。'),
      ev('b', 6, 7, '嗯'),
    ]);
    expect(segments).toHaveLength(1);
  });

  it('占位标题不冒充摘要', () => {
    expect(draftTitle('排队论研究服务系统。下一句')).toBe('排队论研究服务系统…');
  });
});
