/** 运行平台判断（不依赖 DOM，服务 Worker 与测试环境均可使用） */
export function platform(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Edg\//.test(ua)) return 'edge';
  if (/Chrome\//.test(ua)) return 'chrome';
  return 'unknown';
}

export function isFirefox(): boolean {
  return platform() === 'firefox';
}

export function isChromeFamily(): boolean {
  const p = platform();
  return p === 'chrome' || p === 'edge';
}
