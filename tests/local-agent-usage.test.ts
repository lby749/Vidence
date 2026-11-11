import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryDB, setDbForTests, saveSettings } from '@/db/db';
import { localAgentRequest } from '@/agent/local-agent-client';
import { recordUsage, usageSummary } from '@/providers';

let db: MemoryDB;
const config = { backend: 'opencode-go' as const, token: 'test-only', model: 'test-model' };
beforeEach(async () => { db = new MemoryDB(`usage-${Math.random()}`); setDbForTests(db); await db.open(); });
afterEach(async () => { vi.unstubAllGlobals(); await db.delete(); setDbForTests(null); });

it('摘要和回答均记录真实用量、多轮调用、字符数与耗时，健康检查不算模型调用', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ answer: '答', usage: { calls: 2, inputTokens: 50, outputTokens: 10, cacheReadTokens: 20, tokenStatus: 'reported', unknownTokenCalls: 0 } }))));
  await localAgentRequest(config, 'health');
  await localAgentRequest(config, 'ask', '字幕摘要', undefined, undefined, 'organize');
  await localAgentRequest(config, 'ask', '问题');
  const records = await db.usage.toArray();
  expect(records).toHaveLength(2);
  expect(records.map(row => row.role).sort()).toEqual(['answer', 'organize']);
  expect(records.every(row => row.durationMs! >= 0 && row.inputChars! > 0 && row.status === 'completed')).toBe(true);
  expect(await usageSummary()).toMatchObject({ calls: 4, inputTokens: 100, outputTokens: 20, unknownTokenCalls: 0 });
});

it('未返回用量与失败调用不会被当成免费调用，诊断不保存原文或连接码', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ answer: '没有用量的回答' }))));
  await localAgentRequest(config, 'ask', '私有问题');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  await expect(localAgentRequest(config, 'ask', '另一个问题')).rejects.toThrow('无法连接');
  const records = await db.usage.toArray();
  expect(records).toHaveLength(2);
  expect(records.every(row => row.tokenStatus === 'unavailable')).toBe(true);
  expect(records.some(row => row.status === 'failed')).toBe(true);
  expect(JSON.stringify(records)).not.toMatch(/私有问题|test-only|没有用量的回答/);
  expect(await usageSummary()).toMatchObject({ calls: 2, unknownTokenCalls: 2 });
});

it('已有每日预算也适用于本地智能体，达到预算后不再发送请求', async () => {
  await saveSettings({ budget: { dailyTokenBudget: 10 } } as never);
  await recordUsage({ providerId: 'local-agent:opencode-go', modelId: 'test-model', role: 'answer', inputTokens: 8, outputTokens: 2, images: 0, toolRounds: 0 });
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(localAgentRequest(config, 'ask', '新问题')).rejects.toThrow('预算已用尽');
  expect(fetch).not.toHaveBeenCalled();
});
