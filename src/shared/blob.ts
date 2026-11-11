/** Blob 与 data URL 互转（后台、UI 与测试共用）。 */

export async function blobToDataUrl(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const base64 = bytesToBase64(new Uint8Array(buffer));
  const type = blob.type || 'image/jpeg';
  return `data:${type};base64,${base64}`;
}

export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const [meta, base64] = dataUrl.split(',');
  const mime = /data:([^;]+);/.exec(meta ?? '')?.[1] ?? 'image/jpeg';
  const binary = atob(base64 ?? '');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
