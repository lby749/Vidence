import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { APP_VERSION, UPDATE_API, checkAppUpdate, compareVersions, deferAppUpdate, newestRelease, readUpdateState, setAutomaticUpdates } from '@/shared/app-updates';

const release = (version: string, extra = {}) => ({ tag_name: `v${version}`, html_url: `https://github.com/lby749/lby/releases/tag/v${version}`, published_at: '2026-11-11T00:00:00Z', body: '修复画面记录', draft: false, prerelease: version.includes('-'), ...extra });
let values: Map<string, string>, fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
  values = new Map(); vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  fetcher = vi.fn(async () => new Response(JSON.stringify([release('0.1.0-beta.3')]))); vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each([
  ['0.1.0-beta.10', '0.1.0-beta.2', 1], ['0.1.0', '0.1.0-beta.10', 1], ['0.10.0', '0.9.9', 1],
  ['0.1.0-beta.1', '0.1.0-beta.2', -1], ['v0.1.0+build2', '0.1.0+build1', 0],
])('按版本而非字符串或发布日期比较 %s / %s', (a, b, expected) => expect(Math.sign(compareVersions(a, b)!)).toBe(expected));
it.each(['not-a-version', '01.2.3', '1.2.3-beta..2', '1.2.3-beta.01'])('拒绝无效版本 %s', value => expect(compareVersions(value, APP_VERSION)).toBeNull());
it('选择最高版本，排除草稿、旧版本及外部下载地址', () => {
  expect(newestRelease([release('0.1.0-beta.10'), release('0.1.0-beta.2'), release('9.0.0', { draft: true }), release('8.0.0', { html_url: 'https://evil.example/releases/tag/v8.0.0' })])?.version).toBe('0.1.0-beta.10');
  expect(newestRelease([release('0.1.0-beta.1')])).toBeUndefined();
  expect(newestRelease([release('9.0.0-beta.1'), release('0.2.0')], '0.1.0')?.version).toBe('0.2.0');
});
it('只向版本目录发匿名GET，不发送学习数据或账号', async () => {
  expect((await checkAppUpdate()).update?.version).toBe('0.1.0-beta.3');
  expect(fetcher.mock.calls[0][0]).toBe(UPDATE_API);
  expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
  expect(fetcher.mock.calls[0][1]).not.toHaveProperty('body');
  expect(fetcher.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
});
it('自动检查一天最多一次，手动检查可立即重试', async () => {
  await Promise.all([checkAppUpdate(), checkAppUpdate()]); await checkAppUpdate();
  expect(fetcher).toHaveBeenCalledTimes(1);
  await checkAppUpdate(true); expect(fetcher).toHaveBeenCalledTimes(2);
  vi.setSystemTime(Date.now() + 86400001); await checkAppUpdate(); expect(fetcher).toHaveBeenCalledTimes(3);
});
it('关闭自动检查后不请求，手动检查仍可用且不重新开启自动', async () => {
  setAutomaticUpdates(false); await checkAppUpdate(); expect(fetcher).not.toHaveBeenCalled();
  await checkAppUpdate(true); expect(readUpdateState().auto).toBe(false); expect(readUpdateState().update).toBeDefined();
});
it.each([404, 403, 500])('HTTP %s 不误报已是最新版', async status => {
  fetcher.mockResolvedValue(new Response('{}', { status }));
  expect(await checkAppUpdate()).toMatchObject({ error: 'unavailable' });
  await checkAppUpdate(); expect(fetcher).toHaveBeenCalledTimes(1);
});
it('断网和损坏的目录不误报已是最新版', async () => {
  fetcher.mockRejectedValueOnce(new Error('offline')); expect((await checkAppUpdate()).error).toBe('network');
  fetcher.mockResolvedValueOnce(new Response('{}')); expect((await checkAppUpdate(true)).error).toBe('network');
});
it('稍后提醒保持一天，手动检查解除暂缓，升级后不重复提示旧版本', async () => {
  await checkAppUpdate(); deferAppUpdate('0.1.0-beta.3'); expect(readUpdateState().deferredUntil).toBe(Date.now() + 86400000);
  await checkAppUpdate(true); expect(readUpdateState().deferredUntil).toBe(0);
  const saved = readUpdateState(); values.set('vma-app-updates', JSON.stringify({ ...saved, update: { ...saved.update, version: APP_VERSION } }));
  expect(readUpdateState().update).toBeUndefined();
});
it('损坏缓存安全恢复，伪造地址不会显示', () => {
  values.set('vma-app-updates', '{broken'); expect(readUpdateState()).toEqual({ auto: true, checkedAt: 0 });
  values.set('vma-app-updates', JSON.stringify({ update: { version: '9.0.0', url: 'javascript:alert(1)' } })); expect(readUpdateState().update).toBeUndefined();
});
