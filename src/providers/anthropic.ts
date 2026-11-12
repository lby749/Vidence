/**
 * Anthropic Messages API 适配器。
 * 浏览器扩展后台直接请求时附带 anthropic-dangerous-direct-browser-access 头，
 * 以符合其对浏览器来源的显式要求；不读取或复用用户网页登录态。
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

export interface AnthropicAdapterOptions {
  id: string;
  apiKey: string;
  baseUrl?: string;
}

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicBlock[];
}

export function toAnthropicMessages(messages: NeutralMessage[]): {
  system: string;
  messages: AnthropicMessage[];
} {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemParts.push(msg.content);
      continue;
    }
    if (msg.role === 'user') {
      const blocks: AnthropicBlock[] = msg.content.map((part) => {
        if (part.type === 'text') return { type: 'text' as const, text: part.text };
        const mediaType = part.mediaType ?? /^data:([^;]+);/.exec(part.dataUrl)?.[1] ?? 'image/png';
        const data = part.dataUrl.replace(/^data:[^;]+;base64,/, '');
        return { type: 'image' as const, source: { type: 'base64' as const, media_type: mediaType, data } };
      });
      out.push({ role: 'user', content: blocks });
      continue;
    }
    if (msg.role === 'assistant') {
      const blocks: AnthropicBlock[] = [];
      if (msg.content) blocks.push({ type: 'text', text: msg.content });
      for (const call of msg.toolCalls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(call.arguments || '{}');
        } catch {
          input = {};
        }
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    // tool 结果必须作为 user 消息中的 tool_result 块，并尽量并入相邻 user 消息
    const block: AnthropicBlock = { type: 'tool_result', tool_use_id: msg.toolCallId, content: msg.content };
    const last = out[out.length - 1];
    if (last && last.role === 'user' && last.content.every((b) => b.type === 'tool_result')) {
      last.content.push(block);
    } else {
      out.push({ role: 'user', content: [block] });
    }
  }
  return { system: systemParts.join('\n\n'), messages: out };
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly id: string;
  readonly kind = 'anthropic' as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: AnthropicAdapterOptions) {
    this.id = options.id;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl || 'https://api.anthropic.com';
  }

  async *chat(request: ProviderRequest): AsyncGenerator<ProviderEvent, void, unknown> {
    const { system, messages } = toAnthropicMessages(request.messages);
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxTokens ?? 2048,
      messages,
      stream: true,
      ...(system ? { system } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };
    if (request.tools && request.tools.length > 0 && request.toolChoice !== 'none') {
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
    }

    let response: Response;
    try {
      response = await fetch(joinUrl(this.baseUrl, '/v1/messages'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
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

    if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
      const json = (await response.json()) as {
        content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
        usage?: { input_tokens?: number; output_tokens?: number };
        stop_reason?: string;
      };
      for (const block of json.content ?? []) {
        if (block.type === 'text' && block.text) yield { type: 'text', delta: block.text };
        if (block.type === 'tool_use' && block.id && block.name) {
          yield {
            type: 'tool-call',
            call: { id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          };
        }
      }
      if (json.usage) {
        yield { type: 'usage', inputTokens: json.usage.input_tokens ?? 0, outputTokens: json.usage.output_tokens ?? 0 };
      }
      yield { type: 'done', finishReason: json.stop_reason ?? 'stop' };
      return;
    }

    const toolBlocks = new Map<number, { id: string; name: string; args: string }>();
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason = 'stop';

    try {
      for await (const data of parseSse(response)) {
        let event: any;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        switch (event.type) {
          case 'message_start':
            inputTokens = event.message?.usage?.input_tokens ?? inputTokens;
            break;
          case 'content_block_start': {
            const block = event.content_block;
            if (block?.type === 'tool_use') {
              toolBlocks.set(event.index ?? 0, { id: block.id, name: block.name, args: '' });
            }
            break;
          }
          case 'content_block_delta': {
            const delta = event.delta;
            if (delta?.type === 'text_delta' && delta.text) {
              yield { type: 'text', delta: delta.text };
            }
            if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
              const current = toolBlocks.get(event.index ?? 0);
              if (current) current.args += delta.partial_json;
            }
            break;
          }
          case 'message_delta':
            if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
            outputTokens = event.usage?.output_tokens ?? outputTokens;
            break;
          case 'error':
            yield {
              type: 'error',
              code: 'provider_error',
              message: String(event.error?.message ?? '提供商返回错误'),
              retryable: false,
            };
            return;
          default:
            break;
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

    yield { type: 'usage', inputTokens, outputTokens };
    for (const [index, call] of [...toolBlocks.entries()].sort((a, b) => a[0] - b[0])) {
      yield {
        type: 'tool-call',
        call: { id: call.id || `tool_${index}`, name: call.name, arguments: call.args || '{}' },
      };
    }
    yield { type: 'done', finishReason: stopReason };
  }
}
