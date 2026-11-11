import type { Settings } from '@/shared/types';
import type { ToolExecutor } from './tools';

export async function connectAgentMemory(config: NonNullable<Settings['localAgent']>, executor: ToolExecutor, onTool: (name: string) => void, maxCalls: number, aliases: Map<string, string>) {
  const controller = new AbortController();
  async function request(path: string, body?: unknown, method = body ? 'POST' : 'GET') {
    const response = await fetch(`http://127.0.0.1:8131/memory${path}`, {
      method, headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? '记忆库工具连接失败');
    return result;
  }
  const tools = executor.specs('ai-app').filter(t => t.name !== 'submit_answer').map(t => ({ name: t.name, description: t.description, inputSchema: t.parameters, annotations: { readOnlyHint: true, destructiveHint: false } }));
  const { id } = await request('', { tools, maxCalls });
  const poll = (async () => {
    while (!controller.signal.aborted) {
      const { call } = await request(`/${id}/next`);
      if (call) {
        onTool(call.name);
        if (Array.isArray(call.args.evidenceIds)) call.args.evidenceIds = call.args.evidenceIds.map((id: string) => aliases.get(id) ?? id);
        const result = await executor.execute(call.name, call.args);
        await request(`/${id}/result`, { id: call.id, result: { content: [
          { type: 'text', text: result.content },
          ...(result.images ?? []).map(dataUrl => ({ type: 'image', mimeType: dataUrl.slice(5, dataUrl.indexOf(';')), data: dataUrl.slice(dataUrl.indexOf(',') + 1) })),
        ], isError: Boolean(result.error) } });
      } else await new Promise(resolve => setTimeout(resolve, 250));
    }
  })().catch(() => undefined); // 结束/取消提问会撤销服务器上的临时通道。
  return { id, close: async () => { await request(`/${id}`, undefined, 'DELETE').catch(() => undefined); controller.abort(); await poll; } };
}
