import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { createBridge }=await import(pathToFileURL(path.resolve(process.argv[2] ?? 'dist/desktop/视频记忆助手/_internal', 'scripts/local-agent-bridge.mjs')));
const token='packaged-runtime-test';
const server=createBridge({token,models:async()=>({models:[{id:'test',label:'test'}]}),run:async()=> 'runtime-ok'});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try{
  const base=`http://127.0.0.1:${server.address().port}`;const headers={Origin:'http://127.0.0.1:8132',Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
  assert.equal((await fetch(base+'/health',{headers})).status,200);
  const result=await fetch(base+'/ask',{method:'POST',headers,body:JSON.stringify({backend:'opencode-go',model:'test',prompt:'test'})});assert.equal((await result.json()).answer,'runtime-ok');
  console.log('PACKAGED_NODE_RUNTIME_PASS');
}finally{await new Promise(resolve=>server.close(resolve));}
