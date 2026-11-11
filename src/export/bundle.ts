/**
 * 数据导出与导入。
 *
 * 导出不包含密钥；导入必须校验版本、大小、引用与内容格式。
 */

import { getDb, getSettings } from '@/db/db';
import type { ExportBundle, Keyframe, Video } from '@/shared/types';
import { dataUrlToBlob, blobToDataUrl } from '@/shared/blob';

const MAX_IMPORT_BYTES = 120 * 1024 * 1024;

export async function exportBundle(options: { videoId?: string } = {}): Promise<ExportBundle> {
  const db = getDb();
  const settings = await getSettings();
  const videos = options.videoId
    ? [await db.videos.get(options.videoId)].filter((v): v is Video => Boolean(v))
    : await db.videos.toArray();
  const videoIds = new Set(videos.map((v) => v.id));

  const [sessions, evidence, nodes, keyframes] = await Promise.all([
    db.sessions.toArray(),
    db.evidence.toArray(),
    db.nodes.toArray(),
    db.keyframes.toArray(),
  ]);

  const filteredSessions = sessions.filter((s) => videoIds.has(s.videoId));
  const filteredEvidence = evidence.filter((e) => videoIds.has(e.videoId));
  const filteredNodes = nodes.filter((n) => videoIds.has(n.videoId));
  const filteredKeyframes = keyframes.filter((k) => videoIds.has(k.videoId));

  const keyframeExports = [];
  for (const keyframe of filteredKeyframes) {
    const { image, ...rest } = keyframe;
    keyframeExports.push({ ...rest, imageDataUrl: await blobToDataUrl(image) });
  }

  return {
    format: 'vma-export',
    version: 1,
    exportedAt: Date.now(),
    videos,
    sessions: filteredSessions,
    evidence: filteredEvidence,
    nodes: filteredNodes,
    longMemories: (await db.longMemories.toArray()).filter(memory => videoIds.has(memory.videoId)),
    keyframes: keyframeExports,
    // 不导出任何密钥或 token
    settings: {
      profile: settings.profile,
      resourceTier: settings.resourceTier,
      uiLanguage: settings.uiLanguage,
      answerLanguage: settings.answerLanguage,
      answerStyle: settings.answerStyle,
      retrieval: settings.retrieval,
      capture: settings.capture,
      ocr: settings.ocr,
      budget: settings.budget,
      privacy: settings.privacy,
    },
  };
}

export function serializeExport(bundle: ExportBundle): string {
  return JSON.stringify(bundle);
}

export interface ImportValidation {
  ok: boolean;
  error?: string;
  warnings: string[];
  bundle?: ExportBundle;
}

export function validateImport(raw: string): ImportValidation {
  const warnings: string[] = [];
  if (raw.length > MAX_IMPORT_BYTES) {
    return { ok: false, error: `文件过大（>${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)}MB）`, warnings };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: '不是合法的 JSON 文件', warnings };
  }
  const bundle = parsed as Partial<ExportBundle>;
  if (bundle?.format !== 'vma-export') return { ok: false, error: '不是本扩展导出的数据文件', warnings };
  if (bundle.version !== 1) return { ok: false, error: `不支持的导出版本：${String(bundle.version)}`, warnings };
  if (!Array.isArray(bundle.videos) || !Array.isArray(bundle.nodes) || !Array.isArray(bundle.evidence)) {
    return { ok: false, error: '导出文件缺少必要数据表', warnings };
  }
  const videoIds = new Set(bundle.videos.map((v) => v?.id).filter(Boolean));
  for (const node of bundle.nodes) {
    if (!node?.id || !node.videoId) return { ok: false, error: '节点数据格式错误', warnings };
    if (!videoIds.has(node.videoId)) {
      return { ok: false, error: `节点 ${node.id} 引用了不存在的视频，导入已中止`, warnings };
    }
  }
  for (const evidence of bundle.evidence) {
    if (!evidence?.id || !evidence.videoId || typeof evidence.text !== 'string') {
      return { ok: false, error: '证据数据格式错误', warnings };
    }
    if (!videoIds.has(evidence.videoId)) warnings.push(`证据 ${evidence.id} 引用了不存在的视频，已跳过`);
  }
  for (const keyframe of bundle.keyframes ?? []) {
    if (!keyframe?.imageDataUrl?.startsWith('data:image/')) {
      return { ok: false, error: '关键帧图片数据无效', warnings };
    }
    if (keyframe.imageDataUrl.length > 8 * 1024 * 1024) {
      return { ok: false, error: '单张关键帧过大（>8MB）', warnings };
    }
  }
  const evidenceVideo = new Map(bundle.evidence.map(row => [row.id, row.videoId]));
  if (bundle.longMemories !== undefined && (!Array.isArray(bundle.longMemories) || bundle.longMemories.some(memory => !videoIds.has(memory.videoId) || typeof memory.body !== 'string' || !Array.isArray(memory.sources) || memory.sources.some(source => source.videoId !== memory.videoId || evidenceVideo.get(source.evidenceId) !== memory.videoId)))) {
    return { ok: false, error: '长期记忆来源必须属于其独立视频', warnings };
  }
  return { ok: true, warnings, bundle: bundle as ExportBundle };
}

export async function importBundle(bundle: ExportBundle): Promise<{ videos: number; nodes: number; evidence: number; keyframes: number }> {
  const db = getDb();
  const videoIds = new Set(bundle.videos.map((v) => v.id));
  const existingVideos = await db.videos.bulkGet([...videoIds]);
  const existingIds = new Set(existingVideos.filter(Boolean).map((v) => v!.id));

  const videos = bundle.videos.filter((v) => !existingIds.has(v.id));
  const sessions = (bundle.sessions ?? []).filter((s) => videoIds.has(s.videoId));
  const evidence = (bundle.evidence ?? []).filter((e) => videoIds.has(e.videoId));
  const nodes = (bundle.nodes ?? []).filter((n) => videoIds.has(n.videoId));
  const keyframes: Keyframe[] = [];
  for (const keyframe of bundle.keyframes ?? []) {
    if (!keyframe.imageDataUrl) continue;
    const { imageDataUrl, ...rest } = keyframe;
    const image = await dataUrlToBlob(imageDataUrl);
    keyframes.push({ ...rest, image });
  }

  await db.transaction('rw', [db.videos, db.sessions, db.evidence, db.nodes, db.keyframes, db.longMemories], async () => {
    for (const memory of bundle.longMemories ?? []) {
      if (!(await db.longMemories.get(memory.videoId))) await db.longMemories.put({ ...memory, versions: memory.versions ?? [], revision: memory.revision || 1 });
    }
    if (videos.length > 0) await db.videos.bulkPut(videos);
    if (sessions.length > 0) await db.sessions.bulkPut(sessions);
    if (nodes.length > 0) await db.nodes.bulkPut(nodes);
    if (evidence.length > 0) await db.evidence.bulkPut(evidence);
    if (keyframes.length > 0) await db.keyframes.bulkPut(keyframes);
  });

  return { videos: videos.length, nodes: nodes.length, evidence: evidence.length, keyframes: keyframes.length };
}

/** 从任意对象中剥离密钥，确保日志与导出安全 */
export function redactSecrets<T extends Record<string, unknown>>(value: T): T {
  const clone: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/key|token|secret|authorization/i.test(key)) {
      clone[key] = item ? '***' : item;
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      clone[key] = redactSecrets(item as Record<string, unknown>);
    } else {
      clone[key] = item;
    }
  }
  return clone as T;
}
