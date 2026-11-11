import { randomBytes } from 'node:crypto';

// 请求结束即撤销；仅转发工具调用，不保存记忆库副本。
export function createMemoryRelay() {
  const sessions = new Map();
  const remove = id => {
    const session = sessions.get(id);
    if (!session) return;
    clearTimeout(session.timer);
    for (const call of session.pending.values()) call.resolve({ content: [{ type: 'text', text: '提问已结束' }], isError: true });
    sessions.delete(id);
  };
  return {
    has: id => sessions.has(id),
    remove,
    async handle(req, url, reply) {
      if (!url.pathname.startsWith('/memory')) return false;
      let body = {};
      if (req.method === 'POST') {
        let raw = ''; req.setEncoding('utf8');
        const limit = url.pathname.endsWith('/result') ? 16_000_000 : 80_000;
        for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > limit) { reply(413, { error: '工具结果过长' }); return true; } }
        try { body = JSON.parse(raw); } catch { reply(400, { error: '工具请求格式错误' }); return true; }
      }
      if (req.method === 'POST' && url.pathname === '/memory') {
        const names = ['get_question', 'search_library', 'read_evidence', 'get_timeline', 'get_neighbors', 'get_frame'];
        if (!Array.isArray(body.tools) || body.tools.length > names.length || body.tools.some(t => !names.includes(t.name) || !t.inputSchema)) { reply(400, { error: '记忆工具不正确' }); return true; }
        if (sessions.size >= 4) { reply(409, { error: '已有提问未结束' }); return true; }
        const id = randomBytes(24).toString('hex');
        sessions.set(id, { tools: body.tools, queue: [], pending: new Map(), calls: 0, maxCalls: Math.max(1, Math.min(16, Number(body.maxCalls) || 4)), timer: setTimeout(() => remove(id), 190000).unref() });
        reply(200, { id }); return true;
      }
      const [, , id, action] = url.pathname.split('/');
      const session = sessions.get(id);
      if (!session) { reply(404, { error: '提问已过期' }); return true; }
      if (req.method === 'DELETE') { remove(id); reply(200, {}); }
      else if (req.method === 'GET' && !action) reply(200, { tools: session.tools });
      else if (req.method === 'GET' && action === 'next') reply(200, { call: session.queue.shift() ?? null });
      else if (req.method === 'POST' && action === 'call') {
        if (!session.tools.some(t => t.name === body.name) || ++session.calls > session.maxCalls) { reply(400, { error: '未知工具或已超过查询上限' }); return true; }
        const callId = randomBytes(12).toString('hex');
        const result = new Promise(resolve => session.pending.set(callId, { resolve }));
        session.queue.push({ id: callId, name: body.name, args: body.arguments ?? {} });
        const timer = setTimeout(() => session.pending.get(callId)?.resolve({ content: [{ type: 'text', text: '记忆库读取超时' }], isError: true }), 30000);
        reply(200, await result); clearTimeout(timer); session.pending.delete(callId);
      } else if (req.method === 'POST' && action === 'result') {
        const call = session.pending.get(body.id);
        if (!call) reply(404, { error: '工具调用已结束' });
        else { call.resolve(body.result); session.pending.delete(body.id); reply(200, {}); }
      } else reply(404, { error: '工具接口不存在' });
      return true;
    },
  };
}
