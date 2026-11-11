// 只准备运行时，不下载模型；普通构建与本机测试资源分开。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
for (const [directory, runtime] of [
  ['ort', createRequire(import.meta.resolve('@paddleocr/paddleocr-js')).resolve('onnxruntime-web')],
  ['ort-transformers', require.resolve('onnxruntime-web')],
]) {
  const dest = path.resolve('public', directory); fs.mkdirSync(dest, { recursive: true });
  const pattern = directory === 'ort-transformers' ? /^ort-wasm-simd-threaded\.asyncify\.(mjs|wasm)$/ : /^ort-wasm-simd-threaded(?:\.jsep)?\.(mjs|wasm)$/;
  const copied = new Set();
  for (const file of fs.readdirSync(path.dirname(runtime))) {
    if (pattern.test(file)) { fs.copyFileSync(path.join(path.dirname(runtime), file), path.join(dest, file)); copied.add(file); }
  }
  for (const file of fs.readdirSync(dest)) {
    if (/^ort-wasm.*\.(mjs|wasm)$/.test(file) && !copied.has(file)) fs.rmSync(path.join(dest, file));
  }
}
