import type { Settings } from './types';

export type ResourceTier = 'none' | 'low' | 'medium' | 'high';
export const RESOURCE_TIERS = [
  { id: 'none', title: '无占用', caption: '只用已有字幕', description: '记录网页字幕、按关键词查找；AI 回答使用已连接的服务。', capabilities: [], ocrPerMinute: 0 },
  { id: 'low', title: '低占用', caption: '轻量记录', description: '增加中文与中英混排画面的文字识别；以较低频率记录窗口或本地视频。', capabilities: ['ocr'], ocrPerMinute: 6 },
  { id: 'medium', title: '中占用', caption: '记录与理解', description: '为中文内容增加按意思查找，提问和原话措辞不同也能查找相关片段。', capabilities: ['ocr', 'vector'], ocrPerMinute: 12 },
  { id: 'high', title: '高占用', caption: '更精细地查找', description: '增加检索精排，并提高识别频率；需要更多空间和运行内存。', capabilities: ['ocr', 'vector', 'rerank'], ocrPerMinute: 24 },
] as const;

export function currentResourceTier(settings: Settings): ResourceTier {
  return settings.retrieval.rerank ? 'high' : settings.retrieval.vector ? 'medium' : settings.ocr.enabled ? 'low' : 'none';
}

export function resourceTierPatch(id: ResourceTier, settings: Settings): Partial<Settings> {
  const tier = RESOURCE_TIERS.find(tier => tier.id === id);
  if (!tier) throw new Error('请选择有效的占用档位');
  return {
    resourceTier: id,
    ocr: { ...settings.ocr, enabled: id !== 'none', mode: id === 'none' ? 'off' : 'auto', engine: id === 'none' ? 'none' : 'paddle', maxPerMinute: tier.ocrPerMinute },
    retrieval: { ...settings.retrieval, keyword: true, vector: id === 'medium' || id === 'high', rerank: id === 'high' },
  };
}

export function computeFeatureEnabled(type: string, settings: Settings): boolean {
  if (type.startsWith('ocr:')) return settings.ocr.enabled && settings.ocr.mode !== 'off' && settings.ocr.engine !== 'none';
  if (type.startsWith('embed:')) return settings.retrieval.vector;
  if (type.startsWith('rerank:')) return settings.retrieval.rerank;
  return true;
}
