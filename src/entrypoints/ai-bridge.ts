/**
 * AI 应用网页辅助连接器（内容脚本）。
 *
 * 只操作正常可见的交互界面：定位输入框、填入问题、在用户确认后提交、读取可见回答。
 * 不读取 Cookie/令牌，不调用私有接口，不绕过验证码或登录限制。
 */

import { defineContentScript } from 'wxt/utils/define-content-script';
import type { ConnectorProfile } from '@/aiapps/registry';

export interface AiBridgeMessage {
  type: 'ai:probe' | 'ai:fill' | 'ai:read' | 'ai:clear' | 'ai:focus';
  payload?: {
    profile?: ConnectorProfile;
    text?: string;
    submit?: boolean;
  };
}

export interface AiProbeResult {
  ready: boolean;
  inputFound: boolean;
  sendFound: boolean;
  assistantCount: number;
  lastAssistantText: string;
  url: string;
  title: string;
  loginLikely: boolean;
}

export interface AiReadResult {
  assistantCount: number;
  lastAssistantText: string;
  generating: boolean;
  url: string;
}

function visible(el: Element | null): el is HTMLElement {
  if (!el || !(el instanceof HTMLElement)) return false;
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
}

function queryFirst(selectors: string[] | undefined): HTMLElement | null {
  if (!selectors) return null;
  for (const selector of selectors) {
    try {
      const nodes = [...document.querySelectorAll(selector)];
      const found = nodes.find((node) => visible(node));
      if (found) return found as HTMLElement;
    } catch {
      /* 无效选择器忽略 */
    }
  }
  return null;
}

function queryAll(selectors: string[] | undefined): HTMLElement[] {
  if (!selectors) return [];
  const result: HTMLElement[] = [];
  for (const selector of selectors) {
    try {
      for (const node of document.querySelectorAll(selector)) {
        if (visible(node)) result.push(node as HTMLElement);
      }
    } catch {
      /* ignore */
    }
  }
  // 去重 + 文档顺序
  return [...new Set(result)].sort((a, b) =>
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
  );
}

function setText(el: HTMLElement, text: string): boolean {
  el.focus();
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter?.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  // contenteditable：优先使用原生命令，保留站点编辑器的输入事件
  try {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const ok = document.execCommand('insertText', false, text);
    if (!ok) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    }
    return true;
  } catch {
    el.textContent = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    return true;
  }
}

function submit(input: HTMLElement, profile: ConnectorProfile): boolean {
  const button = queryFirst(profile.selectors.send);
  if (button && !button.hasAttribute('disabled') && button.getAttribute('aria-disabled') !== 'true') {
    button.click();
    return true;
  }
  // 回车发送
  const eventInit: KeyboardEventInit = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
  input.dispatchEvent(new KeyboardEvent('keydown', eventInit));
  input.dispatchEvent(new KeyboardEvent('keyup', eventInit));
  return true;
}

function assistantMessages(profile: ConnectorProfile): HTMLElement[] {
  return queryAll(profile.selectors.assistant);
}

function textOf(el: HTMLElement): string {
  return (el.innerText || el.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

export default defineContentScript({
  matches: [
    'https://chatgpt.com/*',
    'https://chat.openai.com/*',
    'https://claude.ai/*',
    'https://chat.deepseek.com/*',
    'https://kimi.moonshot.cn/*',
    'https://gemini.google.com/*',
  ],
  runAt: 'document_idle',
  main() {
    chrome.runtime.onMessage.addListener((message: AiBridgeMessage, _sender, sendResponse) => {
      if (!message || !message.type?.startsWith('ai:')) return false;
      const profile = message.payload?.profile;
      if (!profile) {
        sendResponse({ ok: false, error: '缺少连接器配置' });
        return false;
      }
      try {
        switch (message.type) {
          case 'ai:probe': {
            const input = queryFirst(profile.selectors.input);
            const send = queryFirst(profile.selectors.send);
            const messages = assistantMessages(profile);
            const loginLikely = !input && /log in|sign in|登录|注册/i.test(document.body.innerText.slice(0, 2000));
            const result: AiProbeResult = {
              ready: Boolean(input),
              inputFound: Boolean(input),
              sendFound: Boolean(send),
              assistantCount: messages.length,
              lastAssistantText: messages.length > 0 ? textOf(messages[messages.length - 1]!) : '',
              url: location.href,
              title: document.title,
              loginLikely,
            };
            sendResponse({ ok: true, data: result });
            break;
          }
          case 'ai:fill': {
            const input = queryFirst(profile.selectors.input);
            if (!input) {
              sendResponse({ ok: false, error: 'login_required', message: '找不到输入框，可能未登录或页面结构已变化' });
              break;
            }
            const text = message.payload?.text ?? '';
            const filled = setText(input, text);
            if (!filled) {
              sendResponse({ ok: false, error: 'fill_failed', message: '无法写入输入框' });
              break;
            }
            if (message.payload?.submit) {
              // 让站点编辑器完成状态更新后再提交
              setTimeout(() => {
                const submitted = submit(input, profile);
                sendResponse({ ok: true, data: { filled: true, submitted } });
              }, 350);
              return true;
            }
            sendResponse({ ok: true, data: { filled: true, submitted: false } });
            break;
          }
          case 'ai:read': {
            const messages = assistantMessages(profile);
            const last = messages[messages.length - 1];
            const generating = Boolean(queryFirst(profile.selectors.stop)) || Boolean(document.querySelector('[aria-busy="true"]'));
            const result: AiReadResult = {
              assistantCount: messages.length,
              lastAssistantText: last ? textOf(last) : '',
              generating,
              url: location.href,
            };
            sendResponse({ ok: true, data: result });
            break;
          }
          case 'ai:focus': {
            const input = queryFirst(profile.selectors.input);
            input?.focus();
            sendResponse({ ok: true, data: { focused: Boolean(input) } });
            break;
          }
          case 'ai:clear': {
            const input = queryFirst(profile.selectors.input);
            if (input) setText(input, '');
            sendResponse({ ok: true, data: { cleared: Boolean(input) } });
            break;
          }
          default:
            sendResponse({ ok: false, error: 'unknown_action' });
        }
      } catch (error) {
        sendResponse({ ok: false, error: 'bridge_error', message: (error as Error).message });
      }
      return false;
    });
  },
});
