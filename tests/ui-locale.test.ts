import { afterEach, expect, it } from 'vitest';
import { MemoryDB, getSettings, setDbForTests } from '@/db/db';
import { DEFAULT_SETTINGS } from '@/shared/constants';
import { resolveUiLocale, translateUi } from '@/ui/i18n';
import { orderForLocale } from '@/ui/locale-order';

let db: MemoryDB | undefined;
afterEach(async () => { if (db) await db.delete(); setDbForTests(null); });
it('界面语言跟随系统，旧用户保持中文，新用户可以自动选择', async () => {
  expect(resolveUiLocale('auto','zh-Hant-TW')).toBe('zh-TW');expect(resolveUiLocale('auto','de-DE')).toBe('en');
  expect(resolveUiLocale('en','zh-CN')).toBe('en');
  db=new MemoryDB(`ui-locale-${Math.random()}`);setDbForTests(db);await db.open();
  expect((await getSettings()).uiLanguage).toBe('auto');
  const legacy={...DEFAULT_SETTINGS,id:'app',updatedAt:1} as any;delete legacy.uiLanguage;await db.settings.put(legacy);
  expect((await getSettings()).uiLanguage).toBe('zh-CN');
});
it('语言改变显示顺序，不改原数组或用户选定的渠道和模型ID', () => {
  const tools=[{id:'opencode-go'},{id:'dsh'},{id:'codex'},{id:'claude'}];
  expect(orderForLocale(tools,'zh-CN','agent',item=>item.id)[0].id).toBe('opencode-go');
  expect(orderForLocale(tools,'en','agent',item=>item.id)[0].id).toBe('codex');
  expect(orderForLocale(tools,'zh-TW','agent',item=>item.id)[0].id).toBe('codex');
  expect(tools[0].id).toBe('opencode-go');
  const channels=[{id:'deepseek'},{id:'openai'},{id:'siliconflow'}];
  expect(orderForLocale(channels,'en','api',item=>item.id).map(item=>item.id)).toEqual(['openai','deepseek','siliconflow']);
});
it('界面文案覆盖来源、助手、API和记忆，繁体由独立字典提供', () => {
  expect(translateUi('选择视频文件','en')).toBe('Choose video file');
  expect(translateUi('设置','zh-TW')).toBe('設定');
  expect(translateUi('来源 ⌄','en')).toBe('Source ⌄');
  expect(translateUi('本次新增 12 条记录','en')).toContain('12');
  expect(translateUi('deepseek-v4.1-flash','en')).toBe('deepseek-v4.1-flash');
});
