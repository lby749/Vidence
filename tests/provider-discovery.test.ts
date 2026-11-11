import { afterEach, expect, it, vi } from 'vitest';
import { discoverModels, normalizeApiBase, suggestedModel } from '@/providers/discovery';
afterEach(() => vi.unstubAllGlobals());
it('规范接口地址，拒绝把密钥放进 URL 或发往远程明文接口', () => {
  expect(normalizeApiBase('https://api.example.com/v1/chat/completions/')).toBe('https://api.example.com/v1');
  expect(() => normalizeApiBase('https://api.example.com?key=secret')).toThrow();
  expect(() => normalizeApiBase('http://example.com/v1')).toThrow();
  expect(normalizeApiBase('http://127.0.0.1:4567/v1/')).toBe('http://127.0.0.1:4567/v1');
});
it('只读取所选服务的聊天模型，去重并过滤专用模型；推荐必须来自真实列表', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'embed-embedding' }, { id: 'deepseek-v4.1-flash' }, { id: 'deepseek-v4.1-flash' }, { id: 'other-chat', name: 'Other' }] })));
  vi.stubGlobal('fetch', fetch);
  const models = await discoverModels({ id: 'test', label: 'test', kind: 'openai-compatible', baseUrl: 'https://chosen.example/v1', apiKey: 'test-only-key' });
  expect(models.map(row => row.id)).toEqual(['deepseek-v4.1-flash', 'other-chat']);
  expect(suggestedModel(models)).toBe('deepseek-v4.1-flash');
  expect(fetch).toHaveBeenCalledTimes(1); expect(fetch.mock.calls[0][0]).toBe('https://chosen.example/v1/models');
});
it('权限失败不保存空目录，也不把接口返回的凭据内容展示出来', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('private-error-content', { status: 401 })));
  await expect(discoverModels({ id: 'test', label: 'test', kind: 'openai', apiKey: 'test-only' })).rejects.toThrow('Key 未通过验证');
});
