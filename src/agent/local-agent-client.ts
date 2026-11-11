import type { Settings, UsageSnapshot } from '@/shared/types';
import { recordUsage } from '@/providers';
import { assertDailyBudget } from '@/providers/router';
import { getSettings } from '@/db/db';

interface AgentResponse {
  answer?: string;
  usage?: UsageSnapshot;
  backends?: Record<string, { available: boolean; reason: string }>;
  models?: Array<{ id: string; label: string }>;
  source?: string;
}

export async function localAgentRequest(config: NonNullable<Settings['localAgent']>, path: 'health' | 'models' | 'ask', prompt?: string, signal?: AbortSignal, memorySession?: string, role: 'organize' | 'answer' = 'answer', imageUploads: () => number = () => 0): Promise<AgentResponse> {
  if (!config.token) throw new Error('请先填写桥接令牌并连接测试');
  if (path === 'ask') await assertDailyBudget(await getSettings());
  const startedAt = Date.now(); let result: AgentResponse = {}, status: 'completed' | 'failed' = 'failed';
  try {
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:8131/${path}${path === 'models' ? `?backend=${config.backend}` : ''}`, {
        method: path === 'ask' ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${config.token}`, ...(path === 'ask' ? { 'Content-Type': 'application/json' } : {}) },
        body: path === 'ask' ? JSON.stringify({ backend: config.backend, model: config.model, prompt, memorySession }) : undefined,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(185_000)]) : AbortSignal.timeout(path === 'health' ? 5000 : path === 'models' ? 20000 : 185_000),
      });
    } catch {
      if (signal?.aborted) throw new Error('已取消');
      throw new Error('无法连接本地智能体，请先启动“启动本地智能体.cmd”');
    }
    const body = await response.json(); result = body;
    if (!response.ok) throw new Error(body.error ?? `桥接请求失败（${response.status}）`);
    status = 'completed'; return result;
  } finally {
    if (path === 'ask') await recordUsage({
      providerId: `local-agent:${config.backend}`, modelId: config.model ?? '', role,
      inputTokens: result.usage?.inputTokens ?? 0, outputTokens: result.usage?.outputTokens ?? 0,
      tokenStatus: result.usage?.tokenStatus ?? 'unavailable', calls: result.usage?.calls ?? 1,
      unknownTokenCalls: result.usage?.unknownTokenCalls ?? (result.usage?.tokenStatus === 'reported' ? 0 : 1),
      cacheReadTokens: result.usage?.cacheReadTokens, cacheWriteTokens: result.usage?.cacheWriteTokens,
      status: signal?.aborted ? 'canceled' : status, inputChars: prompt?.length ?? 0,
      outputChars: result.answer?.length ?? 0, durationMs: Date.now() - startedAt, images: imageUploads(), toolRounds: 0,
    }).catch(() => {});
  }
}
