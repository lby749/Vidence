import { describe, expect, it } from 'vitest';
import { canonicalizeUrl, identifyVideo } from '@/shared/video-identity';

describe('视频身份识别', () => {
  it('YouTube 不同跟踪参数得到同一身份', () => {
    const a = identifyVideo('https://www.youtube.com/watch?v=abc123&utm_source=x&t=30', '线性代数 第一讲');
    const b = identifyVideo('https://www.youtube.com/watch?v=abc123&feature=share', '线性代数 第一讲');
    expect(a.id).toBe(b.id);
    expect(a.platform).toBe('youtube');
    expect(a.platformVideoId).toBe('abc123');
  });

  it('youtu.be 短链与完整链接一致', () => {
    const a = identifyVideo('https://youtu.be/abc123?si=xyz', '课程');
    const b = identifyVideo('https://www.youtube.com/watch?v=abc123', '课程');
    expect(a.id).toBe(b.id);
  });

  it('B 站同一视频不同分 P 身份不同', () => {
    const p1 = identifyVideo('https://www.bilibili.com/video/BV1xx411c7mD?p=1', '第一集');
    const p2 = identifyVideo('https://www.bilibili.com/video/BV1xx411c7mD?p=2', '第二集');
    expect(p1.id).not.toBe(p2.id);
    expect(p1.episodeId).toBe('p1');
    expect(p2.episodeId).toBe('p2');
  });

  it('无平台 ID 时使用规范化 URL 与标题区分同页内容', () => {
    const a = identifyVideo('https://course.example.com/lesson?id=1&utm_source=a', '第一节');
    const b = identifyVideo('https://course.example.com/lesson?id=1&utm_source=b', '第二节');
    expect(a.id).not.toBe(b.id);
  });

  it('清理跟踪参数并排序查询参数', () => {
    expect(canonicalizeUrl('https://example.com/v?b=2&a=1&utm_source=x#t=10')).toBe('https://example.com/v?a=1&b=2');
  });
});
