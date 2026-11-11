import type { UiLocale } from './locale-text';

const ranks = {
  domestic: {
    agent: ['opencode-go','dsh','codex','claude','api'],
    api: ['deepseek','siliconflow','openrouter','openai','anthropic','custom'],
    platform: ['作业帮（一课客户端）','高途','Bilibili','抖音','学而思','中国大学 MOOC','学堂在线','智慧树','学习通','国家智慧教育平台','网易公开课','YouTube','Coursera','edX','Udemy','Khan Academy'],
    family: ['DeepSeek','Qwen','GLM','Kimi','Claude','OpenAI','更多模型'],
    aiApp: ['deepseek','qwen','chatgpt','claude','gemini'],
  },
  global: {
    agent: ['codex','claude','opencode-go','dsh','api'],
    api: ['openai','anthropic','openrouter','deepseek','siliconflow','custom'],
    platform: ['YouTube','Coursera','edX','Udemy','Khan Academy','LinkedIn Learning','Skillshare','Bilibili','中国大学 MOOC','抖音','作业帮（一课客户端）','高途'],
    family: ['OpenAI','Claude','DeepSeek','Qwen','GLM','Kimi','更多模型'],
    aiApp: ['chatgpt','claude','gemini','deepseek','qwen'],
  },
};
export function orderForLocale<T>(items: readonly T[], locale: UiLocale, kind: keyof typeof ranks.domestic, id: (item: T) => string): T[] {
  const order: readonly string[] = ranks[locale === 'zh-CN' ? 'domestic' : 'global'][kind];
  const position = (item: T) => { const index = order.indexOf(id(item)); return index < 0 ? order.length : index; };
  return [...items].sort((a,b) => position(a)-position(b));
}
export function apiChannelId(provider: { baseUrl?: string; kind?: string }): string {
  const hosts: Record<string,string> = { 'api.deepseek.com':'deepseek', 'api.siliconflow.cn':'siliconflow', 'openrouter.ai':'openrouter', 'api.openai.com':'openai', 'api.anthropic.com':'anthropic' };
  try { return hosts[new URL(provider.baseUrl || (provider.kind === 'anthropic' ? 'https://api.anthropic.com' : provider.kind === 'openai' ? 'https://api.openai.com' : 'https://custom.invalid')).hostname] ?? 'custom'; }
  catch { return 'custom'; }
}
