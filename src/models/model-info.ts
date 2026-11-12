/**
 * 模型与运行时文件说明。
 *
 * 这里只记录实际引用的模型与来源，不编造哈希：
 * - OCR：PaddleOCR 官方 PP-OCRv5 mobile det/rec（按功能下载）
 * - Embedding：Xenova/bge-small-zh-v1.5（ONNX，512 维，CLS pooling + L2 归一化）
 */

/** 推理资源的逻辑路径；实际读取经校验的用户下载缓存。 */
export const LOCAL_MODEL_PATH = 'models/';
export const RERANK_MODEL_ID = 'Xenova/bge-reranker-base';
export const EMBEDDING_MODEL_ID = 'Xenova/bge-small-zh-v1.5';
export const MODEL_REVISIONS = {
  [EMBEDDING_MODEL_ID]: '75c43b069aac4d136ba6bc1122f995fedcfd2781',
  [RERANK_MODEL_ID]: '280bcc27a84e0b898c251e06fddb25171bd9b101',
} as const;

export const APPROX_MODEL_FILES = {
  ocr: [
    {
      name: 'PP-OCRv5_mobile_det_onnx_infer.tar',
      url: 'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_det_onnx_infer.tar',
      note: '按功能下载；SHA-256 见 model-manifest.json',
    },
    {
      name: 'PP-OCRv5_mobile_rec_onnx_infer.tar',
      url: 'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_rec_onnx_infer.tar',
      note: '按功能下载；SHA-256 见 model-manifest.json',
    },
  ],
  embedding: [
    {
      name: 'Xenova/bge-small-zh-v1.5',
      url: 'https://huggingface.co/Xenova/bge-small-zh-v1.5',
      note: '量化 q8 导出，512 维；按功能下载',
    },
  ],
} as const;

export const EMBEDDING_SPEC = {
  modelId: 'Xenova/bge-small-zh-v1.5',
  dimension: 512,
  pooling: 'cls',
  normalize: true,
  dtype: 'q8',
  /** 中文 query 指令前缀（按 BGE 模型卡：查询侧使用中文指令） */
  queryInstruction: '为这个句子生成表示以用于检索相关文章：',
} as const;

export function embeddingSpec() {
  return { ...EMBEDDING_SPEC, documentInstruction: '' };
}
