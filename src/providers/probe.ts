/**
 * 提供商能力探测。
 *
 * 只把真实观察到的能力写为 true：
 * - text：拿到非空文本
 * - stream：观察到流式增量（或 SSE content-type）
 * - usage：服务返回 token 用量
 * - tools：模型实际返回了一次工具调用
 * - vision：图像输入被接受且返回内容
 * - browserDirect：扩展环境中的请求未被 CORS/鉴权拒绝
 *
 * 探测结果可重复运行，界面显示验证时间。
 */

import type { ProviderCapabilities, ProviderConfig } from '@/shared/types';
import { createAdapter } from './index';
import type { NeutralMessage, ToolSpec } from './types';

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export interface ProbeReport {
  capabilities: ProviderCapabilities;
  notes: string[];
}

export async function probeProvider(
  provider: ProviderConfig,
  modelId: string,
  options: { signal?: AbortSignal; skipVision?: boolean } = {},
): Promise<ProbeReport> {
  const notes: string[] = [];
  const capabilities: ProviderCapabilities = {
    text: false,
    stream: false,
    structured: false,
    tools: false,
    vision: false,
    usage: false,
    browserDirect: false,
  };

  const adapter = createAdapter(provider);
  let deltas = 0;
  let text = '';
  let usageSeen = false;

  try {
    for await (const event of adapter.chat({
      model: modelId,
      messages: [{ role: 'user', content: [{ type: 'text', text: '只回复两个字符：OK' }] }],
      maxTokens: 16,
      signal: options.signal,
    })) {
      if (event.type === 'text') {
        deltas += 1;
        text += event.delta;
      }
      if (event.type === 'usage' && (event.inputTokens > 0 || event.outputTokens > 0)) usageSeen = true;
      if (event.type === 'error') {
        notes.push(`文本请求失败：${event.message}`);
        capabilities.browserDirect = event.status !== undefined; // 拿到 HTTP 状态即视为可达，但为 401/403 时鉴权失败
        return { capabilities, notes };
      }
    }
    capabilities.browserDirect = true;
    capabilities.text = text.trim().length > 0;
    capabilities.stream = deltas > 1;
    capabilities.usage = usageSeen;
    notes.push(`文本响应：${text.trim().slice(0, 40) || '（空）'}`);
  } catch (error) {
    notes.push(`文本请求异常：${(error as Error).message}`);
    return { capabilities, notes };
  }

  // 工具调用能力：要求模型必须调用一次只读工具
  const tool: ToolSpec = {
    name: 'echo_probe',
    description: '回显探测参数，用于验证工具调用通道',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
    },
  };
  try {
    let called = false;
    for await (const event of adapter.chat({
      model: modelId,
      messages: [{ role: 'user', content: [{ type: 'text', text: '请调用 echo_probe 工具，value 设为 probe。不要直接回答。' }] }],
      tools: [tool],
      maxTokens: 128,
      signal: options.signal,
    })) {
      if (event.type === 'tool-call' && event.call.name === 'echo_probe') called = true;
      if (event.type === 'error') {
        notes.push(`工具探测失败：${event.message}`);
        break;
      }
    }
    capabilities.tools = called;
    notes.push(called ? '工具调用：模型实际返回了 echo_probe 调用' : '工具调用：模型未返回工具调用（可能不支持或表述不配合）');
  } catch (error) {
    notes.push(`工具探测异常：${(error as Error).message}`);
  }

  // 结构化输出：OpenAI 兼容的 response_format 是否被接受（仅记录，不据此强制使用）
  try {
    const messages: NeutralMessage[] = [
      { role: 'system', content: '只输出 JSON，不要代码块。' },
      { role: 'user', content: [{ type: 'text', text: '返回 {"ok":true}' }] },
    ];
    let jsonText = '';
    for await (const event of adapter.chat({ model: modelId, messages, maxTokens: 32, signal: options.signal })) {
      if (event.type === 'text') jsonText += event.delta;
      if (event.type === 'error') break;
    }
    capabilities.structured = /\{[\s\S]*\}/.test(jsonText);
    notes.push(capabilities.structured ? '结构化输出：返回了可解析 JSON 形态' : '结构化输出：未观察到 JSON 形态');
  } catch {
    /* 结构化输出不是首版阻塞项 */
  }

  if (!options.skipVision) {
    try {
      let visionText = '';
      for await (const event of adapter.chat({
        model: modelId,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '这张 1x1 图片是什么颜色？只回答颜色。' },
              { type: 'image', dataUrl: TINY_PNG, mediaType: 'image/png' },
            ],
          },
        ],
        maxTokens: 32,
        signal: options.signal,
      })) {
        if (event.type === 'text') visionText += event.delta;
        if (event.type === 'error') {
          notes.push(`图像探测失败：${event.message}`);
          break;
        }
      }
      capabilities.vision = visionText.trim().length > 0;
      capabilities.browserDirect = capabilities.browserDirect || capabilities.vision;
    } catch (error) {
      notes.push(`图像探测异常：${(error as Error).message}`);
    }
  }

  capabilities.verifiedAt = Date.now();
  return { capabilities, notes };
}
