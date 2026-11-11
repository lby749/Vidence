/**
 * 脱敏诊断报告：只包含版本、计数、配置摘要与错误信息，不含密钥、字幕全文或图片。
 */

import { getDb, getSettings } from '@/db/db';
import { indexStatus } from './index-service';
import { ocrStatus } from './ocr-service';
import { rerankStatus } from './rerank-service';
import { embeddingStatus } from './embedding-service';
import { platform } from '@/shared/platform';
import modelManifest from '@/models/model-manifest.json';
import { usageToday } from '@/providers';

export interface DiagnosticsReport {
  generatedAt: string;
  extensionVersion: string;
  browser: { userAgent: string; platform: string; language: string };
  library: { videos: number; sessions: number; evidence: number; nodes: number; keyframes: number; vectors: number };
  index: ReturnType<typeof indexStatus>;
  ocr: Awaited<ReturnType<typeof ocrStatus>>;
  rerank: Awaited<ReturnType<typeof rerankStatus>>;
  embedding: ReturnType<typeof embeddingStatus>;
  models: Array<{ name: string; bytes: number; sha256: string }>;
  settings: {
    profile: string;
    providers: Array<{ id: string; kind: string; baseUrl?: string; hasKey: boolean; capabilities?: unknown }>;
    roles: unknown;
    retrieval: unknown;
    capture: unknown;
    budget: unknown;
    privacy: unknown;
    notionConfigured: boolean;
  };
  permissions: string[];
  usageToday: Awaited<ReturnType<typeof usageToday>>;
  limitations: string[];
}

export async function buildDiagnostics(): Promise<DiagnosticsReport> {
  const db = getDb();
  const settings = await getSettings();
  const [videos, sessions, evidence, nodes, keyframes, vectors] = await Promise.all([
    db.videos.count(),
    db.sessions.count(),
    db.evidence.count(),
    db.nodes.count(),
    db.keyframes.count(),
    db.vectors.count(),
  ]);
  const permissions = (await chrome.permissions.getAll().catch(() => ({ permissions: [], origins: [] }))) as {
    permissions?: string[];
    origins?: string[];
  };

  return {
    generatedAt: new Date().toISOString(),
    usageToday: await usageToday(),
    extensionVersion: chrome.runtime.getManifest().version,
    browser: { userAgent: navigator.userAgent, platform: platform(), language: navigator.language },
    library: { videos, sessions, evidence, nodes, keyframes, vectors },
    index: indexStatus(),
    ocr: await ocrStatus(),
    rerank: await rerankStatus(),
    embedding: embeddingStatus(),
    models: [
      ...Object.values(modelManifest.models).flat().map((item) => ({
        name: item.name,
        bytes: item.bytes,
        sha256: item.sha256,
      })),
      ...modelManifest.ocr.map((item) => ({ name: item.name, bytes: item.bytes, sha256: item.sha256 })),
    ],
    settings: {
      profile: settings.profile,
      providers: settings.providers.map((p) => ({
        id: p.id,
        kind: p.kind,
        baseUrl: p.baseUrl,
        hasKey: Boolean(p.apiKey),
        capabilities: p.capabilities,
      })),
      roles: settings.roles,
      retrieval: settings.retrieval,
      capture: settings.capture,
      budget: settings.budget,
      privacy: settings.privacy,
      notionConfigured: Boolean(settings.notion?.token),
    },
    permissions: [...(permissions.permissions ?? []), ...(permissions.origins ?? [])],
    limitations: [
      'WASM 运行时随包提供，OCR 模型由用户按功能下载，使用本地 CPU 推理。',
      '跨域或受保护视频无法通过 canvas 读取像素，扩展不会绕过安全策略。',
      'AI 应用网页连接器依赖站点公开界面结构，未在真实账号下验证的能力不会标记为已支持。',
      '向量与神经重排资源按功能下载；未下载或加载失败时保留关键词检索。',
    ],
  };
}
