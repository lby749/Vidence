import packageInfo from '../../package.json';

export const APP_VERSION = packageInfo.version;
export const UPDATE_REPOSITORY = 'lby749/Vidence';
export const UPDATE_API = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases?per_page=20`;
const KEY = 'vma-app-updates', DAY = 86400000;
export interface AppUpdate { version: string; url: string; notes: string }
export interface UpdateState { auto: boolean; checkedAt: number; update?: AppUpdate; error?: 'unavailable' | 'network'; deferredVersion?: string; deferredUntil?: number }

function versionParts(value: string) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) return null;
  const numbers = match.slice(1, 4).map(Number);
  const pre = match[4]?.split('.') ?? [];
  if (match.slice(1, 4).some(value => value.length > 1 && value.startsWith('0')) || pre.some(value => !value || (/^\d+$/.test(value) && value.length > 1 && value.startsWith('0')))) return null;
  return numbers.every(Number.isSafeInteger) ? { numbers, pre } : null;
}
export function compareVersions(a: string, b: string): number | null {
  const left = versionParts(a), right = versionParts(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) if (left.numbers[i] !== right.numbers[i]) return left.numbers[i] - right.numbers[i];
  if (!left.pre.length || !right.pre.length) return Number(!left.pre.length) - Number(!right.pre.length);
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i], y = right.pre[i];
    if (x === undefined || y === undefined) return Number(x !== undefined) - Number(y !== undefined);
    if (x === y) continue;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    return nx && ny ? x.length - y.length || (x < y ? -1 : 1) : nx !== ny ? (nx ? -1 : 1) : x < y ? -1 : 1;
  }
  return 0;
}
function officialUrl(value: unknown): value is string {
  try { const url = new URL(String(value)); return url.origin === 'https://github.com' && !url.username && !url.password && url.pathname.startsWith(`/${UPDATE_REPOSITORY}/releases/tag/`); } catch { return false; }
}
export function newestRelease(releases: unknown, current = APP_VERSION): AppUpdate | undefined {
  if (!Array.isArray(releases) || !versionParts(current)) throw new Error('invalid-release-list');
  let latest: AppUpdate | undefined;
  for (const release of releases) {
    if (!release || release.draft || typeof release.tag_name !== 'string' || !officialUrl(release.html_url) || typeof release.published_at !== 'string') continue;
    const parsed = versionParts(release.tag_name);
    if (!parsed || (!versionParts(current)!.pre.length && (release.prerelease || parsed.pre.length))) continue;
    if ((compareVersions(release.tag_name, latest?.version ?? current) ?? -1) <= 0) continue;
    latest = { version: release.tag_name.replace(/^v/, ''), url: release.html_url, notes: typeof release.body === 'string' ? release.body.slice(0, 1600) : '' };
  }
  return latest;
}
export function readUpdateState(): UpdateState {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (saved.repository !== UPDATE_REPOSITORY) return { auto: saved.auto !== false, checkedAt: 0 };
    return { ...saved, auto: saved.auto !== false, checkedAt: Number.isFinite(saved.checkedAt) && saved.checkedAt <= Date.now() ? saved.checkedAt : 0, update: saved.update && (compareVersions(saved.update.version ?? '', APP_VERSION) ?? -1) > 0 && officialUrl(saved.update.url) ? { version: saved.update.version, url: saved.update.url, notes: typeof saved.update.notes === 'string' ? saved.update.notes.slice(0, 1600) : '' } : undefined };
  } catch { return { auto: true, checkedAt: 0 }; }
}
function writeState(state: UpdateState) {
  try { localStorage.setItem(KEY, JSON.stringify({ ...state, repository: UPDATE_REPOSITORY })); } catch { /* 隐私模式下仍可手动检查。 */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('vma:app-updates'));
  return state;
}
export const setAutomaticUpdates = (auto: boolean) => writeState({ ...readUpdateState(), auto });
export const deferAppUpdate = (version: string) => writeState({ ...readUpdateState(), deferredVersion: version, deferredUntil: Date.now() + DAY });
let pending: Promise<UpdateState> | undefined;
export async function checkAppUpdate(force = false): Promise<UpdateState> {
  const state = readUpdateState();
  if (!force && (!state.auto || Date.now() - state.checkedAt < DAY)) return state;
  if (pending) return pending;
  pending = (async () => {
    try {
      const response = await fetch(UPDATE_API, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10000) });
      if (!response.ok) return writeState({ ...readUpdateState(), checkedAt: Date.now(), error: 'unavailable' });
      const update = newestRelease(await response.json());
      return writeState({ ...readUpdateState(), checkedAt: Date.now(), update, error: undefined, ...(force ? { deferredVersion: undefined, deferredUntil: 0 } : {}) });
    } catch { return writeState({ ...readUpdateState(), checkedAt: Date.now(), error: 'network' }); }
    finally { pending = undefined; }
  })();
  return pending;
}
