/**
 * SSE 解析（OpenAI / Anthropic 兼容）。
 * 处理跨 chunk 截断、CRLF、注释行与多行 data。
 */

export async function* parseSse(response: Response): AsyncGenerator<string, void, unknown> {
  if (!response.body) throw new Error('响应没有可读流');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // 按空行分割事件
      let index = buffer.search(/\r?\n\r?\n/);
      while (index !== -1) {
        const rawEvent = buffer.slice(0, index);
        const match = buffer.slice(index).match(/^\r?\n\r?\n/);
        buffer = buffer.slice(index + (match?.[0].length ?? 2));
        const data = extractData(rawEvent);
        if (data !== null) yield data;
        index = buffer.search(/\r?\n\r?\n/);
      }
    }
    const tail = extractData(buffer);
    if (tail !== null) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function extractData(rawEvent: string): string | null {
  const lines = rawEvent.split(/\r?\n/);
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (dataLines.length === 0) return null;
  return dataLines.join('\n');
}

export async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 800);
  } catch {
    return '';
  }
}
