import { Localized } from '@/ui/i18n';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { getDb } from '@/db/db';
import type { LongTermMemory, Video } from '@/shared/types';
import { generateLongMemory } from '@/agent/long-term-memory';
import VideoConversation from '../library/VideoConversation';
import RichText from '@/ui/RichText';

export default function StudySidebar({ video, collapsed, recording, busy, count, status, onCollapse, onRecord, onLibrary, onRestore, attached, sourcePicker }: { video: Video; collapsed: boolean; recording: boolean; busy: boolean; count: number; status: string; onCollapse: () => void; onRecord: () => void; onLibrary: () => void; onRestore: () => void; attached: boolean; sourcePicker?: ReactNode }) {
  const [tab, setTab] = useState<'chat' | 'memory'>('chat');
  const [sourceOpen, setSourceOpen] = useState(false);
  useEffect(() => setSourceOpen(false), [video.id]);
  const [memory, setMemory] = useState<LongTermMemory | undefined>();
  const [evidence, setEvidence] = useState(0), [pictures, setPictures] = useState(0), [generating, setGenerating] = useState(false), [message, setMessage] = useState('');
  const controller = useRef<AbortController | null>(null), current = useRef(video.id); current.current = video.id;
  useEffect(() => {
    const id = video.id; let alive = true;
    void Promise.all([getDb().longMemories.get(id), getDb().evidence.where('videoId').equals(id).count(), getDb().keyframes.where('videoId').equals(id).count()]).then(([memory, count, images]) => { if (alive) { setMemory(memory); setEvidence(count); setPictures(images); } });
    return () => { alive = false; };
  }, [video.id, count, tab]);
  useEffect(() => { setMemory(undefined); setMessage(''); setGenerating(false); return () => controller.current?.abort(); }, [video.id]);
  const generate = async () => {
    const id = video.id, abort = new AbortController(); controller.current = abort; setGenerating(true);
    try {
      await generateLongMemory(id, abort.signal, value => { if (current.current === id) setMessage(value); });
      const result = await getDb().longMemories.get(id);
      if (current.current === id) { setMemory(result); setMessage('本视频的长期记忆已保存。'); }
    } catch (error) { if (current.current === id) setMessage((error as Error).message); }
    finally { if (current.current === id) setGenerating(false); }
  };
  return <Localized>{<aside className={`study-sidebar ${collapsed ? 'is-collapsed' : ''}`} data-video-id={video.id}>
    <button className="study-edge" aria-label={collapsed ? '展开学习侧栏' : '收起学习侧栏'} onClick={onCollapse}><img className="brand-mark" src="/brand/icon-128.png" alt="" aria-hidden="true"/><span>{collapsed ? '展开' : '›'}</span></button>
    <div className="study-body">
      <div className="study-heading"><div><span className="eyebrow">学习空间</span><h2 translate="no" title={video.title}>{video.title}</h2></div>{sourcePicker && <button className="source-picker-toggle" aria-label="更换视频源" aria-expanded={sourceOpen} disabled={recording} onClick={() => setSourceOpen(value => !value)}>来源 ⌄</button>}<button className="icon-btn" aria-label="收起学习侧栏" onClick={onCollapse}>›</button></div>
      {sourceOpen && <section className="sidebar-source-popover" role="region" aria-label="选择视频来源" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setSourceOpen(false); } }}><header><strong>视频来源</strong><button className="picker-close" aria-label="收起来源选择" onClick={() => setSourceOpen(false)}>×</button></header>{sourcePicker}</section>}
      <div className="study-record"><span className={`pill ${recording ? 'ok' : ''}`}>{recording ? '正在记录' : `${evidence} 段文字 · ${pictures} 张画面`}</span><button className="btn primary" disabled={busy} onClick={onRecord}>{recording ? '结束并保存' : '开始记录'}</button></div>
      <div className="study-tabs" role="tablist" aria-label="学习侧栏"><button role="tab" aria-selected={tab === 'chat'} onClick={() => setTab('chat')}>提问</button><button role="tab" aria-selected={tab === 'memory'} onClick={() => setTab('memory')}>长期记忆</button></div>
      <div className="study-chat" hidden={tab !== 'chat'}><VideoConversation key={video.id} video={video} compact/></div>
      <div className="study-memory" hidden={tab !== 'memory'}>{memory ? <><span className="pill">本视频 · v{memory.revision}</span><RichText text={memory.body}/></> : <div className="chat-empty"><span className="chat-spark">✧</span><h3>把学过的，留下来。</h3><p>先记录片段，再整理为这个视频自己的长期记忆。</p></div>}<p className="muted">{pictures > 0 && !evidence ? '当前仅有画面。可在提问中允许读图，补充文字记录后再生成长期记忆。' : ''}</p><button className="btn" disabled={!evidence || generating || memory?.locked} onClick={() => void generate()}>{generating ? '正在整理…' : memory ? '更新本视频的记忆' : '整理本视频的长期记忆'}</button>{generating && <button className="text-button" onClick={() => controller.current?.abort()}>停止整理</button>}</div>
      <p className="study-status" role="status">{message || status}</p>
      <footer><button className="text-button" onClick={onLibrary}>打开视频库</button>{attached && <button className="text-button" onClick={onRestore}>回到主窗口</button>}</footer>
    </div>
  </aside>}</Localized>;
}
