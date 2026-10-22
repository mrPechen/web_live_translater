// Юнит-тесты чистой логики. Запуск: node test/run.mjs
import assert from 'node:assert/strict';
import { encodeWav, concatPCM } from '../src/lib/wav.mjs';
import { Segmenter } from '../src/lib/vad.mjs';
import {
  buildTranslateSystem,
  buildAnswerSystem,
  buildBriefBlock,
  buildGlossaryBlock,
  buildUserPrompt,
  parseModelJSON,
  isNoise,
  migrateSettings,
  missingKeys,
  llmExtraParams,
  PRESETS,
  STT_PRESETS,
  DEFAULTS,
} from '../src/lib/prompts.mjs';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${err.message}`);
    process.exitCode = 1;
  }
}

// ---------- WAV ----------
test('encodeWav: заголовок RIFF/WAVE и размеры', () => {
  const pcm = new Int16Array(16000); // 1 секунда при 16 кГц
  const wav = encodeWav(pcm, 16000);
  const dv = new DataView(wav.buffer);
  const tag = (o) => String.fromCharCode(wav[o], wav[o + 1], wav[o + 2], wav[o + 3]);
  assert.equal(tag(0), 'RIFF');
  assert.equal(tag(8), 'WAVE');
  assert.equal(tag(36), 'data');
  assert.equal(wav.length, 44 + 32000);
  assert.equal(dv.getUint32(4, true), 36 + 32000);
  assert.equal(dv.getUint16(22, true), 1); // моно
  assert.equal(dv.getUint32(24, true), 16000);
  assert.equal(dv.getUint16(34, true), 16);
  assert.equal(dv.getUint32(40, true), 32000);
});

test('encodeWav: сэмплы попадают в data без искажений', () => {
  const pcm = new Int16Array([0, 1000, -1000, 32767, -32768]);
  const wav = encodeWav(pcm, 16000);
  const back = new Int16Array(wav.buffer, 44);
  assert.deepEqual(Array.from(back), [0, 1000, -1000, 32767, -32768]);
});

test('concatPCM: склеивает куски по порядку', () => {
  const out = concatPCM([new Int16Array([1, 2]), new Int16Array([3])], 3);
  assert.deepEqual(Array.from(out), [1, 2, 3]);
});

// ---------- VAD ----------
function tone(ms, amplitude = 8000, rate = 16000) {
  const n = Math.round((ms / 1000) * rate);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * amplitude);
  return pcm;
}

function silence(ms, rate = 16000) {
  return new Int16Array(Math.round((ms / 1000) * rate));
}

function feed(segmenter, pcm, block = 2048) {
  const out = [];
  for (let i = 0; i < pcm.length; i += block) {
    out.push(...segmenter.push(pcm.subarray(i, Math.min(i + block, pcm.length))));
  }
  return out;
}

test('Segmenter: речь + пауза даёт одну фразу', () => {
  const s = new Segmenter();
  const chunks = feed(s, tone(1500));
  assert.equal(chunks.length, 0, 'до паузы фраза не должна закрываться');
  const after = feed(s, silence(1000));
  assert.equal(after.length, 1, 'после паузы фраза закрывается');
  assert.ok(after[0].length > 16000 * 1.4, 'во фразе есть вся речь');
});

test('Segmenter: тишина не отправляется', () => {
  const s = new Segmenter();
  const chunks = feed(s, silence(5000));
  assert.equal(chunks.length, 0);
});

test('Segmenter: короткий щелчок отбрасывается', () => {
  const s = new Segmenter();
  feed(s, tone(100));
  const chunks = feed(s, silence(1500));
  assert.equal(chunks.length, 0, 'короче minSpeechMs — не отправляем');
});

test('Segmenter: длинная речь режется принудительно', () => {
  const s = new Segmenter();
  const chunks = feed(s, tone(15000, 8000, 16000));
  assert.ok(chunks.length >= 1, 'фраза длиннее maxChunkMs режется');
});

test('Segmenter: состояние сбрасывается после take()', () => {
  const s = new Segmenter();
  feed(s, tone(1500));
  const first = feed(s, silence(1000));
  assert.equal(first.length, 1);
  // после take() в буфере остаётся только «хвост» тишины, речи там нет
  assert.equal(s.hasSpeech, false);
  const second = feed(s, silence(1000));
  assert.equal(second.length, 0, 'тишина не даёт новых фраз');
  assert.ok(s.pendingMs < 3000, 'буфер тишины не растёт бесконтрольно');
});

// ---------- Промпты ----------
test('buildBriefBlock: пустые материалы дают предупреждение', () => {
  const block = buildBriefBlock({});
  assert.match(block, /не заполнены/);
});

test('buildBriefBlock: факты попадают в промпт', () => {
  const block = buildBriefBlock({
    userName: 'Дмитрий',
    userRole: 'AI-инженер',
    company: 'Acme',
    brief: 'Пилот стоит фиксированно',
  });
  assert.match(block, /Дмитрий/);
  assert.match(block, /AI-инженер/);
  assert.match(block, /Acme/);
  assert.match(block, /Пилот стоит фиксированно/);
});

test('buildTranslateSystem: просит JSON с переводом и признаком вопроса', () => {
  const prompt = buildTranslateSystem({ sourceLang: 'en', targetLang: 'ru' });
  assert.match(prompt, /JSON/);
  assert.match(prompt, /"ru"/);
  assert.match(prompt, /question/);
  assert.match(prompt, /не переводи/);
});

test('buildAnswerSystem: бриф, запрет выдумывать и английский ответ', () => {
  const prompt = buildAnswerSystem({ brief: 'Факт А' });
  assert.match(prompt, /Факт А/);
  assert.match(prompt, /ничего не выдумывай/i);
  assert.match(prompt, /ПО-АНГЛИЙСКИ/);
  assert.match(prompt, /"answer"/);
});

test('buildGlossaryBlock: пустой глоссарий ничего не добавляет', () => {
  assert.equal(buildGlossaryBlock({}), '');
  assert.equal(buildGlossaryBlock({ glossary: '   ' }), '');
});

test('buildGlossaryBlock: термины попадают в оба промпта', () => {
  const s = { glossary: 'Kubernetes, Sber' };
  assert.match(buildGlossaryBlock(s), /Kubernetes, Sber/);
  assert.match(buildTranslateSystem(s), /Kubernetes, Sber/);
  assert.match(buildAnswerSystem(s), /Kubernetes, Sber/);
});

test('llmExtraParams: DeepSeek по умолчанию без thinking', () => {
  const params = llmExtraParams({ llmBaseUrl: 'https://api.deepseek.com', thinkingEnabled: false });
  assert.deepEqual(params, { thinking: { type: 'disabled' } });
});

test('llmExtraParams: thinking можно включить вручную', () => {
  const params = llmExtraParams({ llmBaseUrl: 'https://api.deepseek.com', thinkingEnabled: true });
  assert.deepEqual(params, {});
});

test('llmExtraParams: другим провайдерам поле не отправляем', () => {
  assert.deepEqual(llmExtraParams({ llmBaseUrl: 'https://api.openai.com/v1' }), {});
  assert.deepEqual(llmExtraParams({ llmBaseUrl: 'http://127.0.0.1:11434/v1' }), {});
});

test('buildUserPrompt: подставляет контекст и реплику', () => {
  const p = buildUserPrompt({ text: 'What is the price?', recent: ['Hello', 'How are you'] });
  assert.match(p, /Hello/);
  assert.match(p, /What is the price\?/);
});

// ---------- Разбор ответа модели ----------
test('parseModelJSON: чистый JSON', () => {
  const r = parseModelJSON('{"ru":"привет","answer":"hi","answerRu":"привет"}');
  assert.equal(r.ru, 'привет');
  assert.equal(r.answer, 'hi');
  assert.equal(r.question, true);
});

test('parseModelJSON: JSON в ```-обёртке', () => {
  const r = parseModelJSON('```json\n{"ru":"ок","answer":null,"answerRu":null}\n```');
  assert.equal(r.ru, 'ок');
  assert.equal(r.answer, null);
  assert.equal(r.question, false);
});

test('parseModelJSON: болтовня вокруг JSON', () => {
  const r = parseModelJSON('Конечно, вот результат: {"ru":"текст","question":false} — готово.');
  assert.equal(r.ru, 'текст');
});

test('parseModelJSON: мусор не роняет', () => {
  assert.equal(parseModelJSON('не json'), null);
  assert.equal(parseModelJSON(null), null);
  assert.equal(parseModelJSON('{"ru":'), null);
});

test('parseModelJSON: answer без answerRu не теряется', () => {
  const r = parseModelJSON('{"ru":"x","answer":"yes"}');
  assert.equal(r.answer, 'yes');
  assert.equal(r.answerRu, '');
});

// ---------- Шум ----------
test('isNoise: отсекает пустое и служебные метки', () => {
  assert.equal(isNoise(''), true);
  assert.equal(isNoise('  '), true);
  assert.equal(isNoise('[BLANK_AUDIO]'), true);
  assert.equal(isNoise('Thank you.'), true);
  assert.equal(isNoise('So what is the timeline for the pilot?'), false);
});

// ---------- Настройки: два провайдера ----------
test('migrateSettings: старые поля разъезжаются в stt и llm', () => {
  const s = migrateSettings({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-old', chatModel: 'gpt-4o-mini' });
  assert.equal(s.sttBaseUrl, 'https://api.openai.com/v1');
  assert.equal(s.llmBaseUrl, 'https://api.openai.com/v1');
  assert.equal(s.sttApiKey, 'sk-old');
  assert.equal(s.llmApiKey, 'sk-old');
  assert.equal(s.llmModel, 'gpt-4o-mini');
  assert.equal(s.baseUrl, undefined, 'старое поле не тащим дальше');
  assert.equal(s.apiKey, undefined);
});

test('migrateSettings: новые поля не перетираются старыми', () => {
  const s = migrateSettings({
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-old',
    sttBaseUrl: 'http://127.0.0.1:8000/v1',
    llmBaseUrl: 'https://api.deepseek.com',
    llmApiKey: 'sk-ds',
  });
  assert.equal(s.sttBaseUrl, 'http://127.0.0.1:8000/v1');
  assert.equal(s.llmBaseUrl, 'https://api.deepseek.com');
  assert.equal(s.llmApiKey, 'sk-ds');
  assert.equal(s.sttApiKey, 'sk-old', 'отсутствующий ключ добирается из старого');
});

test('migrateSettings: пустой вход даёт дефолты', () => {
  const s = migrateSettings();
  assert.equal(s.sttBaseUrl, DEFAULTS.sttBaseUrl);
  assert.equal(s.llmModel, DEFAULTS.llmModel);
  assert.equal(s.provider, 'demo');
});

test('missingKeys: называет оба ключа', () => {
  assert.deepEqual(missingKeys({}), ['ключ распознавания речи', 'ключ перевода']);
  assert.deepEqual(missingKeys({ sttApiKey: 'a' }), ['ключ перевода']);
  assert.deepEqual(missingKeys({ sttApiKey: 'a', llmApiKey: 'b' }), []);
});

test('PRESETS: DeepSeek и Ollama настроены корректно', () => {
  assert.equal(PRESETS.deepseek.llmBaseUrl, 'https://api.deepseek.com');
  assert.equal(PRESETS.deepseek.llmModel, 'deepseek-flash');
  assert.match(PRESETS.ollama.llmBaseUrl, /127\.0\.0\.1:11434/);
});

console.log(`\n${passed} тестов прошло${process.exitCode ? ' (есть падения)' : ''}`);
