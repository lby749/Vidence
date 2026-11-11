import { Localized } from '@/ui/i18n';
import { useEffect, useState, type ReactNode } from 'react';
import type { Settings } from '@/shared/types';
import { localAgentRequest } from '@/agent/local-agent-client';
import CapabilityDownloads from './CapabilityDownloads';
import ApiQuickSetup from './ApiQuickSetup';
import { ANSWER_LANGUAGES, ANSWER_STYLES } from '@/shared/languages';
import { UI_LANGUAGES, useUiLocale, type UiLanguage } from '@/ui/i18n';

type Category = 'assistant' | 'offline' | 'learning' | 'advanced';
const categories: Array<{ id: Category; title: string; icon: string; caption: string }> = [
  { id: 'assistant', title: 'AI 助手', icon: 'spark', caption: '连接你的学习伙伴' },
  { id: 'offline', title: '离线功能', icon: 'download', caption: '按需下载，轻装开始' },
  { id: 'learning', title: '学习偏好', icon: 'sliders', caption: '用你习惯的方式学习' },
  { id: 'advanced', title: '高级选项', icon: 'code', caption: '连接与同步的更多选项' },
];

export function SettingsIcon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    spark: <><path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4Z"/><path d="m20 2 .6 1.4L22 4l-1.4.6L20 6l-.6-1.4L18 4l1.4-.6Z"/></>,
    download: <><path d="M12 3v12m-4-4 4 4 4-4M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></>,
    sliders: <><path d="M4 7h5m4 0h7M4 17h9m4 0h3"/><circle cx="11" cy="7" r="2"/><circle cx="15" cy="17" r="2"/></>,
    code: <><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
  };
  return <Localized>{<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>}</Localized>;
}

export default function SettingsPanel({ settings, onPatch, onToast, advanced, onDiagnostics, saving = false }: {
  settings: Settings; onPatch: (patch: Partial<Settings>) => Promise<void>; onToast: (message: string) => void;
  advanced: ReactNode; onDiagnostics: () => void; saving?: boolean;
}) {
  const { preference } = useUiLocale();
  const [category, setCategory] = useState<Category>(location.hash === '#api' ? 'advanced' : new URLSearchParams(location.search).get('section') === 'offline' ? 'offline' : 'assistant');
  const [backend, setBackend] = useState<NonNullable<Settings['localAgent']>['backend']>(settings.localAgent?.backend ?? 'opencode-go');
  const [token, setToken] = useState(settings.localAgent?.token ?? '');
  const [connecting, setConnecting] = useState(false), [connected, setConnected] = useState(false), [editing, setEditing] = useState(false), [error, setError] = useState('');
  const current = categories.find(item => item.id === category)!;
  useEffect(() => {
    let alive = true;
    if (settings.localAgent?.token) void localAgentRequest(settings.localAgent, 'health').then(report => { if (alive) setConnected(Boolean(report.backends?.[settings.localAgent!.backend]?.available)); }).catch(() => { if (alive) setConnected(false); });
    return () => { alive = false; };
  }, [settings.localAgent?.token, settings.localAgent?.backend]);
  const connect = async () => {
    setConnecting(true); setError('');
    try {
      const config = { backend, token: token.trim(), model: settings.localAgent?.backend === backend ? settings.localAgent.model : undefined };
      const health = await localAgentRequest(config, 'health');
      if (!health.backends?.[backend]?.available) throw new Error('这台电脑还没有准备好所选助手，请先打开对应应用。');
      const report = await localAgentRequest(config, 'models');
      const available = report.models ?? [];
      const model = (available.some(item => item.id === config.model) ? config.model : undefined) ?? available.find(item => item.id === 'deepseek-v4.1-flash')?.id ?? available[0]?.id;
      if (!model) throw new Error('助手没有返回可用模型，请在对应应用中检查服务。');
      await onPatch({ localAgent: { ...config, model }, preferredQaRoute: 'local-agent' }); setConnected(true); setEditing(false);
      onToast('AI 助手已连接，可以开始提问了');
    } catch (error) { setError((error as Error).message); setConnected(false); }
    finally { setConnecting(false); }
  };
  const backendLabel = ({ 'opencode-go': 'OpenCode Go', dsh: 'DeepSeek Harness', codex: 'Codex', claude: 'Claude Code' })[settings.localAgent?.backend ?? backend];
  const modelLabel = settings.localAgent?.model === 'deepseek-v4.1-flash' ? 'DeepSeek V4.1 Flash' : settings.localAgent?.model;
  return <Localized>{<div className="preferences" aria-busy={saving}>
    <header className="preferences-heading"><span className="eyebrow">学习空间</span><h1>设置</h1><p>连接助手，按自己的习惯学习。</p><span className="preferences-save-state" role="status">{saving ? '正在保存…' : '自动保存'}</span></header>
    <div className="preferences-layout">
      <aside className="preferences-nav" aria-label="设置分类">
        <span className="preferences-nav-label">偏好设置</span>
        {categories.map(item => <button key={item.id} className={category === item.id ? 'active' : ''} aria-current={category === item.id ? 'page' : undefined} onClick={() => setCategory(item.id)}><SettingsIcon name={item.icon}/><span>{item.title}</span><span className="nav-chevron" aria-hidden="true">›</span></button>)}
        <div className="preferences-local"><span className="local-dot"/><span>学习记录保存在这台设备</span></div>
      </aside>
      <main className="preferences-content" key={category}>
        <div className="preferences-section-heading"><h2>{current.title}</h2><p>{current.caption}</p></div>
        {category === 'assistant' && <>
          <ApiQuickSetup settings={settings} onPatch={onPatch}/>
          <section className="assistant-card">
            <div className="assistant-card-top"><div className="assistant-orb"><SettingsIcon name="spark"/></div><span className={`connection-status ${connected ? 'connected' : ''}`}><span/>{connected ? '已连接' : '等待连接'}</span></div>
            <h3>{connected ? '学习伙伴，已就位。' : '给学习找个好伙伴。'}</h3>
            <p>{connected ? '看过的内容先整理成摘要，再用于回答。每个视频都有自己的记忆和对话。' : '连接电脑上已有的 AI 助手，让它帮你梳理知识、解答疑惑。'}</p>
            {settings.localAgent?.model && <div className="assistant-account"><div className="assistant-monogram">{backendLabel[0]}</div><div><strong>{backendLabel}</strong><span>{modelLabel}</span></div><button className="text-button" onClick={() => setEditing(!editing)}>{editing ? '收起' : '管理连接'}</button></div>}
            {!settings.localAgent?.model && !editing && <button className="btn primary setup-primary" onClick={() => setEditing(true)}>连接 AI 助手 <span>↗</span></button>}
            {editing && <div className="connection-form">
              <label className="setting-label">使用哪个助手？<select className="field" value={backend} onChange={event => setBackend(event.target.value as typeof backend)}><option value="opencode-go">OpenCode Go</option><option value="dsh">DeepSeek Harness</option><option value="codex">Codex</option><option value="claude">Claude Code</option></select></label>
              <label className="setting-label">连接码<input className="field" type="password" autoComplete="off" placeholder="粘贴启动助手时复制的连接码" value={token} onChange={event => setToken(event.target.value)}/></label>
              <p className="setup-help">先双击程序目录里的“启动本地智能体”，连接码会自动复制。回到这里粘贴，连接一次即可。</p>
              <button className="btn primary" disabled={connecting || !token.trim()} onClick={() => void connect()}>{connecting ? '正在连接…' : '连接并保存'}</button>
              {error && <p className="setup-error" role="alert">{error}</p>}
              <p className="setup-help">连接后，在视频的学习侧栏里直接切换智能体和模型。</p>
            </div>}
          </section>
          <div className="settings-footnote"><SettingsIcon name="check"/><p>视频记录保存在本地。提问时，摘要与按需核对的内容会发送给你连接的 AI 服务。</p></div>
          <button className="text-button other-connections" onClick={() => setCategory('advanced')}>已有其他 AI 服务？查看连接选项 <span>›</span></button>
        </>}
        {category === 'offline' && <CapabilityDownloads settings={settings} onPatch={onPatch}/>}
        {category === 'learning' && <section className="preference-card">
          <label className="preference-row"><span><strong>界面语言</strong><small>界面语言与回答语言可以分别设置。工具、API 服务和视频平台按界面语言排序。</small></span><select aria-label="界面语言" className="language-select" value={preference} onChange={event => void onPatch({ uiLanguage: event.target.value as UiLanguage })}>{Object.entries(UI_LANGUAGES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="preference-row"><span><strong>回答与摘要的语言</strong><small>外语字幕保留原始内容，按你习惯的语言整理和解释。</small></span><select aria-label="回答与摘要的语言" className="language-select" value={settings.answerLanguage ?? 'zh-CN'} onChange={event => void onPatch({ answerLanguage: event.target.value as Settings['answerLanguage'] })}>{Object.entries(ANSWER_LANGUAGES).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <label className="preference-row"><span><strong>回答与整理的风格</strong><small>{ANSWER_STYLES[settings.answerStyle ?? 'balanced'].description} 自动用于聊天和记忆整理。</small></span><select aria-label="回答与整理的风格" className="language-select" value={settings.answerStyle ?? 'balanced'} onChange={event => void onPatch({ answerStyle: event.target.value as Settings['answerStyle'] })}>{Object.entries(ANSWER_STYLES).map(([value, style]) => <option value={value} key={value}>{style.title}</option>)}</select></label>
          <PreferenceSwitch title="允许发送视频截图" description="使用支持图片的 AI 服务时，可以在提问时选择附带画面。" checked={settings.privacy.allowVisionUpload} onChange={allowVisionUpload => void onPatch({ privacy: { ...settings.privacy, allowVisionUpload } })}/>
          <PreferenceSwitch title="自动筛选知识画面" description="记录结束后，用当前助手识别知识点，过滤纯讲者、开场和片尾。会发送截图；原图仍保存在本机。" checked={settings.privacy.autoVisionOrganize} onChange={autoVisionOrganize => void onPatch({ privacy: { ...settings.privacy, autoVisionOrganize, allowVisionUpload: autoVisionOrganize || settings.privacy.allowVisionUpload } })}/>
        </section>}
        {category === 'advanced' && <><p className="advanced-intro">日常使用无需调整这些选项。这里保留自定义 AI 服务、性能参数和 Notion 同步。</p>{advanced}<button className="text-button" onClick={onDiagnostics}>查看运行诊断 <span>↗</span></button></>}
      </main>
    </div>
  </div>}</Localized>;
}

function PreferenceSwitch({ title, description, checked, onChange }: { title: string; description: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <Localized>{<label className="preference-row"><span><strong>{title}</strong><small>{description}</small></span><input className="preference-switch" type="checkbox" role="switch" checked={checked} onChange={event => onChange(event.target.checked)}/></label>}</Localized>;
}
