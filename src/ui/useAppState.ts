/** 侧边栏状态与问答事件管理。 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppEvent, AppStateSnapshot } from '@/shared/messages';
import type { Citation } from '@/shared/types';
import { activeTabId, connectUi, sendUi } from './chrome';

export interface AskView {
  requestId: string | null;
  status: string;
  answer: string;
  citations: Citation[];
  error?: string;
  warnings: string[];
}

const EMPTY_STATE: AppStateSnapshot = {
  tabId: undefined,
  video: null,
  session: null,
  probe: null,
  subtitleSource: { kind: 'none', label: '未开始记录' },
  recording: false,
  paused: false,
  recentEvidence: [],
  nodes: [],
  usage: { calls: 0, inputTokens: 0, outputTokens: 0, imageUploads: 0 },
  notion: { configured: false, pending: 0 },
  aiApps: [],
  connectors: [],
  library: { videos: 0, nodes: 0, evidence: 0, keyframes: 0 },
  warnings: [],
};

export function useAppState() {
  const [state, setState] = useState<AppStateSnapshot>(EMPTY_STATE);
  const [tabId, setTabId] = useState<number | undefined>();
  const [toast, setToast] = useState<string | null>(null);
  const [ask, setAsk] = useState<AskView>({ requestId: null, status: 'idle', answer: '', citations: [], warnings: [] });
  const videoRef = useRef<string | null>(null);
  const applyState = useCallback((next: AppStateSnapshot) => {
    const id = next.video?.id ?? null;
    const changed = videoRef.current !== id; videoRef.current = id;
    setState(next);
    setAsk(previous => {
      if (!changed && previous.requestId) return previous;
      const turn = next.lastTurn;
      if (turn) return { requestId: turn.requestId, status: turn.status, answer: turn.answer ?? '', citations: turn.citations, warnings: [] };
      return changed ? { requestId: null, status: 'idle', answer: '', citations: [], warnings: [] } : previous;
    });
  }, []);

  const refresh = useCallback(async (targetTabId?: number) => {
    // 支持 ?tabId= 指定目标（用于调试/自动化测试，正常打开时使用当前活动标签页）
    const fromQuery = Number(new URLSearchParams(location.search).get('tabId') || '') || undefined;
    const id = targetTabId ?? fromQuery ?? (await activeTabId());
    setTabId(id);
    try {
      const next = await sendUi<AppStateSnapshot>({ type: 'ui:get-state', payload: { tabId: id } });
      applyState(next);
    } catch (error) {
      setToast((error as Error).message);
    }
  }, [applyState]);

  useEffect(() => {
    let disposed = false;
    let connection: ReturnType<typeof connectUi> | null = null;
    void (async () => {
      const fromQuery = Number(new URLSearchParams(location.search).get('tabId') || '') || undefined;
      const id = fromQuery ?? (await activeTabId());
      if (disposed) return;
      setTabId(id);
      await refresh(id);
      connection = connectUi({
        onEvent: (event: AppEvent) => {
          if (event.type.startsWith('ask:') && 'videoId' in event.payload && event.payload.videoId && event.payload.videoId !== videoRef.current) return;
          switch (event.type) {
            case 'state':
              applyState(event.payload);
              break;
            case 'ask:status':
              setAsk((prev) =>
                prev.requestId === event.payload.requestId
                  ? { ...prev, status: event.payload.status, error: undefined }
                  : { ...prev, requestId: event.payload.requestId, status: event.payload.status, answer: '', citations: [], error: undefined, warnings: [] },
              );
              break;
            case 'ask:delta':
              setAsk((prev) =>
                prev.requestId === event.payload.requestId
                  ? { ...prev, answer: prev.answer + event.payload.text }
                  : prev,
              );
              break;
            case 'ask:done':
              setAsk((prev) =>
                prev.requestId === event.payload.requestId
                  ? {
                      ...prev,
                      status: 'completed',
                      answer: event.payload.answer,
                      citations: event.payload.citations as Citation[],
                    }
                  : prev,
              );
              break;
            case 'ask:error':
              setAsk((prev) =>
                prev.requestId === event.payload.requestId
                  ? { ...prev, status: event.payload.code === 'canceled' ? 'canceled' : 'failed', error: event.payload.message }
                  : prev,
              );
              break;
            case 'toast':
              setToast(event.payload.message);
              break;
            case 'capture:status':
              break;
          }
        },
        onDisconnect: () => {
          setToast('后台连接已断开，正在重连…');
          setTimeout(() => void refresh(), 800);
        },
      });
      connection.subscribe(id);
    })();
    return () => {
      disposed = true;
      connection?.close();
    };
  }, [refresh, applyState]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  return {
    state,
    tabId,
    toast,
    ask,
    refresh,
    send: sendUi,
    setAsk,
    setToast,
  };
}
