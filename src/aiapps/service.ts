/**
 * AI 应用问答服务：准备请求 → 打开/连接应用 → 发送 → 读取可见回答。
 *
 * 诚实边界：
 * - 网页辅助连接器依赖站点公开可见的界面结构，站点改版可能失效；
 * - 未验证的站点在界面标记为"未验证"；
 * - 无法确认是否送达时不自动重发。
 */

import { getDb, getSettings, libraryRevision } from '@/db/db';
import type { AiAppRequest, Citation, Evidence, MemoryNode, QueryContext, RequestStatus, Video } from '@/shared/types';
import { uid } from '@/shared/ids';
import { getConnector, runtimeFor, type ConnectorProfile } from './registry';
import { buildAiAppPrompt } from './prompt';
import { prepareQueryContext } from '@/agent/question-agent';
import { questionSummary } from '@/agent/long-term-memory';
import { answerLanguage, answerStyle, learningPreferencesPrompt } from '@/shared/languages';
import { evidenceForHits, searchLibrary } from '@/background/index-service';
import type { AiProbeResult, AiReadResult } from '@/entrypoints/ai-bridge';

const pollers = new Map<string, ReturnType<typeof setInterval>>();
const pendingSubmit = new Map<string, { text: string }>();

export interface PreparedAiRequest {
  request: AiAppRequest;
  prompt: string;
  evidence: Evidence[];
  connector: ConnectorProfile;
  video: Video;
}

export async function prepareAiRequest(params: {
  connectorId: string;
  videoId: string;
  question: string;
  frozenTime: number;
  selectedNodeIds: string[];
  allowImages: boolean;
}): Promise<PreparedAiRequest> {
  const connector = getConnector(params.connectorId);
  if (!connector) throw new Error('未知的 AI 应用连接器');
  if (connector.id === 'manual-handoff') throw new Error('手动交接不需要发送请求');
  const settings = await getSettings();
  if (!settings.experiment.aiAppConnectors) throw new Error('AI 应用连接器已在设置中关闭');

  const requestId = uid('air');
  const { ctx, video, nodes } = await prepareQueryContext({
    requestId,
    videoId: params.videoId,
    question: params.question,
    frozenTime: params.frozenTime,
    selectedNodeIds: params.selectedNodeIds,
    allowImages: params.allowImages,
    route: 'ai-app',
  });

  // 无工具通道：本地先检索一个有限证据包，明确标注"基于已附证据"
  const summary = await questionSummary(ctx, video.title, nodes, async () => {
    const retrieval = await searchLibrary({
      query: [ctx.question, ...nodes.map((n) => n.title)].join(' '),
      videoId: ctx.videoId,
      contextTime: ctx.frozenTime,
      scopes: ctx.scopes.length > 0 ? ctx.scopes : undefined,
      limit: 6,
      useVector: settings.retrieval.vector,
    });
    return evidenceForHits(ctx.videoId, retrieval.hits, ctx.scopes);
  }, settings);
  const evidence = summary.evidence;

  const prompt = buildAiAppPrompt({ ctx, video, nodes, evidence: [], summary: summary.text, connector, language: answerLanguage(settings), style: answerStyle(settings) });
  const request: AiAppRequest = {
    requestId,
    connectorId: connector.id,
    videoId: video.id,
    questionTime: ctx.frozenTime,
    selectedNodeIds: ctx.selectedNodeIds,
    searchScope: ctx.selectedNodeIds.length > 0 ? 'selected-nodes' : 'video',
    libraryRevision: await libraryRevision(),
    question: ctx.question,
    allowImages: params.allowImages,
    maxToolRounds: 0,
    contentBudget: 6000,
    status: 'preparing',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    evidenceIds: evidence.map(row => row.id),
    pendingPrompt: prompt,
    citationIds: [],
  };
  await getDb().aiRequests.put(request);
  return { request, prompt, evidence, connector, video };
}

export async function openConnectorTab(connectorId: string, requestId?: string): Promise<number> {
  const connector = getConnector(connectorId);
  if (!connector) throw new Error('未知的 AI 应用连接器');
  const existing = await chrome.tabs.query({ url: connector.hostPatterns });
  const tab = existing[0] ?? (await chrome.tabs.create({ url: connector.url, active: true }));
  if (!tab.id) throw new Error('无法打开 AI 应用标签页');
  if (requestId) {
    await getDb().aiRequests.update(requestId, { tabId: tab.id, updatedAt: Date.now() });
  }
  await waitForBridge(tab.id, connector, 15000);
  return tab.id;
}

async function waitForBridge(tabId: number, connector: ConnectorProfile, timeoutMs: number): Promise<AiProbeResult | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const probe = await sendBridge<AiProbeResult>(tabId, {
      type: 'ai:probe',
      payload: { profile: connector },
    });
    if (probe) return probe;
    await delay(600);
  }
  return null;
}

async function sendBridge<T>(tabId: number, message: unknown, timeoutMs = 8000): Promise<T | null> {
  try {
    const response = (await Promise.race([
      chrome.tabs.sendMessage(tabId, message),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ])) as { ok?: boolean; data?: T; error?: string; message?: string } | null;
    if (!response || response.ok === false) return null;
    return response.data ?? null;
  } catch {
    return null;
  }
}

export async function launchAiRequest(
  requestId: string,
  options: { confirmSend: boolean },
): Promise<{ status: RequestStatus; message: string }> {
  const db = getDb();
  const request = await db.aiRequests.get(requestId);
  if (!request) throw new Error('请求不存在');
  const connector = getConnector(request.connectorId);
  if (!connector) throw new Error('连接器不存在');

  const tabId = request.tabId ?? (await openConnectorTab(request.connectorId, requestId));
  const probe = await waitForBridge(tabId, connector, 12000);
  if (!probe) {
    await updateRequest(requestId, {
      status: 'failed',
      error: '无法连接 AI 应用页面（可能被浏览器限制或页面未加载）',
    });
    return { status: 'failed', message: '无法连接 AI 应用页面' };
  }
  if (!probe.inputFound) {
    await updateRequest(requestId, {
      status: 'awaiting-login',
      error: probe.loginLikely ? '需要先在 AI 应用中登录' : '找不到消息输入框，页面结构可能已变化',
    });
    return { status: 'awaiting-login', message: probe.loginLikely ? '请先在 AI 应用中登录' : '找不到输入框' };
  }

  const prompt = request.pendingPrompt ?? '';
  if (!prompt) throw new Error('请求缺少问题内容');
  const wantsConfirm = connector.capabilities.requiresConfirmation && !options.confirmSend;
  const fill = await sendBridge<{ filled: boolean; submitted?: boolean }>(tabId, {
    type: 'ai:fill',
    payload: { profile: connector, text: prompt, submit: !wantsConfirm },
  });
  if (!fill) {
    await updateRequest(requestId, { status: 'failed', error: '写入 AI 应用输入框失败' });
    return { status: 'failed', message: '写入输入框失败' };
  }

  if (wantsConfirm) {
    pendingSubmit.set(requestId, { text: prompt });
    await updateRequest(requestId, { status: 'awaiting-confirm', baselineCount: probe.assistantCount, tabId });
    return { status: 'awaiting-confirm', message: '已填入问题，请在 AI 应用中确认后发送' };
  }

  await updateRequest(requestId, {
    status: 'sent',
    baselineCount: probe.assistantCount,
    tabId,
    pendingPrompt: undefined,
  });
  startPolling(requestId, tabId, connector, probe.assistantCount);
  return { status: 'sent', message: '已发送，正在等待回答' };
}

export async function confirmAndSend(requestId: string): Promise<{ status: RequestStatus; message: string }> {
  const db = getDb();
  const request = await db.aiRequests.get(requestId);
  if (!request) throw new Error('请求不存在');
  const connector = getConnector(request.connectorId);
  if (!connector) throw new Error('连接器不存在');
  if (!request.tabId) throw new Error('尚未打开 AI 应用标签页');
  const pending = pendingSubmit.get(requestId);
  const text = pending?.text ?? request.pendingPrompt ?? '';
  const probe = await sendBridge<AiProbeResult>(request.tabId, { type: 'ai:probe', payload: { profile: connector } });
  if (!probe?.inputFound) return { status: 'awaiting-login', message: 'AI 应用页面不可用或未登录' };
  const result = await sendBridge<{ filled: boolean; submitted?: boolean }>(request.tabId, {
    type: 'ai:fill',
    payload: { profile: connector, text: text || undefined, submit: true },
  });
  if (!result) return { status: 'failed', message: '发送失败' };
  await updateRequest(requestId, {
    status: 'sent',
    baselineCount: probe.assistantCount,
    pendingPrompt: undefined,
  });
  pendingSubmit.delete(requestId);
  startPolling(requestId, request.tabId, connector, probe.assistantCount);
  return { status: 'sent', message: '已发送，正在等待回答' };
}

function startPolling(requestId: string, tabId: number, connector: ConnectorProfile, baseline: number): void {
  stopPolling(requestId);
  let lastText = '';
  let stableSince = 0;
  let attempts = 0;
  const interval = setInterval(() => {
    attempts += 1;
    void (async () => {
      const read = await sendBridge<AiReadResult>(tabId, { type: 'ai:read', payload: { profile: connector } }, 5000);
      if (!read) {
        if (attempts > 8) {
          stopPolling(requestId);
          await updateRequest(requestId, { status: 'failed', error: '无法读取 AI 应用页面' });
        }
        return;
      }
      if (read.assistantCount > baseline && read.lastAssistantText) {
        if (read.lastAssistantText !== lastText) {
          lastText = read.lastAssistantText;
          stableSince = Date.now();
          await updateRequest(requestId, { status: 'generating', answerText: lastText });
        } else if (!read.generating && Date.now() - stableSince > 2500) {
          stopPolling(requestId);
          await completeFromText(requestId, lastText);
        }
      }
      if (attempts > 100) {
        stopPolling(requestId);
        await updateRequest(requestId, {
          status: 'failed',
          error: '等待回答超时（约 2 分钟）。可在 AI 应用中查看，或稍后点击“读取当前回答”。',
        });
      }
    })();
  }, 1500);
  pollers.set(requestId, interval);
}

export function stopPolling(requestId: string): void {
  const interval = pollers.get(requestId);
  if (interval) clearInterval(interval);
  pollers.delete(requestId);
}

/** 手动读取当前可见回答（用于恢复或超时后补读） */
export async function readAnswerNow(
  requestId: string,
): Promise<{ status: RequestStatus; message: string; answer?: string; citations?: Citation[] }> {
  const request = await getDb().aiRequests.get(requestId);
  if (!request?.tabId) throw new Error('请求或标签页不存在');
  if (request.status === 'completed' && request.answerText) {
    return {
      status: 'completed',
      message: '已完成',
      answer: request.answerText,
      citations: await buildCitations(request.answerText, new Set(request.evidenceIds ?? [])),
    };
  }
  const connector = getConnector(request.connectorId);
  if (!connector) throw new Error('连接器不存在');
  const read = await sendBridge<AiReadResult>(request.tabId, { type: 'ai:read', payload: { profile: connector } });
  if (!read) return { status: 'failed', message: '无法读取 AI 应用页面' };
  if (read.assistantCount <= (request.baselineCount ?? 0) || !read.lastAssistantText) {
    return { status: request.status, message: '尚未看到新的回答' };
  }
  await completeFromText(requestId, read.lastAssistantText);
  const updated = await getDb().aiRequests.get(requestId);
  return {
    status: 'completed',
    message: '已读取回答',
    answer: updated?.answerText,
    citations: await buildCitations(updated?.answerText ?? '', new Set(request.evidenceIds ?? [])),
  };
}

export async function completeFromText(requestId: string, text: string): Promise<{ answer: string; citations: Citation[] }> {
  const db = getDb();
  const request = await db.aiRequests.get(requestId);
  if (!request) return { answer: '', citations: [] };
  const allowed = new Set(request.evidenceIds ?? []);
  const citations = await buildCitations(text, allowed);
  const answer = text.replace(/\[E:[^\]]+\]/g, '').trim();
  await updateRequest(requestId, {
    status: 'completed',
    answerText: answer,
    citationIds: citations.map((c) => c.evidenceId),
  });
  const turn = {
    id: uid('turn'),
    requestId,
    videoId: request.videoId,
    question: request.question,
    answer,
    citations,
    route: 'ai-app' as const,
    connectorId: request.connectorId,
    status: 'completed' as const,
    createdAt: Date.now(),
    completedAt: Date.now(),
  };
  await db.chats.put(turn);
  stopPolling(requestId);
  return { answer, citations };
}

async function buildCitations(text: string, allowed: Set<string>): Promise<Citation[]> {
  const ids = [...text.matchAll(/\[E:([^\]\s]+)\]/g)].map((m) => m[1]!).filter((id) => allowed.has(id));
  if (ids.length === 0) return [];
  const unique = [...new Set(ids)].slice(0, 12);
  const rows = await getDb().evidence.bulkGet(unique);
  const citations: Citation[] = [];
  for (const row of rows) {
    if (!row) continue;
    citations.push({
      evidenceId: row.id,
      nodeId: row.nodeId,
      startTime: row.startTime,
      endTime: row.endTime,
      source: row.source,
      quote: (row.correctedText || row.text).slice(0, 160),
    });
  }
  return citations;
}

export async function cancelAiRequest(requestId: string): Promise<void> {
  stopPolling(requestId);
  pendingSubmit.delete(requestId);
  await updateRequest(requestId, { status: 'canceled' });
}

async function updateRequest(requestId: string, patch: Partial<AiAppRequest>): Promise<void> {
  await getDb().aiRequests.update(requestId, { ...patch, updatedAt: Date.now() });
}

/** SW 重启后：不自动重发，标记为"是否送达无法确认"，等待用户检查 */
export async function reconcileInterruptedRequests(): Promise<void> {
  const db = getDb();
  const active = await db.aiRequests
    .where('status')
    .anyOf(['sent', 'generating'])
    .toArray();
  for (const request of active) {
    await db.aiRequests.update(request.requestId, {
      status: 'unknown-delivery',
      deliveryUnknown: true,
      updatedAt: Date.now(),
      warnings: [
        ...(request.warnings ?? []),
        '后台服务重启，无法确认问题是否已发送。请先在 AI 应用中查看，再决定是否重发。',
      ],
    });
  }
  for (const request of active) stopPolling(request.requestId);
}

export async function connectorRuntimes(): Promise<
  Array<{ id: string; label: string; status: string; statusLabel: string; reasons: string[]; verified: boolean }>
> {
  return (await import('./registry')).CONNECTORS.filter((c) => c.id !== 'manual-handoff').map((profile) => {
    const runtime = runtimeFor(profile, true);
    return {
      id: profile.id,
      label: profile.label,
      status: runtime.status,
      statusLabel: runtime.statusLabel,
      reasons: runtime.reasons,
      verified: profile.verified,
    };
  });
}

export async function requestRows(videoId: string): Promise<AiAppRequest[]> {
  return getDb().aiRequests.where('videoId').equals(videoId).reverse().sortBy('createdAt');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 手动交接内容：可复制的问题、节点、范围与同步时间 */
export async function buildHandoffText(params: {
  video: Video;
  question: string;
  frozenTime: number;
  nodes: MemoryNode[];
  evidence: Evidence[];
}): Promise<string> {
  const settings = await getSettings();
  const ctx: QueryContext = {
    requestId: uid('handoff'), videoId: params.video.id, frozenTime: params.frozenTime,
    selectedNodeIds: params.nodes.map(node => node.id), scopes: params.nodes.map(node => ({ start: node.startTime, end: node.endTime, nodeId: node.id })),
    recordedRanges: params.video.recordedRanges ?? [], libraryRevision: await libraryRevision(), question: params.question,
    allowImages: false, route: 'ai-app', createdAt: Date.now(),
  };
  const summary = await questionSummary(ctx, params.video.title, params.nodes, params.evidence, settings);
  const lines = [
    '我在观看视频时希望借助本机“视频记忆助手”记忆库理解一个片段。',
    '',
    `视频：${params.video.title}`,
    `提问位置：${formatClock(params.frozenTime)}`,
  ];
  if (params.nodes.length > 0) {
    lines.push('选中节点：');
    for (const node of params.nodes) lines.push(`- 《${node.title}》 ${formatClock(node.startTime)}–${formatClock(node.endTime)}（ID: ${node.id}）`);
  }
  lines.push('', '问题：', params.question, '', '已概括的学习内容：', summary.text);
  lines.push('', learningPreferencesPrompt(settings));
  lines.push('', `交接时间：${new Date().toLocaleString()}`);
  return lines.join('\n');
}

function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

export type { QueryContext };
