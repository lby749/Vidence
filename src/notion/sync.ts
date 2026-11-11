/**
 * Notion 同步（可选、异步、单向）。
 *
 * 使用官方 REST API（Notion-Version 2022-06-28）：
 * - 用户通过官方集成令牌授权；
 * - 不把共享 client secret 放进扩展包；
 * - 稳定 ID + 远端映射 + 幂等更新 + 限流退避；
 * - 失败不影响本地记录。
 */

import { getDb, getSettings, saveSettings } from '@/db/db';
import type { Job, MemoryNode, NotionConfig, Settings, SyncState, Video } from '@/shared/types';
import { uid } from '@/shared/ids';

const NOTION_VERSION = '2022-06-28';
const API = 'https://api.notion.com/v1';

export class NotionError extends Error {
  code: string;
  status?: number;
  retryable: boolean;
  constructor(code: string, message: string, status?: number, retryable = false) {
    super(message);
    this.name = 'NotionError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

interface NotionConfigState extends NotionConfig {
  videosDatabaseId?: string;
  nodesDatabaseId?: string;
}

async function notionRequest<T>(
  config: NotionConfig,
  path: string,
  init: { method?: string; body?: unknown } = {},
  attempt = 0,
): Promise<T> {
  if (!config.token) throw new NotionError('not_configured', '尚未配置 Notion 集成令牌');
  const response = await fetch(`${API}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${config.token}`,
      'notion-version': NOTION_VERSION,
      'content-type': 'application/json',
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });

  if (response.status === 429 && attempt < 4) {
    const retryAfter = Number(response.headers.get('retry-after') ?? '1');
    await delay(Math.min(30_000, (retryAfter + 0.5) * 1000 * 2 ** attempt));
    return notionRequest<T>(config, path, init, attempt + 1);
  }
  if (response.status === 401 || response.status === 403) {
    throw new NotionError('unauthorized', 'Notion 授权失败：请检查集成令牌与页面共享权限', response.status, false);
  }
  if (response.status === 404) {
    throw new NotionError('not_found', 'Notion 页面或数据库不存在，或集成未被授权访问', response.status, false);
  }
  if (response.status >= 500 && attempt < 3) {
    await delay(1000 * 2 ** attempt);
    return notionRequest<T>(config, path, init, attempt + 1);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new NotionError('http_error', `Notion 请求失败（${response.status}）${text.slice(0, 300)}`, response.status, response.status >= 500 || response.status === 429);
  }
  return (await response.json()) as T;
}

export interface NotionTestResult {
  ok: boolean;
  botName?: string;
  videosDatabase?: { id: string; title: string };
  nodesDatabase?: { id: string; title: string };
  error?: string;
}

export async function testConnection(config: NotionConfig): Promise<NotionTestResult> {
  try {
    const me = await notionRequest<{ name?: string; bot?: { owner?: unknown } }>(config, '/users/me');
    const result: NotionTestResult = { ok: true, botName: me.name ?? 'Notion 集成' };
    if (config.videosDatabaseId) {
      const db = await notionRequest<{ id: string; title?: Array<{ plain_text?: string }> }>(
        config,
        `/databases/${config.videosDatabaseId}`,
      );
      result.videosDatabase = { id: db.id, title: db.title?.map((t) => t.plain_text ?? '').join('') ?? '' };
    }
    if (config.nodesDatabaseId) {
      const db = await notionRequest<{ id: string; title?: Array<{ plain_text?: string }> }>(
        config,
        `/databases/${config.nodesDatabaseId}`,
      );
      result.nodesDatabase = { id: db.id, title: db.title?.map((t) => t.plain_text ?? '').join('') ?? '' };
    }
    return result;
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/** 自动创建两个数据库（需要用户提供有权限的父页面 ID） */
export async function createDatabases(config: NotionConfig, parentPageId: string): Promise<{ videosId: string; nodesId: string }> {
  const videos = await notionRequest<{ id: string }>(config, '/databases', {
    method: 'POST',
    body: {
      parent: { type: 'page_id', page_id: parentPageId },
      title: [{ type: 'text', text: { content: '视频记忆 · Videos' } }],
      properties: {
        标题: { title: {} },
        视频ID: { rich_text: {} },
        平台: { rich_text: {} },
        来源URL: { url: {} },
        记录范围: { rich_text: {} },
        最近同步: { date: {} },
        // 节点关系在 Memory Nodes 创建后补齐（创建时不能指向尚不存在的数据库）
      },
    },
  });

  const nodes = await notionRequest<{ id: string }>(config, '/databases', {
    method: 'POST',
    body: {
      parent: { type: 'page_id', page_id: parentPageId },
      title: [{ type: 'text', text: { content: '视频记忆 · Memory Nodes' } }],
      properties: {
        标题: { title: {} },
        节点ID: { rich_text: {} },
        视频ID: { rich_text: {} },
        起止时间: { rich_text: {} },
        摘要: { rich_text: {} },
        标签: { multi_select: {} },
        来源链接: { url: {} },
        用户笔记: { rich_text: {} },
        修订号: { number: {} },
        所属视频: { relation: { database_id: videos.id } },
      },
    },
  });

  // 补齐 Videos 数据库的节点关联
  await notionRequest(config, `/databases/${videos.id}`, {
    method: 'PATCH',
    body: { properties: { 节点: { relation: { database_id: nodes.id } } } },
  });

  return { videosId: videos.id, nodesId: nodes.id };
}

function richText(content: string) {
  return { rich_text: [{ type: 'text', text: { content: content.slice(0, 1900) } }] };
}

async function findSync(config: NotionConfig, entityType: 'video' | 'node', localId: string): Promise<SyncState | null> {
  return (await getDb().syncState.get(`notion:${entityType}:${localId}`)) ?? null;
}

async function saveSync(state: SyncState): Promise<void> {
  await getDb().syncState.put(state);
}

async function queryPageByProperty(
  config: NotionConfig,
  databaseId: string,
  property: string,
  value: string,
): Promise<string | null> {
  const result = await notionRequest<{ results: Array<{ id: string }> }>(config, `/databases/${databaseId}/query`, {
    method: 'POST',
    body: {
      filter: { property, rich_text: { equals: value } },
      page_size: 1,
    },
  });
  return result.results[0]?.id ?? null;
}

/** 同步单个视频（幂等） */
export async function syncVideo(video: Video): Promise<{ pageId: string; created: boolean }> {
  const settings = await getSettings();
  const config = settings.notion;
  if (!config?.enabled || !config.videosDatabaseId || !config.token) {
    throw new NotionError('not_configured', 'Notion 同步未配置');
  }
  const existingSync = await findSync(config, 'video', video.id);
  const pageId =
    existingSync?.remotePageId ??
    (await queryPageByProperty(config, config.videosDatabaseId, '视频ID', video.id));
  const properties: Record<string, unknown> = {
    标题: { title: [{ type: 'text', text: { content: video.title.slice(0, 200) } }] },
    视频ID: richText(video.id),
    平台: richText(video.platform),
    来源URL: { url: video.url },
    记录范围: richText(video.recordedRanges.map(([a, b]) => `${Math.floor(a)}–${Math.floor(b)}s`).join(', ')),
    最近同步: { date: { start: new Date().toISOString() } },
  };

  let created = false;
  let finalPageId = pageId;
  if (pageId) {
    await notionRequest(config, `/pages/${pageId}`, { method: 'PATCH', body: { properties } });
  } else {
    const page = await notionRequest<{ id: string }>(config, '/pages', {
      method: 'POST',
      body: { parent: { database_id: config.videosDatabaseId }, properties },
    });
    finalPageId = page.id;
    created = true;
  }

  await saveSync({
    id: `notion:video:${video.id}`,
    entityType: 'video',
    localId: video.id,
    remotePageId: finalPageId!,
    remoteDatabaseId: config.videosDatabaseId,
    syncedRevision: video.sessionCount,
    lastSyncedAt: Date.now(),
  });
  return { pageId: finalPageId!, created };
}

/** 同步单个节点（幂等，AI 内容与用户笔记分属性存放） */
export async function syncNode(node: MemoryNode, video: Video): Promise<{ pageId: string; created: boolean }> {
  const settings = await getSettings();
  const config = settings.notion;
  if (!config?.enabled || !config.nodesDatabaseId || !config.token) {
    throw new NotionError('not_configured', 'Notion 同步未配置');
  }
  const existingSync = await findSync(config, 'node', node.id);
  const pageId =
    existingSync?.remotePageId ?? (await queryPageByProperty(config, config.nodesDatabaseId, '节点ID', node.id));
  const videoSync = await findSync(config, 'video', video.id);
  const timeLabel = `${formatClock(node.startTime)}–${formatClock(node.endTime)}`;
  const sourceUrl = `${video.url}#t=${Math.floor(node.startTime)}`;

  const properties: Record<string, unknown> = {
    标题: { title: [{ type: 'text', text: { content: node.title.slice(0, 200) } }] },
    节点ID: richText(node.id),
    视频ID: richText(video.id),
    起止时间: richText(timeLabel),
    摘要: richText(node.summary ?? ''),
    标签: { multi_select: node.tags.slice(0, 10).map((tag) => ({ name: tag.slice(0, 90) })) },
    来源链接: { url: sourceUrl },
    用户笔记: richText(node.userNote ?? ''),
    修订号: { number: node.revision },
  };
  if (videoSync?.remotePageId) {
    properties['所属视频'] = { relation: [{ id: videoSync.remotePageId }] };
  }

  let created = false;
  let finalPageId = pageId;
  if (pageId) {
    await notionRequest(config, `/pages/${pageId}`, { method: 'PATCH', body: { properties } });
  } else {
    const page = await notionRequest<{ id: string }>(config, '/pages', {
      method: 'POST',
      body: {
        parent: { database_id: config.nodesDatabaseId },
        properties,
        children: [
          {
            object: 'block',
            type: 'heading_3',
            heading_3: { rich_text: [{ type: 'text', text: { content: 'AI 生成摘要' } }] },
          },
          {
            object: 'block',
            type: 'paragraph',
            paragraph: { rich_text: [{ type: 'text', text: { content: (node.summary ?? '（待整理）').slice(0, 1900) } }] },
          },
          {
            object: 'block',
            type: 'heading_3',
            heading_3: { rich_text: [{ type: 'text', text: { content: '用户笔记' } }] },
          },
          {
            object: 'block',
            type: 'paragraph',
            paragraph: { rich_text: [{ type: 'text', text: { content: '（可在此区域自由编辑，插件不会覆盖页面正文。）' } }] },
          },
        ],
      },
    });
    finalPageId = page.id;
    created = true;
  }

  await saveSync({
    id: `notion:node:${node.id}`,
    entityType: 'node',
    localId: node.id,
    remotePageId: finalPageId!,
    remoteDatabaseId: config.nodesDatabaseId,
    syncedRevision: node.revision,
    lastSyncedAt: Date.now(),
  });
  return { pageId: finalPageId!, created };
}

/** 执行一次同步（按视频或全部），失败写入 Job 并可重试 */
export async function runNotionSync(options: { videoId?: string } = {}): Promise<{
  videos: number;
  nodes: number;
  failed: number;
  errors: string[];
}> {
  const settings = await getSettings();
  const config = settings.notion;
  if (!config?.enabled) throw new NotionError('not_configured', 'Notion 同步未启用');
  const db = getDb();
  const videos = options.videoId
    ? [await db.videos.get(options.videoId)].filter((v): v is Video => Boolean(v))
    : await db.videos.toArray();
  let videoCount = 0;
  let nodeCount = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const video of videos) {
    try {
      await syncVideo(video);
      videoCount += 1;
    } catch (error) {
      failed += 1;
      errors.push(`视频《${video.title}》：${(error as Error).message}`);
      if ((error as NotionError).code === 'unauthorized') break;
      continue;
    }
    const nodes = await db.nodes.where('videoId').equals(video.id).toArray();
    for (const node of nodes) {
      const sync = await findSync(config, 'node', node.id);
      if (sync && sync.syncedRevision >= node.revision) continue;
      try {
        await syncNode(node, video);
        nodeCount += 1;
      } catch (error) {
        failed += 1;
        errors.push(`节点《${node.title}》：${(error as Error).message}`);
        if ((error as NotionError).code === 'unauthorized') break;
      }
      await delay(380); // 官方限制约 3 次/秒
    }
  }

  await saveSettings({ notion: { ...config, lastSyncAt: Date.now() } });
  return { videos: videoCount, nodes: nodeCount, failed, errors };
}

/** 排队的同步任务（供后台 alarm 处理） */
export async function enqueueSync(videoId?: string): Promise<Job> {
  const job: Job = {
    id: uid('job'),
    type: 'sync-notion',
    inputRevision: Date.now(),
    status: 'queued',
    attempts: 0,
    payload: videoId ? { videoId } : {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await getDb().jobs.put(job);
  return job;
}

export async function processSyncJobs(): Promise<void> {
  const db = getDb();
  const jobs = await db.jobs.where('status').equals('queued').and((job) => job.type === 'sync-notion').toArray();
  for (const job of jobs) {
    await db.jobs.update(job.id, { status: 'running', updatedAt: Date.now() });
    try {
      const videoId = typeof job.payload.videoId === 'string' ? job.payload.videoId : undefined;
      await runNotionSync({ videoId });
      await db.jobs.update(job.id, { status: 'done', updatedAt: Date.now() });
    } catch (error) {
      const attempts = job.attempts + 1;
      const retryable = error instanceof NotionError ? error.retryable : true;
      await db.jobs.update(job.id, {
        status: retryable && attempts < 5 ? 'queued' : 'failed',
        attempts,
        lastError: (error as Error).message,
        nextRetryAt: retryable ? Date.now() + Math.min(600_000, 30_000 * 2 ** attempts) : undefined,
        updatedAt: Date.now(),
      });
    }
  }
}

export async function notionStatus(): Promise<{
  configured: boolean;
  enabled: boolean;
  pending: number;
  lastSyncAt?: number;
  error?: string;
}> {
  const settings = await getSettings();
  const db = getDb();
  const pending = await db.jobs.where('status').equals('queued').and((job) => job.type === 'sync-notion').count();
  const failed = await db.jobs.where('status').equals('failed').and((job) => job.type === 'sync-notion').toArray();
  return {
    configured: Boolean(settings.notion?.token && settings.notion.videosDatabaseId && settings.notion.nodesDatabaseId),
    enabled: Boolean(settings.notion?.enabled),
    pending,
    lastSyncAt: settings.notion?.lastSyncAt,
    error: failed[0]?.lastError,
  };
}

export async function saveNotionConfig(patch: Partial<Settings['notion']> & { parentPageId?: string }): Promise<NotionConfig> {
  const settings = await getSettings();
  const merged: NotionConfig = { ...(settings.notion ?? { enabled: false }), ...patch };
  await saveSettings({ notion: merged });
  return merged;
}

function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { NotionConfigState };
