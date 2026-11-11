import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryDB, getSettings, saveSettings, setDbForTests } from '@/db/db';
import { computeFeatureEnabled, currentResourceTier, resourceTierPatch } from '@/shared/resource-tiers';
import { tierCapabilities, tierDownloadBytes, downloadTier } from '@/models/downloads';
import { answerLanguage, answerStyle, learningPreferencesPrompt } from '@/shared/languages';
import { buildSystemPrompt } from '@/agent/prompt';
import { buildOrganizePrompt } from '@/background/organizer';
import { createComputeClient } from '@/ui/compute-client';
import { ToolExecutor } from '@/agent/tools';

let db: MemoryDB;
beforeEach(async () => { db = new MemoryDB(`preferences-${Math.random()}`); setDbForTests(db); await db.open(); });
afterEach(async () => { vi.unstubAllGlobals(); await db.delete(); setDbForTests(null); });

it('四档只准备对应资源，大小递增，无占用不下载也不关闭已连接的云端助手', async () => {
  expect(['none','low','medium','high'].map(id => tierCapabilities(id as never).map(item => item.id))).toEqual([[],['ocr'],['ocr','vector'],['ocr','vector','rerank']]);
  const sizes = ['none','low','medium','high'].map(id => tierDownloadBytes(id as never));
  expect(sizes[0]).toBe(0); expect(sizes.every((size,index) => index === 0 || size > sizes[index-1])).toBe(true);
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await downloadTier('none', new AbortController().signal, () => {}); expect(fetch).not.toHaveBeenCalled();
  await saveSettings({ localAgent: { backend: 'opencode-go', token: 'test-only', model: 'test-model' }, resourceTier: 'high' });
  const none = await saveSettings({ resourceTier: 'none' });
  expect(none.localAgent?.model).toBe('test-model'); expect(none.profile).toBe('standard'); expect(none.retrieval.keyword).toBe(true);
});

it('档位改变实际开关与识别频率，升级降级均能恢复，未下载时不会隐式启用', async () => {
  const initial = await getSettings(); expect(currentResourceTier(initial)).toBe('none');
  for (const tier of ['high','low','medium','none'] as const) {
    const settings = await saveSettings({ resourceTier: tier });
    expect(currentResourceTier(settings)).toBe(tier);
    expect(computeFeatureEnabled('ocr:recognize',settings)).toBe(tier !== 'none');
    expect(computeFeatureEnabled('embed:encode',settings)).toBe(tier === 'medium' || tier === 'high');
    expect(computeFeatureEnabled('rerank:score',settings)).toBe(tier === 'high');
  }
  expect(resourceTierPatch('low',initial).ocr?.maxPerMinute).toBeLessThan(resourceTierPatch('medium',initial).ocr!.maxPerMinute);
  expect(resourceTierPatch('medium',initial).ocr?.maxPerMinute).toBeLessThan(resourceTierPatch('high',initial).ocr!.maxPerMinute);
  expect(() => resourceTierPatch('invalid' as never,initial)).toThrow('有效');
});

it('无占用在创建沙箱前拦住本地计算，冷态卸载不会创建沙箱', async () => {
  const compute = createComputeClient('never-load-this');
  const result = await compute({ type:'ocr:recognize' });
  expect(result.ok).toBe(false); if (!result.ok) expect(result.error.code).toBe('feature_disabled');
  expect((await compute({ type:'compute:reset' })).ok).toBe(true);
});

it('语言和风格写入问答及整理提示词，同时保留事实引用与 JSON 格式要求', async () => {
  const settings = await saveSettings({ answerLanguage:'fr', answerStyle:'patient' });
  const preferences = learningPreferencesPrompt(settings);
  expect(answerLanguage(settings)).toBe('Français'); expect(answerStyle(settings)).toContain('循序分步');
  const qa = buildSystemPrompt({ language:answerLanguage(settings), style:answerStyle(settings), hasTools:true, allowImages:false, scopedToSelection:false, source:'api' });
  expect(qa).toContain('Français'); expect(qa).toContain('耐心讲解'); expect(qa).toContain('[E:证据ID]');
  const organize = buildOrganizePrompt([],[],preferences);
  expect(organize).toContain('Français'); expect(organize).toContain('耐心讲解'); expect(organize).toContain('只输出 JSON');
  expect((await getSettings()).answerStyle).toBe('patient');
  const tool = new ToolExecutor({settings,ctx:{question:'这段讲什么？',videoId:'v'},readEvidence:new Set(),readNodes:new Set(),imageUploads:0,allowImages:false,source:'ai-app'} as never);
  const question = await tool.execute('get_question',{});
  expect(JSON.parse(question.content).responsePreferences).toContain('Français');
  expect(JSON.parse(question.content).responsePreferences).toContain('耐心讲解');
});

it('快速连续修改语言和风格不会互相覆盖', async () => {
  await getSettings();
  await Promise.all([saveSettings({answerLanguage:'en'}),saveSettings({answerStyle:'concise'})]);
  expect(await getSettings()).toMatchObject({answerLanguage:'en',answerStyle:'concise'});
});
