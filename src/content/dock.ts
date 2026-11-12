/**
 * 页面内嵌侧边面板（iframe 承载扩展自身的侧边栏页面）。
 *
 * 目标：点“侧边栏/提问”时在视频页面右侧展开，而不是新开标签页或弹窗。
 * 面板与页面 DOM 隔离在 Shadow DOM 中；iframe 使用扩展自身 origin，可正常访问后台与存储。
 */

import { setLauncherHidden } from './launcher';

let host: HTMLDivElement | null = null;
let shadow: ShadowRoot | null = null;
let frame: HTMLIFrameElement | null = null;
let closeHandler: (() => void) | null = null;

const STYLE = `
  :host { all: initial; }
  .dock {
    position: fixed; top: 0; right: 0; height: 100vh; width: 420px; max-width: 96vw;
    z-index: 2147483646; display: flex; flex-direction: column;
    background: #f5f5f7; border-left: 1px solid #e5e7ec;
    box-shadow: -12px 0 32px rgba(24,36,60,.14);
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    color: #263044;
  }
  .bar {
    display: flex; align-items: center; gap: 8px; padding: 8px 10px;
    background: #ffffff; border-bottom: 1px solid #e5e7ec; flex: 0 0 auto;
  }
  .mark {
    width: 20px; height: 20px; border-radius: 6px; display: grid; place-items: center;
    object-fit: cover;
  }
  .title { font-weight: 650; font-size: 12.5px; }
  .spacer { flex: 1; }
  button {
    font: inherit; font-size: 12px; border: 1px solid #e5e7ec; background: #ffffff;
    border-radius: 7px; padding: 3px 8px; cursor: pointer; color: #526077;
  }
  button:hover { background: #f2f6fc; }
  .close { border-color: transparent; background: transparent; font-size: 16px; line-height: 1; padding: 2px 7px; }
  iframe { flex: 1; width: 100%; border: 0; background: #f5f5f7; }
`;

export function openDock(tabId: number, mode: 'nodes' | 'ask' = 'nodes', onClose?: () => void): void {
  closeHandler = onClose ?? null;
  setLauncherHidden(true);
  if (host?.isConnected) {
    const target = mode === 'ask' ? 'ask' : 'nodes';
    frame?.contentWindow?.postMessage({ type: 'vma:switch-tab', tab: target }, '*');
    return;
  }

  host = document.createElement('div');
  host.id = 'vma-dock-host';
  host.style.cssText = 'all: initial; position: fixed; top: 0; right: 0; width: 0; height: 0; z-index: 2147483646;';
  shadow = host.attachShadow({ mode: 'open' });
  const url = `${chrome.runtime.getURL('sidepanel.html')}?embedded=1&tabId=${tabId}&tab=${mode}`;
  shadow.innerHTML = `
    <style>${STYLE}</style>
    <div class="dock" role="complementary" aria-label="Vidence侧边面板">
      <div class="bar">
        <img class="mark" src="${chrome.runtime.getURL('brand/icon-48.png')}" alt=""/>
        <span class="title">Vidence</span>
        <span class="spacer"></span>
        <button id="popout" title="在新标签页打开完整面板">独立页</button>
        <button id="close" class="close" title="关闭" aria-label="关闭学习栏">×</button>
      </div>
      <iframe title="Vidence 学习栏" id="frame" src="${url}" allow="clipboard-write"></iframe>
    </div>
  `;
  (document.fullscreenElement ?? document.documentElement).appendChild(host);
  frame = shadow.getElementById('frame') as HTMLIFrameElement | null;

  shadow.getElementById('close')?.addEventListener('click', () => closeDock());
  shadow.getElementById('popout')?.addEventListener('click', () => {
    window.open(chrome.runtime.getURL(`sidepanel.html?tabId=${tabId}`), '_blank');
  });

  document.addEventListener('fullscreenchange', onFullscreenChange, true);
  window.addEventListener('message', onWindowMessage);
  document.addEventListener('keydown', onKeyDown);
}

function onWindowMessage(event: MessageEvent): void {
  if (event.source !== frame?.contentWindow) return;
  if (event.data?.type === 'vma:close-dock') closeDock();
  if (event.data?.type === 'vma:popout-dock') {
    const tabId = Number(event.data.tabId) || 0;
    if (tabId) window.open(chrome.runtime.getURL(`sidepanel.html?tabId=${tabId}`), '_blank');
  }
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && !document.fullscreenElement) closeDock();
}

function onFullscreenChange(): void {
  if (!host) return;
  const target = document.fullscreenElement ?? document.documentElement;
  if (host.parentElement !== target) target.appendChild(host);
}

export function closeDock(): void {
  setLauncherHidden(false);
  window.removeEventListener('message', onWindowMessage);
  document.removeEventListener('keydown', onKeyDown);
  document.removeEventListener('fullscreenchange', onFullscreenChange, true);
  host?.remove();
  host = null;
  shadow = null;
  frame = null;
  closeHandler?.();
  closeHandler = null;
}

export function toggleDock(tabId: number, mode: 'nodes' | 'ask' = 'nodes'): void {
  if (host) closeDock();
  else openDock(tabId, mode);
}

export function isDockOpen(): boolean {
  return Boolean(host);
}
