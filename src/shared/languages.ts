import type { Settings } from './types';
export const ANSWER_LANGUAGES = { 'zh-CN': '中文', 'zh-TW': '繁體中文', en: 'English', es: 'Español', ja: '日本語', ko: '한국어', fr: 'Français', de: 'Deutsch', pt: 'Português', ru: 'Русский', ar: 'العربية', auto: '跟随内容和问题' } as const;
export function answerLanguage(settings: Settings): string { return ANSWER_LANGUAGES[settings.answerLanguage ?? 'zh-CN'] ?? '中文'; }
export function outputLanguagePrompt(language: string): string {
  return language === ANSWER_LANGUAGES.auto ? '回答语言跟随当前问题和素材。' : `回答语言：${language}。当前问题未明确要求其他输出语言时，最终答复使用${language}；不要因为问题或历史对话使用另一种语言就切换。`;
}

export const ANSWER_STYLES = {
  balanced: { title: '清晰自然', description: '先给结论，再补充必要的解释。', prompt: '清晰自然。先直接回答，再补充必要的解释，避免冗长。' },
  concise: { title: '简洁直接', description: '抓住重点，适合快速回看。', prompt: '简洁直接。先用一句话给结论，必要时补充不超过三个短要点，省去客套和重复。除非用户明确要求展开，尽量控制在中文150字或英文80词以内。' },
  patient: { title: '耐心讲解', description: '从基础开始，一步步解释。', prompt: '耐心讲解。先解释必要术语，再循序分步说明，使用易懂的例子；例子须标为解释。' },
  exam: { title: '考试复习', description: '突出考点、步骤和易错处。', prompt: '考试复习。围绕证据中的考点、解题步骤与易错点组织；证据没有出现的考点不得补造。' },
  deep: { title: '深入分析', description: '展开原因、条件和推导。', prompt: '深入分析。展开原因、适用条件、推导和比较，明确区分证据与推断；不展示隐藏思考过程。' },
  casual: { title: '轻松交流', description: '自然亲切，像一起讨论。', prompt: '轻松交流。用自然亲切的口语解释，保持准确，不堆砌感叹、夸奖或表情。' },
} as const;
export function answerStyle(settings: Settings): string { return (ANSWER_STYLES[settings.answerStyle ?? 'balanced'] ?? ANSWER_STYLES.balanced).prompt; }
export function learningPreferencesPrompt(settings: Settings): string {
  return `用户当前的输出偏好（优先于历史对话的语言与写法）：${outputLanguagePrompt(answerLanguage(settings))}表达风格：${answerStyle(settings)} 这些偏好只影响表达，不改变当前任务的输出格式、事实边界、来源引用和缺口说明。`;
}
