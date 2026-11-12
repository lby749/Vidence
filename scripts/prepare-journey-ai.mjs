// Test-only real vision model, kept outside the release package. No credentials.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
const dir=path.resolve(process.argv[2]);fs.mkdirSync(dir,{recursive:true});
const revision='1cd86afb9a95c410a6038ab3b40d8b578c892266';
const files=[
 ['Qwen3VL-4B-Instruct-Q4_K_M.gguf',2497281664,'66358cb18bb6b3b1b6675aa412c7a88ef01d228f481184d13668e5201c730a0a'],
 ['mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf',453974304,'30ba2c7dd3127a4561b6cba9d13d0f711c91bdb38742e2f56d73c8cb596bd06d']
];
const spec=JSON.parse(fs.readFileSync('src/models/native-runtime.json','utf8')).platforms['windows-x86_64-cpu'];
files.push([spec.name,spec.bytes,spec.digest.replace('sha256:',''),spec.url]);
for(const [name,size,digest,url] of files){
 const file=path.join(dir,name);const hash=async()=>{const h=crypto.createHash('sha256');for await(const part of fs.createReadStream(file))h.update(part);return h.digest('hex');};
 if(!fs.existsSync(file)||fs.statSync(file).size!==size||await hash()!==digest){
  console.log('Downloading test component:',name);
  const response=await fetch(url||`https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/${revision}/${name}`);
  if(!response.ok)throw Error(`Test component HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body),fs.createWriteStream(file));
  if(fs.statSync(file).size!==size||await hash()!==digest)throw Error('Test component checksum mismatch: '+name);
 }
 console.log('Verified test component:',name);
}
