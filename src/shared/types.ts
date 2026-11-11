/**
 * 核心实体类型。
 *
 * 设计原则：
 * 1. 本地证据库是事实源；全文索引与向量索引是可重建的派生数据。
 * 2. AI 生成内容与人工笔记分开存储，重新整理不覆盖用户笔记。
 * 3. 所有异步采集结果携带 videoId / sessionId / captureEpoch，换视频或 seek 后旧代次结果必须被丢弃。
 */

export type SourceType = 'texttrack' | 'dom' | 'ocr' | 'manual' | 'visual';

/** 问答路线：使用已登录 AI 应用，或使用用户自填 API。 */
export type QaRoute = 'api' | 'ai-app' | 'local-agent';

export type NodeStatus = 'draft' | 'organized' | 'review' | 'failed';

export interface Video {
  /** 稳定视频 ID：platform:platformVideoId 的哈希或平台原生 ID 组合 */
  id: string;
  /** 原始 URL */
  url: string;
  /** 规范化来源（去 tracking 参数后的 URL） */
  canonicalUrl: string;
  platform: string;
  title: string;
  customTitle?: boolean;
  /** 分集 / 分 P 标识（如 bilibili p、youtube list index） */
  episodeId?: string;
  duration: number;
  lastPosition: number;
  /** 实际记录区间（并集），[[start,end], ...] */
  recordedRanges: [number, number][];
  createdAt: number;
  updatedAt: number;
  /** 记录过的会话数量 */
  sessionCount: number;
}

export interface Session {
  id: string;
  videoId: string;
  startedAt: number;
  endedAt?: number;
  /** increasing; 每次开始新记录或换视频时递增 */
  captureEpoch: number;
  status: 'recording' | 'paused' | 'stopped';
  subtitleSource: SubtitleSourceState;
  /** 已观察到字幕的区间 */
  observedRanges: [number, number][];
  /** 缺口（未采集区间） */
  gaps: [number, number][];
  tabId?: number;
  frameId?: number;
  note?: string;
}

export interface SubtitleSourceState {
  kind: 'none' | 'texttrack' | 'dom' | 'ocr' | 'manual-roi';
  label: string;
  /** OCR ROI 以视频显示区域为基准的归一化坐标 0..1 */
  roi?: NormRect;
  /** 自动定位的置信度 */
  roiConfidence?: number;
  detectedAt?: number;
  lastTextAt?: number;
}

export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Evidence {
  id: string;
  videoId: string;
  sessionId: string;
  startTime: number;
  endTime: number;
  /** 原始识别文本；OCR 结果不自动等于准确原话 */
  text: string;
  source: SourceType;
  confidence?: number;
  /** 来源附加信息：texttrack 语言、DOM 选择器、OCR 模型版本 */
  provenance?: string;
  keyframeId?: string;
  nodeId?: string;
  capturedAt: number;
  captureEpoch: number;
  /** 人工纠错文本；不覆盖原文 */
  correctedText?: string;
}

export interface Keyframe {
  id: string;
  videoId: string;
  sessionId: string;
  time: number;
  /** 图片 Blob；仅本地保存 */
  image: Blob;
  width: number;
  height: number;
  /** 保存原因：auto-change / user / subtitle-roi */
  reason: 'auto-change' | 'user' | 'subtitle-roi';
  selectionReason?: string;
  knowledge?: {
    kind: 'knowledge' | 'speaker' | 'outro' | 'intro' | 'uncertain';
    title: string;
    summary: string;
    visibleText: string;
    confidence: number;
    modelId: string;
    reviewedAt: number;
  };
  /** 去重指纹 */
  fingerprint: string;
  /** 内容区 OCR 文本（可空） */
  ocrText?: string;
  ocrBoxes?: Array<{ text: string; confidence: number; rect: NormRect }>;
  nodeId?: string;
  evidenceIds: string[];
  /** 是否允许上传到云端视觉服务（默认 false） */
  uploadAllowed: boolean;
  uploadedAt?: number;
  capturedAt: number;
  captureEpoch: number;
}

export interface MemoryNode {
  id: string;
  videoId: string;
  sessionId: string;
  title: string;
  startTime: number;
  endTime: number;
  evidenceIds: string[];
  keyframeIds: string[];
  /** AI 生成的摘要 */
  summary?: string;
  tags: string[];
  relatedNodeIds: string[];
  /** 生成该摘要的模型与版本 */
  generatedBy?: { modelId: string; providerId: string; promptVersion: string };
  /** 用户笔记，永不被 AI 覆盖 */
  userNote?: string;
  /** 用户手动修订过的标题等 */
  userEdited?: { title?: string; summary?: string; updatedAt?: number };
  status: NodeStatus;
  /** 关键词索引文本（原文拼接，便于关键词召回；派生字段） */
  searchText?: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
}

export interface IndexMetadata {
  id: string;
  /** 索引类型：keyword / vector */
  kind: 'keyword' | 'vector';
  version: number;
  modelId?: string;
  modelFiles?: Array<{ name: string; sha256?: string }>;
  dimension?: number;
  quantized?: boolean;
  pooling?: string;
  normalized?: boolean;
  chunkVersion: string;
  /** 已索引证据范围对应的最大 revision */
  indexedUpToRevision: number;
  updatedAt: number;
}

/** 向量记录；按模型分表空间，换模型必须重建 */
export interface VectorRecord {
  id: string;
  videoId: string;
  nodeId?: string;
  evidenceId?: string;
  modelId: string;
  dim: number;
  vector: Float32Array;
  text: string;
  indexedAt: number;
}

export type JobType =
  | 'organize-node'
  | 'embed-node'
  | 'ocr-keyframe'
  | 'sync-notion'
  | 'answer-request';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'canceled';

export interface Job {
  id: string;
  type: JobType;
  /** 输入修订号，用于幂等 */
  inputRevision: number;
  status: JobStatus;
  attempts: number;
  nextRetryAt?: number;
  lastError?: string;
  payload: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface SyncState {
  id: string;
  /** local 实体 -> remote 映射 */
  entityType: 'video' | 'node';
  localId: string;
  remotePageId?: string;
  remoteDatabaseId?: string;
  syncedRevision: number;
  lastSyncedAt?: number;
  error?: string;
}

export interface Settings {
  id: 'app';
  uiLanguage?: 'auto' | 'zh-CN' | 'zh-TW' | 'en';
  answerLanguage?: 'zh-CN' | 'zh-TW' | 'en' | 'es' | 'ja' | 'ko' | 'fr' | 'de' | 'pt' | 'ru' | 'ar' | 'auto';
  answerStyle?: 'balanced' | 'concise' | 'patient' | 'exam' | 'deep' | 'casual';
  resourceTier?: import('./resource-tiers').ResourceTier;
  /** 运行配置 */
  profile: 'standard' | 'low-resource' | 'no-ai';
  providers: ProviderConfig[];
  preferredQaRoute?: 'api' | 'local-agent';
  localAgent?: { backend: 'opencode-go' | 'dsh' | 'codex' | 'claude'; token: string; model?: string };
  roles: {
    organizeModel?: ModelRole;
    answerModel?: ModelRole;
    visionModel?: ModelRole;
    embedding?: ModelRole;
  };
  capture: {
    /** 是否允许在开始记录时尝试标签页捕获 */
    allowTabCapture: boolean;
    /** 关键帧保存预算（每视频） */
    keyframeBudget: number;
    /** 关键帧最小间隔毫秒 */
    keyframeCooldownMs: number;
    keyframePolicyVersion?: number;
    /** 单张关键帧最大宽度 */
    maxFrameWidth: number;
    keyframeQualityVersion?: number;
  };
  ocr: {
    enabled: boolean;
    /** auto: 无可用字幕源时启用；off: 关闭 */
    mode: 'auto' | 'off';
    engine: 'paddle' | 'none';
    maxPerMinute: number;
  };
  retrieval: {
    keyword: boolean;
    vector: boolean;
    rerank: boolean;
    vectorModel: string;
  };
  budget: {
    organizeMaxCallsPerHour: number;
    answerMaxToolRounds: number;
    maxImageUploadsPerRequest: number;
    dailyTokenBudget?: number;
    perRequestTokenBudget?: number;
  };
  privacy: {
    allowCloudOcr: boolean;
    allowVisionUpload: boolean;
    allowNotionSync: boolean;
    /** 关键帧上传需要显式授权 */
    autoVisionOrganize: boolean;
  };
  notion?: NotionConfig;
  experiment: {
    /** 是否启用 AI 应用网页连接器 */
    aiAppConnectors: boolean;
  };
  updatedAt: number;
}

export interface ProviderConfig {
  id: string;
  label: string;
  /** openai-compatible / anthropic / custom */
  kind: 'openai' | 'openai-compatible' | 'anthropic';
  baseUrl?: string;
  /** 仅保存于本地扩展存储；不写入导出 */
  apiKey?: string;
  models?: Array<{ id: string; label: string }>;
  /** 已核验的能力，未核验为 undefined */
  capabilities?: ProviderCapabilities;
}

export interface ProviderCapabilities {
  text: boolean;
  stream: boolean;
  structured: boolean;
  tools: boolean;
  vision: boolean;
  usage: boolean;
  browserDirect: boolean;
  verifiedAt?: number;
}

export interface ModelRole {
  providerId: string;
  modelId: string;
  temperature?: number;
  maxTokens?: number;
}

export interface NotionConfig {
  token?: string;
  videosDatabaseId?: string;
  nodesDatabaseId?: string;
  enabled: boolean;
  lastSyncAt?: number;
}

/* ----------------------------- 问答 ----------------------------- */

export interface QueryContext {
  requestId: string;
  videoId: string;
  /** 发送时冻结的媒体时间 */
  frozenTime: number;
  selectedNodeIds: string[];
  /** 选中节点对应的严格范围 */
  scopes: Array<{ start: number; end: number; nodeId?: string }>;
  recordedRanges: [number, number][];
  /** 知识库修订号快照 */
  libraryRevision: number;
  question: string;
  previousRequestId?: string;
  previousTurns?: Array<{ question: string; answer: string }>;
  allowImages: boolean;
  /** 仅本次提问允许读取的画面，不改写图片长期设置。 */
  allowedFrameIds?: string[];
  route: 'api' | 'ai-app' | 'local-agent';
  createdAt: number;
}

export interface Citation {
  evidenceId: string;
  nodeId?: string;
  startTime: number;
  endTime: number;
  source: SourceType;
  quote?: string;
  keyframeId?: string;
}

export interface ChatTurn {
  id: string;
  requestId: string;
  videoId: string;
  sessionId?: string;
  question: string;
  context?: Pick<QueryContext, 'frozenTime' | 'selectedNodeIds' | 'previousTurns'>;
  memoryContext?: { videoId: string; revision: number; sourceCount: number };
  answer?: string;
  citations: Citation[];
  route: 'api' | 'ai-app' | 'local-agent';
  connectorId?: string;
  status: RequestStatus;
  error?: string;
  createdAt: number;
  completedAt?: number;
  usage?: UsageSnapshot;
  /** AI 应用模式下的会话标识 */
  conversationId?: string;
}

export type RequestStatus =
  | 'preparing'
  | 'awaiting-login'
  | 'awaiting-confirm'
  | 'sent'
  | 'generating'
  | 'completed'
  | 'canceled'
  | 'failed'
  | 'unknown-delivery';

export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  imageUploads: number;
  calls: number;
  toolRounds: number;
  costUsd?: number;
  tokenStatus?: 'reported' | 'unavailable';
  unknownTokenCalls?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface AiAppRequest {
  requestId: string;
  connectorId: string;
  conversationId?: string;
  videoId: string;
  questionTime: number;
  selectedNodeIds: string[];
  searchScope: string;
  libraryRevision: number;
  question: string;
  allowImages: boolean;
  maxToolRounds: number;
  contentBudget: number;
  status: RequestStatus;
  createdAt: number;
  updatedAt: number;
  error?: string;
  /** 本次随问题发送的证据包（供引用核验） */
  evidenceIds?: string[];
  /** 目标标签页与发送前的消息数基线 */
  tabId?: number;
  baselineCount?: number;
  /** 回流答案 */
  answerText?: string;
  citationIds?: string[];
  warnings?: string[];
  /** 待发送的完整提示词（确认后使用） */
  pendingPrompt?: string;
  /** 是否已经送达无法确认 */
  deliveryUnknown?: boolean;
}

/* ----------------------------- 用量 ----------------------------- */

export interface UsageRecord {
  id: string;
  at: number;
  providerId: string;
  modelId: string;
  role: 'organize' | 'answer' | 'vision' | 'embedding' | 'probe';
  inputTokens: number;
  outputTokens: number;
  images: number;
  toolRounds: number;
  /** 仅当用户配置了可核验单价时才写入 */
  costUsd?: number;
  tokenStatus?: 'reported' | 'unavailable';
  status?: 'completed' | 'failed' | 'canceled';
  inputChars?: number;
  outputChars?: number;
  durationMs?: number;
  calls?: number;
  unknownTokenCalls?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/* ----------------------------- 导出 ----------------------------- */

export interface LongTermMemory {
  videoId: string;
  body: string;
  sources: Array<Citation & { videoId: string }>;
  locked: boolean;
  revision: number;
  model: string;
  updatedAt: number;
  versions: Array<{ body: string; sources: LongTermMemory['sources']; updatedAt: number }>;
}

export interface ExportBundle {
  format: 'vma-export';
  version: 1;
  exportedAt: number;
  videos: Video[];
  sessions: Session[];
  evidence: Evidence[];
  nodes: MemoryNode[];
  longMemories?: LongTermMemory[];
  keyframes: Array<Omit<Keyframe, 'image'> & { imageDataUrl?: string }>;
  settings: Partial<Settings>;
  checksum?: string;
}
