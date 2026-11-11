/**
 * 只读检索工具层（供 API 问答 Agent 使用）。
 *
 * 约束：
 * - 参数校验、数量与长度上限、截断标志、统一错误结构；
 * - 每条结果带证据 ID、时间范围、来源与置信度；
 * - 范围权限检查：多选节点提问时默认严格限制在所选节点内；
 * - 引用只能指向本次实际读取过的证据。
 */

import { isKnowledgeFrame } from '@/pipeline/visual';
import { learningPreferencesPrompt } from '@/shared/languages';
import { getDb } from '@/db/db';
import type { Evidence, Keyframe, MemoryNode, QueryContext, Settings } from '@/shared/types';
import { MAX_TOOL_LIMIT, MAX_TOOL_RESULT_CHARS } from '@/shared/constants';
import { searchLibrary, readEvidenceByIds, readNodesByIds } from '@/background/index-service';
import type { ToolSpec } from '@/providers/types';
import type { Hit } from '@/retrieval/fusion';
import { blobToDataUrl } from '@/shared/blob';

export { blobToDataUrl };

export interface ToolResult {
  /** 返回给模型的结构化结果（JSON 字符串） */
  content: string;
  /** 需要注入的图像（仅 get_frame 且已授权时） */
  images?: string[];
  truncated?: boolean;
  error?: { code: string; message: string };
}

export interface ToolRuntime {
  ctx: QueryContext;
  settings: Settings;
  /** 本请求内实际读取的证据 ID */
  readEvidence: Set<string>;
  /** 本请求内读取的节点 ID */
  readNodes: Set<string>;
  imageUploads: number;
  allowImages: boolean;
  frameEvidence?: Map<string, Evidence>;
  /** 允许模型访问的记忆库连接器（AI 应用路线使用） */
  source: 'api' | 'ai-app';
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'search_library',
    description:
      '在当前视频（或指定节点范围）内检索记忆库。返回命中的节点与证据片段，包含证据 ID 与时间。用于查找相关讲解、前后文或重复话题。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索文本，使用与问题相关的关键词' },
        nodeIds: { type: 'array', items: { type: 'string' }, description: '限定节点 ID（可选）' },
        startTime: { type: 'number', description: '起始媒体时间（秒，可选）' },
        endTime: { type: 'number', description: '结束媒体时间（秒，可选）' },
        limit: { type: 'number', description: '返回条数，1-20，默认 8' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_evidence',
    description: '读取指定证据 ID 的原文、来源类型、置信度与时间范围。只读取本次检索或上下文中出现过的证据。',
    parameters: {
      type: 'object',
      properties: {
        evidenceIds: { type: 'array', items: { type: 'string' }, description: '证据 ID，最多 12 个' },
      },
      required: ['evidenceIds'],
    },
  },
  {
    name: 'get_timeline',
    description: '获取当前视频指定时间范围内的节点目录及关键画面ID、时间，图形或公式问题可再用get_frame读取已授权画面。',
    parameters: {
      type: 'object',
      properties: {
        startTime: { type: 'number', description: '起始时间（可选）' },
        endTime: { type: 'number', description: '结束时间（可选）' },
        limit: { type: 'number', description: '最多返回节点数，1-50，默认 20' },
      },
      required: [],
    },
  },
  {
    name: 'get_neighbors',
    description: '读取指定节点前后相邻的节点与原文，用于补充上下文。',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: '节点 ID' },
        before: { type: 'number', description: '向前读取几个节点，0-2，默认 1' },
        after: { type: 'number', description: '向后读取几个节点，0-2，默认 1' },
      },
      required: ['nodeId'],
    },
  },
  {
    name: 'get_frame',
    description:
      '获取已授权关键帧的图像。只有在问题确实需要图形、公式或界面证据时使用；未授权时会返回错误。',
    parameters: {
      type: 'object',
      properties: {
        keyframeId: { type: 'string', description: '关键帧 ID' },
        keyframeIds: { type: 'array', items: { type: 'string' }, description: '批量读取的画面ID，最多6张，仍受本次图片额度限制' },
      },
      required: [],
    },
  },
];

const CLAMP = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));

function errorContent(code: string, message: string): ToolResult {
  return { content: JSON.stringify({ error: { code, message } }), error: { code, message } };
}

function hitToPayload(hit: Hit, evidence?: Evidence | null) {
  return {
    evidenceId: hit.evidenceId ?? hit.id,
    nodeId: hit.nodeId ?? (hit.kind === 'node' ? hit.id : undefined),
    startTime: Number(hit.startTime.toFixed(2)),
    endTime: Number(hit.endTime.toFixed(2)),
    source: evidence?.source ?? hit.source ?? 'unknown',
    confidence: evidence?.confidence,
    snippet: (hit.text ?? evidence?.text ?? '').slice(0, 240),
  };
}

/** 检查证据是否落在本次提问的允许范围内 */
export async function isEvidenceInScope(ctx: QueryContext, evidence: Evidence): Promise<boolean> {
  if (evidence.videoId !== ctx.videoId) return false;
  if (ctx.selectedNodeIds.length === 0) return true;
  if (evidence.nodeId && ctx.selectedNodeIds.includes(evidence.nodeId)) return true;
  return ctx.scopes.some((scope) => evidence.endTime >= scope.start - 0.5 && evidence.startTime <= scope.end + 0.5);
}

export function isKeyframeInScope(ctx: QueryContext, frame: Pick<Keyframe, 'videoId' | 'time'>): boolean {
  return isKnowledgeFrame(frame as Keyframe) && frame.videoId === ctx.videoId && (ctx.selectedNodeIds.length === 0 || ctx.scopes.some(scope => frame.time >= scope.start - 0.5 && frame.time <= scope.end + 0.5));
}

async function resolveNodeHits(hits: Hit[]): Promise<{ hits: Hit[]; nodes: Map<string, MemoryNode> }> {
  const db = getDb();
  const nodeIds = [...new Set(hits.map((h) => h.nodeId ?? (h.kind === 'node' ? h.id : '')).filter(Boolean))];
  const nodes = new Map<string, MemoryNode>();
  if (nodeIds.length > 0) {
    const rows = await db.nodes.bulkGet(nodeIds);
    for (const row of rows) if (row) nodes.set(row.id, row);
  }
  return { hits, nodes };
}

export class ToolExecutor {
  constructor(private readonly runtime: ToolRuntime) {}

  specs(source: 'api' | 'ai-app' = this.runtime.source): ToolSpec[] {
    if (source === 'ai-app') {
      return [
        ...TOOL_SPECS.filter((t) => t.name !== 'get_frame' || this.runtime.allowImages),
        {
          name: 'get_question',
          description: '读取本次请求的问题、提问时冻结的媒体时间、选中节点与检索范围。用于确认用户到底在问什么。',
          parameters: { type: 'object', properties: {}, required: [] },
        },
        {
          name: 'submit_answer',
          description:
            '提交当前请求的最终答案与引用。只能用于当前 requestId；答案必须基于实际读取过的证据，引用格式为证据 ID 数组。',
          parameters: {
            type: 'object',
            properties: {
              answer: { type: 'string', description: '最终答案正文' },
              citations: {
                type: 'array',
                items: { type: 'string' },
                description: '本次实际读取并使用的证据 ID 列表',
              },
            },
            required: ['answer', 'citations'],
          },
        },
      ];
    }
    return TOOL_SPECS;
  }

  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    switch (name) {
      case 'search_library':
        return this.searchLibrary(args);
      case 'read_evidence':
        return this.readEvidence(args);
      case 'get_timeline':
        return this.getTimeline(args);
      case 'get_neighbors':
        return this.getNeighbors(args);
      case 'get_frame':
        return this.getFrame(args);
      case 'get_question':
        return this.getQuestion();
      default:
        return errorContent('unknown_tool', `未知工具：${name}`);
    }
  }

  private async searchLibrary(args: Record<string, unknown>): Promise<ToolResult> {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) return errorContent('bad_request', 'query 不能为空');
    if (query.length > 300) return errorContent('bad_request', 'query 过长');
    const limit = CLAMP(Number(args.limit ?? 8), 1, 20);
    const ctx = this.runtime.ctx;

    let scopes = ctx.scopes;
    if (ctx.selectedNodeIds.length === 0) {
      const startTime = typeof args.startTime === 'number' ? args.startTime : undefined;
      const endTime = typeof args.endTime === 'number' ? args.endTime : undefined;
      if (startTime !== undefined || endTime !== undefined) {
        scopes = [{ start: startTime ?? 0, end: endTime ?? Number.MAX_SAFE_INTEGER }];
      }
    }

    let nodeIds: string[] | undefined;
    if (Array.isArray(args.nodeIds)) {
      const requested = args.nodeIds.filter((id): id is string => typeof id === 'string');
      if (ctx.selectedNodeIds.length > 0) {
        // 多选节点：只允许在所选节点内
        nodeIds = requested.filter((id) => ctx.selectedNodeIds.includes(id));
        if (nodeIds.length === 0 && requested.length > 0) {
          return errorContent('out_of_scope', '当前提问限制了所选节点范围，不能检索其他节点');
        }
      } else {
        nodeIds = requested;
      }
    }

    const { hits } = await searchLibrary({
      query,
      videoId: ctx.videoId,
      contextTime: ctx.frozenTime,
      scopes,
      limit: limit * 2,
      useVector: this.runtime.settings.retrieval.vector,
    });

    const filtered = hits.filter((hit) => {
      if (nodeIds && nodeIds.length > 0) {
        const nodeId = hit.nodeId ?? (hit.kind === 'node' ? hit.id : '');
        if (!nodeIds.includes(nodeId)) return false;
      }
      return true;
    });

    const { nodes } = await resolveNodeHits(filtered);
    const evidenceIds = filtered.filter((h) => h.evidenceId).map((h) => h.evidenceId!);
    const evidenceRows = await readEvidenceByIds(ctx.videoId, evidenceIds);
    const evidenceById = new Map(evidenceRows.map((e) => [e.id, e]));

    const inScope: Hit[] = [];
    for (const hit of filtered) {
      if (hit.evidenceId) {
        const evidence = evidenceById.get(hit.evidenceId);
        if (!evidence || !(await isEvidenceInScope(ctx, evidence))) continue;
        this.runtime.readEvidence.add(evidence.id);
      }
      if (hit.nodeId) this.runtime.readNodes.add(hit.nodeId);
      inScope.push(hit);
      if (inScope.length >= limit) break;
    }

    const words = query.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]{2}/g) ?? [];
    const keyframes = (await getDb().keyframes.where('videoId').equals(ctx.videoId).toArray())
      .filter(frame => isKeyframeInScope(ctx, frame) && (frame.knowledge || frame.ocrText))
      .map(frame => ({ frame, score: words.filter(word => `${frame.knowledge?.title} ${frame.knowledge?.summary} ${frame.knowledge?.visibleText} ${frame.ocrText}`.toLowerCase().includes(word)).length }))
      .filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 6);
    const payload = {
      keyframes: keyframes.map(({ frame }) => ({ keyframeId: frame.id, time: frame.time, description: frame.knowledge?.summary || frame.ocrText, note: '模型生成的查找线索，引用须get_frame读取原图核验' })),
      scope: ctx.selectedNodeIds.length > 0 ? 'selected-nodes' : 'video',
      scopeNote:
        ctx.selectedNodeIds.length > 0
          ? '结果已严格限制在用户所选节点范围内；如需更大范围，需要用户在界面显式选择。'
          : undefined,
      results: inScope.map((hit) => hitToPayload(hit, hit.evidenceId ? evidenceById.get(hit.evidenceId) : null)),
      nodes: [...nodes.values()].slice(0, limit).map((node) => ({
        nodeId: node.id,
        title: node.title,
        startTime: node.startTime,
        endTime: node.endTime,
        status: node.status,
      })),
      total: filtered.length,
      truncated: filtered.length > limit,
    };
    return this.bound(payload);
  }

  private async readEvidence(args: Record<string, unknown>): Promise<ToolResult> {
    const ids = Array.isArray(args.evidenceIds)
      ? args.evidenceIds.filter((id): id is string => typeof id === 'string').slice(0, 12)
      : [];
    if (ids.length === 0) return errorContent('bad_request', 'evidenceIds 不能为空');
    const ctx = this.runtime.ctx;
    const rows = await readEvidenceByIds(ctx.videoId, ids);
    const allowed: Evidence[] = [];
    for (const row of rows) {
      if (await isEvidenceInScope(ctx, row)) {
        allowed.push(row);
        this.runtime.readEvidence.add(row.id);
      }
    }
    if (allowed.length === 0) {
      return errorContent('not_found', '没有找到属于当前视频且位于本次提问范围内的证据');
    }
    let used = 0;
    const items = [];
    for (const row of allowed) {
      const text = (row.correctedText || row.text).slice(0, 2000);
      used += text.length;
      if (used > MAX_TOOL_RESULT_CHARS) break;
      items.push({
        evidenceId: row.id,
        nodeId: row.nodeId,
        startTime: row.startTime,
        endTime: row.endTime,
        source: row.source,
        confidence: row.confidence,
        text,
        corrected: Boolean(row.correctedText),
      });
    }
    return this.bound({ items, requested: ids.length, returned: items.length });
  }

  private async getTimeline(args: Record<string, unknown>): Promise<ToolResult> {
    const ctx = this.runtime.ctx;
    const limit = CLAMP(Number(args.limit ?? 20), 1, MAX_TOOL_LIMIT);
    const start = typeof args.startTime === 'number' ? args.startTime : 0;
    const end = typeof args.endTime === 'number' ? args.endTime : Number.MAX_SAFE_INTEGER;
    const db = getDb();
    const nodes = await db.nodes.where('videoId').equals(ctx.videoId).toArray();
    const filtered = nodes
      .filter((node) => {
        if (node.endTime < start || node.startTime > end) return false;
        if (ctx.selectedNodeIds.length > 0) {
          return ctx.selectedNodeIds.includes(node.id) || ctx.scopes.some((s) => node.endTime >= s.start && node.startTime <= s.end);
        }
        return true;
      })
      .sort((a, b) => a.startTime - b.startTime)
      .slice(0, limit);
    for (const node of filtered) this.runtime.readNodes.add(node.id);
    const frames = (await db.keyframes.where('videoId').equals(ctx.videoId).toArray()).filter(frame => isKeyframeInScope(ctx, frame) && frame.time >= start && frame.time <= end).sort((a, b) => Math.abs(a.time - ctx.frozenTime) - Math.abs(b.time - ctx.frozenTime)).slice(0, Math.min(limit, 12));
    return this.bound({
      keyframes: frames.map(frame => ({ keyframeId: frame.id, time: frame.time, description: (frame.knowledge?.summary || frame.ocrText)?.slice(0, 240), imageAllowed: this.runtime.allowImages && this.runtime.settings.privacy.allowVisionUpload && Boolean(frame.uploadAllowed || ctx.allowedFrameIds?.includes(frame.id)) })),
      items: filtered.map((node) => ({
        nodeId: node.id,
        title: node.title,
        startTime: node.startTime,
        endTime: node.endTime,
        status: node.status,
        summary: node.summary?.slice(0, 200),
      })),
      truncated: nodes.length > filtered.length,
    });
  }

  private async getNeighbors(args: Record<string, unknown>): Promise<ToolResult> {
    const nodeId = typeof args.nodeId === 'string' ? args.nodeId : '';
    if (!nodeId) return errorContent('bad_request', 'nodeId 不能为空');
    const before = CLAMP(Number(args.before ?? 1), 0, 2);
    const after = CLAMP(Number(args.after ?? 1), 0, 2);
    const db = getDb();
    const ctx = this.runtime.ctx;
    const node = await db.nodes.get(nodeId);
    if (!node || node.videoId !== ctx.videoId) return errorContent('not_found', '节点不存在或不属于当前视频');

    const siblings = await db.nodes.where('videoId').equals(ctx.videoId).toArray();
    const ordered = siblings.sort((a, b) => a.startTime - b.startTime);
    const index = ordered.findIndex((n) => n.id === nodeId);
    const picked = ordered.slice(Math.max(0, index - before), Math.min(ordered.length, index + after + 1))
      .filter(item => !ctx.selectedNodeIds.length || ctx.selectedNodeIds.includes(item.id));

    const items = [];
    for (const item of picked) {
      this.runtime.readNodes.add(item.id);
      const evidence = [];
      for (const row of await readEvidenceByIds(ctx.videoId, item.evidenceIds.slice(0, 4))) {
        if (await isEvidenceInScope(ctx, row)) evidence.push(row);
      }
      for (const e of evidence) this.runtime.readEvidence.add(e.id);
      items.push({
        nodeId: item.id,
        title: item.title,
        startTime: item.startTime,
        endTime: item.endTime,
        current: item.id === nodeId,
        evidence: evidence.map((e) => ({
          evidenceId: e.id,
          startTime: e.startTime,
          endTime: e.endTime,
          text: (e.correctedText || e.text).slice(0, 400),
        })),
      });
    }
    return this.bound({ items, truncated: picked.length < before + after + 1 });
  }

  private async getFrame(args: Record<string, unknown>): Promise<ToolResult> {
    const ids = [...new Set(Array.isArray(args.keyframeIds) ? args.keyframeIds.filter((id): id is string => typeof id === 'string') : typeof args.keyframeId === 'string' ? [args.keyframeId] : [])];
    if (!ids.length || ids.length > 6) return errorContent('bad_request', '请提供1–6个关键帧ID');
    const runtime = this.runtime;
    if (!runtime.settings.privacy.allowVisionUpload || !runtime.allowImages) return errorContent('vision_not_authorized', '本次未允许读取图片');
    if (runtime.imageUploads + ids.length > runtime.settings.budget.maxImageUploadsPerRequest) return errorContent('image_budget', '本次提问的图像读取次数已达上限');
    const frames = await getDb().keyframes.bulkGet(ids);
    if (frames.some(frame => !frame || !isKeyframeInScope(runtime.ctx, frame))) return errorContent('not_found', '关键帧不存在或不属于本次范围');
    const allowed = frames as Keyframe[];
    if (allowed.some(frame => !frame.uploadAllowed && !runtime.ctx.allowedFrameIds?.includes(frame.id))) return errorContent('vision_not_authorized', '该关键帧未被授权上传');
    const images = await Promise.all(allowed.map(frame => blobToDataUrl(frame.image)));
    runtime.imageUploads += images.length;
    runtime.frameEvidence ??= new Map();
    for (const frame of allowed) {
      runtime.readEvidence.add(frame.id);
      runtime.frameEvidence.set(frame.id, { id: frame.id, videoId: frame.videoId, sessionId: frame.sessionId, startTime: frame.time, endTime: frame.time, source: 'visual', text: '实际读取的视频画面', keyframeId: frame.id, capturedAt: frame.capturedAt, captureEpoch: frame.captureEpoch });
    }
    return { content: JSON.stringify({ frames: allowed.map(frame => ({ keyframeId: frame.id, citation: `[E:${frame.id}]`, time: frame.time, width: frame.width, height: frame.height })), note: '图片按上述顺序附加。只有实际看清的内容可引用对应[E:画面ID]，不推测模糊细节。' }), images };
  }

  private getQuestion(): ToolResult {
    const ctx = this.runtime.ctx;
    return this.bound({
      requestId: ctx.requestId,
      question: ctx.question,
      responsePreferences: learningPreferencesPrompt(this.runtime.settings),
      previousTurns: ctx.previousTurns,
      frozenTime: ctx.frozenTime,
      selectedNodeIds: ctx.selectedNodeIds,
      scopes: ctx.scopes,
      recordedRanges: ctx.recordedRanges,
      videoId: ctx.videoId,
    });
  }

  private bound(payload: unknown): ToolResult {
    let content = JSON.stringify(payload);
    let truncated = false;
    if (content.length > MAX_TOOL_RESULT_CHARS) {
      content = content.slice(0, MAX_TOOL_RESULT_CHARS);
      truncated = true;
      content = JSON.stringify({ truncated: true, preview: content });
    }
    return { content, truncated };
  }
}


