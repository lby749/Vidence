import { resolveUiLocale, translateUi, type UiLocale, type UiLanguage } from './locale-text';
export * from './locale-text';
import { cloneElement, createContext, isValidElement, useContext, useEffect, useState, type ReactNode, type ReactElement } from 'react';
import { liveQuery } from 'dexie';
import { getDb, getSettings } from '@/db/db';

const LocaleContext = createContext<{ locale: UiLocale; preference: UiLanguage }>({ locale: 'zh-CN', preference: 'zh-CN' });
export const useUiLocale = () => useContext(LocaleContext);
export function UiLocaleProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<UiLanguage>('zh-CN'), [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true, subscription: { unsubscribe: () => void } | undefined;
    void getSettings().then(settings => {
      if (!alive) return;
      setPreference(settings.uiLanguage ?? 'zh-CN'); setReady(true);
      subscription = liveQuery(() => getDb().settings.get('app')).subscribe({ next: settings => { if (settings) setPreference(settings.uiLanguage ?? 'zh-CN'); } });
    });
    return () => { alive = false; subscription?.unsubscribe(); };
  }, []);
  const locale = resolveUiLocale(preference);
  useEffect(() => {
    if (!ready) return;
    document.documentElement.lang = locale;
    if (typeof chrome !== 'undefined' && chrome.storage?.local) void chrome.storage.local.set({ vmaUiLanguage: preference }).catch(() => {});
  }, [locale, preference, ready]);
  return <LocaleContext.Provider value={{ locale, preference }}>{ready ? children : null}</LocaleContext.Provider>;
}

function translateTree(node: ReactNode, locale: UiLocale): ReactNode {
  if (typeof node === 'string') return translateUi(node, locale);
  if (Array.isArray(node)) return node.map(child => translateTree(child, locale));
  if (!isValidElement(node) || node.type === Localized) return node;
  const element = node as ReactElement<Record<string, unknown>>, props = element.props;
  if (props.translate === 'no' || ['pre','code','blockquote'].includes(String(element.type)) || /(?:^|\s)(?:user-message|rich-text|video-item-title|node-title|memory-video-title)(?:\s|$)/.test(String(props.className ?? ''))) return node;
  const attributes: Record<string, unknown> = {};
  for (const name of ['aria-label', 'placeholder', 'title']) if (typeof props[name] === 'string') attributes[name] = translateUi(props[name], locale);
  // option 的实际值保持原样；语言切换只改变显示，不改变用户选中的渠道。
  if (element.type === 'option' && props.value === undefined && typeof props.children === 'string') attributes.value = props.children;
  if ('children' in props) attributes.children = translateTree(props.children as ReactNode, locale);
  return cloneElement(element, attributes);
}
/** 在 React 渲染前翻译界面，不修改 DOM，也不处理用户输入和 RichText 正文。 */
export function Localized({ children }: { children: ReactNode }) {
  const { locale } = useUiLocale();
  return translateTree(children, locale);
}
