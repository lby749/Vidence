import { expect, it } from 'vitest';
import { CAPABILITIES, MODEL_FILES, verifyModelFile } from '@/models/downloads';

it('每项功能都有固定且可校验的资源，不接受用户输入任意模型 URL', () => {
  expect(CAPABILITIES.map(item => item.id)).toEqual(['ocr', 'vector', 'rerank']);
  expect(new Set(MODEL_FILES.map(file => file.path)).size).toBe(MODEL_FILES.length);
  for (const file of MODEL_FILES) {
    expect(file.url.startsWith('https://')).toBe(true);
    expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(file.bytes).toBeGreaterThan(0);
  }
});

it('大小或哈希不符时拒绝安装下载文件', async () => {
  const file = { path: 'test', url: 'https://example.test', bytes: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' };
  await expect(verifyModelFile(file, new TextEncoder().encode('abc').buffer)).resolves.toBeUndefined();
  await expect(verifyModelFile(file, new TextEncoder().encode('ab').buffer)).rejects.toThrow('大小');
  await expect(verifyModelFile(file, new TextEncoder().encode('bad').buffer)).rejects.toThrow('校验');
});
