import { describe, expect, it } from 'vitest';
import { redactSecrets, validateImport } from '@/export/bundle';
import type { ExportBundle } from '@/shared/types';

function baseBundle(overrides: Partial<ExportBundle> = {}): ExportBundle {
  return {
    format: 'vma-export',
    version: 1,
    exportedAt: Date.now(),
    videos: [
      {
        id: 'v1',
        url: 'https://example.com/v1',
        canonicalUrl: 'https://example.com/v1',
        platform: 'example',
        title: '课程',
        duration: 100,
        lastPosition: 10,
        recordedRanges: [[0, 10]],
        createdAt: 1,
        updatedAt: 2,
        sessionCount: 1,
      },
    ],
    sessions: [],
    evidence: [
      {
        id: 'e1',
        videoId: 'v1',
        sessionId: 's1',
        startTime: 1,
        endTime: 3,
        text: '证据',
        source: 'texttrack',
        capturedAt: 1,
        captureEpoch: 1,
      },
    ],
    nodes: [
      {
        id: 'n1',
        videoId: 'v1',
        sessionId: 's1',
        title: '节点',
        startTime: 0,
        endTime: 5,
        evidenceIds: ['e1'],
        keyframeIds: [],
        tags: [],
        relatedNodeIds: [],
        status: 'draft',
        createdAt: 1,
        updatedAt: 1,
        revision: 1,
      },
    ],
    keyframes: [],
    settings: { profile: 'standard' },
    ...overrides,
  };
}

describe('导入校验', () => {
  it('拒绝非本扩展文件', () => {
    expect(validateImport('{"format":"other"}').ok).toBe(false);
  });

  it('拒绝不支持的版本', () => {
    const bundle = baseBundle({ version: 2 as never });
    expect(validateImport(JSON.stringify(bundle)).ok).toBe(false);
  });

  it('拒绝引用不存在视频的节点', () => {
    const bundle = baseBundle();
    bundle.nodes[0].videoId = 'missing';
    const result = validateImport(JSON.stringify(bundle));
    expect(result.ok).toBe(false);
  });

  it('拒绝非法关键帧图片', () => {
    const bundle = baseBundle({
      keyframes: [
        {
          id: 'k1',
          videoId: 'v1',
          sessionId: 's1',
          time: 1,
          width: 1,
          height: 1,
          reason: 'user',
          fingerprint: 'x',
          evidenceIds: [],
          uploadAllowed: false,
          capturedAt: 1,
          captureEpoch: 1,
          imageDataUrl: 'javascript:alert(1)',
        },
      ],
    });
    expect(validateImport(JSON.stringify(bundle)).ok).toBe(false);
  });

  it('接受合法文件', () => {
    const result = validateImport(JSON.stringify(baseBundle()));
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });
});

describe('脱敏', () => {
  it('递归隐藏密钥与令牌', () => {
    const redacted = redactSecrets({
      provider: { apiKey: 'sk-secret', label: 'x' },
      notion: { token: 'ntn_secret', enabled: true },
      normal: 'value',
    });
    const text = JSON.stringify(redacted);
    expect(text).not.toContain('sk-secret');
    expect(text).not.toContain('ntn_secret');
    expect(text).toContain('***');
  });
});
