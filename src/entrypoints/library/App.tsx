import { Localized, useUiLocale, translateUi } from '@/ui/i18n';
import { liveQuery } from 'dexie';
import { orderForLocale, apiChannelId } from '@/ui/locale-order';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getDb, getSettings, saveSettings, wipeDatabase } from '@/db/db';
import { exportBundle, importBundle, serializeExport, validateImport } from '@/export/bundle';
import type { Evidence, Keyframe, MemoryNode, Settings, Video } from '@/shared/types';
import type { DiagnosticsReport } from '@/background/diagnostics';
import { formatClock, sendUi } from '@/ui/chrome';

import LongMemoryPage from './LongMemoryPage';
import VideoConversation from './VideoConversation';
import SettingsPanel from './SettingsPanel';
import AppUpdates from '@/ui/AppUpdates';
import { reviewKnowledgeFrames, isKnowledgeFrame, isUncertainFrame } from '@/agent/knowledge-frames';
import { videoUrlAt } from '@/ui/chrome';

type TabKey = 'library' | 'memory' | 'settings' | 'diagnostics';

export default function App({ onNewSource }: { onNewSource?: () => void } = {}) {
  const { locale } = useUiLocale();
  const [tab, setTab] = useState<TabKey>(() => {
    const requested = new URLSearchParams(location.search).get('tab');
    return requested === 'settings' || requested === 'memory' ? requested : 'library';
  });
  const [videos, setVideos] = useState<Video[]>([]);
  const [activeVideoId, setActiveVideoId] = useState<string | null>(() => new URLSearchParams(location.search).get('videoId'));
  const [videoView, setVideoView] = useState<'chat' | 'notes'>('chat');
  const searchEpoch = useRef(0);
  const [nodes, setNodes] = useState<MemoryNode[]>([]);
  const [evidenceById, setEvidenceById] = useState<Map<string, Evidence>>(new Map());
  const [keyframes, setKeyframes] = useState<Keyframe[]>([]);
  const [reviewing, setReviewing] = useState(false), [reviewStatus, setReviewStatus] = useState('');
  const reviewController = useRef<AbortController | null>(null);
  useEffect(() => { setReviewStatus(''); setReviewing(false); return () => { reviewController.current?.abort(); reviewController.current = null; }; }, [activeVideoId]);
  const reviewFrames = async () => {
    if (!activeVideoId) return;
    const controller = new AbortController(); reviewController.current = controller; setReviewing(true);
    try { const result = await reviewKnowledgeFrames(activeVideoId, controller.signal, message => { if (reviewController.current === controller) setReviewStatus(message); }); if (reviewController.current === controller) setReviewStatus(`已筛选 ${result.reviewed} 张，过滤 ${result.filtered} 张非知识画面`); }
    catch (error) { if (reviewController.current === controller) setReviewStatus((error as Error).message); }
    finally { if (reviewController.current === controller) setReviewing(false); }
  };
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Array<{ id: string; kind: string; nodeId?: string; evidenceId?: string; startTime: number; endTime: number; text?: string }>>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const settingsWrites = useRef(0), settingsEpoch = useRef(0);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsReport | null>(null);

  const loadVideos = useCallback(async () => {
    const db = getDb();
    const list = await db.videos.toArray();
    setVideos(list.sort((a, b) => b.updatedAt - a.updatedAt));
    if (!activeVideoId && list[0]) setActiveVideoId(list[0].id);
  }, [activeVideoId]);

  const loadVideoData = useCallback(async (videoId: string | null) => {
    const epoch = ++searchEpoch.current;
    setHits([]); setQuery(''); setNodes([]); setKeyframes([]); setEvidenceById(new Map());
    if (!videoId) {
      setNodes([]);
      setKeyframes([]);
      setEvidenceById(new Map());
      return;
    }
    const db = getDb();
    const list = await db.nodes.where('[videoId+startTime]').between([videoId, 0], [videoId, Number.MAX_SAFE_INTEGER]).toArray();
    const [frames, evidence] = await Promise.all([db.keyframes.where('videoId').equals(videoId).sortBy('time'), db.evidence.where('videoId').equals(videoId).toArray()]);
    if (epoch !== searchEpoch.current) return;
    setNodes(list); setKeyframes(frames);
    setEvidenceById(new Map(evidence.map((e) => [e.id, e])));
  }, []);

  useEffect(() => {
    const settingsSubscription = liveQuery(() => getSettings()).subscribe(next => { if (!settingsWrites.current) setSettings(next); });
    const subscription = liveQuery(() => getDb().videos.toArray()).subscribe(list => {
      setVideos(list.sort((a,b) => b.updatedAt-a.updatedAt));
      setActiveVideoId(current => list.some(video => video.id === current) ? current : list[0]?.id ?? null);
    });
    return () => { subscription.unsubscribe(); settingsSubscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    void loadVideoData(activeVideoId);
    if (!activeVideoId) return;
    const subscription = liveQuery(() => getDb().keyframes.where('videoId').equals(activeVideoId).sortBy('time')).subscribe(setKeyframes);
    return () => subscription.unsubscribe();
  }, [activeVideoId, loadVideoData]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (tab === 'settings' && settings && location.hash === '#api') document.getElementById('api')?.scrollIntoView();
  }, [tab, settings]);

  const activeVideo = useMemo(() => videos.find((v) => v.id === activeVideoId) ?? null, [videos, activeVideoId]);

  const runSearch = async () => {
    if (!query.trim()) {
      setHits([]);
      return;
    }
    try {
      const epoch = searchEpoch.current;
      const result = await sendUi<{ hits: typeof hits }>({
        type: 'ui:search',
        payload: { query: query.trim(), videoId: activeVideoId ?? undefined, limit: 30 },
      });
      if (epoch === searchEpoch.current) setHits(result.hits);
    } catch (error) {
      setToast((error as Error).message);
    }
  };

  const saveNote = async (node: MemoryNode, note: string) => {
    const db = getDb();
    await db.nodes.update(node.id, {
      userNote: note,
      revision: node.revision + 1,
      updatedAt: Date.now(),
    });
    void loadVideoData(activeVideoId);
    setToast('笔记已保存（AI 重新整理不会覆盖）');
  };

  const deleteVideo = async (video: Video) => {
    if (!window.confirm(translateUi('删除《', locale) + video.title + translateUi('》的全部本地证据、关键帧、节点与索引？\n此操作不可撤销；如需同时删除 Notion 远端内容，请另行在 Notion 中操作。', locale))) return;
    try {
      await sendUi({ type: 'ui:delete-video', payload: { videoId: video.id } });
      setActiveVideoId(null);
      await loadVideos();
      setToast('已删除本地数据');
    } catch (error) {
      setToast((error as Error).message);
    }
  };

  const doExport = async (videoId?: string) => {
    try {
      const bundle = await exportBundle({ videoId });
      const blob = new Blob([serializeExport(bundle)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `Vidence-export-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setToast('已导出（不包含任何 API Key 或 Notion 令牌）');
    } catch (error) {
      setToast((error as Error).message);
    }
  };

  const fileRef = useRef<HTMLInputElement>(null);
  const doImport = async (file: File) => {
    const raw = await file.text();
    const validation = validateImport(raw);
    if (!validation.ok || !validation.bundle) {
      setToast(`导入失败：${validation.error}`);
      return;
    }
    if (validation.warnings.length > 0 && !window.confirm(`${validation.warnings.join('\n')}\n\n仍要继续导入吗？`)) return;
    try {
      const counts = await importBundle(validation.bundle);
      setToast(`已导入 ${counts.videos} 个视频、${counts.nodes} 个节点、${counts.evidence} 条证据`);
      await loadVideos();
      await loadVideoData(activeVideoId);
    } catch (error) {
      setToast(`导入失败：${(error as Error).message}`);
    }
  };

  const patchSettings = async (patch: Partial<Settings>) => {
    const epoch = ++settingsEpoch.current; settingsWrites.current++; setSettingsSaving(true);
    setSettings(previous => previous ? { ...previous, ...patch } : previous);
    try { const saved = await saveSettings(patch); if (epoch === settingsEpoch.current) setSettings(saved); }
    catch (error) { if (epoch === settingsEpoch.current) setSettings(await getSettings()); setToast(`设置未能保存：${(error as Error).message}`); }
    finally { settingsWrites.current--; if (!settingsWrites.current) setSettingsSaving(false); }
  };

  const loadDiagnostics = async () => {
    try {
      setDiagnostics(await sendUi<DiagnosticsReport>({ type: 'ui:diagnostics' }));
    } catch (error) {
      setToast((error as Error).message);
    }
  };

  const clearAll = async () => {
    if (!window.confirm(translateUi('清空全部本地数据（视频、字幕、关键帧、节点、聊天、索引）？\n设置会保留；Notion 远端内容不会被删除。', locale))) return;
    await wipeDatabase();
    setVideos([]);
    setNodes([]);
    setKeyframes([]);
    setToast('本地数据已清空');
  };

  return <Localized>{(
    <div className="page">
      <div className="page-header">
        <img className="brand-mark" src="/brand/icon-128.png" alt="" aria-hidden="true"/>
        <h1 className="page-title">Vidence</h1><span className="beta-badge">BETA · 测试版</span>
        <span className="header-caption">个人学习空间</span>
        <div className="spacer" />
        {onNewSource && <button className="btn" onClick={onNewSource}>添加视频</button>}
        <button className={`btn ${tab === 'library' ? 'primary' : ''}`} onClick={() => setTab('library')}>
          视频库
        </button>
        <button className={`btn ${tab === 'settings' ? 'primary' : ''}`} onClick={() => setTab('settings')}>
          设置
        </button>
        <button className={`btn ${tab === 'memory' ? 'primary' : ''}`} onClick={() => setTab('memory')}>长期记忆</button>
      </div>

      {tab !== 'settings' && <AppUpdates compact/>}
      {toast && <div className="toast">{toast}</div>}
      {tab === 'memory' && <LongMemoryPage videos={videos} onToast={setToast} />}

      {tab === 'library' && (
        <>
        <div className="workspace-intro"><div><span className="eyebrow">VIDEO LIBRARY</span><h1>我的视频库</h1><p>从看过的内容出发，留下值得记住的东西。</p></div><span className="workspace-count">{videos.length} 个视频<span>独立记忆 · 独立对话</span></span></div>
        <div className="layout">
          <aside className="panel">
            <div className="row" style={{ marginBottom: 8 }}>
              <strong style={{ fontSize: 12 }}>视频（{videos.length}）</strong>
              <div className="spacer" />
              <button className="btn ghost" onClick={() => void doExport()}>
                全部导出
              </button>
            </div>
            <div className="list">
              {videos.map((video) => (
                <button
                  type="button"
                  key={video.id}
                  className={`video-item ${video.id === activeVideoId ? 'active' : ''}`}
                  onClick={() => setActiveVideoId(video.id)}
                  aria-current={video.id === activeVideoId ? 'true' : undefined}
                >
                  <span className="video-item-title" title={video.title}>
                    {video.title}
                  </span>
                  <span className="video-item-meta">{video.platform} · 已记录 {Math.round(video.recordedRanges.reduce((sum, [a,b]) => sum+b-a, 0))} 秒</span>
                </button>
              ))}
              {videos.length === 0 && <div className="empty">还没有记录。打开视频页并在侧边栏开始记录。</div>}
            </div>
          </aside>

          <main>
            {activeVideo ? (
              <>
                <div className="panel" style={{ marginBottom: 14 }}>
                  <div className="row">
                    <div style={{ flex: 1, minWidth: 200 }}>
                      <h2 className="library-video-title" translate="no">{activeVideo.title}</h2>
                      <div className="faint" style={{ fontSize: 11 }}>
                        {activeVideo.platform} · {activeVideo.duration ? formatClock(activeVideo.duration) : '时长未知'} · 已记录{' '}
                        {Math.round(activeVideo.recordedRanges.reduce((sum, [a, b]) => sum + (b - a), 0))}s
                      </div>
                    </div>
                    <button className="btn" onClick={() => window.open(activeVideo.url, '_blank')}>
                      打开视频
                    </button>
                    <button className="btn" onClick={() => void doExport(activeVideo.id)}>
                      导出本视频
                    </button>
                    <button className="btn danger" onClick={() => void deleteVideo(activeVideo)}>
                      删除
                    </button>
                  </div>
                  <div className="row" style={{ marginTop: 10 }}>
                    <input
                      className="field"
                      style={{ flex: 1 }}
                      placeholder="检索字幕与节点（中文关键词）"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void runSearch();
                      }}
                    />
                    <button className="btn" onClick={() => void runSearch()}>
                      检索
                    </button>
                  </div>
                  {hits.length > 0 && (
                    <div style={{ marginTop: 10 }}>
                      <div className="faint" style={{ fontSize: 11 }}>
                        检索结果 {hits.length}
                      </div>
                      {hits.slice(0, 12).map((hit) => (
                        <div
                          key={`${hit.kind}-${hit.id}-${hit.startTime}`}
                          className="evidence"
                          style={{ cursor: 'pointer' }}
                          onClick={() => {
                            const time = hit.startTime;
                            window.open(videoUrlAt(activeVideo.url, time), '_blank');
                          }}
                        >
                          <span className="time-chip">{formatClock(hit.startTime)}</span> {hit.text?.slice(0, 180)}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="view-switch" role="group" aria-label="视频内容视图"><button className={videoView === 'chat' ? 'active' : ''} onClick={() => setVideoView('chat')}>与视频对话</button><button className={videoView === 'notes' ? 'active' : ''} onClick={() => setVideoView('notes')}>原文与节点 · {nodes.length}</button></div>
                {videoView === 'chat' && <VideoConversation key={activeVideo.id} video={activeVideo} />}

                {videoView === 'notes' && keyframes.length > 0 && <section className="panel knowledge-frames"><div className="knowledge-frames-heading"><div><h3>知识画面</h3><p className="muted">保留图示、公式和操作步骤，排除纯讲者与片尾。</p></div><button className="btn" disabled={reviewing || !settings?.privacy.allowVisionUpload} title={!settings?.privacy.allowVisionUpload ? '先在设置中开启允许发送视频截图' : undefined} onClick={() => void reviewFrames()}>筛选知识画面</button>{reviewing && <button className="btn" onClick={() => reviewController.current?.abort()}>取消</button>}</div><p role="status">{reviewStatus}</p><details className="frame-gallery"><summary><span>画面记录</span> · {keyframes.filter(isKnowledgeFrame).length}</summary><div>{keyframes.filter(isKnowledgeFrame).map(keyframe => <KeyframeImage key={keyframe.id} keyframe={keyframe} videoUrl={activeVideo.url}/>)}</div></details>{keyframes.some(frame => !isKnowledgeFrame(frame)) && <details className="frame-gallery"><summary>待确认与已过滤画面 · {keyframes.filter(frame => !isKnowledgeFrame(frame)).length}</summary><div>{keyframes.filter(frame => !isKnowledgeFrame(frame)).map(keyframe => <div key={keyframe.id}><KeyframeImage keyframe={keyframe} videoUrl={activeVideo.url}/><span className="pill">{isUncertainFrame(keyframe) ? '待确认' : '非知识画面'}</span><button className="text-button" onClick={() => void getDb().keyframes.update(keyframe.id, { reason: 'user' })}>保留这张画面</button></div>)}</div></details>}</section>}

                {videoView === 'notes' && (nodes.length === 0 ? (
                  <div className="panel empty">这个视频还没有节点。记录过程中会根据字幕自动切分。</div>
                ) : (
                  nodes.map((node) => {
                    const nodeEvidence = node.evidenceIds.map((id) => evidenceById.get(id)).filter(Boolean) as Evidence[];
                    const nodeKeyframes = keyframes.filter(isKnowledgeFrame).filter((k) => node.keyframeIds.includes(k.id) || (k.time >= node.startTime && k.time <= node.endTime));
                    return <Localized>{(
                      <div className="node-detail" key={node.id}>
                        <div className="row">
                          <strong style={{ fontSize: 13 }} translate="no">{node.title}</strong>
                          <span className="pill">{node.status}</span>
                          <div className="spacer" />
                          <button
                            className="btn ghost"
                            onClick={() =>
                              window.open(videoUrlAt(activeVideo.url, node.startTime), '_blank')
                            }
                          >
                            {formatClock(node.startTime)} ↗
                          </button>
                        </div>
                        {node.summary && <div translate="no" style={{ margin: '6px 0', fontSize: 12 }}>{node.summary}</div>}
                        {nodeEvidence.slice(0, 6).map((item) => (
                          <div className="evidence" key={item.id}>
                            <span className="time-chip">{formatClock(item.startTime)}</span>{' '}
                            <span className="faint">{item.source}</span>
                            {item.confidence !== undefined && <span className="faint"> {item.confidence.toFixed(2)}</span>}
                            <div translate="no">{item.correctedText || item.text}</div>
                          </div>
                        ))}
                        {nodeKeyframes.length > 0 && (
                          <div className="row" style={{ marginTop: 8 }}>
                            {nodeKeyframes.slice(0, 3).map((keyframe) => (
                              <KeyframeImage key={keyframe.id} keyframe={keyframe} videoUrl={activeVideo.url} />
                            ))}
                          </div>
                        )}
                        <label className="field-label">我的笔记（AI 不会覆盖）</label>
                        <textarea
                          className="question"
                          defaultValue={node.userNote ?? ''}
                          style={{ minHeight: 44 }}
                          onBlur={(e) => {
                            if (e.target.value !== (node.userNote ?? '')) void saveNote(node, e.target.value);
                          }}
                        />
                      </div>
                    )}</Localized>;
                  })
                ))}
              </>
            ) : (
              <div className="panel empty">从左侧选择一个视频查看节点。</div>
            )}
          </main>
        </div>
        </>
      )}

      {tab === 'settings' && settings && (
        <SettingsPanel settings={settings} saving={settingsSaving} onPatch={patchSettings} onToast={setToast} advanced={<AdvancedSettingsPanel settings={settings} onPatch={patchSettings} onToast={setToast} />} onDiagnostics={() => { setTab('diagnostics'); void loadDiagnostics(); }} />
      )}

      {tab === 'diagnostics' && (
        <div className="panel">
          <div className="row" style={{ marginBottom: 10 }}>
            <strong style={{ fontSize: 13 }}>脱敏诊断</strong>
            <div className="spacer" />
            <button className="btn" onClick={() => void loadDiagnostics()}>
              重新生成
            </button>
            <button className="btn" onClick={() => void doExport()}>
              导出数据
            </button>
            <button className="btn" onClick={() => fileRef.current?.click()}>
              导入数据
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void doImport(file);
                e.target.value = '';
              }}
            />
            <button className="btn danger" onClick={() => void clearAll()}>
              清空本地数据
            </button>
          </div>
          {diagnostics ? (
            <pre className="code">{JSON.stringify(diagnostics, null, 2)}</pre>
          ) : (
            <div className="empty">点击“重新生成”查看运行状态、索引与权限。</div>
          )}
        </div>
      )}
    </div>
  )}</Localized>;
}

function KeyframeImage({ keyframe, videoUrl }: { keyframe: Keyframe; videoUrl?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const objectUrl = URL.createObjectURL(keyframe.image);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [keyframe.image]);
  if (!url) return null;
  return <Localized>{(
    <figure style={{ margin: 0 }}>
      <img className="keyframe" src={url} loading="lazy" alt={`关键帧 ${formatClock(keyframe.time)}`} />
      <figcaption className="faint" style={{ fontSize: 10.5 }}>
        {videoUrl ? <button className="time-chip" onClick={() => window.open(videoUrlAt(videoUrl, keyframe.time), '_blank')}>{formatClock(keyframe.time)}</button> : formatClock(keyframe.time)}
        {keyframe.knowledge ? <span> {keyframe.knowledge.title} · {keyframe.knowledge.summary}</span> : keyframe.selectionReason && <span> {keyframe.selectionReason}</span>}
      </figcaption>
    </figure>
  )}</Localized>;
}

function AdvancedSettingsPanel({
  settings,
  onPatch,
  onToast,
}: {
  settings: Settings;
  onPatch: (patch: Partial<Settings>) => Promise<void>;
  onToast: (message: string) => void;
}) {
  const { locale } = useUiLocale();
  const channels = orderForLocale(settings.providers,locale,'api',apiChannelId);
  const [notion, setNotion] = useState({
    token: settings.notion?.token ?? '',
    videosDatabaseId: settings.notion?.videosDatabaseId ?? '',
    nodesDatabaseId: settings.notion?.nodesDatabaseId ?? '',
    enabled: settings.notion?.enabled ?? false,
  });
  const [testing, setTesting] = useState(false);

  const testNotion = async () => {
    setTesting(true);
    try {
      await onPatch({
        notion: { ...notion, enabled: notion.enabled },
      });
      const result = await sendUi<{ ok: boolean; error?: string }>({ type: 'ui:notion-test', payload: {} });
      onToast(result.ok ? 'Notion 连接成功' : `Notion 连接失败：${result.error}`);
    } catch (error) {
      onToast((error as Error).message);
    } finally {
      setTesting(false);
    }
  };

  const syncNow = async () => {
    try {
      const result = await sendUi<{ videos: number; nodes: number; failed: number; errors: string[] }>({ type: 'ui:notion-sync', payload: {} });
      onToast(`同步完成：${result.videos} 个视频，${result.nodes} 个节点，失败 ${result.failed}`);
    } catch (error) {
      onToast((error as Error).message);
    }
  };

  return <Localized>{(
    <div className="settings-grid">
      <section className="panel">
        <div className="section-title">运行配置</div>
        <div className="grid-2">
          <label>
            <span className="field-label">模式</span>
            <select
              className="field"
              value={settings.profile}
              onChange={(e) => void onPatch({ profile: e.target.value as Settings['profile'] })}
            >
              <option value="standard">标准（本地 OCR + 云端 A/B）</option>
              <option value="low-resource">低资源（关键词优先）</option>
              <option value="no-ai">无 AI 凭据（纯本地）</option>
            </select>
          </label>
          <label>
            <span className="field-label">每视频关键帧预算</span>
            <input
              className="field"
              type="number"
              min={0}
              max={500}
              value={settings.capture.keyframeBudget}
              onChange={(e) => void onPatch({ capture: { ...settings.capture, keyframeBudget: Number(e.target.value) } })}
            />
          </label>
        </div>
        <div className="grid-2" style={{ marginTop: 8 }}>
          <label className="row" style={{ fontSize: 12, gap: 6 }}>
            <input
              type="checkbox"
              checked={settings.ocr.enabled}
              onChange={(e) => void onPatch({ ocr: { ...settings.ocr, enabled: e.target.checked } })}
            />
            启用字幕 OCR（无可读字幕时）
          </label>
          <label className="row" style={{ fontSize: 12, gap: 6 }}>
            <input
              type="checkbox"
              checked={settings.retrieval.keyword}
              onChange={(e) => void onPatch({ retrieval: { ...settings.retrieval, keyword: e.target.checked } })}
            />
            关键词检索
          </label>
          <label className="row" style={{ fontSize: 12, gap: 6 }}>
            <input
              type="checkbox"
              checked={settings.retrieval.vector}
              onChange={(e) => {
                if (e.target.checked) {
                  onToast('向量检索需要下载中文 embedding 模型并完成自检；当前版本标记为实验性，失败时仍保留关键词检索。');
                }
                void onPatch({ retrieval: { ...settings.retrieval, vector: e.target.checked } });
              }}
            />
            向量检索（实验性）
          </label>
          <label className="row" style={{ fontSize: 12, gap: 6 }}>
            <input
              type="checkbox"
              checked={settings.retrieval.rerank}
              onChange={(e) => void onPatch({ retrieval: { ...settings.retrieval, rerank: e.target.checked } })}
            />
            本地神经重排（bge-reranker-base）
          </label>
          <label className="row" style={{ fontSize: 12, gap: 6 }}>
            <input
              type="checkbox"
              checked={settings.privacy.allowVisionUpload}
              onChange={(e) => void onPatch({ privacy: { ...settings.privacy, allowVisionUpload: e.target.checked } })}
            />
            允许问答时上传关键帧
          </label>
        </div>
      </section>

      <section className="panel">
        <div className="section-title" id="api">API 提供商与模型角色</div>
        {settings.providers.length === 0 && <div className="faint" style={{ fontSize: 12 }}>尚未配置。可先用“AI 应用”路线，无需 API Key。</div>}
        {channels.map((provider) => (
          <div key={provider.id} className="node-detail" style={{ marginBottom: 8 }}>
            <div className="row">
              <strong style={{ fontSize: 12 }}>{provider.label}</strong>
              <span className="pill">{provider.kind}</span>
              <div className="spacer" />
              <span className="faint" style={{ fontSize: 10.5 }}>
                {provider.apiKey ? '已保存密钥' : '无密钥'}
              </span>
              <button
                className="btn ghost"
                onClick={() => {
                  const next = settings.providers.filter(item => item.id !== provider.id);
                  void onPatch({ providers: next });
                }}
              >
                删除
              </button>
            </div>
            <div className="faint" style={{ fontSize: 11 }}>{provider.baseUrl ?? '默认地址'}</div>
          </div>
        ))}

        <p className="setup-help">添加服务请使用“AI 助手”里的 API Key 连接。模型从服务返回的目录中选择。</p>
        <div className="grid-2" style={{ marginTop: 16 }}>{(['answerModel', 'organizeModel'] as const).map(role => <label key={role} className="setting-label">{role === 'answerModel' ? 'API 问答模型' : 'API 摘要模型'}<select className="field" value={settings.roles[role] ? JSON.stringify([settings.roles[role]!.providerId, settings.roles[role]!.modelId]) : ''} onChange={event => { if (!event.target.value) return; const [providerId, modelId] = JSON.parse(event.target.value); void onPatch({ roles: { ...settings.roles, [role]: { ...settings.roles[role], providerId, modelId } } }); }}><option value="">尚未配置</option>{settings.roles[role] && <option value={JSON.stringify([settings.roles[role]!.providerId, settings.roles[role]!.modelId])}>当前：{settings.roles[role]!.modelId}</option>}{channels.flatMap(provider => (provider.models ?? []).filter(model => model.id !== settings.roles[role]?.modelId || provider.id !== settings.roles[role]?.providerId).map(model => <option key={`${provider.id}:${model.id}`} value={JSON.stringify([provider.id, model.id])}>{provider.label} · {model.label}</option>))}</select></label>)}</div>
      </section>

      <section className="panel">
        <div className="section-title">Notion 同步（可选）</div>
        <div className="grid-2">
          <input className="field" type="password" placeholder="集成令牌" value={notion.token} onChange={(e) => setNotion({ ...notion, token: e.target.value })} />
          <input className="field" placeholder="Videos 数据库 ID" value={notion.videosDatabaseId} onChange={(e) => setNotion({ ...notion, videosDatabaseId: e.target.value })} />
          <input className="field" placeholder="Memory Nodes 数据库 ID" value={notion.nodesDatabaseId} onChange={(e) => setNotion({ ...notion, nodesDatabaseId: e.target.value })} />
          <label className="row" style={{ fontSize: 12, gap: 6 }}>
            <input type="checkbox" checked={notion.enabled} onChange={(e) => setNotion({ ...notion, enabled: e.target.checked })} />
            启用同步（本地始终可用）
          </label>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn" onClick={() => void onPatch({ notion: { ...settings.notion, ...notion } })}>
            保存
          </button>
          <button className="btn" onClick={() => void testNotion()} disabled={testing}>
            {testing ? '测试中…' : '测试连接'}
          </button>
          <button className="btn" onClick={() => void syncNow()}>
            立即同步
          </button>
        </div>
        <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>
          单向同步本地生成内容，保留远端人工编辑区域；页面正文不会整页覆盖。
        </div>
      </section>
    </div>
  )}</Localized>;
}
