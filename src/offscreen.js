// Offscreen-документ: захват звука вкладки, нарезка на фразы, STT и перевод.
// Живёт отдельно от service worker, поэтому не засыпает и держит аудиограф.
//
// Перевод и ответ идут двумя параллельными запросами: субтитр появляется сразу,
// не дожидаясь, пока модель придумает ответ.

import { encodeWav } from './lib/wav.mjs';
import { Segmenter } from './lib/vad.mjs';
import {
  buildTranslateSystem,
  buildAnswerSystem,
  buildUserPrompt,
  parseModelJSON,
  isNoise,
  llmExtraParams,
} from './lib/prompts.mjs';

const sessions = new Map(); // tabId -> session

function toTab(tabId, payload) {
  chrome.runtime.sendMessage({ type: 'ci:to-tab', tabId, payload }).catch(() => {});
}

async function startSession({ tabId, streamId, settings }) {
  await stopSession(tabId);

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  const ctx = new AudioContext({ sampleRate: 48000 });
  await ctx.resume();

  const source = ctx.createMediaStreamSource(stream);
  // tabCapture глушит вкладку — возвращаем звук в колонки, иначе собеседника не слышно
  source.connect(ctx.destination);

  await ctx.audioWorklet.addModule(chrome.runtime.getURL('src/pcm-worklet.js'));

  const node = new AudioWorkletNode(ctx, 'pcm16', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
    processorOptions: { targetRate: 16000 },
  });

  // узел должен быть частью графа, иначе его не «тянет» аудиопоток
  const silent = ctx.createGain();
  silent.gain.value = 0;
  source.connect(node);
  node.connect(silent);
  silent.connect(ctx.destination);

  const session = {
    tabId,
    settings,
    ctx,
    stream,
    node,
    segmenter: new Segmenter({ sampleRate: 16000 }),
    recent: [],
    seq: 0,
    queue: Promise.resolve(),
  };

  node.port.onmessage = (event) => {
    const pcm = new Int16Array(event.data);
    const phrases = session.segmenter.push(pcm);
    for (const phrase of phrases) enqueue(session, phrase);
  };

  stream.getAudioTracks()[0].addEventListener('ended', () => {
    toTab(tabId, { type: 'ci:error', message: 'Захват звука вкладки прерван.' });
    stopSession(tabId);
  });

  sessions.set(tabId, session);
  toTab(tabId, { type: 'ci:status', text: 'слушаю звонок' });
}

function enqueue(session, pcm) {
  session.queue = session.queue
    .then(() => handlePhrase(session, pcm))
    .catch((err) => {
      console.warn('[call-interpreter]', err);
      toTab(session.tabId, {
        type: 'ci:error',
        message: String(err && err.message ? err.message : err),
      });
    });
}

async function stopSession(tabId) {
  const session = sessions.get(tabId);
  if (!session) return;
  sessions.delete(tabId);
  try {
    session.node.port.onmessage = null;
    session.stream.getTracks().forEach((t) => t.stop());
    await session.ctx.close();
  } catch {
    /* ignore */
  }
}

function baseUrl(session, kind) {
  const raw = kind === 'stt' ? session.settings.sttBaseUrl : session.settings.llmBaseUrl;
  return (raw || 'https://api.openai.com/v1').replace(/\/+$/, '');
}

function authHeaders(session, kind) {
  const key = kind === 'stt' ? session.settings.sttApiKey : session.settings.llmApiKey;
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

async function errorText(res) {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}

async function transcribe(session, wav) {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'chunk.wav');
  form.append('model', session.settings.sttModel || 'gpt-4o-mini-transcribe');
  if (session.settings.sourceLang) form.append('language', session.settings.sourceLang);

  // глоссарий подсказывает распознаванию, как писать имена
  const hint = (session.settings.glossary || '').trim().slice(0, 500);
  if (hint) form.append('prompt', hint);

  const res = await fetch(`${baseUrl(session, 'stt')}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.settings.sttApiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Распознавание: HTTP ${res.status} ${await errorText(res)}`);
  const data = await res.json();
  return (data.text || '').trim();
}

async function chatJSON(session, { system, user, temperature }) {
  const body = {
    model: session.settings.llmModel || 'gpt-4o-mini',
    temperature,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    ...llmExtraParams(session.settings),
  };

  const res = await fetch(`${baseUrl(session, 'llm')}/chat/completions`, {
    method: 'POST',
    headers: authHeaders(session, 'llm'),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Модель: HTTP ${res.status} ${await errorText(res)}`);
  const data = await res.json();
  return parseModelJSON(data?.choices?.[0]?.message?.content || '');
}

async function translateAndShow(session, id, text) {
  const result = await chatJSON(session, {
    system: buildTranslateSystem(session.settings),
    user: buildUserPrompt({ text, recent: session.recent }),
    temperature: 0.2,
  });
  const ru = result?.ru || '';
  toTab(session.tabId, { type: 'ci:translated', id, text, ru });
  return ru;
}

async function answerAndShow(session, id, text, variant = false) {
  const result = await chatJSON(session, {
    system: buildAnswerSystem(session.settings),
    user: buildUserPrompt({ text, recent: session.recent }),
    temperature: variant ? 0.9 : 0.4,
  });
  if (!result?.answer) return null;
  toTab(session.tabId, {
    type: 'ci:answer',
    id,
    answer: result.answer,
    answerRu: result.answerRu,
  });
  return result.answer;
}

async function handlePhrase(session, pcm) {
  if (!sessions.has(session.tabId)) return;

  const wav = encodeWav(pcm, 16000);
  const text = await transcribe(session, wav);
  if (isNoise(text)) return;

  const id = ++session.seq;
  toTab(session.tabId, { type: 'ci:heard', id, text });

  // оба запроса стартуют одновременно: субтитр не ждёт генерации ответа
  const jobs = [translateAndShow(session, id, text)];
  if (session.settings.autoAnswer !== false) jobs.push(answerAndShow(session, id, text));

  const settled = await Promise.allSettled(jobs);
  for (const result of settled) {
    if (result.status === 'rejected') {
      toTab(session.tabId, {
        type: 'ci:error',
        message: String(result.reason?.message || result.reason),
      });
    }
  }

  session.recent.push(`Собеседник: ${text}`);
  if (session.recent.length > 12) session.recent.shift();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'ci:start') {
    startSession(msg)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.warn('[call-interpreter] start failed', err);
        toTab(msg.tabId, { type: 'ci:error', message: String(err && err.message ? err.message : err) });
        sendResponse({ ok: false, error: String(err) });
      });
    return true;
  }

  if (msg.type === 'ci:stop') {
    stopSession(msg.tabId).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'ci:regenerate') {
    const session = sessions.get(msg.tabId);
    if (!session) return;
    const text = msg.text || session.recent[session.recent.length - 1] || '';
    if (!text) return;
    const clean = text.replace(/^Собеседник:\s*/, '');
    answerAndShow(session, ++session.seq, clean, true).catch((err) =>
      console.warn('[call-interpreter] regenerate failed', err),
    );
    return;
  }
});
