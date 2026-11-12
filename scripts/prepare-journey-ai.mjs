// Test-only real vision model, kept outside the release package. No credentials.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
const dir=path.resolve(process.argv[2]);fs.mkdirSync(dir,{recursive:true});
const revision='5037fcf163dd95d1e41d1974465f0898ed108ca2';
const files=[
 ['Qwen-Qwen2.5-7B-Instruct.jinja',2507,'cd8e9439f0570856fd70470bf8889ebd8b5d1107207f67a5efb46e342330527f','https://raw.githubusercontent.com/ggml-org/llama.cpp/b11597/models/templates/Qwen-Qwen2.5-7B-Instruct.jinja'],
 ['Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf',1929901056,'d02fe9b69ad8cadbbd228e387667af66612c44bed29ffc8eb1e7caf9ac486c12'],
 ['mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf',844757728,'980c9b2f78c04e6cff93d277ada09e768394f112d75db3b4e9dea8a69f9fb904']
];
const spec=JSON.parse(fs.readFileSync('src/models/native-runtime.json','utf8')).platforms['windows-x86_64-cpu'];
files.push([spec.name,spec.bytes,spec.digest.replace('sha256:',''),spec.url]);
for(const [name,size,digest,url] of files){
 const file=path.join(dir,name);const hash=async()=>{const h=crypto.createHash('sha256');for await(const part of fs.createReadStream(file))h.update(part);return h.digest('hex');};
 if(!fs.existsSync(file)||fs.statSync(file).size!==size||await hash()!==digest){
  console.log('Downloading test component:',name);
  const response=await fetch(url||`https://huggingface.co/ggml-org/Qwen2.5-VL-3B-Instruct-GGUF/resolve/${revision}/${name}`);
  if(!response.ok)throw Error(`Test component HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body),fs.createWriteStream(file));
  if(fs.statSync(file).size!==size||await hash()!==digest)throw Error('Test component checksum mismatch: '+name);
 }
 console.log('Verified test component:',name);
}
