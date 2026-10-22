// Промпты и разбор ответа модели. Чистые функции — тестируются в node.

export const DEFAULTS = {
  provider: 'demo', // 'demo' | 'openai'
  // распознавание речи: нужен OpenAI-совместимый whisper-эндпоинт
  sttBaseUrl: 'https://api.openai.com/v1',
  sttApiKey: '',
  sttModel: 'gpt-4o-mini-transcribe',
  // перевод и ответы: любая OpenAI-совместимая чат-модель, включая DeepSeek
  llmBaseUrl: 'https://api.openai.com/v1',
  llmApiKey: '',
  llmModel: 'gpt-4o-mini',
  sourceLang: 'en',
  targetLang: 'ru',
  userName: '',
  userRole: '',
  company: '',
  brief: '',
  glossary: '', // «Kubernetes, DeepSeek, Sber» — чтобы имена не перевирались
  thinkingEnabled: false, // для DeepSeek: режим рассуждений по умолчанию выключен
  autoAnswer: true,
  showSource: true,
};

/** Быстрые пресеты для блока «перевод и ответы». */
export const PRESETS = {
  openai: { llmBaseUrl: 'https://api.openai.com/v1', llmModel: 'gpt-4o-mini' },
  // DeepSeek-V4.1-Flash: 1M контекст, JSON-режим, дёшево. Понимает картинки, но не звук.
  deepseek: { llmBaseUrl: 'https://api.deepseek.com', llmModel: 'deepseek-flash' },
  ollama: { llmBaseUrl: 'http://127.0.0.1:11434/v1', llmModel: 'qwen2.5:7b' },
};

/** Пресеты распознавания: все OpenAI-совместимые. */
export const STT_PRESETS = {
  openai: { sttBaseUrl: 'https://api.openai.com/v1', sttModel: 'gpt-4o-mini-transcribe' },
  // 0,04 $/час, ~216x реального времени
  groq: { sttBaseUrl: 'https://api.groq.com/openai/v1', sttModel: 'whisper-large-v3-turbo' },
  // whisper.cpp server на своём Mac; имя модели сервер игнорирует
  local: { sttBaseUrl: 'http://127.0.0.1:8080/v1', sttModel: 'whisper-large-v3-turbo' },
};

/** Старые настройки (один провайдер на всё) → новые (два независимых). */
export function migrateSettings(raw = {}) {
  const s = { ...DEFAULTS, ...(raw || {}) };
  if (raw.baseUrl && !raw.sttBaseUrl) s.sttBaseUrl = raw.baseUrl;
  if (raw.baseUrl && !raw.llmBaseUrl) s.llmBaseUrl = raw.baseUrl;
  if (raw.apiKey && !raw.sttApiKey) s.sttApiKey = raw.apiKey;
  if (raw.apiKey && !raw.llmApiKey) s.llmApiKey = raw.apiKey;
  if (raw.chatModel && !raw.llmModel) s.llmModel = raw.chatModel;
  delete s.baseUrl;
  delete s.apiKey;
  delete s.chatModel;
  return s;
}

/** Каких ключей не хватает, чтобы всё заработало. */
export function missingKeys(s = {}) {
  const missing = [];
  if (!s.sttApiKey) missing.push('ключ распознавания речи');
  if (!s.llmApiKey) missing.push('ключ перевода');
  return missing;
}

/**
 * DeepSeek по умолчанию думает перед ответом — для живого звонка это лишние
 * секунды. Параметр отправляем только ему: OpenAI на незнакомое поле ответит ошибкой.
 */
export function llmExtraParams(s = {}) {
  const base = String(s.llmBaseUrl || '');
  if (/deepseek\.com/i.test(base) && s.thinkingEnabled !== true) {
    return { thinking: { type: 'disabled' } };
  }
  return {};
}

/** Блок «кто я и что знаю» — подставляется в промпт ответов. */
export function buildBriefBlock(s = {}) {
  const lines = [];
  if (s.userName) lines.push(`Имя пользователя: ${s.userName}`);
  if (s.userRole) lines.push(`Роль: ${s.userRole}`);
  if (s.company) lines.push(`Компания / проект: ${s.company}`);
  const brief = (s.brief || '').trim();
  if (brief) lines.push(`МАТЕРИАЛЫ (факты, цифры, опыт, цены, заготовки):\n${brief}`);
  if (!lines.length) lines.push('МАТЕРИАЛЫ не заполнены — ответы давать нельзя, только перевод.');
  return lines.join('\n');
}

/** Глоссарий: и в перевод, и в подсказку распознаванию. */
export function buildGlossaryBlock(s = {}) {
  const terms = (s.glossary || '').trim();
  if (!terms) return '';
  return `ГЛОССАРИЙ (эти названия писать ровно так, не переводить и не склонять):\n${terms}`;
}

export function buildTranslateSystem(s = {}) {
  const src = (s.sourceLang || 'en').toUpperCase();
  const dst = (s.targetLang || 'ru').toUpperCase();
  const glossary = buildGlossaryBlock(s);
  return `Ты — синхронный переводчик на живом деловом звонке.
Собеседник говорит по-${src === 'EN' ? 'английски' : src}, пользователь читает по-${dst === 'RU' ? 'русски' : dst}.
Переведи реплику: естественно, разговорно, без канцелярита и таким же коротким текстом, как оригинал.
Имена, продукты и технические термины не переводи.
${glossary ? `\n${glossary}\n` : ''}
Верни строго JSON: {"ru": "перевод", "question": true|false}
question = true, если к пользователю обращён вопрос или просьба.
Только JSON, без markdown и пояснений.`;
}

export function buildAnswerSystem(s = {}) {
  return `Ты помогаешь русскоязычному специалисту отвечать на живом деловом звонке.
Пользователь читает твой ответ глазами и произносит вслух, пока собеседник слушает.

О пользователе и его материалах:
${buildBriefBlock(s)}
${buildGlossaryBlock(s)}

Задача по реплике собеседника:
- Если к пользователю обратились с вопросом или просьбой — дай короткий ответ ПО-АНГЛИЙСКИ от первого лица: 1–3 фразы, разговорный регистр, который удобно произнести вслух. Строго по материалам, ничего не выдумывай.
- Если в материалах нет ответа — скажи, что уточнишь и вернёшься с деталями, и предложи, что именно уточнить.
- Если вопроса нет — answer = null.
- Не пересказывай реплику собеседника, отвечай по существу.

Верни строго JSON: {"answer": "…" | null, "answerRu": "…" | null}
Только JSON, без markdown и пояснений.`;
}

export function buildUserPrompt({ text, recent = [] }) {
  const context = recent
    .slice(-6)
    .map((line) => `- ${line}`)
    .join('\n');
  return `${context ? `Предыдущие реплики (контекст):\n${context}\n\n` : ''}Новая реплика собеседника:
"""${text}"""`;
}

/** Аккуратный JSON.parse со снятием ```-обёртки. */
export function parseModelJSON(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return normalize(JSON.parse(s.slice(start, end + 1)));
  } catch {
    return null;
  }
}

export function normalize(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const ru = typeof obj.ru === 'string' ? obj.ru.trim() : '';
  const answer = typeof obj.answer === 'string' && obj.answer.trim() ? obj.answer.trim() : null;
  const answerRu = typeof obj.answerRu === 'string' && obj.answerRu.trim() ? obj.answerRu.trim() : null;
  return {
    ru,
    answer,
    answerRu: answer ? answerRu || '' : null,
    question: Boolean(obj.question) || Boolean(answer),
  };
}

/** Похоже ли на шум/пустоту, которую не надо показывать. */
export function isNoise(text) {
  if (!text) return true;
  const t = text.trim();
  if (t.length < 2) return true;
  if (/^\[[^\]]*\]$/.test(t)) return true; // [BLANK_AUDIO], [MUSIC]
  if (/^[\s.,!?…\-–—]*(thank you|thanks|bye)[\s.!?]*$/i.test(t) && t.length < 12) return true;
  return false;
}
