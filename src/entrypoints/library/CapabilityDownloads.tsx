import { Localized } from '@/ui/i18n';
import { useEffect, useRef, useState } from 'react';
import { downloadTier, installedCapabilities, tierCapabilities, tierDownloadBytes } from '@/models/downloads';
import { RESOURCE_TIERS, currentResourceTier, type ResourceTier } from '@/shared/resource-tiers';
import type { Settings } from '@/shared/types';

export default function CapabilityDownloads({ settings, onPatch }: { settings: Settings; onPatch: (patch: Partial<Settings>) => Promise<void> }) {
  const [installed, setInstalled] = useState<Record<string, boolean> | null>(null);
  const [busy, setBusy] = useState(false);
  const active = currentResourceTier(settings);
  const [selected, setSelected] = useState<ResourceTier>(active);
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => { void installedCapabilities().then(setInstalled).catch(error => setError(error.message)); return () => controller.current?.abort(); }, []);
  const download = async () => {
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setPercent(0); setError(''); setMessage('');
    try {
      await downloadTier(selected, abort.signal, (loaded, total) => setPercent(Math.round(loaded / total * 100)));
      abort.signal.throwIfAborted();
      await onPatch({ resourceTier: selected });
      setMessage(`${RESOURCE_TIERS.find(tier => tier.id === selected)!.title}已启用。`);
    } catch (error) {
      setError(abort.signal.aborted ? '下载已取消，完成的文件保留，之后可继续。' : (error as Error).message);
    } finally {
      setInstalled(await installedCapabilities()); setBusy(false);
    }
  };
  const ready = selected === 'none' || installed && tierCapabilities(selected).every(item => installed[item.id]);
  const title = RESOURCE_TIERS.find(tier => tier.id === selected)!.title;
  return <Localized>{<section className="tier-panel">
    <p className="download-intro">让占用，由你决定。</p>
    <p className="download-explanation">选一个适合你的档位，应用会准备对应功能。无需挑选模型。</p>
    <fieldset className="tier-grid"><legend className="sr-only">本地占用档位</legend>{RESOURCE_TIERS.map(tier => <label key={tier.id} className={`tier-card ${selected === tier.id ? 'selected' : ''}`}>
      <input type="radio" name="resource-tier" aria-label={tier.title} checked={selected === tier.id} disabled={busy} onChange={() => { setSelected(tier.id); setError(''); setMessage(''); }}/>
      <span className="tier-card-heading"><strong>{tier.title}</strong><span className="tier-check">{selected === tier.id ? '✓' : ''}</span></span>
      <span className="tier-caption">{tier.caption}</span><span className="tier-description">{tier.description}</span>
      <span className="tier-card-footer"><span>{tierDownloadBytes(tier.id) ? `${(tierDownloadBytes(tier.id) / 1e6).toFixed(1)} MB` : '无需下载'}</span><span>{active === tier.id ? '当前档位' : '本地功能'}</span></span>
    </label>)}</fieldset>
    <div className="tier-action"><div><strong>{title}</strong><p>{selected === 'none' ? '不加载本地 AI 模型，AI 回答仍使用你连接的服务。' : ready ? '所需文件已就绪，启用即可。' : `首次需准备约 ${(tierDownloadBytes(selected) / 1e6).toFixed(1)} MB，已下载的文件会复用。`}</p></div>
      <button className="btn primary" disabled={busy || (!installed && selected !== 'none') || (active === selected && Boolean(ready))} onClick={() => void download()}>{busy ? '正在准备…' : !installed && selected !== 'none' ? '正在检查资源…' : active === selected && ready ? '当前档位' : ready ? `启用${title}` : `下载并启用${title}`}</button>
    </div>
    {busy && <div className="tier-progress"><progress aria-label="档位下载进度" value={percent} max={100}/><span>{percent}%</span><button className="text-button" onClick={() => controller.current?.abort()}>取消下载</button></div>}
    <p className="tier-note">“无占用”指不加载本地 AI 模型，应用本身仍有基础占用。降档会卸载当前本地计算；已下载文件保留，切回来不用重下。</p>
    <details className="tier-details"><summary>本档包含哪些功能</summary>{tierCapabilities(selected).map(item => <div className="capability-row" key={item.id}><div><strong>{item.title}</strong><p className="muted">{item.description}</p><span className="muted">{installed?.[item.id] ? '文件已就绪' : installed ? '尚未下载' : '正在检查资源…'}</span></div></div>)}{selected === 'none' && <p className="muted">已有字幕记录与关键词检索，无需本地模型。</p>}</details>
    {message && <p role="status" className="tier-success">{message}</p>}
    {error && <p role="alert">{error}</p>}
  </section>}</Localized>;
}
