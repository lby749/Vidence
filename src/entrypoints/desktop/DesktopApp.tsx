import { Localized } from '@/ui/i18n';
import { useEffect, useRef, useState } from 'react';
import LibraryApp from '../library/App';
import { getDb, getSettings } from '@/db/db';
import { installedCapabilities } from '@/models/downloads';
import { nativeCall, type NativeBridge } from '@/desktop/runtime';
import { recognize } from '@/background/ocr-service';
import { ingestCaptions } from '@/background/subtitle-service';
import { rebuildDraftNodes } from '@/background/node-service';
import { embedPendingNodes } from '@/background/embedding-service';
import { addRecordedRange } from '@/pipeline/range';
import type { NormRect, Session, Video } from '@/shared/types';
import { COURSE_PLATFORMS } from '@/shared/course-platforms';
import StudySidebar from './StudySidebar';
import AppUpdates from '@/ui/AppUpdates';
import { useUiLocale } from '@/ui/i18n';
import { orderForLocale } from '@/ui/locale-order';
import { handleSignature, resetVisualState } from '@/background/visual-service';
import { signatureFromImageData, subtitleMask } from '@/pipeline/visual';
import type { FrameResult } from '@/shared/messages';
import type { ActiveSession } from '@/background/session-store';

type Source = { id: string; title: string; url: string; duration?: number; kind?: 'local' | 'window'; platform?: string };
type Frame = { dataUrl?: string; previewUrl?: string; time: number; duration: number; capturedAt: number; playing?: boolean; error?: string; sourceId?: string };

export default function DesktopApp({ native }: { native: NativeBridge }) {
  const { locale } = useUiLocale();
  const platforms = orderForLocale(COURSE_PLATFORMS, locale, 'platform', item => item.label).map(item => item.label);
  const [view, setView] = useState<'source' | 'library'>('source'), [kind, setKind] = useState<'local' | 'window'>('local');
  const [pickerKind, setPickerKind] = useState<'local' | 'window'>('local');
  const [source, setSource] = useState<Source | null>(null), [windows, setWindows] = useState<Array<{ id: string; title: string }>>([]), [windowId, setWindowId] = useState('');
  const [title, setTitle] = useState(''), [platform, setPlatform] = useState(platforms[0]), [offset, setOffset] = useState(0);
  const [frame, setFrame] = useState<Frame | null>(null), [roi, setRoi] = useState<NormRect>({ x: 0, y: 0, w: 1, h: 1 });
  const [session, setSession] = useState<Session | null>(null), [count, setCount] = useState(0), [status, setStatus] = useState('选择一个视频，开始留下记忆。');
  const [busy, setBusy] = useState(false); const active = useRef<Session | null>(null); const processing = useRef(false); const lastFrame = useRef(0);
  const sourceResolved = useRef(false);
  const selectedSource = useRef<string | null>(null); selectedSource.current = source?.id ?? null;
  const currentSource = useRef<Source | null>(null); currentSource.current = source;
  const lastRecognition = useRef(0);
  const stopLatest = useRef<() => Promise<void>>(async () => {});
  const [webAddress, setWebAddress] = useState(''), [browserId, setBrowserId] = useState('in-app');
  const [browsers, setBrowsers] = useState<Array<{ id: string; title: string }>>([{ id: 'default', title: '系统默认浏览器' }]);
  const [openedWeb, setOpenedWeb] = useState<{ url: string } | null>(null);
  const [presentation, setPresentation] = useState({ attached: false, collapsed: false, fullscreen: false, playerFullscreen: false, webFullscreen: false });
  const updatePresentation = (method: string, ...args: unknown[]) => nativeCall<typeof presentation>(native, method, ...args).then(next => { setPresentation(next); return next; });
  const [sidebarVideo, setSidebarVideo] = useState<Video | null>(null);
  const [adjustingRegion, setAdjustingRegion] = useState(false);
  useEffect(() => {
    let receivedEvent = false;
    const update = (event: Event) => { receivedEvent = true; const state = (event as CustomEvent).detail; setPresentation(state); if (state.reason === 'target-closed' || state.reason === 'player-closed') void stopLatest.current(); };
    window.addEventListener('desktop:presentation', update);
    void nativeCall<typeof presentation>(native, 'presentationState').then(state => { if (!receivedEvent) setPresentation(state); });
    return () => window.removeEventListener('desktop:presentation', update);
  }, []);
  useEffect(() => {
    const update = (event: Event) => {
      const next = (event as CustomEvent<Source & { previousTitle: string }>).detail, previous = currentSource.current;
      if (!previous || previous.id !== next.id) return;
      setTitle(value => !value || value === previous.title || value === next.previousTitle ? next.title : value);
      currentSource.current = { ...previous, title: next.title, platform: next.platform };
      setSource(current => current?.id === next.id ? { ...current, title: next.title, platform: next.platform } : current);
      void getDb().transaction('rw', getDb().videos, async () => {
        const video = await getDb().videos.get(next.id);
        if (!video) return;
        const patch = { platform: next.platform ?? video.platform, ...(!video.customTitle && video.title === next.previousTitle ? { title: next.title } : {}) };
        await getDb().videos.update(next.id, patch);
        setSidebarVideo(current => current?.id === next.id ? { ...current, ...patch } : current);
      });
    };
    window.addEventListener('desktop:source-title', update); return () => window.removeEventListener('desktop:source-title', update);
  }, []);
  useEffect(() => {
    const update = (event: Event) => setStatus(`网页播放器未能打开：${(event as CustomEvent<string>).detail}`);
    window.addEventListener('desktop:playback-error', update); return () => window.removeEventListener('desktop:playback-error', update);
  }, []);
  useEffect(() => {
    const update = (event: Event) => {
      const next = (event as CustomEvent<Source>).detail;
      void (async () => { if (active.current) await stopLatest.current(); setSource(next); setKind(next.kind ?? 'window'); setPickerKind(next.kind ?? 'window'); setTitle(next.title); setFrame(null); setView('source'); setRoi({ x: 0, y: 0, w: 1, h: 1 }); setStatus('网页播放器已打开。可使用网页自己的全屏按钮，侧栏可随时收起。'); })();
    };
    window.addEventListener('desktop:source-changed', update); return () => window.removeEventListener('desktop:source-changed', update);
  }, []);
  useEffect(() => {
    document.body.classList.toggle('desktop-attached', presentation.attached);
    document.body.classList.toggle('desktop-fullscreen', presentation.fullscreen);
    return () => { document.body.classList.remove('desktop-attached', 'desktop-fullscreen'); };
  }, [presentation.attached, presentation.fullscreen]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const fullscreen = presentation.fullscreen || presentation.playerFullscreen || presentation.webFullscreen;
      if (event.key === 'Escape' && fullscreen) { event.preventDefault(); void updatePresentation('fullscreen', false).catch(error => setStatus(error.message)); }
      if (event.key === 'F11' && source) { event.preventDefault(); void updatePresentation('fullscreen', !fullscreen).catch(error => setStatus(error.message)); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [presentation.fullscreen, presentation.playerFullscreen, presentation.webFullscreen, source?.id]);
  useEffect(() => {
    let alive = true; setSidebarVideo(null); setAdjustingRegion(false);
    if (source) void (async () => {
      const video = await getDb().transaction('rw', getDb().videos, async () => {
        const previous = await getDb().videos.get(source.id), now = Date.now(), latest = currentSource.current?.id === source.id ? currentSource.current : source;
        const video: Video = previous ?? { id: source.id, title: latest.title, url: source.url, canonicalUrl: source.url, platform: latest.platform ?? (kind === 'local' ? '本地视频' : platform), duration: frame?.duration ?? 0, lastPosition: frame?.time ?? offset, recordedRanges: [], createdAt: now, updatedAt: now, sessionCount: 0 };
        if (!previous) await getDb().videos.put(video);
        if (previous?.customTitle) setTitle(previous.title);
        return video;
      });
      if (alive) setSidebarVideo(video);
    })();
    return () => { alive = false; };
  }, [source?.id]);
  const showLibrary = async () => {
    if (presentation.attached || presentation.fullscreen) await updatePresentation('restoreWindow');
    if (source) history.replaceState(null, '', `?videoId=${encodeURIComponent(source.id)}`);
    setView('library');
  };
  useEffect(() => {
    const opened = (event: Event) => { const source = (event as CustomEvent<Source>).detail; history.replaceState(null, '', `?videoId=${encodeURIComponent(source.id)}`); setSource(source); setKind(source.kind ?? 'local'); setPickerKind(source.kind ?? 'local'); setTitle(source.title); setFrame(null); setRoi({ x: 0, y: 0, w: 1, h: 1 }); setView('source'); setStatus('已回到原视频。'); };
    const failed = (event: Event) => { setStatus((event as CustomEvent<string>).detail); setView('source'); };
    window.addEventListener('desktop:source-opened', opened); window.addEventListener('desktop:source-error', failed);
    return () => { window.removeEventListener('desktop:source-opened', opened); window.removeEventListener('desktop:source-error', failed); };
  }, []);
  const [refreshingWindows, setRefreshingWindows] = useState(false); const refreshing = useRef(false);
  useEffect(() => { void nativeCall<Array<{ id: string; title: string }>>(native, 'browsers').then(setBrowsers).catch(error => setStatus(error.message)); }, []);
  const choosePlatform = (value: string) => {
    setPlatform(value); setWebAddress(COURSE_PLATFORMS.find(item => item.label === value)?.url ?? '');
    setOpenedWeb(null);
  };
  const openWeb = async () => {
    try {
      const link = await nativeCall<{ url: string; inApp?: boolean }>(native, 'openWebPage', webAddress, browserId);
      if (link.inApp) { setOpenedWeb(link); return; }
      setOpenedWeb(link); setSource(null); setFrame(null); await refreshWindows();
      setStatus('网页已在所选浏览器打开。请刷新窗口列表，选择对应的浏览器窗口，再确认预览。');
    } catch (error) { setStatus((error as Error).message); }
  };
  const drag = useRef<{ x: number; y: number } | null>(null); const preview = useRef<HTMLImageElement>(null);
  const [imageSize, setImageSize] = useState({ width: 1280, height: 720 });
  const refreshWindows = async () => {
    if (refreshing.current) return;
    refreshing.current = true; setRefreshingWindows(true); setWindowId(''); setWindows([]);
    try { setWindows(await nativeCall(native, 'windows')); }
    catch (error) { setStatus((error as Error).message); }
    finally { refreshing.current = false; setRefreshingWindows(false); }
  };
  useEffect(() => { void refreshWindows(); void nativeCall<Source | null>(native, 'currentSource').then(current => { sourceResolved.current = true; if (current) { setSource(current); setTitle(current.title); setKind(current.kind ?? 'local'); setPickerKind(current.kind ?? 'local'); } }); return () => { void nativeCall(native, 'stopCapture'); }; }, []);
  useEffect(() => { if ((!source && sourceResolved.current) || (view === 'library' && !session)) void nativeCall(native, 'stopCapture'); }, [source, view, session]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!source || (view === 'library' && !active.current) || processing.current) return;
      processing.current = true;
      void (async () => {
        const current = await nativeCall<Frame>(native, 'frame');
        if (selectedSource.current !== source.id || (current.sourceId && current.sourceId !== source.id)) return;
        setFrame(current);
        if (current.error) { setStatus(current.error); return; }
        setStatus(previous => previous.startsWith('无法取得所选画面') || previous.startsWith('无法取得所选') ? '画面已恢复，可以继续学习。' : previous);
        const recording = active.current;
        if (current.sourceId && recording && current.sourceId !== recording.videoId) return;
        if (!recording || !current.dataUrl || current.capturedAt === lastFrame.current || (kind === 'local' && !current.playing)) return;
        const settings = await getSettings();
        lastFrame.current = current.capturedAt;
        const time = kind === 'local' ? current.time : offset + Math.max(0, current.capturedAt - recording.startedAt) / 1000;
        const image = new Image(); image.src = current.dataUrl; await image.decode();
        if (active.current?.id !== recording.id) return;
        const thumbnail = document.createElement('canvas'); thumbnail.width = Math.min(320, image.width); thumbnail.height = Math.max(1, Math.round(image.height * thumbnail.width / image.width));
        const sample = thumbnail.getContext('2d', { willReadFrequently: true })!; sample.drawImage(image, 0, 0, thumbnail.width, thumbnail.height);
        const signature = signatureFromImageData(sample.getImageData(0, 0, thumbnail.width, thumbnail.height).data, thumbnail.width, thumbnail.height, { mask: subtitleMask(roi) });
        await handleSignature({ sessionId: recording.id, videoId: recording.videoId, epoch: recording.captureEpoch, paused: false } as ActiveSession, {
          ...signature, sessionId: recording.id, epoch: recording.captureEpoch, time, duration: current.duration,
          captureFrame: async maxWidth => {
            const high = await nativeCall<FrameResult & { sourceId?: string }>(native, 'keyframe', maxWidth);
            if (active.current?.id !== recording.id || selectedSource.current !== recording.videoId || (high.sourceId && high.sourceId !== recording.videoId)) throw new Error('视频已切换，未保存迟到画面');
            const full = new Image(); full.src = high.dataUrl; await full.decode();
            sample.drawImage(full, 0, 0, thumbnail.width, thumbnail.height);
            return { ...high, mediaTime: kind === 'local' ? high.mediaTime : offset + Math.max(0, high.capturedAt - recording.startedAt) / 1000, signature: signatureFromImageData(sample.getImageData(0, 0, thumbnail.width, thumbnail.height).data, thumbnail.width, thumbnail.height, { mask: subtitleMask(roi) }) };
          },
        }, event => { if (active.current?.id !== recording.id) return; if (event.type === 'keyframe-saved') setCount(previous => previous + 1); if (event.type === 'warning' || event.type === 'skipped') setStatus(event.reason ?? ''); });
        if (active.current?.id !== recording.id) return;
        await getDb().videos.update(recording.videoId, { lastPosition: time, duration: current.duration || frame?.duration || 0 });
        if (!settings.ocr.enabled || settings.ocr.maxPerMinute <= 0) return;
        if (Date.now() - lastRecognition.current < 60000 / settings.ocr.maxPerMinute) return;
        lastRecognition.current = Date.now();
        const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.width * roi.w)); canvas.height = Math.max(1, Math.round(image.height * roi.h));
        canvas.getContext('2d')!.drawImage(image, image.width * roi.x, image.height * roi.y, image.width * roi.w, image.height * roi.h, 0, 0, canvas.width, canvas.height);
        const result = await recognize(canvas.toDataURL('image/png'));
        if (active.current?.id !== recording.id) return;
        const text = result.items.map(item => item.text).join('\n').trim();
        if (!text) { setStatus('正在记录，当前画面没有识别到文字。'); return; }
        const sourceState = { kind: 'ocr' as const, label: kind === 'local' ? '本地视频画面文字' : '用户所选课程窗口画面文字', roi };
        const endTime = current.duration > 0 ? Math.min(time + 2.5, current.duration) : time + 2.5;
        const written = await ingestCaptions({ videoId: recording.videoId, sessionId: recording.id, epoch: recording.captureEpoch, sessionEpoch: recording.captureEpoch, duration: current.duration, source: sourceState, items: [{ text, startTime: time, endTime, source: 'ocr', confidence: result.items.reduce((sum, item) => sum + item.score, 0) / result.items.length, provenance: `${result.modelId}; ${sourceState.label}` }] });
        const video = await getDb().videos.get(recording.videoId);
        if (video && active.current?.id === recording.id) await getDb().videos.update(video.id, { lastPosition: time, duration: current.duration || video.duration, recordedRanges: addRecordedRange(video.recordedRanges, [time, endTime]), updatedAt: Date.now() });
        setCount(previous => previous + written.added); setStatus('正在记录所选区域中的文字。');
      })().catch(error => setStatus((error as Error).message)).finally(() => { processing.current = false; });
    }, 2500);
    return () => clearInterval(timer);
  }, [source, kind, offset, roi, view]);
  const openLocal = async () => {
    try { const selected = await nativeCall<Source | { canceled: boolean }>(native, 'openVideo'); if ('canceled' in selected) return; setSource(selected); setTitle(selected.title); setKind('local'); setPickerKind('local'); setFrame(null); setRoi({ x: 0, y: 0, w: 1, h: 1 }); setStatus('视频已打开。可在预览中拖动框选字幕或课件区域。'); }
    catch (error) { setStatus((error as Error).message); }
  };
  const openWindow = async () => {
    try {
      const selected = windows.find(item => item.id === windowId); if (!selected) return;
      await nativeCall(native, 'captureWindow', selected.id);
      setKind('window');
      setSource({ id: `course_${crypto.randomUUID()}`, url: openedWeb?.url ?? `vma-course://lesson/${crypto.randomUUID()}`, title: title || selected.title, kind:'window', platform });
      if (!title) setTitle(selected.title); setFrame(null); setRoi({ x: 0, y: 0, w: 1, h: 1 });
      setStatus('先确认预览属于这节课，再框选需要记录的区域。每节新课程分别建立记忆。');
    } catch (error) { setStatus((error as Error).message); }
  };
  const start = async () => {
    if (!source || !title.trim()) return;
    setBusy(true);
    try {
      const settings = await getSettings(), ocrEnabled = settings.ocr.enabled && settings.ocr.maxPerMinute > 0;
      if (ocrEnabled && !(await installedCapabilities()).ocr) throw new Error('请先下载“画面文字识别”。也可切换无占用，只记录画面。');
      const now = Date.now(), db = getDb(), previous = await db.videos.get(source.id);
      const video: Video = { id: source.id, title: title.trim(), url: source.url, canonicalUrl: source.url, platform: source.platform ?? (kind === 'local' ? '本地视频' : platform), customTitle: previous?.customTitle || title.trim() !== source.title, duration: frame?.duration ?? 0, lastPosition: frame?.time ?? offset, recordedRanges: previous?.recordedRanges ?? [], createdAt: previous?.createdAt ?? now, updatedAt: now, sessionCount: (previous?.sessionCount ?? 0) + 1 };
      const next: Session = { id: `desktop_${crypto.randomUUID()}`, videoId: video.id, startedAt: now, status: 'recording', captureEpoch: now, observedRanges: [], gaps: [], subtitleSource: ocrEnabled ? { kind: 'ocr', label: '所选画面区域', roi } : { kind: 'none', label: '仅记录画面' } };
      await db.videos.put(video); await db.sessions.put(next); active.current = next; lastRecognition.current = 0; setSession(next); setCount(0);
      if (kind === 'local') await nativeCall(native, 'media', 'play', 0);
      else await nativeCall(native, 'resumeCapture');
      setStatus(ocrEnabled ? '开始记录画面和所选区域的文字，不录制声音。' : '正在记录画面，未启用文字识别。可让助手读取保存的图片。');
    } catch (error) { setStatus((error as Error).message); }
    finally { setBusy(false); }
  };
  const stop = async () => {
    const current = active.current; active.current = null; setSession(null);
    await nativeCall(native, 'stopCapture'); setFrame(previous => previous ? { ...previous, playing: false } : previous);
    if (!current) return;
    resetVisualState(current.id);
    if (kind === 'window') setOffset(offset + (Date.now() - current.startedAt) / 1000);
    await getDb().sessions.update(current.id, { status: 'stopped', endedAt: Date.now() });
    await rebuildDraftNodes(current.videoId, current.id); void embedPendingNodes(10);
    void import('@/agent/knowledge-frames').then(({ autoReviewKnowledgeFrames }) => autoReviewKnowledgeFrames(current.videoId)).catch(error => { if (currentSource.current?.id === current.videoId) setStatus(`记录已保存；知识画面筛选未完成：${(error as Error).message}`); });
    setStatus(kind === 'local' ? '记录已保存，已停止播放与采集。可以到视频库生成长期记忆并继续提问。' : '记录已保存，已停止采集。若课程还在播放，请在原窗口暂停；再次记录前可校准课程时间。');
    history.replaceState(null, '', `?videoId=${encodeURIComponent(current.videoId)}`);
  };
  const pointer = (event: React.PointerEvent) => { const rect = preview.current!.getBoundingClientRect(), scale = Math.min(rect.width / imageSize.width, rect.height / imageSize.height), width = imageSize.width * scale, height = imageSize.height * scale; return { x: Math.max(0, Math.min(1, (event.clientX - rect.left - (rect.width - width) / 2) / width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top - (rect.height - height) / 2) / height)) }; };
  stopLatest.current = stop;
  const sourcePicker = <div className="source-picker-content">
      <div className="view-switch"><button disabled={Boolean(session)} className={pickerKind === 'local' ? 'active' : ''} onClick={() => setPickerKind('local')}>本地视频</button><button disabled={Boolean(session)} className={pickerKind === 'window' ? 'active' : ''} onClick={() => setPickerKind('window')}>网课窗口</button></div>
      {pickerKind === 'local' ? <><h3>打开一个视频</h3><p className="muted">支持 MP4 等本机可播放的视频文件。</p><button className="btn primary" disabled={Boolean(session)} onClick={() => void openLocal()}>选择视频文件</button></> : <><label className="setting-label">课程来自哪里<select aria-label="课程来自哪里" className="field" disabled={Boolean(session)} value={platform} onChange={event => choosePlatform(event.target.value)}>{platforms.map(item => <option key={item}>{item}</option>)}</select></label><div className="web-course-launcher"><label className="setting-label">课程网址（可选）<input aria-label="课程网址" className="field" type="url" placeholder="粘贴课程地址，也可填其他网站" disabled={Boolean(session)} value={webAddress} onChange={event => { setWebAddress(event.target.value); setOpenedWeb(null); }}/></label><div className="web-open-row"><select aria-label="打开课程使用的浏览器" className="field" disabled={Boolean(session)} value={browserId} onChange={event => setBrowserId(event.target.value)}>{browsers.map(browser => <option key={browser.id} value={browser.id}>{browser.title}</option>)}</select><button className="btn" disabled={!webAddress.trim() || Boolean(session)} onClick={() => void openWeb()}>打开网页</button></div><p className="setup-help">浏览器里的课程也可以记录。打开网址后，选择对应的 Edge、Chrome、Firefox 等窗口；也可直接选择已打开的窗口。</p></div><label className="setting-label">正在上课的窗口<select aria-label="正在上课的窗口" className="field" disabled={Boolean(session) || refreshingWindows} value={windowId} onChange={event => setWindowId(event.target.value)}><option value="">选择已打开的窗口</option>{windows.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><div className="row"><button className="btn" disabled={!windowId || Boolean(session) || refreshingWindows} onClick={() => void openWindow()}>预览这个窗口</button><button className="btn ghost" disabled={Boolean(session) || refreshingWindows} onClick={() => void refreshWindows()}>{refreshingWindows ? '正在刷新…' : '刷新'}</button></div></>}
      {source && <><label className="setting-label source-title-label">这节课的名称<input className="field" disabled={Boolean(session)} value={title} onChange={event => setTitle(event.target.value)} onBlur={() => { if (source && title.trim() && title.trim() !== source.title) void getDb().videos.update(source.id, { title: title.trim(), customTitle: true, updatedAt: Date.now() }); }} placeholder="为每节课起一个独立的名字"/></label>{kind === 'window' && <label className="setting-label">当前课程已播放到（秒）<input className="field" type="number" min="0" value={offset} disabled={Boolean(session)} onChange={event => setOffset(Math.max(0, Number(event.target.value)))}/><small>窗口课程按记录经过的时间对齐，暂停上课时也请停止记录。</small></label>}</>}
      <div className="source-actions"><span className="faint">本次新增 {count} 条记录</span></div>
      <button className="text-button" onClick={() => { history.replaceState(null, '', '?tab=settings&section=offline'); setView('library'); }}>添加离线功能 ›</button>
  </div>;
  if (view === 'library') return <Localized>{<LibraryApp onNewSource={() => setView('source')}/>}</Localized>;
  return <Localized>{<div className={`page desktop-source-page ${source ? 'player-ready' : ''} ${presentation.attached ? 'is-attached' : ''} ${presentation.fullscreen ? 'is-fullscreen' : ''} ${presentation.collapsed ? 'sidebar-collapsed' : ''}`}>
    <div className="page-header"><img className="brand-mark" src="/brand/icon-128.png" alt="" aria-hidden="true"/><h1 className="page-title">Vidence</h1><span className="beta-badge">BETA · 测试版</span><span className="header-caption">独立应用</span><div className="spacer"/><button className="btn" onClick={() => void showLibrary()}>我的视频库</button></div>
    {!presentation.attached && !presentation.fullscreen && <AppUpdates compact/>}
    <div className="workspace-intro"><div><span className="eyebrow">从这一刻开始</span><h1>让看过的，成为自己的。</h1><p>本地视频，或正在上课的窗口。选一个，开始学习。</p></div></div>
    <div className="layout source-layout"><main className="panel capture-panel">
      <div className="row player-heading"><strong>{source ? <span translate="no">{title}</span> : '视频预览'}</strong><div className="spacer"/>{source && <><button className="btn ghost" disabled={Boolean(session)} onClick={() => setAdjustingRegion(value => !value)}>{adjustingRegion ? '完成区域调整' : '调整记录区域'}</button><button className="btn ghost" onClick={() => void updatePresentation('attachSidebar').catch(error => setStatus(error.message))}>回到播放器</button><button className="btn ghost" onClick={() => void updatePresentation('fullscreen', true).catch(error => setStatus(error.message))}>全屏播放</button></>}<span className={`pill ${session ? 'ok' : ''}`}>{session ? '记录中' : '尚未记录'}</span></div>
      {source && !adjustingRegion ? <div className="capture-preview playback-launch"><span className="chat-spark">▷</span><h2>在播放器中继续学习</h2><p>播放、进度、音量和全屏都在原视频窗口操作。</p><button className="btn primary" onClick={() => void updatePresentation('attachSidebar').catch(error => setStatus(error.message))}>打开播放器与学习侧栏</button><small>需要框选字幕时，点击“调整记录区域”。</small></div> : <div className="capture-preview" onPointerDown={event => { if (session || !frame?.dataUrl) return; event.currentTarget.setPointerCapture(event.pointerId); drag.current = pointer(event); }} onPointerUp={event => { if (!drag.current) return; const end = pointer(event), begin = drag.current; drag.current = null; if (Math.abs(end.x - begin.x) > .02 && Math.abs(end.y - begin.y) > .02) setRoi({ x: Math.min(begin.x, end.x), y: Math.min(begin.y, end.y), w: Math.abs(end.x - begin.x), h: Math.abs(end.y - begin.y) }); }}>
        {frame?.dataUrl ? <><img ref={preview} src={frame.previewUrl || frame.dataUrl} alt="所选视频或课程窗口的实时预览" draggable={false} onLoad={event => { const image = event.currentTarget; if (image.naturalWidth) setImageSize({ width: image.naturalWidth, height: image.naturalHeight }); }}/>{(roi.w < .999 || roi.h < .999) && <svg className="capture-roi-svg" viewBox={`0 0 ${imageSize.width} ${imageSize.height}`} preserveAspectRatio="xMidYMid meet"><rect x={roi.x * imageSize.width} y={roi.y * imageSize.height} width={roi.w * imageSize.width} height={roi.h * imageSize.height}/></svg>}</> : <div className="capture-empty"><span className="chat-spark">▹</span><p>画面会显示在这里</p><small>先打开视频，或选择课程窗口。</small></div>}
      </div>}
      {source && adjustingRegion && <div className="row media-controls"><span>识别范围预览 · 画面中的按钮不可操作</span><button className="btn ghost" disabled={Boolean(session)} onClick={() => setRoi({ x: 0, y: 0, w: 1, h: 1 })}>记录整个画面</button></div>}
      <p className="source-status" role={source ? undefined : 'status'}>{status}</p>{adjustingRegion && <p className="faint capture-help">在预览图上拖动，选择字幕或课件区域。每个视频单独保存；识别到的文字先概括，再用于问答。</p>}
    </main>{sidebarVideo && source && <StudySidebar video={{ ...sidebarVideo, title: title || sidebarVideo.title, lastPosition: kind === 'local' ? frame?.time ?? 0 : session ? offset + (Date.now() - session.startedAt) / 1000 : offset }} collapsed={presentation.collapsed} attached={presentation.attached} recording={Boolean(session)} busy={busy || (!session && (!title.trim() || !frame?.dataUrl))} count={count} status={status} onCollapse={() => void updatePresentation('collapseSidebar', !presentation.collapsed)} onRecord={() => void (session ? stop() : start())} onLibrary={() => void showLibrary()} onRestore={() => void updatePresentation('restoreWindow')} sourcePicker={sourcePicker}/>} {!source && <aside className="panel source-entry">{sourcePicker}</aside>}</div>
  </div>}</Localized>;
}
