import { describe, expect, it } from 'vitest';
import { buildOrganizePrompt, parseJsonFromText, validateOrganizeResponse } from '@/background/organizer';
import type { MemoryNode } from '@/shared/types';

function node(id: string): MemoryNode {
  return {
    id,
    videoId: 'v1',
    sessionId: 's1',
    title: '草稿',
    startTime: 0,
    endTime: 10,
    evidenceIds: [],
    keyframeIds: [],
    tags: [],
    relatedNodeIds: [],
    status: 'draft',
    searchText: '排队论研究服务系统，先来先服务。',
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
  };
}

describe('整理模型结果校验', () => {
  it('拒绝缺少必要字段的结果', () => {
    expect(validateOrganizeResponse({ nodes: [{ nodeId: 'n1', title: '标题' }] })).toEqual([]);
    expect(validateOrganizeResponse({ nodes: [] })).toEqual([]);
    expect(validateOrganizeResponse(null)).toEqual([]);
  });

  it('只接受合法节点并裁剪长度', () => {
    const suggestions = validateOrganizeResponse({
      nodes: [
        {
          nodeId: 'n1',
          title: '排队模型',
          summary: '介绍排队论的基本服务系统。',
          tags: ['排队论', 1, '服务系统'],
          relatedNodeIds: ['n0', 'n2'],
        },
      ],
    });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].tags).toEqual(['排队论', '服务系统']);
    expect(suggestions[0].relatedNodeIds).toEqual(['n0', 'n2']);
  });

  it('从代码块或多余文字中提取 JSON', () => {
    expect(parseJsonFromText('```json\n{"nodes":[]}\n```')).toEqual({ nodes: [] });
    expect(parseJsonFromText('好的，结果如下：{"nodes":[]} 希望有帮助')).toEqual({ nodes: [] });
    expect(parseJsonFromText('不是 JSON')).toBeNull();
  });

  it('提示词包含原文与 schema 要求', () => {
    const prompt = buildOrganizePrompt([node('n1')], [{ id: 'n0', title: '前文' }]);
    expect(prompt).toContain('片段 n1');
    expect(prompt).toContain('{"nodes"');
    expect(prompt).toContain('不补充视频中未出现的事实');
  });
});
