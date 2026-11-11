import { describe, expect, it } from 'vitest';
import { isSameCaption, isPlayerControlText, looksLikeSlideText, mergeCaption, normalizeCaption, similarity } from '@/pipeline/subtitle';

const makeId = () => `ev_${Math.random().toString(36).slice(2)}`;
it('播放器进度和直播控件不能当作课程字幕，保留正常中英文台词', () => {
  expect(isPlayerControlText('0:00 / 11:22 直播•观看完整版视频')).toBe(true);
  expect(isPlayerControlText('1:20:00 / 2:00:00')).toBe(true);
  expect(isPlayerControlText('The Sun is a star.')).toBe(false);
  expect(isPlayerControlText('我们将在 10:30 开始直播讲解')).toBe(false);
});

describe('字幕规范化与去重', () => {
  it('清理零宽字符、合并空格并去除重复行', () => {
    expect(normalizeCaption(' 你好\u200b世界 \n你好\u200b世界\n第二行 ')).toBe('你好世界\n第二行');
  });

  it('逐字出现时合并为一条并保留更完整文本', () => {
    let records = [
      {
        id: 'e1',
        text: '我们来看',
        startTime: 10,
        endTime: 11,
        source: 'dom' as const,
        mergedCount: 0,
      },
    ];
    const result = mergeCaption(records, { text: '我们来看这个公式', startTime: 10.8, endTime: 12.5, source: 'dom' }, { makeId });
    expect(result.action).toBe('merged');
    expect(result.records).toHaveLength(1);
    expect(result.records[0].text).toBe('我们来看这个公式');
    expect(result.records[0].endTime).toBe(12.5);
  });

  it('时间邻近的重复显示不会产生新证据', () => {
    const records = [{ id: 'e1', text: '先来先服务', startTime: 20, endTime: 22, source: 'ocr' as const, mergedCount: 0 }];
    const result = mergeCaption(records, { text: '先来先服务。', startTime: 27, endTime: 28, source: 'ocr' }, { makeId, duplicateWindowSeconds: 25 });
    expect(result.action).toBe('duplicate');
    expect(result.records).toHaveLength(1);
    expect(result.records[0].endTime).toBe(28);
  });

  it('紧邻的同句重复显示合并为持续区间', () => {
    const records = [{ id: 'e1', text: '先来先服务', startTime: 20, endTime: 22, source: 'ocr' as const, mergedCount: 0 }];
    const result = mergeCaption(records, { text: '先来先服务', startTime: 22.5, endTime: 24, source: 'ocr' }, { makeId, duplicateWindowSeconds: 25 });
    expect(result.action).toBe('merged');
    expect(result.records).toHaveLength(1);
    expect(result.records[0].endTime).toBe(24);
  });

  it('很久以后重新说的一句话必须保留', () => {
    const records = [{ id: 'e1', text: '先来先服务', startTime: 20, endTime: 22, source: 'ocr' as const, mergedCount: 0 }];
    const result = mergeCaption(records, { text: '先来先服务', startTime: 120, endTime: 122, source: 'ocr' }, { makeId, duplicateWindowSeconds: 25 });
    expect(result.action).toBe('added');
    expect(result.records).toHaveLength(2);
  });

  it('双语字幕重复行只保留一次', () => {
    expect(normalizeCaption('Hello world\nHello world\n你好世界')).toBe('Hello world\n你好世界');
  });

  it('相似度对中文短句稳定', () => {
    expect(similarity('先来先服务', '先来先服务。')).toBeGreaterThan(0.9);
    expect(similarity('先来先服务', '平均等待时间')).toBeLessThan(0.3);
    expect(isSameCaption('λ等于3', 'λ 等于 3')).toBe(true);
  });

  it('区分字幕与 PPT 正文', () => {
    expect(looksLikeSlideText('一、排队模型\n二、到达率\n三、服务率\n四、稳定性条件')).toBe(true);
    expect(looksLikeSlideText('先来先服务是最基本的规则。')).toBe(false);
  });
});
