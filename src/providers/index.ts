import { getDb } from '@/db/db';
import { uid } from '@/shared/ids';
import type { ProviderConfig, UsageRecord } from '@/shared/types';
import type { ProviderAdapter } from './types';
import { OpenAICompatibleAdapter } from './openai';
import { AnthropicAdapter } from './anthropic';

export type { ProviderAdapter } from './types';
export { ProviderError } from './types';

export function createAdapter(provider: ProviderConfig): ProviderAdapter {
  if (!provider.apiKey) {
    throw new Error(`提供商「${provider.label}」未配置 API Key`);
  }
  if (provider.kind === 'anthropic') {
    return new AnthropicAdapter({ id: provider.id, apiKey: provider.apiKey, baseUrl: provider.baseUrl });
  }
  return new OpenAICompatibleAdapter({
    id: provider.id,
    kind: provider.kind,
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl,
  });
}

export async function recordUsage(record: Omit<UsageRecord, 'id' | 'at'> & { at?: number }): Promise<void> {
  const db = getDb();
  await db.usage.put({ ...record, id: uid('usage'), at: record.at ?? Date.now() });
}

export interface UsageSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  imageUploads: number;
  costUsd?: number;
  unknownTokenCalls: number;
}

/** 按时间窗口聚合用量；价格未知时不估算金额。 */
export async function usageSummary(sinceMs?: number): Promise<UsageSummary> {
  const db = getDb();
  const all = await db.usage.toArray();
  const filtered = sinceMs ? all.filter((r) => r.at >= sinceMs) : all;
  const summary: UsageSummary = {
    calls: filtered.reduce((sum, record) => sum + (record.calls ?? 1), 0),
    inputTokens: 0,
    outputTokens: 0,
    imageUploads: 0,
    unknownTokenCalls: 0,
  };
  let cost = 0;
  let hasCost = false;
  for (const r of filtered) {
    if (r.tokenStatus === 'unavailable') summary.unknownTokenCalls += r.unknownTokenCalls ?? r.calls ?? 1;
    summary.inputTokens += r.inputTokens;
    summary.outputTokens += r.outputTokens;
    summary.imageUploads += r.images;
    if (r.costUsd !== undefined) {
      cost += r.costUsd;
      hasCost = true;
    }
  }
  if (hasCost) summary.costUsd = cost;
  return summary;
}

export async function usageToday(): Promise<UsageSummary> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return usageSummary(start.getTime());
}
