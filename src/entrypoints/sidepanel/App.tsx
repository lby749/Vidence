import { Localized, useUiLocale } from '@/ui/i18n';
import AppUpdates from '@/ui/AppUpdates';
import { orderForLocale } from '@/ui/locale-order';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getSettings } from '@/db/db';
import type { Settings } from '@/shared/types';
import type { Citation } from '@/shared/types';
import type { AppStateSnapshot } from '@/shared/messages';
import { formatClock, sendUi } from '@/ui/chrome';
import { useAppState } from '@/ui/useAppState';
import RichText from '@/ui/RichText';
import AssistantPicker from '@/entrypoints/library/AssistantPicker';

type TabKey = 'nodes' | 'ask';

const EMBEDDED = new URLSearchParams(location.search).get('embedded') === '1';

interface AiProgress {
  requestId: string;
  status: string;
  message: string;
  answer?: string;
  citations?: Citation[];
}

export default function App() {
  const { locale } = useUiLocale();
  const { state, toast, ask, refresh, send, setToast, tabId } = useAppState();
  const [tab, setTab] = useState<TabKey>(() =>
    new URLSearchParams(location.search).get('tab') === 'ask' ? 'ask' : 'nodes',
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [question, setQuestion] = useState('');
  const [followUp, setFollowUp] = useState(false);
  const [route, setRoute] = useState<'api' | 'ai-app' | 'local-agent'>('api');
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    void getSettings().then(next => {
      setSettings(next);
      setRoute(next.preferredQaRoute ?? (next.localAgent?.token ? 'local-agent' : 'api'));
    });
    const reload = () => void getSettings().then(next => {
      setSettings(next);
      setRoute(current => current === 'ai-app' ? current : next.preferredQaRoute ?? current);
    });
    window.addEventListener('focus', reload);
    return () => window.removeEventListener('focus', reload);
  }, []);
  const [connectorId, setConnectorId] = useState<string>('chatgpt');
  const [allowImages, setAllowImages] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [ai, setAi] = useState<AiProgress | null>(null);
  const [handoff, setHandoff] = useState<string | null>(null);
  const pollTimer = useRef<number | null>(null);

  const video = state.video;
  const probe = state.probe;
  const frozen = useRef(0);

  useEffect(() => {
    if (selected.length > 0) setTab('ask');
  }, [selected.length]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'vma:switch-tab' && (event.data.tab === 'ask' || event.data.tab === 'nodes')) {
        setTab(event.data.tab);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && EMBEDDED) {
        window.parent.postMessage({ type: 'vma:close-dock' }, '*');
      }
    };
    window.addEventListener('message', onMessage);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (pollTimer.current) window.clearInterval(pollTimer.current);
    };
  }, []);

  const selectedNodes = useMemo(
    () => state.nodes.filter((node) => selected.includes(node.id)),
    [state.nodes, selected],
  );

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    try {
      await action();
    } catch (error) {
      setToast((error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const start = () =>
    run('start', async () => {
      if (tabId === undefined) throw new Error('没有可用标签页');
      await send({ type: 'ui:start', payload: { tabId } });
      await refresh();
    });

  const toggleSelect = (nodeId: string) => {
    setFollowUp(false);
    setSelected((prev) => (prev.includes(nodeId) ? prev.filter((id) => id !== nodeId) : [...prev, nodeId]));
  };

  const seek = (time: number) => {
    void run('seek', async () => {
      await send({ type: 'ui:seek', payload: { time, videoId: video?.id, tabId } });
    });
  };

  const submitAsk = () =>
    run('ask', async () => {
      if (!question.trim()) throw new Error('请输入问题');
      frozen.current = probe?.currentTime ?? 0;
      if (route === 'ai-app') {
        if (connectorId === 'manual-handoff') {
          const result = await send<{ text: string }>({
            type: 'ui:handoff',
            payload: { question: question.trim(), frozenTime: frozen.current, selectedNodeIds: selected, videoId: video?.id },
          });
          setHandoff(result.text);
          await navigator.clipboard.writeText(result.text).catch(() => undefined);
          setToast('已生成交接内容并复制到剪贴板');
          return;
        }
        const requestId = `air_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const prepared = await send<{ requestId: string; evidenceCount: number; promptChars: number }>({
          type: 'ui:ai-prepare',
          payload: {
            connectorId,
            question: question.trim(),
            frozenTime: frozen.current,
            selectedNodeIds: selected,
            allowImages,
            requestId,
          },
        });
        setAi({
          requestId: prepared.requestId,
          status: 'awaiting-confirm',
          message: `已打开应用并填入问题（${prepared.evidenceCount} 条证据，${prepared.promptChars} 字），请确认后发送`,
        });
        return;
      }
      await send({
        type: 'ui:ask',
        payload: {
          question: question.trim(),
          route,
          videoId: video?.id,
          tabId,
          followUpTo: followUp && ask.status === 'completed' ? ask.requestId ?? undefined : undefined,
          selectedNodeIds: selected,
          frozenTime: frozen.current,
          allowImages,
        },
      });
    });

  const confirmAiSend = () =>
    run('ai-send', async () => {
      if (!ai) return;
      const result = await send<{ status: string; message: string }>({
        type: 'ui:ai-send',
        payload: { requestId: ai.requestId, confirmSend: true },
      });
      setAi({ ...ai, status: result.status, message: result.message });
      if (result.status === 'sent' || result.status === 'generating') {
        if (pollTimer.current) window.clearInterval(pollTimer.current);
        let ticks = 0;
        pollTimer.current = window.setInterval(() => {
          ticks += 1;
          void (async () => {
            const read = await send<{ status: string; message: string; answer?: string; citations?: Citation[] }>({
              type: 'ui:ai-read',
              payload: { requestId: ai.requestId },
            });
            setAi((prev) =>
              prev
                ? { ...prev, status: read.status, message: read.message, answer: read.answer ?? prev.answer, citations: read.citations ?? prev.citations }
                : prev,
            );
            if (read.status === 'completed' || read.status === 'failed' || ticks > 30) {
              if (pollTimer.current) window.clearInterval(pollTimer.current);
              await refresh();
            }
          })();
        }, 5000);
      }
    });

  const readAiNow = () =>
    run('ai-read', async () => {
      if (!ai) return;
      const result = await send<{ status: string; message: string; answer?: string; citations?: Citation[] }>({
        type: 'ui:ai-read',
        payload: { requestId: ai.requestId },
      });
      setAi({ ...ai, status: result.status, message: result.message, answer: result.answer, citations: result.citations });
      await refresh();
    });

  const cancelAi = () =>
    run('ai-cancel', async () => {
      if (!ai) return;
      await send({ type: 'ui:ai-cancel', payload: { requestId: ai.requestId } });
      setAi(null);
    });

  const copyHandoff = async () => {
    if (!handoff) return;
    await navigator.clipboard.writeText(handoff).catch(() => undefined);
    setToast('已复制交接内容');
  };

  const statusPill = state.recording ? (state.paused ? '已暂停' : '记录中') : '未记录';

  return <Localized>{(
    <div className="app browser-sidepanel">
      <div className="topbar">
        <div className="brand">
          <img className="brand-mark" src="/brand/icon-128.png" alt="" aria-hidden="true"/>
          Vidence
        </div>
        <span className={`pill ${state.recording ? 'ok' : ''}`}>{statusPill}</span>
        <div className="spacer" />
        <button className="btn ghost" title="刷新状态" onClick={() => void refresh()} disabled={busy === 'refresh'}>
          刷新
        </button>
        {EMBEDDED && (
          <button
            className="btn ghost"
            title="关闭面板"
            aria-label="关闭面板"
            onClick={() => window.parent.postMessage({ type: 'vma:close-dock' }, '*')}
          >
            ×
          </button>
        )}
      </div>

      <AppUpdates compact/>
      {toast && <div className="toast">{toast}</div>}

      <div className="section">
        {video ? (
          <>
            <div className="video-title" title={video.title}>
              {video.title}
            </div>
            <div className="row muted" style={{ fontSize: 11 }}>
              <span>{video.platform}</span>
              {probe && (
                <span>
                  {formatClock(probe.currentTime)} / {formatClock(probe.duration)}
                </span>
              )}
              {video.recordedRanges.length > 0 && <span>已记录 {Math.round(video.recordedRanges.reduce((sum, [a, b]) => sum + (b - a), 0))}s</span>}
            </div>
          </>
        ) : (
          <div className="muted">在当前标签页打开视频后开始记录。</div>
        )}

        <div className="row" style={{ marginTop: 8 }}>
          {!state.recording ? (
            <button className="btn primary" onClick={start} disabled={busy !== null || tabId === undefined}>
              {busy === 'start' ? '启动中…' : '开始记录'}
            </button>
          ) : (
            <>
              {state.paused ? (
                <button className="btn" onClick={() => run('resume', async () => { await send({ type: 'ui:resume' }); await refresh(); })}>
                  继续
                </button>
              ) : (
                <button className="btn" onClick={() => run('pause', async () => { await send({ type: 'ui:pause' }); await refresh(); })}>
                  暂停
                </button>
              )}
              <button
                className="btn"
                onClick={() => run('stop', async () => { await send({ type: 'ui:stop' }); await refresh(); })}
              >
                停止
              </button>
            </>
          )}
          {state.recording && (
            <>
              <button
                className="btn ghost"
                onClick={() =>
                  run('roi', async () => {
                    await send({ type: 'ui:detect-subtitles', payload: {} });
                    await refresh();
                  })
                }
                disabled={busy !== null}
                title="在页面上框选字幕区域"
              >
                框选字幕区
              </button>
              <button
                className="btn ghost"
                onClick={() =>
                  run('kf', async () => {
                    await send({ type: 'ui:manual-keyframe' });
                    setToast('已保存关键帧');
                  })
                }
                disabled={busy !== null}
              >
                保存画面
              </button>
            </>
          )}
        </div>

        <div className="row" style={{ marginTop: 6, fontSize: 11 }}>
          <span className="faint">字幕来源</span>
          <span className={`pill ${state.subtitleSource.kind === 'none' ? 'warn' : 'ok'}`}>
            {state.subtitleSource.label}
          </span>
          {state.subtitleSource.roi && (
            <span className="faint">
              ROI {(state.subtitleSource.roi.x * 100).toFixed(0)}%,{(state.subtitleSource.roi.y * 100).toFixed(0)}%
            </span>
          )}
        </div>
      </div>

      {state.warnings.slice(0, 3).map((warning) => (
        <div className="banner" key={warning}>
          {warning}
        </div>
      ))}

      <div className="row section">
        <button className="btn" onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL('library.html?tab=settings#api') })}>配置 API</button>
        <button className="btn" onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL('library.html?tab=memory') })}>长期记忆</button>
      </div>

      {settings && <div className="section"><AssistantPicker settings={settings} inline disabled={busy !== null} onSettings={next => { setSettings(next); setRoute(next.preferredQaRoute ?? 'api'); }}/></div>}
      <div className="tabs">
        <button className={`tab ${tab === 'nodes' ? 'active' : ''}`} onClick={() => setTab('nodes')}>
          节点 {state.nodes.length > 0 ? `(${state.nodes.length})` : ''}
        </button>
        <button className={`tab ${tab === 'ask' ? 'active' : ''}`} onClick={() => setTab('ask')}>
          提问 {selected.length > 0 ? `(选中 ${selected.length})` : ''}
        </button>
      </div>

      {tab === 'nodes' && (
        <div className="section">
          {state.nodes.length === 0 ? (
            <div className="empty">
              {state.recording ? '正在观察字幕，节点会在出现后自动生成…' : '开始记录后，这里会出现按时间切分的节点。'}
            </div>
          ) : (
            <div className="list">
              {state.nodes.map((node) => (
                <div className={`node ${selected.includes(node.id) ? 'selected' : ''}`} key={node.id}>
                  <input
                    className="node-check"
                    type="checkbox"
                    checked={selected.includes(node.id)}
                    onChange={() => toggleSelect(node.id)}
                    aria-label={`选择节点 ${node.title}`}
                  />
                  <div className="node-body">
                    <div className="node-title" onClick={() => seek(node.startTime)} title="点击跳回视频">
                      {node.title}
                    </div>
                    <div className="node-meta">
                      <span className="time-chip">{formatClock(node.startTime)}</span>
                      <span>{formatClock(node.endTime)}</span>
                      {node.status === 'draft' ? <span>草稿</span> : <span>{node.status}</span>}
                    </div>
                  </div>
                  <button className="btn ghost" onClick={() => seek(node.startTime)} title="跳回视频">
                    ▶
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'ask' && (
        <div className="section">
          <div className="ask-box">
            <div className="row" style={{ fontSize: 11 }}>
              <span className="faint">路线</span>
              <select className="field" style={{ width: 'auto' }} value={route} onChange={(e) => setRoute(e.target.value as typeof route)}>
                <option value="api">API</option>
                <option value="ai-app">AI 应用</option>
                <option value="local-agent">本地智能体</option>
              </select>
              {route === 'ai-app' && (
                <select className="field" style={{ width: 'auto' }} value={connectorId} onChange={(e) => setConnectorId(e.target.value)}>
                  {orderForLocale(state.aiApps,locale,'aiApp',app=>app.id).map((app) => (
                    <option key={app.id} value={app.id}>
                      {app.label}
                    </option>
                  ))}
                  <option value="manual-handoff">手动交接</option>
                </select>
              )}
            </div>

            {route === 'api' && (!settings?.roles.answerModel?.modelId || !settings.providers.some(p => p.id === settings.roles.answerModel?.providerId && p.apiKey)) && (
              <div className="banner">先点击“配置 API”连接自己的服务，自动获取模型；也可以选择已连接的 AI 助手。</div>
            )}
            {route === 'local-agent' && !settings?.localAgent?.token && <div className="banner">请先在设置中连接电脑上的 AI 助手；也可以直接使用 API 服务。</div>}

            {selectedNodes.length > 0 && (
              <div className="row" style={{ fontSize: 11 }}>
                <span className="faint">已选节点：</span>
                {selectedNodes.slice(0, 3).map((node) => (
                  <span className="pill" key={node.id}>
                    {node.title.slice(0, 12)}
                  </span>
                ))}
                {selectedNodes.length > 3 && <span className="faint">+{selectedNodes.length - 3}</span>}
                <button className="btn ghost" onClick={() => { setSelected([]); setFollowUp(false); }}>
                  清空
                </button>
              </div>
            )}

            <textarea
              className="question"
              placeholder="就当前片段提问，例如：刚才这一步是怎么推导出来的？"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submitAsk();
              }}
            />
            {route !== 'ai-app' && ask.status === 'completed' && (
              <label className="row faint" style={{ fontSize: 11 }}>
                <input type="checkbox" checked={followUp} onChange={e => setFollowUp(e.target.checked)} />
                继续追问（沿用上次范围与播放位置）
              </label>
            )}

            <div className="row">
              <button className="btn ghost" onClick={() => setQuestion('刚才这一段在讲什么？请结合证据说明。')}>
                问问刚才这一段
              </button>
              <label className="row faint" style={{ fontSize: 11, gap: 4 }}>
                <input type="checkbox" disabled={!settings?.privacy.allowVisionUpload || route === 'ai-app' || (route === 'local-agent' && !['opencode-go', 'dsh'].includes(settings?.localAgent?.backend ?? ''))} checked={allowImages && Boolean(settings?.privacy.allowVisionUpload)} onChange={(e) => setAllowImages(e.target.checked)} />
                允许读取关键帧
              </label>
              <div className="spacer" />
              <button className="btn primary" onClick={submitAsk} disabled={busy !== null || !video || (route !== 'ai-app' && Boolean(ask.requestId) && !['completed', 'failed', 'canceled'].includes(ask.status))}>
                {busy === 'ask' ? '处理中…' : '发送'}
              </button>
            </div>

            {route !== 'ai-app' && ask.requestId && (
              <div className="answer">
                <div className="row faint" style={{ fontSize: 11, marginBottom: 6 }}>
                  <span>状态：{ask.status}</span>
                  {!['completed', 'failed', 'canceled'].includes(ask.status) && (
                    <button
                      className="btn ghost"
                      onClick={() => void send({ type: 'ui:cancel-ask', payload: { requestId: ask.requestId! } })}
                    >
                      取消
                    </button>
                  )}
                </div>
                {ask.error ? <div className="banner err">{ask.error}</div> : <RichText text={ask.answer || '正在组织回答…'} onCitation={index => { const citation = ask.citations[index]; if (citation) seek(citation.startTime); }} />}
                {ask.citations.length > 0 && (
                  <div className="citations">
                    {ask.citations.map((citation: Citation, index: number) => (
                      <button
                        key={`${citation.evidenceId}-${index}`}
                        className="citation"
                        title={citation.quote}
                        onClick={() => seek(citation.startTime)}
                      >
                        [{index + 1}] {formatClock(citation.startTime)}–{formatClock(citation.endTime)}
                      </button>
                    ))}
                  </div>
                )}
                {video && <button className="btn ghost" onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL(`library.html?videoId=${encodeURIComponent(video.id)}`) })}>查看这个视频的全部对话 ↗</button>}
              </div>
            )}

            {route === 'ai-app' && ai && (
              <div className="answer">
                <div className="muted" style={{ fontSize: 12 }}>
                  {ai.message}
                </div>
                <div className="row" style={{ marginTop: 8 }}>
                  {ai.status === 'awaiting-confirm' && (
                    <button className="btn primary" onClick={confirmAiSend} disabled={busy !== null}>
                      发送到应用
                    </button>
                  )}
                  <button className="btn" onClick={readAiNow} disabled={busy !== null}>
                    读取当前回答
                  </button>
                  <button className="btn ghost" onClick={cancelAi}>
                    取消
                  </button>
                </div>
                {ai.answer && (
                  <div className="answer" style={{ marginTop: 8, background: '#fbf8f3' }}>
                    {ai.answer}
                    {ai.citations && ai.citations.length > 0 && (
                      <div className="citations">
                        {ai.citations.map((citation, index) => (
                          <button key={citation.evidenceId} className="citation" title={citation.quote} onClick={() => seek(citation.startTime)}>
                            [{index + 1}] {formatClock(citation.startTime)}–{formatClock(citation.endTime)}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>
                  网页辅助连接器：仅操作正常可见界面，不读取 Cookie；站点改版可能导致失效。
                </div>
              </div>
            )}

            {handoff && (
              <div className="answer">
                <div className="row" style={{ fontSize: 11 }}>
                  <span className="pill warn">手动交接</span>
                  <button className="btn ghost" onClick={copyHandoff}>
                    复制
                  </button>
                </div>
                <div className="code" style={{ marginTop: 6, maxHeight: 180 }}>
                  {handoff}
                </div>
              </div>
            )}

            {route === 'ai-app' && connectorId !== 'manual-handoff' && (
              <button
                className="btn ghost"
                onClick={() => run('open', async () => { await send({ type: 'ui:open-connector', payload: { connectorId } }); })}
              >
                只打开应用
              </button>
            )}
          </div>
        </div>
      )}

      <div className="section" style={{ borderBottom: 'none', marginTop: 'auto' }}>
        <div className="row faint" style={{ fontSize: 10.5 }}>
          <span>
            今日调用 {state.usage.calls} 次 · {state.usage.unknownTokenCalls ? `${state.usage.inputTokens + state.usage.outputTokens} 个已知 tokens，${state.usage.unknownTokenCalls} 次用量未返回` : `${state.usage.inputTokens}+${state.usage.outputTokens} tokens`}
          </span>
          <div className="spacer" />
          <span>
            库 {state.library.videos} 视频 / {state.library.nodes} 节点
          </span>
        </div>
      </div>
    </div>
  )}</Localized>;
}

export type { AppStateSnapshot };
