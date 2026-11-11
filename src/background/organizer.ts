/**
 * 整理模型 A：批量、增量地为草稿节点生成标题/摘要/标签与主题关联。
 *
 * 约束：
 * - 按新增片段批量处理，不按每句字幕调用；
 * - 只发送新增原文与少量已有节点；
 * - 只接受符合 schema 的结构化结果，本地校验后才写入派生字段；
 * - 不覆盖用户笔记与用户手动修订的标题；
 * - 调用失败或超时不影响采集与本地检索。
 */

import { learningPreferencesPrompt } from '@/shared/languages';
import { getDb, getSettings } from '@/db/db';
import type { Job, MemoryNode, UsageRecord } from '@/shared/types';
import { createAdapter, recordUsage } from '@/providers';
import { resolveRole, findProvider } from '@/providers/router';
import { ProviderError, type NeutralMessage } from '@/providers/types';
import { uid } from '@/shared/ids';
import { markIndexDirty } from './index-service';

export interface OrganizeSuggestion {
  nodeId: string;
  title: string;
  summary: string;
  tags: string[];
  relatedNodeIds?: string[];
}

export function validateOrganizeResponse(raw: unknown): OrganizeSuggestion[] {
  if (!raw || typeof raw !== 'object') return [];
  const payload = raw as { nodes?: unknown };
  if (!Array.isArray(payload.nodes)) return [];
  const suggestions: OrganizeSuggestion[] = [];
  for (const item of payload.nodes.slice(0, 20)) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const nodeId = typeof record.nodeId === 'string' ? record.nodeId : '';
    const title = typeof record.title === 'string' ? record.title.trim().slice(0, 80) : '';
    const summary = typeof record.summary === 'string' ? record.summary.trim().slice(0, 600) : '';
    const tags = Array.isArray(record.tags)
      ? record.tags.filter((t): t is string => typeof t === 'string').map((t) => t.slice(0, 30)).slice(0, 8)
      : [];
    const related = Array.isArray(record.relatedNodeIds)
      ? record.relatedNodeIds.filter((id): id is string => typeof id === 'string').slice(0, 8)
      : [];
    if (!nodeId || !title || !summary) continue;
    suggestions.push({ nodeId, title, summary, tags, relatedNodeIds: related });
  }
  return suggestions;
}

export function buildOrganizePrompt(nodes: MemoryNode[], existing: Array<{ id: string; title: string }>, preferences = ''): string {
  return [
    '你是视频记忆库的整理助手。下面是从视频字幕中按时间切分出的片段。',
    '请为每个片段生成简洁标题、客观摘要与主题标签，并可指出与已有节点的延续关系。',
    preferences,
    '要求：',
    '1. 只依据给出的原文，不补充视频中未出现的事实；不确定就保守概括。',
    '2. 摘要 1-3 句，说明这一段在讲什么；不要把示例、猜测写成原话。',
    '3. 标签 1-5 个，短词。',
    '4. 只输出 JSON，不要代码块或解释，格式：',
    '{"nodes":[{"nodeId":"...","title":"...","summary":"...","tags":["..."],"relatedNodeIds":["..."]}]}',
    '',
    `已有节点（用于判断延续关系，最多 ${existing.length} 个）：`,
    existing.map((n) => `- ${n.id} 《${n.title}》`).join('\n') || '（无）',
    '',
    '待整理片段：',
    ...nodes.map((node) => [`片段 ${node.id}（${Math.round(node.startTime)}–${Math.round(node.endTime)}s）`, node.searchText ?? ''].join('\n')),
  ].join('\n');
}

export function parseJsonFromText(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function organizeCallsLastHour(): Promise<number> {
  const db = getDb();
  const since = Date.now() - 60 * 60 * 1000;
  return db.usage.where('at').above(since).and((record: UsageRecord) => record.role === 'organize').count();
}

/** 处理一批草稿节点；返回处理数量与说明 */
export async function organizeDraftNodes(limit = 6): Promise<{ organized: number; message: string }> {
  const settings = await getSettings();
  if (settings.profile === 'no-ai') return { organized: 0, message: '无 AI 凭据模式：跳过整理' };
  const role = resolveRole(settings, 'organizeModel');
  if (!role || !role.role.modelId) return { organized: 0, message: '未配置整理模型（A）' };
  const provider = findProvider(settings, role.providerId);
  if (!provider?.apiKey) return { organized: 0, message: '整理模型缺少 API Key' };

  const calls = await organizeCallsLastHour();
  if (calls >= settings.budget.organizeMaxCallsPerHour) {
    return { organized: 0, message: `已达到每小时整理调用上限（${settings.budget.organizeMaxCallsPerHour}）` };
  }

  const db = getDb();
  const drafts = (await db.nodes.where('status').equals('draft').toArray())
    .filter((node) => !node.summary && !node.userNote && (node.searchText?.length ?? 0) > 10)
    .sort((a, b) => a.startTime - b.startTime)
    .slice(0, limit);
  if (drafts.length === 0) return { organized: 0, message: '没有待整理节点' };

  const existing = (await db.nodes.where('status').equals('organized').limit(20).toArray()).map((node) => ({
    id: node.id,
    title: node.title,
  }));

  const adapter = createAdapter(provider);
  const messages: NeutralMessage[] = [
    { role: 'system', content: '你只输出符合要求的 JSON 对象，不输出任何其他文字。' },
    { role: 'user', content: [{ type: 'text', text: buildOrganizePrompt(drafts, existing, learningPreferencesPrompt(settings)) }] },
  ];

  let text = '';
  let inputTokens = 0;
  let outputTokens = 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    for await (const event of adapter.chat({
      model: role.role.modelId,
      messages,
      temperature: 0.2,
      maxTokens: 1200,
      signal: controller.signal,
    })) {
      if (event.type === 'text') text += event.delta;
      if (event.type === 'usage') {
        inputTokens += event.inputTokens;
        outputTokens += event.outputTokens;
      }
      if (event.type === 'error') {
        if (event.code === 'canceled') return { organized: 0, message: '整理请求超时' };
        throw new ProviderError({ code: event.code, message: event.message, retryable: event.retryable });
      }
    }
  } finally {
    clearTimeout(timer);
  }

  const suggestions = validateOrganizeResponse(parseJsonFromText(text));
  if (suggestions.length === 0) {
    return { organized: 0, message: '整理模型返回结果未通过校验，已忽略（不影响原文）' };
  }

  let organized = 0;
  for (const suggestion of suggestions) {
    const node = await db.nodes.get(suggestion.nodeId);
    if (!node || node.status !== 'draft' || node.userNote || node.summary) continue;
    const related = (suggestion.relatedNodeIds ?? []).filter((id) => id !== node.id).slice(0, 5);
    const updated: MemoryNode = {
      ...node,
      title: node.userEdited?.title ?? suggestion.title,
      summary: suggestion.summary,
      tags: suggestion.tags,
      relatedNodeIds: related.length > 0 ? related : node.relatedNodeIds,
      status: 'organized',
      generatedBy: {
        modelId: role.role.modelId,
        providerId: provider.id,
        promptVersion: 'organize-v1',
      },
      revision: node.revision + 1,
      updatedAt: Date.now(),
    };
    await db.nodes.put(updated);
    organized += 1;
  }

  await recordUsage({
    providerId: provider.id,
    modelId: role.role.modelId,
    role: 'organize',
    inputTokens,
    outputTokens,
    images: 0,
    toolRounds: 0,
  });
  markIndexDirty();
  return { organized, message: `已整理 ${organized} 个节点` };
}

export async function enqueueOrganizeJob(): Promise<Job> {
  const job: Job = {
    id: uid('job'),
    type: 'organize-node',
    inputRevision: Date.now(),
    status: 'queued',
    attempts: 0,
    payload: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await getDb().jobs.put(job);
  return job;
}

export async function processOrganizeJobs(): Promise<void> {
  const db = getDb();
  const jobs = await db.jobs.where('status').equals('queued').and((job) => job.type === 'organize-node').toArray();
  for (const job of jobs) {
    await db.jobs.update(job.id, { status: 'running', updatedAt: Date.now() });
    try {
      const result = await organizeDraftNodes();
      await db.jobs.update(job.id, { status: 'done', lastError: result.message, updatedAt: Date.now() });
    } catch (error) {
      const attempts = job.attempts + 1;
      const retryable = !(error instanceof ProviderError) || error.retryable;
      await db.jobs.update(job.id, {
        status: retryable && attempts < 4 ? 'queued' : 'failed',
        attempts,
        lastError: (error as Error).message,
        nextRetryAt: retryable ? Date.now() + Math.min(600_000, 30_000 * 2 ** attempts) : undefined,
        updatedAt: Date.now(),
      });
    }
  }
}
