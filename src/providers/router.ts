/**
 * ModelRouter：模型角色、提供商选择、预算与降级。
 *
 * A（整理）与 B（问答）分别配置提供商、模型与凭据；用户举出的模型名不写死在程序里。
 */

import type { ModelRole, Settings } from '@/shared/types';
import { usageToday } from './index';
import { ProviderError } from './types';

export interface ResolvedRole {
  role: ModelRole;
  providerId: string;
}

export function resolveRole(settings: Settings, role: 'organizeModel' | 'answerModel' | 'visionModel' | 'embedding'): ResolvedRole | null {
  const configured = settings.roles[role];
  if (configured && settings.providers.some((p) => p.id === configured.providerId && p.apiKey)) {
    return { role: configured, providerId: configured.providerId };
  }
  // 问答角色允许回退到第一个可用提供商（用户只配置了一家时）
  if (role === 'answerModel') {
    const provider = settings.providers.find((p) => p.apiKey);
    if (provider) {
      return { role: { providerId: provider.id, modelId: '' }, providerId: provider.id };
    }
  }
  return null;
}

export function findProvider(settings: Settings, providerId: string) {
  return settings.providers.find((p) => p.id === providerId) ?? null;
}

/** 每日 token 预算检查；未配置预算时不限制。 */
export async function assertDailyBudget(settings: Settings): Promise<void> {
  const budget = settings.budget.dailyTokenBudget;
  if (!budget || budget <= 0) return;
  const usage = await usageToday();
  if (usage.inputTokens + usage.outputTokens >= budget) {
    throw new ProviderError({
      code: 'quota',
      message: `今日 token 预算已用尽（${usage.inputTokens + usage.outputTokens}/${budget}）`,
      retryable: false,
    });
  }
}

export function requiresImageCapability(settings: Settings): boolean {
  return settings.privacy.allowVisionUpload;
}
