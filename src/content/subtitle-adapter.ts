/**
 * SubtitleAdapter（内容脚本侧）。
 *
 * 优先级：可读文本轨 → 页面可访问字幕节点 → 字幕区域 OCR（由后台触发）。
 * 只观察"当前实际播放过程中"出现的字幕；不把整份字幕文件提前加入记忆。
 */

import { isPlayerControlText } from '@/pipeline/subtitle';

export interface CaptionObservation {
  text: string;
  startTime: number;
  endTime: number;
  source: 'texttrack' | 'dom' | 'ocr';
  confidence?: number;
  provenance?: string;
}

interface DomCandidate {
  text: string;
  confidence: number;
  provenance: string;
}

interface ActiveCue {
  text: string;
  start: number;
  end: number;
  key: string;
}

/** 已知站点的字幕容器选择器；不含任何站点私有接口调用。 */
const KNOWN_SELECTORS = [
  '.ytp-caption-segment',
  '.caption-window',
  '.ytp-caption-window-container',
  '.bpx-player-subtitle-panel-text',
  '.bpx-player-subtitle-panel',
  '.bilibili-player-video-subtitle',
  '.shaka-player-captions',
  '.vjs-text-track-display',
  '.jw-text-track-display',
  '.plyr__captions',
  '[data-purpose="captions-cue-text"]',
  '[data-testid="caption-line"]',
  '[class*="caption-line"]',
  '[class*="captions-cue"]',
  '[class*="subtitle-panel"]',
  '[class*="video-subtitle"]',
];

function textOf(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function isInsideChrome(el: Element): boolean {
  return Boolean(el.closest('header, nav, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], .ytp-chrome-bottom, .ytp-chrome-top, .ytp-tooltip, .bpx-player-control-wrap, .vjs-control-bar, .jw-controlbar, [role="slider"]'));
}

export class SubtitleAdapter {
  private video: HTMLVideoElement | null = null;
  private pollTimer: number | null = null;
  private observer: MutationObserver | null = null;
  private onCaption: ((caption: CaptionObservation) => void) | null = null;
  private onSourceHint: ((kind: 'texttrack' | 'dom' | 'none') => void) | null = null;

  private activeCue: ActiveCue | null = null;
  private domText: string | null = null;
  private domStart: number | null = null;
  private domConfidence = 0.9;
  private domProvenance = '';
  private domLastSeenMedia: number | null = null;
  private domLastSeenWall = 0;
  private lastSourceHint: 'texttrack' | 'dom' | 'none' | null = null;

  start(
    video: HTMLVideoElement,
    handlers: {
      onCaption: (caption: CaptionObservation) => void;
      onSourceHint?: (kind: 'texttrack' | 'dom' | 'none') => void;
    },
  ): void {
    this.stop();
    this.video = video;
    this.onCaption = handlers.onCaption;
    this.onSourceHint = handlers.onSourceHint ?? null;

    this.observer = new MutationObserver(() => this.scanDom());
    this.observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    this.pollTimer = window.setInterval(() => this.poll(), 400);
    this.poll();
  }

  stop(): void {
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.observer?.disconnect();
    this.observer = null;
    this.video = null;
    this.onCaption = null;
    this.onSourceHint = null;
    this.activeCue = null;
    this.domText = null;
    this.domStart = null;
    this.domLastSeenMedia = null;
    this.lastSourceHint = null;
  }

  setVideo(video: HTMLVideoElement): void {
    this.video = video;
  }

  /** 扫描已知容器 + 启发式候选（底部、宽度受限、位于视频区域附近） */
  hasReadableDom(video: HTMLVideoElement): boolean {
    return this.scanDom(video) !== null;
  }

  private scanDom(video = this.video): DomCandidate | null {
    if (!video) return null;
    const videoRect = video.getBoundingClientRect();
    const vw = window.innerWidth;

    for (const selector of KNOWN_SELECTORS) {
      let nodes: Element[] = [];
      try {
        nodes = [...document.querySelectorAll(selector)];
      } catch {
        continue;
      }
      for (const node of nodes) {
        const text = textOf(node);
        if (!text || text.length > 400 || isPlayerControlText(text)) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 8) continue;
        if (rect.bottom < videoRect.top || rect.top > videoRect.bottom || rect.right < videoRect.left || rect.left > videoRect.right) continue;
        if (rect.width > vw * 1.02) continue;
        if (isInsideChrome(node)) continue;
        if (node.querySelector('input, textarea, select, button')) continue;
        return { text, confidence: 0.95, provenance: `selector:${selector}` };
      }
    }

    if (videoRect.width > 80) {
      const points: Array<[number, number]> = [
        [videoRect.left + videoRect.width / 2, videoRect.bottom - videoRect.height * 0.08],
        [videoRect.left + videoRect.width / 2, videoRect.bottom - videoRect.height * 0.16],
        [videoRect.left + videoRect.width / 2, videoRect.bottom - videoRect.height * 0.24],
      ];
      for (const [x, y] of points) {
        const stack = document.elementsFromPoint(x, y);
        for (const el of stack.slice(0, 8)) {
          if (el === video) continue;
          if (isInsideChrome(el)) continue;
          if (el.closest('input, textarea, select, button, a')) continue;
          const text = textOf(el);
          if (!text || text.length < 2 || text.length > 300 || isPlayerControlText(text)) continue;
          if (el.querySelector('input, textarea, select, button, [role="button"], [role="slider"]')) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width < 40 || rect.width > videoRect.width * 1.05) continue;
          if (rect.height < 10 || rect.height > videoRect.height * 0.3) continue;
          const fontSize = parseFloat(getComputedStyle(el).fontSize || '0');
          if (fontSize > 0 && fontSize < 10) continue;
          return { text, confidence: 0.62, provenance: 'heuristic:overlay' };
        }
      }
    }
    return null;
  }

  private activeTrackCue(): ActiveCue | null {
    const video = this.video;
    if (!video) return null;
    const tracks = [...video.textTracks].filter((t) => t.mode === 'showing' || t.mode === 'hidden');
    if (tracks.length === 0) return null;
    const time = video.currentTime;
    for (const track of tracks) {
      const cues = track.cues;
      if (!cues || cues.length === 0) continue;
      for (let i = 0; i < cues.length; i++) {
        const cue = cues[i] as VTTCue;
        if (!cue) continue;
        if (cue.startTime <= time + 0.15 && cue.endTime >= time - 0.15) {
          const text = (cue.text ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
          if (!text) continue;
          return {
            text,
            start: cue.startTime,
            end: cue.endTime,
            key: `${track.id}:${cue.id || ''}:${cue.startTime.toFixed(2)}`,
          };
        }
      }
    }
    return null;
  }

  private poll(): void {
    if (!this.video || !this.onCaption) return;
    const nowWall = performance.now();
    const mediaTime = this.video.currentTime;
    const cue = this.activeTrackCue();

    if (cue) {
      if (!this.activeCue || this.activeCue.key !== cue.key) {
        if (this.activeCue) this.emitTrack(this.activeCue);
        this.activeCue = { ...cue };
      } else {
        this.activeCue.end = Math.max(this.activeCue.end, cue.end);
        this.activeCue.text = cue.text;
      }
      this.hint('texttrack');
      return;
    }
    if (this.activeCue) {
      this.emitTrack(this.activeCue);
      this.activeCue = null;
    }

    const dom = this.scanDom();
    if (dom) {
      this.hint('dom');
      if (this.domStart === null || (this.domText !== null && this.domText !== dom.text)) {
        if (this.domText !== null && this.domStart !== null) {
          this.emitDom(mediaTime);
        }
        this.domStart = mediaTime;
      }
      this.domText = dom.text;
      this.domConfidence = dom.confidence;
      this.domProvenance = dom.provenance;
      this.domLastSeenMedia = mediaTime;
      this.domLastSeenWall = nowWall;
      return;
    }

    // DOM 文本消失：结束上一句
    if (
      this.domText !== null &&
      this.domStart !== null &&
      this.domLastSeenWall !== 0 &&
      nowWall - this.domLastSeenWall > 900
    ) {
      this.emitDom(this.domLastSeenMedia ?? mediaTime);
      this.domText = null;
      this.domStart = null;
      this.domLastSeenMedia = null;
      this.domLastSeenWall = 0;
    }
    if (this.domText === null && this.activeCue === null) this.hint('none');
  }

  private emitTrack(cue: ActiveCue): void {
    this.emit({
      text: cue.text,
      startTime: cue.start,
      endTime: cue.end,
      source: 'texttrack',
      confidence: 0.98,
      provenance: 'texttrack',
    });
  }

  private emitDom(endTime: number): void {
    if (!this.domText || this.domStart === null) return;
    if (endTime - this.domStart < 0.3) return;
    this.emit({
      text: this.domText,
      startTime: this.domStart,
      endTime,
      source: 'dom',
      confidence: this.domConfidence,
      provenance: this.domProvenance,
    });
  }

  private emit(caption: CaptionObservation): void {
    const text = caption.text.trim();
    if (!text || !this.onCaption) return;
    this.onCaption({ ...caption, text });
  }

  private hint(kind: 'texttrack' | 'dom' | 'none'): void {
    if (kind === this.lastSourceHint) return;
    this.lastSourceHint = kind;
    this.onSourceHint?.(kind);
  }
}
