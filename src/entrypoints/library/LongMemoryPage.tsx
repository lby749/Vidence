import { Localized } from '@/ui/i18n';
import { useEffect, useRef, useState } from 'react';
import { getDb } from '@/db/db';
import type { LongTermMemory, Video } from '@/shared/types';
import { generateLongMemory, saveLongMemory } from '@/agent/long-term-memory';
import { formatClock } from '@/ui/chrome';
import { videoUrlAt } from '@/ui/chrome';
import RichText from '@/ui/RichText';

export default function LongMemoryPage({ videos, onToast }: { videos: Video[]; onToast: (message: string) => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [memories, setMemories] = useState<LongTermMemory[]>([]);
  const [progress, setProgress] = useState('');
  const [running, setRunning] = useState(false);
  const [unfinished, setUnfinished] = useState<string[]>([]);
  const [viewId, setViewId] = useState<string | null>(null), [filter, setFilter] = useState('');
  const drafts = useRef(new Map<string, string>());
  const controller = useRef<AbortController | null>(null);
  const reload = async () => setMemories(await getDb().longMemories.toArray());
  useEffect(() => { void reload(); return () => controller.current?.abort(); }, []);
  const generate = async (ids = selected) => {
    controller.current = new AbortController(); setRunning(true); setUnfinished([]); setProgress('正在准备所选视频…');
    let pending = [...ids];
    const errors: string[] = []; let completed = 0;
    try {
      for (const id of ids) {
        if (controller.current.signal.aborted) break;
        try { await generateLongMemory(id, controller.current.signal, setProgress); completed++; pending = pending.filter(item => item !== id); await reload(); }
        catch (error) { errors.push(`${videos.find(v => v.id === id)?.title}：${(error as Error).message}`); }
      }
      setProgress(`已保存 ${completed} 个视频的独立记忆。${errors.join('；')}${controller.current.signal.aborted ? ' 已取消后续处理。' : ''}`);
      setUnfinished(pending);
    } finally { setRunning(false); }
  };
  const activeId = viewId ?? memories[0]?.videoId ?? videos[0]?.id;
  const activeMemory = memories.find(memory => memory.videoId === activeId);
  return <Localized>{<>
    <div className="workspace-intro"><div><span className="eyebrow">PERSONAL MEMORY</span><h1>长期记忆</h1><p>按视频保存知识，随时回到它的来处。</p></div><span className="workspace-count">{memories.length} 份记忆<span>彼此独立，清楚可追溯</span></span></div>
    <div className="layout memory-layout">
    <aside className="panel memory-sidebar">
      <div className="sidebar-heading"><strong>我的视频</strong><span>{videos.length}</span></div>
      <input className="field sidebar-filter" aria-label="查找记忆视频" placeholder="查找视频…" value={filter} onChange={e => setFilter(e.target.value)} />
      <div className="memory-video-list">{videos.filter(video => video.title.toLowerCase().includes(filter.toLowerCase())).map(video => <div className={`memory-video ${activeId === video.id ? 'active' : ''}`} key={video.id}>
        <input type="checkbox" aria-label={`记忆选择：${video.title}`} disabled={running} checked={selected.includes(video.id)} onChange={e => setSelected(previous => e.target.checked ? [...previous, video.id] : previous.filter(id => id !== video.id))} />
        <button className="memory-video-open" onClick={() => setViewId(video.id)}><span translate="no">{video.title}</span><small>{memories.some(memory => memory.videoId === video.id) ? '已保存长期记忆' : '尚未整理'} · {Math.round(video.recordedRanges.reduce((sum, [a,b]) => sum+b-a, 0))} 秒已记录</small></button>
      </div>)}</div>
      <div className="memory-batch"><p className="faint">多选仅批量整理，各视频分别保存。</p><button className="btn primary" disabled={running || !selected.length} onClick={() => void generate()}>生成所选视频的长期记忆（{selected.length}）</button>
      {running && <button className="btn" onClick={() => controller.current?.abort()}>取消生成</button>}
      {!running && unfinished.length > 0 && <button className="btn" onClick={() => void generate(unfinished)}>重试未完成视频（{unfinished.length}）</button>}
      {progress && <div role="status" className="generation-progress">{progress}</div>}</div>
    </aside>
    <main className="memory-main">
      {!activeMemory && <div className="panel memory-empty"><span className="chat-spark">✧</span><h2>为这段学习留一份记忆。</h2><p>在左侧勾选视频后整理。记录的内容先概括，再进入问答；每条结论保留原文依据。</p></div>}
      {activeMemory && <MemoryCard key={`${activeMemory.videoId}-${activeMemory.revision}`} memory={activeMemory} video={videos.find(v => v.id === activeMemory.videoId)} onChange={reload} onToast={onToast} drafts={drafts.current} />}
    </main>
  </div></>}</Localized>;
}

function MemoryCard({ memory, video, onChange, onToast, drafts }: { memory: LongTermMemory; video?: Video; onChange: () => Promise<void>; onToast: (message: string) => void; drafts: Map<string, string> }) {
  const [body, setBody] = useState(drafts.get(memory.videoId) ?? memory.body), [editing, setEditing] = useState(drafts.has(memory.videoId));
  const save = async (patch: Partial<LongTermMemory>) => {
    try { await saveLongMemory({ ...memory, ...patch, updatedAt: Date.now() }, memory.revision); drafts.delete(memory.videoId); await onChange(); onToast('长期记忆已保存'); }
    catch (error) { onToast((error as Error).message); }
  };
  return <Localized>{<section className="panel long-memory-card" data-video-id={memory.videoId} style={{ marginBottom: 14 }}>
    <div className="memory-document-header"><div className="row"><span className="eyebrow">本视频的学习摘要</span><div className="spacer"/><span className="pill">版本 {memory.revision}</span></div><h2 translate="no">{video?.title ?? memory.videoId}</h2><p className="faint">{new Date(memory.updatedAt).toLocaleDateString()} 更新 · {memory.sources.length} 处原文依据 · {memory.locked ? '已锁定保护' : '可编辑'}</p></div>
    {editing ? <textarea className="field memory-editor" aria-label={`长期记忆内容：${video?.title ?? memory.videoId}`} rows={16} value={body} disabled={memory.locked} onChange={e => { setBody(e.target.value); drafts.set(memory.videoId, e.target.value); }} /> : <RichText text={memory.body} onCitation={index => { const source = memory.sources[index]; if (video && source) window.open(videoUrlAt(video.url, source.startTime), '_blank'); }} />}
    <div className="row" style={{ marginTop: 8 }}>
      {!editing && <button className="btn" disabled={memory.locked} onClick={() => setEditing(true)}>编辑记忆</button>}
      {editing && <><button className="btn primary" disabled={memory.locked || !body.trim() || body === memory.body} onClick={() => void save({ body: body.trim(), model: '人工编辑' })}>保存修改</button><button className="btn ghost" onClick={() => { drafts.delete(memory.videoId); setBody(memory.body); setEditing(false); }}>取消编辑</button></>}
      <button className="btn ghost" onClick={() => void save({ locked: !memory.locked })}>{memory.locked ? '解锁记忆' : '锁定记忆'}</button>
      <button className="btn" disabled={memory.locked || !memory.versions.length} onClick={() => { const old = memory.versions.at(-1)!; void save({ body: old.body, sources: old.sources }); }}>恢复上一版本</button>
    </div>
    <details style={{ marginTop: 8 }}><summary className="faint">查看原文来源（{memory.sources.length}）</summary><div className="citations" style={{ marginTop: 8 }}>
      {memory.sources.map((source, index) => <button className="citation" key={`${source.evidenceId}-${index}`} title={source.quote} onClick={() => { if (video) window.open(videoUrlAt(video.url, source.startTime), '_blank'); }}>[{index + 1}] {formatClock(source.startTime)} · 本视频原文</button>)}
    </div></details>
  </section>}</Localized>;
}
