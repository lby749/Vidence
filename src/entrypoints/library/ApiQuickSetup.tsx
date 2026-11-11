import { Localized } from '@/ui/i18n';
import { useEffect, useRef, useState } from 'react';
import type { ProviderConfig, Settings } from '@/shared/types';
import { API_SERVICES, discoverModels, normalizeApiBase, suggestedModel } from '@/providers/discovery';
import { createAdapter, recordUsage } from '@/providers';
import { uid } from '@/shared/ids';
import { useUiLocale } from '@/ui/i18n';
import { orderForLocale } from '@/ui/locale-order';

export default function ApiQuickSetup({ settings, onPatch }: { settings: Settings; onPatch: (patch: Partial<Settings>) => Promise<void> }) {
  const { locale } = useUiLocale();
  const services = orderForLocale(API_SERVICES, locale, 'api', item => item.id);
  const [service, setService] = useState<string>(services[0].id), [key, setKey] = useState(''), [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const [models, setModels] = useState<Array<{ id: string; label: string }>>([]), [model, setModel] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const connect = async (onlyDiscover = false) => {
    const preset = API_SERVICES.find(item => item.id === service)!;
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError(''); setMessage('正在获取可用模型…');
    try {
      const baseUrl = normalizeApiBase(service === 'custom' ? address : preset.baseUrl);
      const existing = settings.providers.find(provider => provider.baseUrl?.replace(/\/+$/, '') === baseUrl && provider.kind === preset.kind);
      const provider: ProviderConfig = { id: existing?.id ?? uid('provider'), label: service === 'custom' ? new URL(baseUrl).hostname : preset.label, kind: preset.kind, baseUrl, apiKey: key.trim() };
      const available = await discoverModels(provider, abort.signal); setModels(available);
      if (model && !available.some(item => item.id === model)) throw new Error('请选择模型列表中的一个名称');
      const chosen = model || suggestedModel(available); setModel(chosen);
      if (onlyDiscover) { setMessage(`已获取 ${available.length} 个聊天模型。可以自行选择，再连接使用。`); return; }
      setMessage('正在测试一条简短消息…');
      let output = '', inputTokens = 0, outputTokens = 0, reported = false;
      const started = Date.now();
      try {
        for await (const event of createAdapter(provider).chat({ model: chosen, messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply only OK.' }] }], maxTokens: 64, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(45000)]) })) {
          if (event.type === 'text') output += event.delta;
          if (event.type === 'usage') { reported = true; inputTokens = event.inputTokens; outputTokens = event.outputTokens; }
          if (event.type === 'error') throw new Error(`模型连接测试未通过${event.status ? `（${event.status}）` : ''}，可换一个模型再试。`);
        }
        if (!output.trim()) throw new Error('模型没有返回文字，可换一个模型再试。');
      } finally {
        await recordUsage({ providerId: provider.id, modelId: chosen, role: 'answer', inputTokens, outputTokens, images: 0, toolRounds: 0, tokenStatus: reported ? 'reported' : 'unavailable', status: output ? 'completed' : 'failed', calls: 1, unknownTokenCalls: reported ? 0 : 1, durationMs: Date.now() - started, inputChars: 14, outputChars: output.length });
      }
      if (abort.signal.aborted) return;
      await onPatch({ providers: [...settings.providers.filter(item => item.id !== provider.id), { ...provider, models: available }], roles: { ...settings.roles, answerModel: { providerId: provider.id, modelId: chosen }, organizeModel: { providerId: provider.id, modelId: chosen } }, preferredQaRoute: 'api' });
      setKey(''); setMessage(`已连接 ${provider.label} · ${available.length} 个聊天模型。问答和摘要已配置。`);
    } catch (error) { if (!abort.signal.aborted) { setError((error as Error).message.replaceAll(key.trim(), '••••')); setMessage(''); } }
    finally { if (!abort.signal.aborted) setBusy(false); }
  };
  return <Localized>{<section className="api-quick-setup"><div className="connection-section-heading"><span className="assistant-avatar">↗</span><div><h3>用 API Key 连接</h3><p>获取模型、测试连接、配置问答与摘要，一次完成。</p></div></div>
    <div className="api-services" aria-label="API 服务">{services.map(item => <button key={item.id} disabled={busy} aria-pressed={service === item.id} onClick={() => { setService(item.id); setKey(''); setModels([]); setModel(''); setMessage(''); setError(''); }}>{item.label}</button>)}</div>
    {service === 'custom' && <label className="setting-label">服务地址<input className="field" aria-label="API 服务地址" type="url" placeholder="https://你的服务地址/v1" value={address} disabled={busy} onChange={event => { setAddress(event.target.value); setModels([]); setModel(''); }}/></label>}
    <label className="setting-label">API Key<input className="field" type="password" autoComplete="off" aria-label="一键配置 API Key" placeholder="粘贴你的 API Key" value={key} disabled={busy} onChange={event => { setKey(event.target.value); setModels([]); setModel(''); }}/></label>
    {models.length > 0 && key && <label className="setting-label">聊天与摘要使用<input className="field" aria-label="自动获取的 API 模型" list="api-discovered-models" value={model} onChange={event => setModel(event.target.value)} disabled={busy}/><datalist id="api-discovered-models">{models.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</datalist></label>}
    <div className="api-connect-actions"><button className="btn primary setup-primary" disabled={busy || !key.trim() || (service === 'custom' && !address.trim())} onClick={() => void connect()}>{busy ? '正在配置…' : models.length ? '连接并使用所选模型' : '一键连接并配置'}<span>↗</span></button><button className="text-button" disabled={busy || !key.trim() || (service === 'custom' && !address.trim())} onClick={() => void connect(true)}>自己选择模型</button></div>
    <p className="setup-help">Key 仅保存在本机，仅发给所选服务。连接时发送一句简短测试消息。</p>
    {message && <p className="setup-success" role="status">{message}</p>}{error && <p className="setup-error" role="alert">{error}</p>}
  </section>}</Localized>;
}
