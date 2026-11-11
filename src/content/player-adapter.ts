/**
 * PlayerAdapter（内容脚本侧）。
 *
 * 职责：发现视频、读取媒体时间与播放状态、跳转、识别换集/换视频。
 * 不访问 IndexedDB，不直接写库。
 */

export interface PlayerSnapshot {
  currentTime: number;
  duration: number;
  paused: boolean;
  playbackRate: number;
  readyState: number;
  width: number;
  height: number;
  fullscreen: boolean;
  muted: boolean;
  isPlaying: boolean;
}

export interface VideoCandidate {
  el: HTMLVideoElement;
  area: number;
  visible: boolean;
  playing: boolean;
  hasAudio: boolean;
}

function isVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 40 && rect.height > 40;
}

/** 选择页面中最可能是"正在看的视频"的元素 */
export function findPrimaryVideo(): HTMLVideoElement | null {
  const videos = [...document.querySelectorAll('video')];
  if (videos.length === 0) return null;

  const candidates: VideoCandidate[] = videos.map((el) => {
    const rect = el.getBoundingClientRect();
    const area = rect.width * rect.height;
    return {
      el,
      area,
      visible: isVisible(el),
      playing: !el.paused && !el.ended,
      hasAudio: !el.muted && el.volume > 0,
    };
  });

  candidates.sort((a, b) => {
    if (a.playing !== b.playing) return a.playing ? -1 : 1;
    if (a.visible !== b.visible) return a.visible ? -1 : 1;
    return b.area - a.area;
  });

  return candidates[0]?.el ?? null;
}

export class PlayerAdapter {
  private video: HTMLVideoElement | null = null;
  private listeners = new Set<() => void>();
  private pollTimer: number | null = null;
  private lastVideoKey = '';

  constructor(private readonly onVideoChanged?: (info: { key: string; title: string }) => void) {}

  get element(): HTMLVideoElement | null {
    return this.video;
  }

  start(): void {
    this.refresh();
    this.pollTimer = window.setInterval(() => {
      const changed = this.refresh();
      if (changed) this.notify();
    }, 700);
    document.addEventListener('visibilitychange', this.notify);
  }

  stop(): void {
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    this.pollTimer = null;
    document.removeEventListener('visibilitychange', this.notify);
  }

  private notify = () => {
    for (const fn of this.listeners) fn();
  };

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 检测视频元素或视频身份变化；返回是否发生变化 */
  refresh(): boolean {
    const primary = findPrimaryVideo();
    if (!primary) return false;

    const key = this.videoKey(primary);
    const changed = key !== this.lastVideoKey;
    this.video = primary;
    if (changed) {
      this.lastVideoKey = key;
      this.onVideoChanged?.({ key, title: this.titleOf(primary) });
    }
    return changed;
  }

  videoKey(video: HTMLVideoElement): string {
    const dataset = video.dataset as Record<string, string | undefined>;
    const nativeId =
      dataset.videoId ??
      dataset.videoKey ??
      dataset.id ??
      video.getAttribute('data-video-id') ??
      '';
    if (nativeId) return `native:${nativeId}`;
    return `src:${(video.currentSrc || video.src || '').split('?')[0]}:${Math.round(video.duration || 0)}`;
  }

  titleOf(video: HTMLVideoElement): string {
    const meta = document.querySelector('meta[property="og:title"]')?.getAttribute('content');
    if (meta) return meta;
    const h1 = document.querySelector('h1')?.textContent?.trim();
    if (h1 && h1.length < 120) return h1;
    return document.title;
  }

  snapshot(): PlayerSnapshot | null {
    const video = this.video ?? findPrimaryVideo();
    if (!video) return null;
    this.video = video;
    return {
      currentTime: video.currentTime || 0,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      paused: video.paused,
      playbackRate: video.playbackRate || 1,
      readyState: video.readyState,
      width: video.videoWidth || 0,
      height: video.videoHeight || 0,
      fullscreen: Boolean(document.fullscreenElement) || Boolean((document as any).webkitFullscreenElement),
      muted: video.muted,
      isPlaying: !video.paused && !video.ended && video.readyState >= 2,
    };
  }

  seek(time: number): boolean {
    const video = this.video ?? findPrimaryVideo();
    if (!video) return false;
    video.currentTime = Math.max(0, time);
    return true;
  }

  /** 当前视频在视口中的显示矩形与视频内容坐标映射 */
  displayRect(): { rect: DOMRect; videoWidth: number; videoHeight: number } | null {
    const video = this.video ?? findPrimaryVideo();
    if (!video) return null;
    const rect = video.getBoundingClientRect();
    return { rect, videoWidth: video.videoWidth, videoHeight: video.videoHeight };
  }
}
