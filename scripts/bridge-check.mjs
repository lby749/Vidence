import assert from 'node:assert/strict';
import { createBridge, extensionIdForPath, INSTALLED_ORIGIN, parseAgentOutput } from './local-agent-bridge.mjs';
if (process.platform === 'win32') assert.equal(extensionIdForPath('D:\\Desktop\\New folder (11)\\.output\\chrome-mv3'), 'gafmabkbhodiinhhidaebjljimbkechg');
const parsed = parseAgentOutput([
  { type: 'thinking', text: '不进入最终回答' },
  { type: 'status', phase: 'step_end', usage: { inputTokens: 20, outputTokens: 3, cacheReadTokens: 10 } },
  { type: 'status', phase: 'step_end', usage: { inputTokens: 5, outputTokens: 7 } },
  { type: 'final', text: '完整回答', reason: { kind: 'completed' } },
].map(JSON.stringify).join('\n'));
assert.equal(parsed.answer, '完整回答'); assert.equal(parsed.usage.inputTokens, 35); assert.equal(parsed.usage.outputTokens, 10); assert.equal(parsed.usage.calls, 2); assert.equal(parsed.usage.tokenStatus, 'reported');
assert.equal(parseAgentOutput(JSON.stringify({ type: 'final', text: '回答', reason: { kind: 'completed' } })).usage.tokenStatus, 'unavailable');
assert.throws(() => parseAgentOutput(JSON.stringify({ type: 'final', text: '截断回答', reason: { kind: 'max-tokens' } })));
const token = 'unit-test-token';
const origin = 'chrome-extension://test-extension';
let calls = 0; let usedModel;
const server = createBridge({ token, origin, models: async () => ({ models: [{ id: 'model-a', label: 'Model A' }, { id: 'model-b', label: 'Model B' }] }), run: async (_backend, prompt, _signal, model) => { calls++; usedModel = model; return `回答：${prompt}`; } });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
try {
  const headers = { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${base}/health`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/health`, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
  assert.equal((await fetch(`${base}/health`, { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${base}/health`, { headers: { ...headers, Origin: 'http://127.0.0.1:8132' } })).status, 200);
  assert.equal((await fetch(`${base}/health`, { headers: { ...headers, Origin: INSTALLED_ORIGIN } })).status, 200);
  assert.equal((await fetch(`${base}/health`, { headers: { ...headers, Origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } })).status, 403);
  assert.equal((await fetch(`${base}/health`, { headers: { ...headers, Origin: 'http://127.0.0.1:8133' } })).status, 403);
  assert.equal((await fetch(`${base}/health`, { headers: { ...headers, Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(`${base}/ask`, { method: 'POST', headers, body: JSON.stringify({ backend: 'powershell', prompt: 'x' }) })).status, 400);
  assert.equal((await fetch(`${base}/ask`, { method: 'POST', headers, body: JSON.stringify({ backend: 'dsh', prompt: 'x'.repeat(20001) }) })).status, 400);
  assert.equal((await fetch(`${base}/ask`, { method: 'POST', headers, body: '{' })).status, 400);
  const response = await fetch(`${base}/ask`, { method: 'POST', headers, body: JSON.stringify({ backend: 'dsh', model: 'model-b', prompt: '测试' }) });
  assert.equal((await response.json()).answer, '回答：测试'); assert.equal(calls, 1); assert.equal(usedModel, 'model-b');
  const models = await (await fetch(`${base}/models?backend=dsh`, { headers })).json(); assert.equal(models.models.length, 2);
  const memory = async (path, body, method = body ? 'POST' : 'GET') => fetch(`${base}/memory${path}`, { headers, method, body: body ? JSON.stringify(body) : undefined });
  assert.equal((await memory('', { tools: [{ name: 'shell', inputSchema: {} }] })).status, 400);
  assert.equal((await fetch(`${base}/memory`, { method: 'POST', headers, body: 'null' })).status, 400, '畸形工具请求不能导致桥接退出');
  const { id } = await (await memory('', { maxCalls: 1, tools: [{ name: 'get_question', inputSchema: { type: 'object', properties: {} } }] })).json();
  assert.equal((await (await memory(`/${id}`)).json()).tools[0].name, 'get_question');
  const pending = memory(`/${id}/call`, { name: 'get_question' });
  let call;
  for (let i = 0; i < 40 && !call; i++) { call = (await (await memory(`/${id}/next`)).json()).call; if (!call) await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.ok(call);
  await memory(`/${id}/result`, { id: call.id, result: { content: [{ type: 'text', text: '真实证据' }] } });
  assert.equal((await (await pending).json()).content[0].text, '真实证据');
  assert.equal((await memory(`/${id}/call`, { name: 'get_question' })).status, 400, '工具次数上限');
  await memory(`/${id}`, undefined, 'DELETE');
  assert.equal((await memory(`/${id}/next`)).status, 404, '请求结束撤销工具');
  console.log('桥接：鉴权、Origin、后端白名单、输入上限、错误回传、回答返回均通过');
} finally { await new Promise(resolve => server.close(resolve)); }
