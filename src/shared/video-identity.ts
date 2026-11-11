/**
 * 视频身份识别。
 *
 * 不能仅用页面 URL 区分所有视频：同页换集、单页应用切换需要稳定 ID。
 * 优先使用平台原生 ID；无法识别时使用规范化 URL + 标题的短哈希。
 */

export interface VideoIdentity {
  id: string;
  platform: string;
  platformVideoId: string;
  episodeId?: string;
  canonicalUrl: string;
  url: string;
  title: string;
}

const TRACKING_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'spm_id_from',
  'vd_source',
  'share_source',
  'share_medium',
  'from_source',
  'fbclid',
  'gclid',
  'si',
  'feature',
  't',
  'start',
];

export function canonicalizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const key of TRACKING_PARAMS) url.searchParams.delete(key);
    url.hash = '';
    // 保留必要参数（v/p/list/bvid 等），其余排序保证稳定性
    const entries = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    url.search = '';
    for (const [k, v] of entries) url.searchParams.append(k, v);
    return url.toString();
  } catch {
    return raw;
  }
}

function platformOf(host: string): string {
  const h = host.replace(/^www\./, '');
  if (h.endsWith('youtube.com') || h === 'youtu.be') return 'youtube';
  if (h.endsWith('bilibili.com') || h === 'b23.tv') return 'bilibili';
  if (h.endsWith('coursera.org')) return 'coursera';
  if (h.endsWith('udemy.com')) return 'udemy';
  if (h.endsWith('bilibili.tv')) return 'bilibili';
  if (h.endsWith('vimeo.com')) return 'vimeo';
  if (h.endsWith('ted.com')) return 'ted';
  if (h.endsWith('icourse163.org')) return 'mooc';
  if (h.endsWith('xuetangx.com')) return 'xuetangx';
  if (h.endsWith('zhihu.com')) return 'zhihu';
  return h;
}

/**
 * 解析视频身份。
 * @param url 当前页面 URL
 * @param fallbackTitle 页面标题（无平台 ID 时用于区分同页不同视频）
 */
export function identifyVideo(url: string, fallbackTitle = '', episodeHint = ''): VideoIdentity {
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }

  const canonicalUrl = canonicalizeUrl(url);
  const platform = parsed ? platformOf(parsed.hostname) : 'web';
  const knownPlatform = ['youtube', 'bilibili', 'vimeo', 'coursera', 'udemy', 'ted', 'mooc', 'xuetangx'].includes(platform);
  let platformVideoId = '';
  let episodeId = episodeHint || undefined;

  if (parsed) {
    const p = parsed.pathname;
    const q = parsed.searchParams;
    switch (platform) {
      case 'youtube': {
        if (parsed.hostname === 'youtu.be') {
          platformVideoId = p.slice(1);
        } else {
          platformVideoId = q.get('v') ?? '';
          if (!platformVideoId && p.startsWith('/shorts/')) platformVideoId = p.split('/')[2] ?? '';
          if (!platformVideoId && p.startsWith('/embed/')) platformVideoId = p.split('/')[2] ?? '';
          if (!platformVideoId && p.startsWith('/live/')) platformVideoId = p.split('/')[2] ?? '';
        }
        episodeId = episodeId || undefined;
        break;
      }
      case 'bilibili': {
        const bv = p.match(/\/video\/(BV[0-9A-Za-z]+)/);
        const av = p.match(/\/video\/av(\d+)/i);
        platformVideoId = bv?.[1] ?? (av ? `av${av[1]}` : '');
        const page = q.get('p');
        if (page) episodeId = `p${page}`;
        break;
      }
      case 'vimeo': {
        platformVideoId = p.split('/').filter(Boolean).pop() ?? '';
        break;
      }
      case 'coursera': {
        platformVideoId = p.split('/').filter(Boolean).slice(-2).join('-');
        break;
      }
      case 'udemy': {
        platformVideoId = p.split('/').filter(Boolean).slice(-2).join('-');
        const lecture = q.get('lecture_id');
        if (lecture) episodeId = `lecture-${lecture}`;
        break;
      }
      case 'mooc':
      case 'xuetangx': {
        platformVideoId = p.split('/').filter(Boolean).slice(-2).join('-');
        break;
      }
      default: {
        platformVideoId = p;
      }
    }
  }

  const title = (fallbackTitle || '').replace(/\s+/g, ' ').trim();
  // 未知平台没有可靠的原生 ID：路径 + 规范化 URL + 标题一起参与身份，
  // 以处理单页应用同页切换不同视频的情况。
  const includeTitle = !knownPlatform || !platformVideoId;
  const identityBasis = platformVideoId
    ? `${platform}:${platformVideoId}${episodeId ? `#${episodeId}` : ''}`
    : `${platform}:${canonicalUrl}`;
  const id = `${platform}:${shortHash(identityBasis + (includeTitle ? `|${title}` : ''))}`;

  return {
    id,
    platform,
    platformVideoId: platformVideoId || shortHash(canonicalUrl),
    episodeId,
    canonicalUrl,
    url,
    title: title || parsed?.hostname || '未命名视频',
  };
}

function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, '0');
}
