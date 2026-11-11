import type { ProviderConfig } from '@/shared/types';
import { providerFetch } from '@/desktop/local-models';
import { joinUrl } from './types';

export const API_SERVICES = [
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', kind: 'openai-compatible' },
  { id: 'siliconflow', label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', kind: 'openai-compatible' },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', kind: 'openai-compatible' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', kind: 'openai' },
  { id: 'anthropic', label: 'Claude API', baseUrl: 'https://api.anthropic.com', kind: 'anthropic' },
  { id: 'custom', label: '其他服务', baseUrl: '', kind: 'openai-compatible' },
] as const;

export function normalizeApiBase(value: string): string {
  const url = new URL(value.trim());
  if (url.username || url.password || url.search || url.hash) throw new Error('请填写不含密钥和参数的 API 地址');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('远程服务请使用 HTTPS 地址');
  url.pathname = url.pathname.replace(/\/(?:chat\/completions|models)\/?$/, '').replace(/\/+$/, '');
  return url.toString().replace(/\/+$/, '');
}

export async function discoverModels(provider: ProviderConfig, signal?: AbortSignal): Promise<Array<{ id: string; label: string }>> {
  const anthropic = provider.kind === 'anthropic';
  const base = normalizeApiBase(provider.baseUrl || (anthropic ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'));
  const headers: Record<string, string> = anthropic ? { 'x-api-key': provider.apiKey ?? '', 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' } : { Authorization: `Bearer ${provider.apiKey}` };
  const found = new Map<string, { id: string; label: string }>(); let after = '';
  for (let page = 0; page < 20; page++) {
    const response = await providerFetch(joinUrl(base, anthropic ? '/v1/models' : '/models') + (after ? `?after_id=${encodeURIComponent(after)}` : ''), { headers, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(response.status === 401 ? 'Key 未通过验证，请检查是否复制完整。' : response.status === 403 ? '这个 Key 暂无模型列表权限。' : `无法获取模型列表（${response.status}），请检查服务地址或稍后重试。`);
    const body = await response.json(), rows = body.data ?? body.models;
    if (!Array.isArray(rows)) throw new Error('服务没有返回可识别的模型列表');
    for (const row of rows) if (typeof row.id === 'string' && row.id.length <= 200 && !/embedding|rerank|whisper|tts|dall-e|moderation|realtime|image|audio|speech|transcri/i.test(row.id)) found.set(row.id, { id: row.id, label: row.display_name ?? row.name ?? row.id });
    if (!anthropic || !body.has_more || !body.last_id || body.last_id === after) break;
    after = body.last_id;
  }
  if (!found.size) throw new Error('没有找到可用于聊天的模型，请检查 Key 的访问范围');
  return [...found.values()];
}

export function suggestedModel(models: Array<{ id: string }>): string {
  const preferred = ['deepseek-v4.1-flash', 'deepseek-flash', 'deepseek-chat', 'gpt-4.1-mini', 'qwen-plus'];
  return preferred.find(id => models.some(model => model.id === id)) ?? models.find(model => /flash|mini|sonnet|instruct|chat/i.test(model.id))?.id ?? models[0]?.id ?? '';
}
