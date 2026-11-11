/**
 * 下载本机开发测试用模型；public 中的模型会被构建排除，不进入发布包。
 *
 * 来源使用 Hugging Face 镜像 hf-mirror.com（与 huggingface.co 同内容），
 * PaddleOCR 使用官方 BCE 模型库。下载后写入 src/models/model-manifest.json：
 * 文件名、大小、SHA-256，供诊断与索引元数据记录。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const HF = process.env.HF_MIRROR ?? 'https://hf-mirror.com';
const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, 'public');

const models = [
  {
    id: 'Xenova/bge-small-zh-v1.5',
    files: [
      'config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'special_tokens_map.json',
      'vocab.txt',
      'onnx/model_quantized.onnx',
    ],
  },
  {
    id: 'Xenova/bge-reranker-base',
    files: [
      'config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'special_tokens_map.json',
      'onnx/model_int8.onnx',
    ],
  },
];

const ocr = [
  {
    name: 'PP-OCRv5_mobile_det_onnx_infer.tar',
    url: 'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_det_onnx_infer.tar',
  },
  {
    name: 'PP-OCRv5_mobile_rec_onnx_infer.tar',
    url: 'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_rec_onnx_infer.tar',
  },
];

const { spawnSync } = await import('node:child_process');

function download(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const result = spawnSync(
    'curl.exe',
    ['-L', '--fail', '--retry', '8', '--retry-delay', '2', '--retry-all-errors', '--silent', '--show-error', '-o', dest, url],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) throw new Error(`下载失败：${url}（curl ${result.status}）`);
  const size = fs.statSync(dest).size;
  const needsBig = /\.(onnx|tar)$/i.test(dest);
  if (size < (needsBig ? 1024 * 1024 : 64)) {
    throw new Error(`下载文件异常小：${dest} (${size} bytes)`);
  }
  return size;
}

function sha256(file) {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

const manifest = { generatedAt: new Date().toISOString(), models: {}, ocr: [] };

for (const model of models) {
  console.log(`\n== ${model.id} ==`);
  for (const file of model.files) {
    const dest = path.join(PUBLIC, 'models', model.id, file);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 64 && !process.argv.includes('--force')) {
      console.log(`skip ${file} (${(fs.statSync(dest).size / 1e6).toFixed(1)} MB)`);
    } else {
      console.log(`download ${file} ...`);
      download(`${HF}/${model.id}/resolve/main/${file}`, dest);
      console.log(`  ${file} ${(fs.statSync(dest).size / 1e6).toFixed(1)} MB`);
    }
    manifest.models[model.id] ??= [];
    manifest.models[model.id].push({
      name: file,
      bytes: fs.statSync(dest).size,
      sha256: sha256(dest),
    });
  }
}

console.log('\n== PaddleOCR ==');
for (const item of ocr) {
  const dest = path.join(PUBLIC, 'ocr', item.name);
  if (!fs.existsSync(dest) || process.argv.includes('--force')) {
    console.log(`download ${item.name} ...`);
    download(item.url, dest);
  }
  console.log(`  ${item.name} ${(fs.statSync(dest).size / 1e6).toFixed(1)} MB`);
  manifest.ocr.push({ name: item.name, bytes: fs.statSync(dest).size, sha256: sha256(dest) });
}

const out = path.join(ROOT, 'src', 'models', 'model-manifest.json');
fs.writeFileSync(out, JSON.stringify(manifest, null, 2));
console.log(`\n已写入 ${out}`);

// 粗略统计
const total = [
  ...Object.values(manifest.models).flat(),
  ...manifest.ocr,
].reduce((sum, item) => sum + item.bytes, 0);
console.log(`模型总计 ${(total / 1e6).toFixed(1)} MB`);


await import('./prepare-runtime.mjs');
