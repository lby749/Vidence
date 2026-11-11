/**
 * QuestionAgent（API 路线）。
 *
 * 流程：
 * 1. 冻结 QueryContext（时间、选中节点、范围、库修订号）；
 * 2. 本地检索少量证据作为初始上下文；
 * 3. 调用用户配置的强模型，允许有限轮只读工具查询；
 * 4. 核验引用：只接受本次实际读取过的证据 ID，其余移除并提示。
 */

import { getDb, getSettings, libraryRevision } from '@/db/db';
import type { ChatTurn, Citation, Evidence, MemoryNode, QueryContext, Settings, UsageSnapshot, Video } from '@/shared/types';
import { createAdapter, recordUsage } from '@/providers';
import { ProviderError, type NeutralMessage, type ToolCall } from '@/providers/types';
import { resolveRole, findProvider, assertDailyBudget } from '@/providers/router';
import { buildContextBlock, buildSystemPrompt, PROMPT_VERSION } from './prompt';
import { ToolExecutor, isKeyframeInScope, type ToolRuntime } from './tools';
import { evidenceForHits, searchLibrary } from '@/background/index-service';
import { uid } from '@/shared/ids';
import { finalizeCitations, estimateTokens, type FinalizedAnswer } from './citations';
import { questionSummary } from './long-term-memory';
import { answerLanguage, answerStyle } from '@/shared/languages';

export { finalizeCitations, estimateTokens };

export interface AskCallbacks {
  onDelta?: (text: string) => void;
  onStatus?: (status: string, detail?: string) => void;
}

export interface AskResult {
  requestId: string;
  answer: string;
  citations: Citation[];
  usage: UsageSnapshot;
  warnings: string[];
  unknownCitations: number;
  memoryContext?: ChatTurn['memoryContext'];
}

export class AskCanceledError extends Error {
  constructor() {
    super('已取消');
    this.name = 'AskCanceledError';
  }
}

export async function prepareQueryContext(params: {
  requestId: string;
  videoId: string;
  question: string;
  frozenTime: number;
  selectedNodeIds: string[];
  allowImages: boolean;
  route: QueryContext['route'];
  followUpTo?: string;
}): Promise<{ ctx: QueryContext; video: Video; nodes: MemoryNode[] }> {
  const db = getDb();
  const video = await db.videos.get(params.videoId);
  if (!video) throw new Error('找不到对应视频记录');
  const previous = params.followUpTo ? await db.chats.where('requestId').equals(params.followUpTo).first() : undefined;
  if (params.followUpTo && (!previous || previous.videoId !== video.id || previous.status !== 'completed' || !previous.context)) throw new Error('上次问答不可追问，请重新选择节点提问');
  const nodes: MemoryNode[] = [];
  for (const id of (previous?.context?.selectedNodeIds ?? params.selectedNodeIds).slice(0, 20)) {
    const node = await db.nodes.get(id);
    if (!node || node.videoId !== params.videoId) throw new Error('选中的节点不属于当前视频或已删除，请重新选择');
    nodes.push(node);
  }
  const ctx: QueryContext = {
    requestId: params.requestId,
    videoId: params.videoId,
    frozenTime: Math.max(0, previous?.context?.frozenTime ?? params.frozenTime),
    selectedNodeIds: nodes.map((n) => n.id),
    scopes: nodes.map((n) => ({ start: n.startTime, end: n.endTime, nodeId: n.id })),
    recordedRanges: video.recordedRanges ?? [],
    libraryRevision: await libraryRevision(),
    question: params.question.trim().slice(0, 4000),
    previousRequestId: previous?.requestId,
    previousTurns: previous ? [...(previous.context?.previousTurns ?? []), { question: previous.question, answer: (previous.answer ?? '').slice(0, 2000) }].slice(-3) : undefined,
    allowImages: params.allowImages,
    route: params.route,
    createdAt: Date.now(),
  };
  if (params.allowImages && (await getSettings()).privacy.allowVisionUpload) {
    ctx.allowedFrameIds = (await db.keyframes.where('videoId').equals(video.id).toArray()).filter(frame => isKeyframeInScope(ctx, frame)).map(frame => frame.id);
  }
  return { ctx, video, nodes };
}

export async function askQuestion(params: {
  ctx: QueryContext;
  video: Video;
  nodes: MemoryNode[];
  callbacks?: AskCallbacks;
  externalSignal?: AbortSignal;
}): Promise<AskResult> {
  const { ctx, video, nodes, callbacks } = params;
  const settings = await getSettings();
  const warnings: string[] = [];

  const resolved = resolveRole(settings, 'answerModel');
  if (!resolved) {
    throw new ProviderError({ code: 'no_provider', message: '尚未配置问答模型，请先在设置中填写提供商与 API Key', retryable: false });
  }
  const provider = findProvider(settings, resolved.providerId);
  if (!provider) {
    throw new ProviderError({ code: 'no_provider', message: '问答模型对应的提供商不存在', retryable: false });
  }
  if (!resolved.role.modelId) {
    throw new ProviderError({ code: 'no_provider', message: '尚未设置问答模型名称', retryable: false });
  }
  await assertDailyBudget(settings);

  const runtime: ToolRuntime = {
    ctx,
    settings,
    readEvidence: new Set<string>(),
    readNodes: new Set(nodes.map((n) => n.id)),
    imageUploads: 0,
    allowImages: ctx.allowImages,
    source: 'api',
  };
  const executor = new ToolExecutor(runtime);

  // 初始召回：问题 + 选中节点标题
  const queryText = [ctx.question, ctx.previousTurns?.at(-1)?.question ?? '', ...nodes.map((n) => n.title)].join(' ');
  callbacks?.onStatus?.('retrieving', '正在检索本地记忆库');
  const recalled = await questionSummary(ctx, video.title, nodes, async () => {
    const retrieval = await searchLibrary({
      query: queryText,
      videoId: ctx.videoId,
      contextTime: ctx.frozenTime,
      scopes: ctx.scopes.length > 0 ? ctx.scopes : undefined,
      limit: 8,
      useVector: settings.retrieval.vector,
    });

    return evidenceForHits(ctx.videoId, retrieval.hits, ctx.scopes);
  }, settings, params.externalSignal, detail => callbacks?.onStatus?.('summarizing', detail));
  const evidenceRows = recalled.evidence;
  // 初始上下文中的证据视为已读取
  for (const row of evidenceRows) runtime.readEvidence.add(row.id);
  if (evidenceRows.length === 0) {
    warnings.push('本地记忆库中没有检索到与问题直接相关的证据');
  }

  const hasTools = settings.budget.answerMaxToolRounds > 0;
  const system = buildSystemPrompt({
    language: answerLanguage(settings),
    style: answerStyle(settings),
    hasTools,
    allowImages: ctx.allowImages && settings.privacy.allowVisionUpload,
    scopedToSelection: ctx.selectedNodeIds.length > 0,
    source: 'api',
  });
  const userContent = buildContextBlock({
    ctx,
    videoTitle: video.title,
    evidence: [],
    summary: recalled.text,
    nodeSummaries: nodes.map((n) => ({ nodeId: n.id, title: n.title, startTime: n.startTime, endTime: n.endTime })),
  });

  const messages: NeutralMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: [{ type: 'text', text: userContent }] },
  ];

  const controller = new AbortController();
  if (params.externalSignal) {
    if (params.externalSignal.aborted) controller.abort();
    else params.externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const adapter = createAdapter(provider);
  const usage: UsageSnapshot = {
    inputTokens: 0,
    outputTokens: 0,
    imageUploads: 0,
    calls: 0,
    toolRounds: 0,
  };
  const maxRounds = Math.max(0, Math.min(settings.budget.answerMaxToolRounds, 6));
  let answer = '';
  let finalText = '';

  for (let round = 0; round <= maxRounds; round++) {
    if (controller.signal.aborted) throw new AskCanceledError();
    callbacks?.onStatus?.(round === 0 ? 'generating' : 'tool-loop', round === 0 ? '正在生成回答' : `正在进行第 ${round} 轮工具查询`);
    const toolCalls: ToolCall[] = [];
    let roundText = '';

    const stream = adapter.chat({
      model: resolved.role.modelId,
      messages: [...messages],
      tools: hasTools ? executor.specs('api') : undefined,
      temperature: resolved.role.temperature ?? 0.3,
      maxTokens: resolved.role.maxTokens ?? 1600,
      signal: controller.signal,
      allowImages: runtime.allowImages,
    });

    for await (const event of stream) {
      if (event.type === 'text') {
        roundText += event.delta;
      } else if (event.type === 'tool-call') {
        toolCalls.push(event.call);
      } else if (event.type === 'usage') {
        usage.inputTokens += event.inputTokens;
        usage.outputTokens += event.outputTokens;
      } else if (event.type === 'error') {
        if (event.code === 'canceled') throw new AskCanceledError();
        throw new ProviderError({
          code: event.code,
          message: event.message,
          status: event.status,
          retryable: event.retryable,
        });
      }
    }
    usage.calls += 1;

    if (toolCalls.length === 0) {
      finalText = roundText;
      break;
    }

    // 模型请求了工具：记录本轮文本（通常是过渡说明），执行工具后继续
    messages.push({ role: 'assistant', content: roundText, toolCalls });
    const imageQueue: string[] = [];
    for (const call of toolCalls) {
      usage.toolRounds += 1;
      let args: Record<string, unknown> = {};
      try {
        args = call.arguments ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
      } catch {
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: JSON.stringify({ error: { code: 'bad_arguments', message: '工具参数不是合法 JSON' } }),
        });
        continue;
      }
      const result = await executor.execute(call.name, args);
      messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: result.content });
      if (result.images && result.images.length > 0) {
        imageQueue.push(...result.images);
        usage.imageUploads += result.images.length;
      }
    }
    if (imageQueue.length > 0) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: '以上工具返回的关键帧图像如下。只依据可见内容作答，看不清的部分明确说明。' },
          ...imageQueue.map((dataUrl) => ({ type: 'image' as const, dataUrl })),
        ],
      });
    }
    if (round === maxRounds) {
      warnings.push(`工具查询达到上限（${maxRounds} 轮），已基于现有证据作答`);
    }
  }

  if (!finalText) {
    // 达到工具轮数上限但模型未给最终答案
    finalText = '（模型在工具查询上限内没有给出最终回答，请缩小问题范围或重试。）';
    warnings.push('模型未返回最终答案');
  }

  const finalized = finalizeCitations(finalText, runtime.readEvidence, new Map([...(await evidenceMap([...runtime.readEvidence])), ...(runtime.frameEvidence ?? new Map())]));
  answer = finalized.answer;
  if (finalized.unknown > 0) {
    warnings.push(`已移除 ${finalized.unknown} 个无法核验的引用`);
  }
  if (finalized.citations.length === 0 && evidenceRows.length > 0) {
    warnings.push('回答没有引用具体证据，可能依据了模型自身知识');
  }
  answer = answer.replace(/\[E:[^\]]+\]/g, '').trim();

  usage.imageUploads = runtime.imageUploads;
  await recordUsage({
    providerId: provider.id,
    modelId: resolved.role.modelId,
    role: 'answer',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    images: usage.imageUploads,
    toolRounds: usage.toolRounds,
  });

  const turnStatus = controller.signal.aborted ? 'canceled' : 'completed';
  await persistTurn({
    requestId: ctx.requestId,
    ctx,
    video,
    answer,
    citations: finalized.citations,
    status: turnStatus,
    usage,
    memoryContext: recalled.memoryContext,
  });

  callbacks?.onStatus?.('completed');
  void PROMPT_VERSION;
  return {
    requestId: ctx.requestId,
    answer,
    citations: finalized.citations,
    usage,
    warnings,
    unknownCitations: finalized.unknown,
    memoryContext: recalled.memoryContext,
  };
}

async function evidenceMap(ids: string[]): Promise<Map<string, Evidence>> {
  const rows = await getDb().evidence.bulkGet(ids);
  const map = new Map<string, Evidence>();
  for (const row of rows) if (row) map.set(row.id, row);
  return map;
}

async function persistTurn(params: {
  requestId: string;
  ctx: QueryContext;
  video: Video;
  answer: string;
  citations: Citation[];
  status: string;
  usage: UsageSnapshot;
  memoryContext?: ChatTurn['memoryContext'];
}): Promise<void> {
  const db = getDb();
  const turn = {
    id: uid('turn'),
    requestId: params.requestId,
    videoId: params.video.id,
    sessionId: undefined,
    question: params.ctx.question,
    context: { frozenTime: params.ctx.frozenTime, selectedNodeIds: params.ctx.selectedNodeIds, previousTurns: params.ctx.previousTurns },
    memoryContext: params.memoryContext,
    answer: params.answer,
    citations: params.citations,
    route: 'api' as const,
    status: params.status as 'completed' | 'canceled',
    createdAt: Date.now(),
    completedAt: Date.now(),
    usage: params.usage,
  };
  await db.chats.put(turn);
}


