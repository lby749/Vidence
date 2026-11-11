export const APP_NAME = '视频记忆助手';
export const DB_NAME = 'video-memory-assistant';
export const DB_VERSION = 2;

/** 字幕去重/合并参数 */
export const SUBTITLE = {
  /** 相邻证据合并的最大时间间隙（秒） */
  mergeGapSeconds: 1.6,
  /** 相同文本在多少秒内视为重复 */
  duplicateWindowSeconds: 25,
  /** 低置信 OCR 阈值 */
  lowConfidence: 0.6,
  /** 采样间隔（毫秒） */
  pollIntervalMs: 400,
} as const;

/** 规则节点切分参数 */
export const SEGMENT = {
  gapSeconds: 6,
  maxChars: 220,
  minChars: 12,
  maxDurationSeconds: 180,
} as const;

/** 关键帧链路默认值 */
export const VISUAL = {
  /** 与上一张已保存关键帧的累计差异阈值 */
  changeThreshold: 0.045,
  /** 稳定等待 */
  settleMs: 1200,
  maxSettleMs: 8000,
  /** 冷却 */
  cooldownMs: 4000,
  /** 默认每视频保存预算 */
  budget: 60,
  /** 采样缩略图宽度 */
  sampleWidth: 320,
  /** 小区域变化检测：分块网格 */
  gridCols: 48,
  gridRows: 27,
  /** 单块差异阈值 */
  cellDiffThreshold: 0.12,
} as const;

export const DEFAULT_SETTINGS = {
  uiLanguage: 'auto' as const,
  id: 'app' as const,
  profile: 'standard' as const,
  providers: [],
  roles: {},
  capture: {
    allowTabCapture: true,
    keyframeBudget: VISUAL.budget,
    keyframeCooldownMs: VISUAL.cooldownMs,
    keyframePolicyVersion: 2,
    maxFrameWidth: 3840,
    keyframeQualityVersion: 1,
  },
  ocr: {
    enabled: false,
    mode: 'auto' as const,
    engine: 'paddle' as const,
    maxPerMinute: 20,
  },
  retrieval: {
    // 用户选择占用档位后下载并启用本地模型；新用户先使用已有字幕和关键词。
    keyword: true,
    vector: false,
    rerank: false,
    vectorModel: 'Xenova/bge-small-zh-v1.5',
  },
  budget: {
    organizeMaxCallsPerHour: 30,
    answerMaxToolRounds: 4,
    maxImageUploadsPerRequest: 2,
  },
  privacy: {
    allowCloudOcr: false,
    allowVisionUpload: false,
    allowNotionSync: false,
    autoVisionOrganize: false,
  },
  experiment: {
    aiAppConnectors: true,
  },
};

export const MAX_EVIDENCE_TEXT = 4000;
export const MAX_TOOL_RESULT_CHARS = 12000;
export const MAX_TOOL_LIMIT = 50;
export const LIBRARY_PAGE_SIZE = 50;
