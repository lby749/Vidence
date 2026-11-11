import readline from 'node:readline';

const session = process.argv[2];
const base = `http://127.0.0.1:8131/memory/${session}`;
const headers = { Authorization: `Bearer ${process.env.VMA_MEMORY_TOKEN}`, 'Content-Type': 'application/json' };
async function request(action, body) {
  const response = await fetch(base + action, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(35000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? '记忆库连接失败');
  return data;
}
const input = readline.createInterface({ input: process.stdin });
input.on('line', async line => {
  let message;
  try {
    message = JSON.parse(line);
    if (message.id === undefined) return;
    let result;
    switch (message.method) {
      case 'initialize': result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'video-memory', version: '1.0.0' } }; break;
      case 'ping': result = {}; break;
      case 'tools/list': result = await request(''); break;
      case 'tools/call': result = await request('/call', message.params); break;
      default: throw new Error('不支持此方法');
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32603, message: error.message } }) + '\n');
  }
});
