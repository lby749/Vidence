import { Localized } from '@/ui/i18n';
import { useEffect, useRef, useState } from 'react';
import { getDb, getSettings } from '@/db/db';
import type { ChatTurn, Settings, Video } from '@/shared/types';
import { connectUi, formatClock, sendUi, videoUrlAt } from '@/ui/chrome';
import AssistantPicker from './AssistantPicker';
import RichText from '@/ui/RichText';

export default function VideoConversation({ video, compact = false }: { video: Video; compact?: boolean }) {
  const [turns, setTurns] = useState<ChatTurn[]>([]), [question, setQuestion] = useState(() => sessionStorage.getItem(`vma-chat-draft:${video.id}`) ?? '');
  useEffect(() => { sessionStorage.setItem(`vma-chat-draft:${video.id}`, question); }, [video.id, question]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [allowImages, setAllowImages] = useState(false);
  const imageRouteSupported = (settings?.preferredQaRoute ?? (settings?.localAgent?.token ? 'local-agent' : 'api')) === 'api' || ['opencode-go', 'dsh'].includes(settings?.localAgent?.backend ?? '');
  const [pending, setPending] = useState<{ id: string; question: string; status: string; answer?: string; error?: string } | null>(null);
  const [memoryRevision, setMemoryRevision] = useState<number | null>(null);
  const currentRequest = useRef<string | null>(null); const ownTab = useRef<number | undefined>(undefined); const alive = useRef(true);
  const thread = useRef<HTMLDivElement | null>(null);
  const previewDialog = useRef<HTMLDialogElement | null>(null);
  const [preview, setPreview] = useState<{ url: string; time: number } | null>(null);
  useEffect(() => { if (!preview) return; previewDialog.current?.showModal(); return () => URL.revokeObjectURL(preview.url); }, [preview]);
  useEffect(() => { if (thread.current) thread.current.scrollTop = thread.current.scrollHeight; }, [turns.length, pending?.id, pending?.answer]);
  const reload = async () => { const rows = await getDb().chats.where('videoId').equals(video.id).sortBy('createdAt'); if (alive.current) setTurns(rows); };
  useEffect(() => {
    alive.current = true; setAllowImages(false);
    void reload();
    void getDb().longMemories.get(video.id).then(memory => { if (alive.current) setMemoryRevision(memory?.revision ?? null); });
    void getSettings().then(config => {
      if (!alive.current) return; setSettings(config);
    });
    const connection = connectUi({ onEvent: event => {
      if (!event.type.startsWith('ask:') || !('requestId' in event.payload) || event.payload.requestId !== currentRequest.current) return;
      if ('videoId' in event.payload && event.payload.videoId && event.payload.videoId !== video.id) return;
      if (event.type === 'ask:status') setPending(previous => previous ? { ...previous, status: event.payload.detail ?? statusLabel(event.payload.status) } : previous);
      if (event.type === 'ask:delta') setPending(previous => previous ? { ...previous, answer: (previous.answer ?? '') + event.payload.text } : previous);
      if (event.type === 'ask:done') { currentRequest.current = null; setPending(null); void reload(); }
      if (event.type === 'ask:error') { currentRequest.current = null; setPending(previous => previous ? { ...previous, error: event.payload.message, status: event.payload.code === 'canceled' ? '已取消' : '未能完成' } : previous); }
    } });
    void chrome.tabs.getCurrent().then(tab => { if (alive.current) { ownTab.current = tab?.id; connection.subscribe(tab?.id); } });
    return () => { alive.current = false; connection.close(); };
  }, [video.id]);
  const submit = async () => {
    if (!question.trim() || currentRequest.current) return;
    const id = `req_${crypto.randomUUID()}`, value = question.trim(); currentRequest.current = id;
    setPending({ id, question: value, status: '正在准备学习摘要' }); setQuestion('');
    try {
      await sendUi({ type: 'ui:ask', payload: { videoId: video.id, tabId: ownTab.current, requestId: id, question: value, route: settings?.preferredQaRoute ?? (settings?.localAgent?.token ? 'local-agent' : 'api'), frozenTime: video.lastPosition, selectedNodeIds: [], allowImages: Boolean(allowImages && settings?.privacy.allowVisionUpload && imageRouteSupported), followUpTo: turns.at(-1)?.context ? turns.at(-1)?.requestId : undefined } });
    } catch (error) { currentRequest.current = null; setPending({ id, question: value, status: '未能发送', error: (error as Error).message }); }
  };
  const source = async (turn: ChatTurn, index: number) => { const citation = turn.citations[index]; if (!citation) return; if (citation.keyframeId) { const frame = await getDb().keyframes.get(citation.keyframeId); if (frame?.videoId === video.id && alive.current) setPreview({ url: URL.createObjectURL(frame.image), time: frame.time }); } else window.open(videoUrlAt(video.url, citation.startTime), '_blank'); };
  return <Localized>{<section className="conversation" data-video-id={video.id}>
    <div className="conversation-heading"><div><span className="eyebrow">当前视频</span><h2>与视频对话</h2></div><span className={`pill ${memoryRevision ? 'ok' : ''}`}>{memoryRevision ? `已连接长期记忆 v${memoryRevision}` : '先概括，再回答'}</span></div>
    <div className="chat-thread" aria-live="polite" ref={thread}>
      {!turns.length && !pending && <div className="chat-empty"><span className="chat-spark">✧</span><h3>边看，边理解。</h3><p>关于这个视频，想知道些什么？</p><div className="suggestions">{['这段内容的核心是什么？', '帮我梳理关键步骤和易错点。'].map(value => <button className="btn" key={value} onClick={() => setQuestion(value)}>{value}</button>)}</div></div>}
      {turns.map(turn => <article key={turn.id} className="chat-turn" data-request-id={turn.requestId}>
        <div className="user-message">{turn.question}</div>
        <div className="assistant-message"><div className="assistant-label"><span className="ai-mark">✦</span> 学习助手 {turn.memoryContext && <span className="memory-badge">本视频长期记忆 v{turn.memoryContext.revision}</span>}</div>{turn.error ? <div className="chat-error">{turn.status === 'canceled' ? '已取消。' : '这次回答未完成。'}{turn.error}<button className="btn" onClick={() => setQuestion(turn.question)}>重新编辑问题</button></div> : <RichText text={turn.answer ?? ''} onCitation={index => void source(turn, index)} />}
          {turn.citations.length > 0 && <details className="source-details"><summary>查看 {turn.citations.length} 处原文依据</summary><div className="citations">{turn.citations.map((citation, index) => <button className="citation" title={citation.quote} key={index} onClick={() => void source(turn, index)}>[{index + 1}] {formatClock(citation.startTime)}</button>)}</div></details>}
        </div>
      </article>)}
      {pending && <article className="chat-turn pending"><div className="user-message">{pending.question}</div><div className="assistant-message"><div className="assistant-label"><span className="ai-mark">✦</span> {pending.status}</div>{pending.error ? <div className="chat-error">{pending.error}<button className="btn" onClick={() => { setQuestion(pending.question); setPending(null); }}>重新编辑</button></div> : <><RichText text={pending.answer || '正在根据当前视频的学习内容整理回答…'} /><button className="btn ghost" onClick={() => void sendUi({ type: 'ui:cancel-ask', payload: { requestId: pending.id } })}>停止回答</button></>}</div></article>}
    </div>
    <div className="chat-composer">{settings && <AssistantPicker settings={settings} onSettings={setSettings} disabled={Boolean(currentRequest.current)} inline={compact}/>}<textarea aria-label="向当前视频提问" placeholder="问问这个视频，或接着上次的讨论…" value={question} onChange={e => setQuestion(e.target.value)} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void submit(); } }} />
      <label className="chat-image-option"><input type="checkbox" checked={allowImages && imageRouteSupported && Boolean(settings?.privacy.allowVisionUpload)} disabled={!imageRouteSupported || !settings?.privacy.allowVisionUpload || Boolean(currentRequest.current)} onChange={event => setAllowImages(event.target.checked)}/>允许读取画面</label>{!settings?.privacy.allowVisionUpload && <small className="faint">在设置中开启“允许发送视频截图”后可用。</small>}
      <div className="composer-toolbar"><span className="composer-hint">⌘ / Ctrl + Enter</span><button className="btn primary" aria-label="发送给当前视频" disabled={!question.trim() || Boolean(currentRequest.current)} onClick={() => void submit()}>发送 ↑</button></div>
    </div>
    <dialog className="frame-preview" ref={previewDialog} aria-label="回答引用的画面" onClose={() => setPreview(null)} onCancel={() => setPreview(null)}><header><strong>回答引用的画面 {preview && formatClock(preview.time)}</strong><button className="icon-btn" aria-label="关闭画面" onClick={() => previewDialog.current?.close()}>×</button></header>{preview && <img src={preview.url} alt="回答实际读取的视频截图"/>}</dialog>
  </section>}</Localized>;
}

function statusLabel(status: string) { return ({ preparing: '正在准备', retrieving: '正在查找学习内容', summarizing: '先概括，再回答', generating: '正在组织回答', completed: '已完成' } as Record<string, string>)[status] ?? '正在处理'; }
