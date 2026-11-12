import { Localized } from '@/ui/i18n';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { saveSettings } from '@/db/db';
import { localAgentRequest } from '@/agent/local-agent-client';
import type { Settings } from '@/shared/types';
import { discoverModels } from '@/providers/discovery';
import { useUiLocale } from '@/ui/i18n';
import { orderForLocale, apiChannelId } from '@/ui/locale-order';

type Backend = NonNullable<Settings['localAgent']>['backend'] | 'api';
const assistants: Array<{ id: Backend; name: string; caption: string; mark: string }> = [
  { id: 'opencode-go', name: 'OpenCode Go', caption: '使用你已连接的模型目录', mark: 'O' },
  { id: 'dsh', name: 'DeepSeek Harness', caption: '使用 DeepSeek 账号', mark: 'D' },
  { id: 'codex', name: 'Codex', caption: '使用本机 Codex CLI', mark: 'C' },
  { id: 'claude', name: 'Claude Code', caption: '使用本机 Claude Code', mark: '✳' },
  { id: 'api', name: 'API 服务', caption: '使用自己连接的服务', mark: '↗' },
];
const family = (name: string) => /deepseek/i.test(name) ? 'DeepSeek' : /^(gpt|o[134]-)/i.test(name) ? 'OpenAI' : /claude|sonnet|opus|haiku/i.test(name) ? 'Claude' : /glm/i.test(name) ? 'GLM' : /kimi/i.test(name) ? 'Kimi' : /qwen/i.test(name) ? 'Qwen' : '更多模型';

export default function AssistantPicker({ settings, onSettings, disabled, inline = false }: { settings: Settings; onSettings: (settings: Settings) => void; disabled: boolean; inline?: boolean }) {
  const { locale } = useUiLocale();
  const tools = orderForLocale(assistants, locale, 'agent', item => item.id);
  const channels = orderForLocale(settings.providers, locale, 'api', apiChannelId);
  const chosenBackend = settings.preferredQaRoute === 'api' ? 'api' : settings.localAgent?.backend ?? 'opencode-go';
  const [open, setOpen] = useState(false), [backend, setBackend] = useState<Backend>(chosenBackend);
  const [providerId, setProviderId] = useState(settings.roles.answerModel?.providerId ?? settings.providers[0]?.id ?? '');
  const [models, setModels] = useState<Array<{ id: string; label: string }>>([]), [query, setQuery] = useState('');
  const [health, setHealth] = useState<Record<string, { available: boolean; reason: string }>>({});
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null), search = useRef<HTMLInputElement>(null), anchor = useRef<HTMLDivElement>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!inline) { if (open) dialog.current?.showModal(); else dialog.current?.close(); }
  }, [open, inline]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setModels([]); setError(''); setQuery('');
    setLoading(true);
    void (async () => {
      try {
        if (backend === 'api') {
          const provider = settings.providers.find(item => item.id === providerId);
          if (!provider) throw new Error('请先在设置中用 API Key 连接一个服务。');
          const list = provider.models && refresh === 0 ? provider.models : await discoverModels(provider, controller.signal);
          if (!controller.signal.aborted) setModels(list);
          return;
        }
        if (!settings.localAgent?.token) throw new Error('请先在设置中连接电脑上的 AI 助手。');
        const config = { ...settings.localAgent, backend };
        const report = await localAgentRequest(config, 'health', undefined, controller.signal);
        if (controller.signal.aborted) return;
        setHealth(report.backends ?? {});
        if (!report.backends?.[backend]?.available) throw new Error(report.backends?.[backend]?.reason ?? '这个助手尚未准备好');
        const list = await localAgentRequest(config, 'models', undefined, controller.signal);
        if (!controller.signal.aborted) setModels(list.models ?? []);
      } catch (error) { if (!controller.signal.aborted) setError((error as Error).message); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [open, backend, refresh, providerId]);
  const choose = async (model: string) => {
    if (saving) return;
    setSaving(true); setError('');
    try {
      if (backend !== 'api' && !settings.localAgent) throw new Error('请先连接这个助手');
      const updated = await saveSettings(backend === 'api' ? { preferredQaRoute: 'api', providers: settings.providers.map(provider => provider.id === providerId ? { ...provider, models } : provider), roles: { ...settings.roles, answerModel: { providerId, modelId: model } } } : { preferredQaRoute: 'local-agent', localAgent: { ...settings.localAgent!, backend, model } });
      onSettings(updated); setOpen(false);
    } catch (error) { setError((error as Error).message); }
    finally { setSaving(false); }
  };
  const current = assistants.find(item => item.id === chosenBackend);
  const currentProvider = settings.providers.find(item => item.id === settings.roles.answerModel?.providerId);
  const modelId = chosenBackend === 'api' ? settings.roles.answerModel?.modelId : settings.localAgent?.model;
  const filtered = models.filter(model => `${model.label} ${model.id}`.toLowerCase().includes(query.trim().toLowerCase()));
  const groups = new Map<string, typeof models>();
  for (const model of filtered) { const group = family(model.label); groups.set(group, [...(groups.get(group) ?? []), model]); }
  const orderedGroups = orderForLocale([...groups], locale, 'family', ([group]) => group);
  const panelContent = <>
      <header><div><span className="eyebrow">为这次学习选择</span><h2 id="assistant-picker-title">AI 助手与模型</h2></div><button className="picker-close" aria-label="关闭助手选择" disabled={saving} onClick={() => setOpen(false)}>×</button></header>
      <div className="assistant-options" aria-label="智能体工具">{tools.map(item => <button key={item.id} aria-pressed={backend === item.id} disabled={saving} onClick={() => setBackend(item.id)}><span className="assistant-avatar">{item.mark}</span><span><strong>{item.name}</strong><small>{health[item.id]?.available === false ? health[item.id].reason : item.caption}</small></span>{backend === item.id && <span className="picker-check">✓</span>}</button>)}</div>
      {backend === 'api' && settings.providers.length > 0 && <div className="api-provider-options" aria-label="已连接的 API 服务">{channels.map(provider => <button key={provider.id} aria-pressed={providerId === provider.id} disabled={saving} onClick={() => setProviderId(provider.id)}>{provider.label}</button>)}</div>}
      <div className="model-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg><input ref={search} type="search" aria-label="搜索模型" placeholder="搜索模型名称…" value={query} onChange={event => setQuery(event.target.value)}/><button className="text-button" aria-label="刷新模型列表" disabled={loading || saving} onClick={() => setRefresh(value => value + 1)}>刷新</button></div>
      <div className="model-results" aria-busy={loading}>
        {loading ? <p className="picker-message" role="status">正在读取这个助手的模型…</p> : error ? <p className="picker-message setup-error" role="alert">{error}</p> : !filtered.length ? <p className="picker-message">{models.length ? '没有找到匹配的模型。' : '这个助手没有返回可选模型，请在对应应用中检查连接。'}</p> : Array.from(orderedGroups, ([group, rows]) => <section key={group}><h3>{group}</h3>{rows.map(model => { const selected = chosenBackend === backend && modelId === model.id && (backend !== 'api' || providerId === currentProvider?.id); return <button className="model-option" key={model.id} aria-pressed={selected} disabled={saving} onClick={() => void choose(model.id)}><span>{model.label}</span>{selected && <span className="picker-check">✓</span>}</button>; })}</section>)}
      </div>
      <footer>{saving ? '正在切换…' : `点击模型即可切换${models.length ? ` · 共 ${models.length} 个模型` : ''}`}</footer>
  </>;
  return <Localized>{<div className="assistant-picker-anchor" ref={anchor}>
    <div className="assistant-toolbar">
      <button className="assistant-switch" aria-label="切换智能体" disabled={disabled} onClick={() => { setBackend(chosenBackend); setOpen(true); }}><span className="assistant-avatar">{current?.mark ?? '✧'}</span><span>{chosenBackend === 'api' ? currentProvider?.label ?? 'API 服务' : current?.name ?? '连接 AI 助手'}</span><span className="picker-chevron">⌄</span></button>
      <button className="model-switch" aria-label="选择聊天模型" disabled={disabled} title={modelId} onClick={() => { setBackend(chosenBackend); setOpen(true); requestAnimationFrame(() => search.current?.focus()); }}><span>{modelId ?? '选择模型'}</span><span className="picker-chevron">⌄</span></button>
    </div>
    {inline ? open && anchor.current?.closest('.study-sidebar, .browser-sidepanel') && createPortal(<Localized><section className="assistant-picker is-inline" aria-label="侧栏助手与模型" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } }}>{panelContent}</section></Localized>, anchor.current.closest('.study-sidebar, .browser-sidepanel')!) : <dialog ref={dialog} className="assistant-picker" aria-labelledby="assistant-picker-title" onCancel={event => { event.preventDefault(); if (!saving) setOpen(false); }} onClick={event => { if (event.target === event.currentTarget && !saving) setOpen(false); }}>
{panelContent}
    </dialog>}
  </div>}</Localized>;
}
