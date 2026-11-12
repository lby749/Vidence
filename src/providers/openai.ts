/**
 * OpenAI 兼容协议适配器（OpenAI、DeepSeek、Moonshot、通义兼容模式、自建网关等）。
 *
 * 显式假设并逐项验证：
 * - /chat/completions 路径可配置；
 * - 流式增量、工具调用、用量字段；
 * - “OpenAI-compatible” 不保证工具调用与图像格式一致，能力由真实探测写入。
 */

import {
  ProviderError,
  classifyHttpStatus,
  joinUrl,
  type NeutralMessage,
  type ProviderAdapter,
  type ProviderEvent,
  type ProviderRequest,
} from './types';
import { parseSse, readErrorBody } from './sse';

export interface OpenAIAdapterOptions {
  id: string;
  kind?: 'openai' | 'openai-compatible';
  apiKey: string;
  baseUrl?: string;
  /** 额外请求头（如 OpenRouter 的 HTTP-Referer） */
  headers?: Record<string, string>;
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<Record<string, unknown>> | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export function toOpenAIMessages(messages: NeutralMessage[]): OpenAIMessage[] {
  return messages.map((msg): OpenAIMessage => {
    switch (msg.role) {
      case 'system':
        return { role: 'system', content: msg.content };
      case 'user':
        return {
          role: 'user',
          content: msg.content.map((part) =>
            part.type === 'text'
              ? { type: 'text', text: part.text }
              : { type: 'image_url', image_url: { url: part.dataUrl } },
          ),
        };
      case 'assistant':
        return {
          role: 'assistant',
          content: msg.content || null,
          ...(msg.toolCalls && msg.toolCalls.length > 0
            ? {
                tool_calls: msg.toolCalls.map((call) => ({
                  id: call.id,
                  type: 'function' as const,
                  function: { name: call.name, arguments: call.arguments },
                })),
              }
            : {}),
        };
      case 'tool':
        return { role: 'tool', tool_call_id: msg.toolCallId, content: msg.content };
    }
  });
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly id: string;
  readonly kind: 'openai' | 'openai-compatible';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: OpenAIAdapterOptions) {
    this.id = options.id;
    this.kind = options.kind ?? 'openai-compatible';
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl || 'https://api.openai.com/v1';
    this.extraHeaders = options.headers ?? {};
  }

  private body(request: ProviderRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: toOpenAIMessages(request.messages),
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
    };
    if (request.tools && request.tools.length > 0 && request.toolChoice !== 'none') {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }));
      body.tool_choice = 'auto';
    }
    return body;
  }

  async *chat(request: ProviderRequest): AsyncGenerator<ProviderEvent, void, unknown> {
    let response: Response;
    try {
      response = await fetch(joinUrl(this.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          ...this.extraHeaders,
        },
        body: JSON.stringify(this.body(request, true)),
        signal: request.signal,
      });
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        yield { type: 'error', code: 'canceled', message: '已取消', retryable: false };
        return;
      }
      yield { type: 'error', code: 'network', message: `网络错误：${(error as Error).message}`, retryable: true };
      return;
    }

    if (!response.ok) {
      const detail = await readErrorBody(response);
      const mapped = classifyHttpStatus(response.status);
      yield { type: 'error', ...mapped, message: `${mapped.message}${detail ? `：${detail}` : ''}`, status: response.status };
      return;
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      // 某些兼容服务忽略 stream=true，直接返回 JSON
      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = json.choices?.[0];
      if (choice?.message?.content) yield { type: 'text', delta: choice.message.content };
      for (const call of choice?.message?.tool_calls ?? []) {
        yield {
          type: 'tool-call',
          call: { id: call.id, name: call.function.name, arguments: call.function.arguments ?? '{}' },
        };
      }
      if (json.usage) {
        yield { type: 'usage', inputTokens: json.usage.prompt_tokens ?? 0, outputTokens: json.usage.completion_tokens ?? 0 };
      }
      yield { type: 'done', finishReason: choice?.finish_reason ?? 'stop' };
      return;
    }

    const pending = new Map<number, { id: string; name: string; args: string }>();
    let finishReason = 'stop';

    try {
      for await (const data of parseSse(response)) {
        if (data === '[DONE]') break;
        let parsed: any;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        if (parsed.error) {
          yield { type: 'error', code: 'provider_error', message: String(parsed.error.message ?? '提供商返回错误'), retryable: false };
          return;
        }
        const choice = parsed.choices?.[0];
        const delta = choice?.delta;
        if (delta?.content) {
          const text = typeof delta.content === 'string' ? delta.content : '';
          if (text) yield { type: 'text', delta: text };
        }
        if (Array.isArray(delta?.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const index = typeof tc.index === 'number' ? tc.index : 0;
            const current = pending.get(index) ?? { id: '', name: '', args: '' };
            if (tc.id) current.id = tc.id;
            if (tc.function?.name) current.name += tc.function.name;
            if (tc.function?.arguments) current.args += tc.function.arguments;
            pending.set(index, current);
          }
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (parsed.usage) {
          yield {
            type: 'usage',
            inputTokens: parsed.usage.prompt_tokens ?? 0,
            outputTokens: parsed.usage.completion_tokens ?? 0,
          };
        }
      }
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        yield { type: 'error', code: 'canceled', message: '已取消', retryable: false };
        return;
      }
      yield { type: 'error', code: 'stream_error', message: `流读取失败：${(error as Error).message}`, retryable: true };
      return;
    }

    for (const [index, call] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
      yield {
        type: 'tool-call',
        call: {
          id: call.id || `call_${index}`,
          name: call.name,
          arguments: call.args || '{}',
        },
      };
    }
    yield { type: 'done', finishReason };
  }
}

/** 非流式请求，用于能力探测与结构化输出等需要完整 JSON 的场景。 */
export async function openAIJson(
  options: OpenAIAdapterOptions,
  payload: { model: string; messages: NeutralMessage[]; maxTokens?: number; responseFormat?: 'json' },
  signal?: AbortSignal,
): Promise<{ content: string; usage: { inputTokens: number; outputTokens: number }; status: number }> {
  let response: Response;
  try {
    response = await fetch(joinUrl(options.baseUrl || 'https://api.openai.com/v1', '/chat/completions'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.apiKey}`,
        ...(options.headers ?? {}),
      },
      body: JSON.stringify({
        model: payload.model,
        messages: toOpenAIMessages(payload.messages),
        max_tokens: payload.maxTokens ?? 300,
        ...(payload.responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal,
    });
  } catch (error) {
    throw new ProviderError({ code: 'network', message: `网络错误：${(error as Error).message}`, retryable: true });
  }
  if (!response.ok) {
    const detail = await readErrorBody(response);
    const mapped = classifyHttpStatus(response.status);
    throw new ProviderError({ ...mapped, status: response.status, message: `${mapped.message}${detail ? `：${detail}` : ''}` });
  }
  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    content: json.choices?.[0]?.message?.content ?? '',
    usage: {
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
    },
    status: response.status,
  };
}
