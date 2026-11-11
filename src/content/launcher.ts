/**
 * 页面内浮动启动器。
 *
 * 目的：用户不必先找扩展图标、再打开侧边栏才能开始记录。
 * 只在包含可见视频的页面出现；必须由用户点击才开始采集（不自动录制）。
 * 使用 Shadow DOM 隔离站点样式。
 */

import { resolveUiLocale, translateUi, type UiLocale } from '@/ui/locale-text';
export type LauncherState = 'idle' | 'starting' | 'recording' | 'paused' | 'error';

export interface LauncherHandlers {
  onStart: () => Promise<void>;
  onPause: () => Promise<void>;
  onResume: () => Promise<void>;
  onStop: () => Promise<void>;
  onOpenPanel: () => void;
  onAsk: () => void;
}

let host: HTMLDivElement | null = null;
let shadowRoot: ShadowRoot | null = null;
let expanded = false;
let currentState: LauncherState = 'idle';
let currentElapsed = 0;
let errorMessage = '';
let handlers: LauncherHandlers | null = null;
let locale: UiLocale = 'zh-CN';
const text = (value: string) => translateUi(value, locale);
function languageChanged(changes: Record<string, chrome.storage.StorageChange>, area: string) {
  if (area !== 'local' || !changes.vmaUiLanguage) return;
  const next = resolveUiLocale(changes.vmaUiLanguage.newValue);
  if (next !== locale) { locale = next; render(); }
}

const STYLE = `
  :host { all: initial; }
  .wrap {
    position: fixed; right: 18px; bottom: 84px; z-index: 2147483647;
    font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    color: #263044;
  }
  .pill {
    display: flex; align-items: center; gap: 7px;
    background: #ffffff; border: 1px solid #e6e9ef; border-radius: 999px;
    box-shadow: 0 4px 18px rgba(24,36,60,.16);
    padding: 7px 12px 7px 8px; cursor: pointer; user-select: none;
    transition: transform .15s ease, box-shadow .15s ease;
  }
  .pill:hover { transform: translateY(-1px); box-shadow: 0 6px 22px rgba(24,36,60,.2); }
  .mark {
    width: 24px; height: 24px; border-radius: 8px; display: grid; place-items: center;
    background: linear-gradient(135deg, #007aff, #54a5ff); color: #fff; font-weight: 700; font-size: 12px;
  }
  .mark img { width:100%; height:100%; border-radius:7px; }
  .mark.rec { background: #a3352c; animation: pulse 1.8s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .55; } }
  .label { font-weight: 600; letter-spacing: .01em; white-space: nowrap; }
  .time { font-variant-numeric: tabular-nums; color: #0062cc; font-size: 12px; }
  .card {
    margin-top: 8px; width: 228px; background: #ffffff; border: 1px solid #e6e9ef;
    border-radius: 12px; box-shadow: 0 10px 30px rgba(24,36,60,.18); padding: 10px;
  }
  .title { font-size: 12px; font-weight: 650; margin: 0 0 2px; }
  .sub { font-size: 11px; color: #8b96a7; margin: 0 0 8px; }
  .row { display: flex; gap: 6px; flex-wrap: wrap; }
  button {
    font: inherit; font-size: 12px; border-radius: 8px; border: 1px solid #e6e9ef;
    background: #fff; color: #263044; padding: 5px 9px; cursor: pointer;
  }
  button:hover { background: #f2f6fc; }
  button.primary { background: #007aff; border-color: #007aff; color: #fff; }
  button.primary:hover { background: #0062cc; }
  button.ghost { border-color: transparent; background: transparent; color: #768396; }
  .hint { font-size: 10.5px; color: #95a1b2; margin-top: 7px; }
  .err { color: #a3352c; font-size: 11px; margin-top: 6px; }
`;

function render(): void {
  if (!shadowRoot) return;
  const recording = currentState === 'recording';
  const paused = currentState === 'paused';
  const starting = currentState === 'starting';
  const label =
    currentState === 'recording' ? '记录中' : currentState === 'paused' ? '已暂停' : currentState === 'starting' ? '启动中…' : currentState === 'error' ? (errorMessage.includes('扩展已') ? '刷新重连' : '启动失败') : '视频记忆';

  const status = text(label);

  shadowRoot.innerHTML = `
    <style>${STYLE}</style>
    <div class="wrap">
      <div class="pill" id="pill" role="button" tabindex="0" aria-label="${text('视频记忆助手')}">
        <span class="mark ${recording ? 'rec' : ''}"><img src="${chrome.runtime.getURL('brand/icon-48.png')}" alt=""/></span>
        <span class="label">${status}</span>
        <span class="time" id="time">${currentElapsed > 0 ? formatElapsed(currentElapsed) : ''}</span>
      </div>
      ${
        expanded
          ? `<div class="card">
              <p class="title">${text(recording || paused ? '正在记录这个页面' : '把这段视频变成可检索的记忆')}</p>
              <p class="sub">${text(recording || paused ? '字幕与关键画面只保存在本地' : '点击开始后，字幕会边看边存到本地。')}</p>
              <div class="row">
                ${
                  recording || paused
                    ? `<button id="pause" class="primary">${text(paused ? '继续' : '暂停')}</button>
                       <button id="stop">${text('停止')}</button>
                       <button id="panel" class="ghost">${text('侧边栏')}</button>
                       <button id="ask" class="ghost">${text('提问')}</button>`
                    : `<button id="start" class="primary">${text(starting ? '启动中…' : currentState === 'error' && errorMessage.includes('扩展已') ? '刷新重连' : '开始记录')}</button>
                       <button id="panel" class="ghost">${text('打开侧边栏')}</button>`
                }
              </div>
              ${errorMessage ? '<div class="err"></div>' : ''}
              <div class="hint">${text('不读取其他标签页，不上传视频；可随时停止。')}</div>
            </div>`
          : ''
      }
    </div>
  `;
  const error = shadowRoot.querySelector('.err'); if (error) error.textContent = text(errorMessage);

  const pill = shadowRoot.getElementById('pill');
  pill?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    expanded = !expanded;
    render();
  });

  const bind = (id: string, fn: () => void) => {
    shadowRoot?.getElementById(id)?.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      fn();
    });
  };

  bind('start', () => void handlers?.onStart());
  bind('pause', () => {
    if (paused) void handlers?.onResume();
    else void handlers?.onPause();
  });
  bind('stop', () => void handlers?.onStop());
  bind('panel', () => handlers?.onOpenPanel());
  bind('ask', () => handlers?.onAsk());
}

export function mountLauncher(nextHandlers: LauncherHandlers): void {
  if (host) {
    handlers = nextHandlers;
    return;
  }
  handlers = nextHandlers;
  void chrome.storage.local.get('vmaUiLanguage').then(value => { if (value.vmaUiLanguage) { locale = resolveUiLocale(value.vmaUiLanguage); render(); } }).catch(() => {});
  chrome.storage.onChanged.addListener(languageChanged);
  host = document.createElement('div');
  host.id = 'vma-launcher-host';
  host.style.cssText = 'all: initial; position: fixed; right: 0; bottom: 0; width: 0; height: 0; z-index: 2147483647;';
  shadowRoot = host.attachShadow({ mode: 'open' });
  render();
  (document.fullscreenElement ?? document.documentElement).appendChild(host);
  document.addEventListener('fullscreenchange', onFullscreenChange, true);
}

function onFullscreenChange(): void {
  if (!host) return;
  const target = document.fullscreenElement ?? document.documentElement;
  if (host.parentElement !== target) target.appendChild(host);
}

export function updateLauncher(state: LauncherState, elapsedSeconds?: number, error?: string): void {
  const nextError = error ?? '';
  const stateChanged = state !== currentState || nextError !== errorMessage;
  currentState = state;
  errorMessage = nextError;
  if (elapsedSeconds !== undefined) currentElapsed = elapsedSeconds;
  if (!shadowRoot) return;
  if (stateChanged) {
    render();
    return;
  }
  // 只更新计时，避免每秒重建按钮导致点击丢失
  const time = shadowRoot.getElementById('time');
  if (time) time.textContent = currentElapsed > 0 ? formatElapsed(currentElapsed) : '';
}

export function destroyLauncher(): void {
  chrome.storage.onChanged.removeListener(languageChanged);
  document.removeEventListener('fullscreenchange', onFullscreenChange, true);
  host?.remove();
  host = null;
  shadowRoot = null;
  handlers = null;
  expanded = false;
  currentState = 'idle';
  currentElapsed = 0;
}

export function isLauncherMounted(): boolean {
  return Boolean(host);
}

export function setLauncherExpanded(value: boolean): void {
  expanded = value;
  render();
}

/** 开始记录后收起卡片，避免遮挡视频 */
export function collapseLauncher(): void {
  if (!expanded) return;
  expanded = false;
  render();
}

function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

/** 面板已有记录控制，展开时避免浮动按钮遮住面板输入区。 */
export function setLauncherHidden(hidden: boolean): void {
  if (host) host.style.display = hidden ? 'none' : '';
}
