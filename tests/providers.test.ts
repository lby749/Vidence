import { describe, expect, it, vi, afterEach } from 'vitest';
import { parseSse } from '@/providers/sse';
import { OpenAICompatibleAdapter, toOpenAIMessages } from '@/providers/openai';
import { toAnthropicMessages } from '@/providers/anthropic';
import type { NeutralMessage } from '@/providers/types';

function sseResponse(events: string[], chunkSize?: number): Response {
  const payload = events.map((event) => `data: ${event}\n\n`).join('');
  const encoder = new TextEncoder();
  const bytes = encoder.encode(payload);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (!chunkSize) {
        controller.enqueue(bytes);
      } else {
        for (let i = 0; i < bytes.length; i += chunkSize) {
          controller.enqueue(bytes.slice(i, i + chunkSize));
        }
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('SSE 解析', () => {
  it('跨 chunk 截断时仍能正确拼接事件', async () => {
    const response = sseResponse(['{"a":1}', '[DONE]'], 3);
    const events: string[] = [];
    for await (const data of parseSse(response)) events.push(data);
    expect(events).toEqual(['{"a":1}', '[DONE]']);
  });

  it('忽略注释行并支持多行 data', async () => {
    const body = ': ping\n\ndata: line1\ndata: line2\n\n';
    const response = new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    const events: string[] = [];
    for await (const data of parseSse(response)) events.push(data);
    expect(events).toEqual(['line1\nline2']);
  });
});

describe('OpenAI 兼容适配器', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('累积流式工具调用参数并返回用量', async () => {
    const events = [
      '{"choices":[{"delta":{"content":"我来查一下"}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"search_library","arguments":"{\\"query\\":"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"排队\\"}"}}]}}]}',
      '{"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":12,"completion_tokens":7}}',
      '[DONE]',
    ];
    const fetchMock = vi.fn(async () => sseResponse(events, 17));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new OpenAICompatibleAdapter({ id: 'p1', apiKey: 'test-key', baseUrl: 'https://example.test/v1' });
    const collected: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const event of adapter.chat({
      model: 'test-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: '排队论是什么' }] }],
    })) {
      collected.push(event as never);
    }

    const text = collected
      .filter((e) => e.type === 'text')
      .map((e) => (e as unknown as { delta: string }).delta)
      .join('');
    expect(text).toBe('我来查一下');
    const toolCall = collected.find((e) => e.type === 'tool-call') as unknown as {
      call: { name: string; arguments: string };
    };
    expect(toolCall.call.name).toBe('search_library');
    expect(JSON.parse(toolCall.call.arguments)).toEqual({ query: '排队' });
    const usage = collected.find((e) => e.type === 'usage') as unknown as {
      inputTokens: number;
      outputTokens: number;
    };
    expect(usage.inputTokens).toBe(12);
    expect(usage.outputTokens).toBe(7);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestInit = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    expect((requestInit.headers as Record<string, string>).authorization).toBe('Bearer test-key');
  });

  it('401 被归类为不可重试的授权错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad key', { status: 401 })),
    );
    const adapter = new OpenAICompatibleAdapter({ id: 'p1', apiKey: 'bad', baseUrl: 'https://example.test/v1' });
    const errors = [];
    for await (const event of adapter.chat({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) {
      if (event.type === 'error') errors.push(event);
    }
    expect(errors[0]).toMatchObject({ code: 'unauthorized', retryable: false, status: 401 });
  });

  it('消息转换保留工具调用与工具结果', () => {
    const messages: NeutralMessage[] = [
      { role: 'system', content: '系统' },
      { role: 'user', content: [{ type: 'text', text: '问题' }] },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'search_library', arguments: '{"query":"x"}' }] },
      { role: 'tool', toolCallId: 'c1', name: 'search_library', content: '{"ok":true}' },
    ];
    const converted = toOpenAIMessages(messages);
    expect(converted[2].tool_calls?.[0].function.name).toBe('search_library');
    expect(converted[3]).toMatchObject({ role: 'tool', tool_call_id: 'c1' });
  });
});

describe('Anthropic 消息转换', () => {
  it('system 单独提取，工具结果合并为 user 块', () => {
    const messages: NeutralMessage[] = [
      { role: 'system', content: '规则' },
      { role: 'user', content: [{ type: 'text', text: '问题' }] },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'read_evidence', arguments: '{"evidenceIds":["e1"]}' }] },
      { role: 'tool', toolCallId: 't1', name: 'read_evidence', content: '证据正文' },
    ];
    const { system, messages: converted } = toAnthropicMessages(messages);
    expect(system).toBe('规则');
    expect(converted[1].content[0]).toMatchObject({ type: 'tool_use', id: 't1', name: 'read_evidence' });
    expect(converted[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1' });
  });

  it('图像块转换为 base64 source', () => {
    const { messages } = toAnthropicMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image', dataUrl: 'data:image/png;base64,AAAA', mediaType: 'image/png' },
        ],
      },
    ]);
    expect(messages[0].content[1]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
  });
});
