import { useEffect, useState } from 'react';
import { APP_VERSION, checkAppUpdate, deferAppUpdate, readUpdateState, setAutomaticUpdates } from '@/shared/app-updates';
import { Localized } from './i18n';
const FEEDBACK_URL = 'https://github.com/lby749/lby/issues/new/choose';

export default function AppUpdates({ compact = false }: { compact?: boolean }) {
  const [state, setState] = useState(readUpdateState), [checking, setChecking] = useState(false);
  const check = async (force = false) => { setChecking(true); try { setState(await checkAppUpdate(force)); } finally { setChecking(false); } };
  useEffect(() => {
    const sync = () => setState(readUpdateState()), automatic = () => { void check(); };
    window.addEventListener('vma:app-updates', sync); window.addEventListener('storage', sync); window.addEventListener('focus', automatic);
    automatic(); const timer = setInterval(automatic, 3600000);
    return () => { clearInterval(timer); window.removeEventListener('vma:app-updates', sync); window.removeEventListener('storage', sync); window.removeEventListener('focus', automatic); };
  }, []);
  const update = state.update, visible = update && state.auto && (state.deferredVersion !== update.version || (state.deferredUntil ?? 0) <= Date.now());
  if (compact && !visible) return null;
  return <Localized><section className={compact ? 'app-update-banner' : 'app-update-card'} aria-label="应用更新">
    {!compact && <><div className="app-update-heading"><div><h3>应用更新</h3><p>当前版本 <span translate="no">{APP_VERSION}</span></p></div><button className="btn" onClick={() => void check(true)} disabled={checking}>{checking ? '正在检查更新…' : '检查更新'}</button></div><label className="app-update-toggle"><input type="checkbox" checked={state.auto} onChange={event => setState(setAutomaticUpdates(event.target.checked))}/>自动提醒新版本</label><p className="muted">每天检查一次应用版本。</p></>}
    {update ? <div className="app-update-available"><div><strong>发现新版本 <span translate="no">{update.version}</span></strong>{!compact && update.notes && <details><summary>更新说明</summary><p className="app-update-notes" translate="no">{update.notes}</p></details>}</div><div className="app-update-actions"><button className="btn primary" onClick={() => window.open(update.url, '_blank', 'noopener,noreferrer')}>查看更新</button>{compact && <button className="btn ghost" onClick={() => setState(deferAppUpdate(update.version))}>稍后提醒</button>}</div></div> : !compact && <p role="status" className="muted">{checking ? '正在检查更新…' : state.error === 'unavailable' ? '更新服务暂不可用，请稍后重试。' : state.error ? '暂时无法连接更新服务。' : state.checkedAt ? '当前已是最新版本。' : '检查后可查看是否有新版本。'}</p>}
    {!compact && <div className="app-update-feedback"><p className="muted">项目仍在 BETA 测试阶段，欢迎提出问题和改进建议。</p><button className="btn ghost" onClick={() => window.open(FEEDBACK_URL, '_blank', 'noopener,noreferrer')}>反馈问题或建议 ↗</button></div>}
  </section></Localized>;
}
