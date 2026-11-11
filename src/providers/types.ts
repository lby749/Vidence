/**
 * 提供商适配层：与具体协议无关的请求/响应模型。
 *
 * 这里刻意不依赖某个 SDK 的内部类型：每个提供商的
 * 文本、流式、结构化、工具调用、图像、用量能力分别声明并用真实请求验证。
 */

export type NeutralMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: NeutralPart[] }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export type NeutralPart =
  | { type: 'text'; text: string }
  | { type: 'image'; dataUrl: string; mediaType?: string };

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ProviderRequest {
  model: string;
  messages: NeutralMessage[];
  tools?: ToolSpec[];
  toolChoice?: 'auto' | 'none';
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** 需要图像输入时由提供商支持检测决定 */
  allowImages?: boolean;
}

export type ProviderEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool-call'; call: ToolCall }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done'; finishReason: string }
  | { type: 'error'; code: string; message: string; status?: number; retryable?: boolean };

export interface ProviderAdapter {
  readonly id: string;
  readonly kind: 'openai' | 'openai-compatible' | 'anthropic';
  chat(request: ProviderRequest): AsyncGenerator<ProviderEvent, void, unknown>;
}

export interface ProviderErrorShape {
  code: string;
  message: string;
  status?: number;
  retryable?: boolean;
}

export class ProviderError extends Error {
  code: string;
  status?: number;
  retryable: boolean;
  constructor(shape: ProviderErrorShape) {
    super(shape.message);
    this.name = 'ProviderError';
    this.code = shape.code;
    this.status = shape.status;
    this.retryable = shape.retryable ?? false;
  }
}

/** 将 HTTP 状态映射为可操作的错误码；401/403 不能无限重试。 */
export function classifyHttpStatus(status: number): { code: string; retryable: boolean; message: string } {
  if (status === 401) return { code: 'unauthorized', retryable: false, message: 'API Key 无效或已过期（401）' };
  if (status === 403) return { code: 'forbidden', retryable: false, message: '无权访问该模型或接口（403）' };
  if (status === 404) return { code: 'not_found', retryable: false, message: '接口或模型不存在（404），请检查 Base URL 与模型名' };
  if (status === 413) return { code: 'too_large', retryable: false, message: '请求体过大（413）' };
  if (status === 429) return { code: 'rate_limited', retryable: true, message: '触发频率限制（429），请稍后重试' };
  if (status >= 500) return { code: 'server_error', retryable: true, message: `服务端错误（${status}）` };
  return { code: 'http_error', retryable: false, message: `请求失败（${status}）` };
}

/** 去掉末尾斜杠，便于拼接路径 */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
