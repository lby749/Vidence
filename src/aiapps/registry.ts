/**
 * AI 应用连接器：能力声明与站点配置。
 *
 * 重要：能力表按"实际验证过"填写，未验证的能力一律标为 unknown/unverified，
 * 不用一个笼统的"已连接"掩盖缺失。
 */

export interface ConnectorProfile {
  id: string;
  label: string;
  /** 打开应用时使用的 URL */
  url: string;
  hostPatterns: string[];
  selectors: {
    input: string[];
    send: string[];
    assistant: string[];
    stop?: string[];
    newChat?: string[];
  };
  capabilities: ConnectorCapabilities;
  /** 是否在真实站点上验证过（本仓库默认 false，需用户实测后确认） */
  verified: boolean;
  notes: string;
}

export interface ConnectorCapabilities {
  createConversation: boolean;
  autoSend: boolean;
  attachText: boolean;
  attachImages: boolean;
  connectTools: boolean;
  receiveAnswer: boolean;
  streamAnswer: boolean;
  cancel: boolean;
  requiresConfirmation: boolean;
  needsLocalBridge: boolean;
  needsRemoteService: boolean;
}

export type ConnectorStatus =
  | 'full'
  | 'send-only'
  | 'tools-only'
  | 'snippets-only'
  | 'manual-handoff'
  | 'unverified'
  | 'unavailable';

export interface ConnectorRuntime {
  profile: ConnectorProfile;
  status: ConnectorStatus;
  statusLabel: string;
  reasons: string[];
}

export const CONNECTORS: ConnectorProfile[] = [
  {
    id: 'chatgpt',
    label: 'ChatGPT 网页版',
    url: 'https://chatgpt.com/',
    hostPatterns: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
    selectors: {
      input: ['#prompt-textarea', 'div[contenteditable="true"]', 'textarea[data-id="root"]'],
      send: ['button[data-testid="send-button"]', 'button[aria-label*="发送"]', 'button[aria-label*="Send"]'],
      assistant: ['article[data-testid^="conversation-turn"] .markdown', '[data-message-author-role="assistant"] .markdown'],
      stop: ['button[data-testid="stop-button"]'],
      newChat: ['a[href="/"]', 'button[data-testid="new-chat-button"]'],
    },
    capabilities: {
      createConversation: true,
      autoSend: true,
      attachText: true,
      attachImages: false,
      connectTools: false,
      receiveAnswer: true,
      streamAnswer: false,
      cancel: false,
      requiresConfirmation: true,
      needsLocalBridge: false,
      needsRemoteService: false,
    },
    verified: false,
    notes:
      '通过正常可见界面填写并发送问题；回答读取依赖页面结构，站点改版后可能失效。未在真实登录账号下验证，界面标记为未验证。',
  },
  {
    id: 'claude',
    label: 'Claude 网页版',
    url: 'https://claude.ai/new',
    hostPatterns: ['https://claude.ai/*'],
    selectors: {
      input: ['div[contenteditable="true"][data-placeholder]', 'div[contenteditable="true"]', 'textarea'],
      send: ['button[aria-label*="Send"]', 'button[aria-label*="发送"]'],
      assistant: ['.font-claude-message', '[data-testid="assistant-message"]', '.prose'],
      stop: ['button[aria-label*="Stop"]'],
      newChat: ['a[href="/new"]'],
    },
    capabilities: {
      createConversation: true,
      autoSend: true,
      attachText: true,
      attachImages: false,
      connectTools: false,
      receiveAnswer: true,
      streamAnswer: false,
      cancel: false,
      requiresConfirmation: true,
      needsLocalBridge: false,
      needsRemoteService: false,
    },
    verified: false,
    notes: '网页辅助路线，未在真实账号下验证。需用户保持登录，页面结构变化会失效。',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek 网页版',
    url: 'https://chat.deepseek.com/',
    hostPatterns: ['https://chat.deepseek.com/*'],
    selectors: {
      input: ['textarea#chat-input', 'textarea', 'div[contenteditable="true"]'],
      send: ['div[role="button"][aria-disabled="false"]', 'button[aria-label*="发送"]'],
      assistant: ['.ds-markdown', '.markdown-body'],
      stop: ['div[role="button"][aria-label*="停止"]'],
    },
    capabilities: {
      createConversation: true,
      autoSend: true,
      attachText: true,
      attachImages: false,
      connectTools: false,
      receiveAnswer: true,
      streamAnswer: false,
      cancel: false,
      requiresConfirmation: true,
      needsLocalBridge: false,
      needsRemoteService: false,
    },
    verified: false,
    notes: '网页辅助路线，未在真实账号下验证。',
  },
  {
    id: 'kimi',
    label: 'Kimi 网页版',
    url: 'https://kimi.moonshot.cn/',
    hostPatterns: ['https://kimi.moonshot.cn/*'],
    selectors: {
      input: ['div[contenteditable="true"]', 'textarea'],
      send: ['button[class*="send"]', 'div[class*="send-button"]'],
      assistant: ['.markdown', '[class*="segment-content"]'],
    },
    capabilities: {
      createConversation: true,
      autoSend: true,
      attachText: true,
      attachImages: false,
      connectTools: false,
      receiveAnswer: true,
      streamAnswer: false,
      cancel: false,
      requiresConfirmation: true,
      needsLocalBridge: false,
      needsRemoteService: false,
    },
    verified: false,
    notes: '网页辅助路线，未在真实账号下验证。',
  },
  {
    id: 'gemini',
    label: 'Gemini 网页版',
    url: 'https://gemini.google.com/app',
    hostPatterns: ['https://gemini.google.com/*'],
    selectors: {
      input: ['rich-textarea div[contenteditable="true"]', 'div[contenteditable="true"]'],
      send: ['button[aria-label*="Send message"]', 'button[aria-label*="发送"]'],
      assistant: ['message-content', '.model-response-text', '.markdown'],
    },
    capabilities: {
      createConversation: true,
      autoSend: true,
      attachText: true,
      attachImages: false,
      connectTools: false,
      receiveAnswer: true,
      streamAnswer: false,
      cancel: false,
      requiresConfirmation: true,
      needsLocalBridge: false,
      needsRemoteService: false,
    },
    verified: false,
    notes: '网页辅助路线，未在真实账号下验证。',
  },
  {
    id: 'manual-handoff',
    label: '手动交接（通用回退）',
    url: 'about:blank',
    hostPatterns: [],
    selectors: { input: [], send: [], assistant: [] },
    capabilities: {
      createConversation: false,
      autoSend: false,
      attachText: false,
      attachImages: false,
      connectTools: false,
      receiveAnswer: false,
      streamAnswer: false,
      cancel: false,
      requiresConfirmation: false,
      needsLocalBridge: false,
      needsRemoteService: false,
    },
    verified: true,
    notes: '生成可复制的提问交接内容，明确标记为人工交接，不计入自动连接器。',
  },
];

export function getConnector(id: string): ConnectorProfile | null {
  return CONNECTORS.find((connector) => connector.id === id) ?? null;
}

export function statusLabel(status: ConnectorStatus): string {
  switch (status) {
    case 'full':
      return '完整问答（发送 + 回答回流）';
    case 'send-only':
      return '可发送，答案在原应用查看';
    case 'tools-only':
      return '支持自主查库（MCP），不能主动发问';
    case 'snippets-only':
      return '仅提供检索片段';
    case 'manual-handoff':
      return '手动交接';
    case 'unverified':
      return '未验证';
    case 'unavailable':
      return '暂不可用';
  }
}

export function runtimeFor(profile: ConnectorProfile, available: boolean): ConnectorRuntime {
  const reasons: string[] = [];
  let status: ConnectorStatus = 'unverified';
  if (profile.id === 'manual-handoff') status = 'manual-handoff';
  else if (!available) {
    status = 'unavailable';
    reasons.push('当前浏览器环境未就绪');
  } else if (!profile.verified) {
    status = 'unverified';
    reasons.push('尚未在真实登录会话中验证选择器');
    if (profile.capabilities.receiveAnswer) reasons.push('回答读取依赖页面结构，可能失效');
  } else if (profile.capabilities.receiveAnswer && profile.capabilities.autoSend) {
    status = 'full';
  } else if (profile.capabilities.autoSend) {
    status = 'send-only';
  } else {
    status = 'manual-handoff';
  }
  return { profile, status, statusLabel: statusLabel(status), reasons };
}
