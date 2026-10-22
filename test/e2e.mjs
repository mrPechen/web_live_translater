// Сквозной тест настоящего пути: tabCapture → AudioWorklet → VAD → WAV → API → UI.
// Вместо OpenAI поднимается локальный совместимый сервер.
// Запуск: node test/e2e.mjs

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const HTTP_PORT = 8900;
const API_PORT = 8901;
const DEBUG_PORT = 9334;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILE = path.join(os.tmpdir(), `ci-e2e-${process.pid}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// --local: распознавание идёт в настоящий whisper-server на 127.0.0.1:8080
const USE_LOCAL_STT = process.argv.includes('--local');
const STT_BASE = USE_LOCAL_STT ? 'http://127.0.0.1:8080/v1' : `http://127.0.0.1:${API_PORT}/v1`;
const STT_KEY = USE_LOCAL_STT ? 'local' : 'test-key';
const STT_MODEL = USE_LOCAL_STT ? 'whisper-1' : 'gpt-4o-mini-transcribe';
let failures = 0;
function check(name, condition, extra = '') {
  if (condition) console.log(`  ok  ${name}`);
  else {
    console.error(`  FAIL ${name} ${extra}`);
    failures++;
  }
}

const FIXTURE = {
  text: 'What would you need from our side to get a pilot running by January?',
  ru: 'Что вам нужно с нашей стороны, чтобы запустить пилот к январю?',
  answer: 'Three things: access to a sample of your tickets, one process owner on your side, and two weeks for the first evaluation.',
  answerRu: 'Три вещи: доступ к выборке тикетов, владелец процесса с вашей стороны и две недели на первую оценку.',
};

const stats = { transcriptions: 0, chats: 0, audioBytes: 0 };

// ---------- фейковый OpenAI ----------
function startApi() {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    if (req.url.startsWith('/v1/audio/transcriptions')) {
      stats.transcriptions++;
      stats.audioBytes += body.length;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: FIXTURE.text }));
      return;
    }

    if (req.url.startsWith('/v1/chat/completions')) {
      stats.chats++;
      const payload = JSON.parse(body.toString() || '{}');
      const isJson = payload.response_format?.type === 'json_object';
      const content = isJson
        ? JSON.stringify({ ru: FIXTURE.ru, answer: FIXTURE.answer, answerRu: FIXTURE.answerRu, question: true })
        : FIXTURE.ru;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
      return;
    }

    res.writeHead(404).end('{}');
  });
  return new Promise((resolve) => server.listen(API_PORT, '127.0.0.1', () => resolve(server)));
}

// ---------- статика ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wav': 'audio/wav',
};

function startStatic() {
  const server = createServer(async (req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(ROOT, url);
    if (!file.startsWith(ROOT) || !existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  });
  return new Promise((resolve) => server.listen(HTTP_PORT, '127.0.0.1', () => resolve(server)));
}

// ---------- CDP ----------
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
    });
    return new CDP(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }
      }, 25000);
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function waitForDevtools(ms = 25000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch {
      /* ещё не поднялся */
    }
    await sleep(250);
  }
  throw new Error('DevTools не отвечает');
}

async function evaluate(cdp, sessionId, expression) {
  const res = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true, userGesture: true },
    sessionId,
  );
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || 'evaluate failed');
  return res.result.value;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const api = await startApi();
  const statics = await startStatic();

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--user-data-dir=${PROFILE}`,
      `--remote-debugging-port=${DEBUG_PORT}`,
      '--enable-unsafe-extension-debugging',
      '--autoplay-policy=no-user-gesture-required',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-breakpad',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  let cdp = null;
  try {
    cdp = await CDP.connect(await waitForDevtools());
    const { id: extensionId } = await cdp.send('Extensions.loadUnpacked', { path: ROOT });
    check('расширение загружено', Boolean(extensionId));

    const { targetId } = await cdp.send('Target.createTarget', {
      url: `http://127.0.0.1:${HTTP_PORT}/test/audio.html`,
    });
    const { sessionId: page } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, page);
    await sleep(2000);

    // service worker расширения
    let sw = null;
    for (let i = 0; i < 40 && !sw; i++) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      sw = targetInfos.find(
        (t) => t.type === 'service_worker' && t.url === `chrome-extension://${extensionId}/src/background.js`,
      );
      if (!sw) await sleep(250);
    }
    if (!sw) throw new Error('service worker не появился');
    const { sessionId: swS } = await cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, swS);

    const settingsSet = await evaluate(
      cdp,
      swS,
      `(async () => {
        const settings = {
          provider: 'openai',
          sttBaseUrl: '${STT_BASE}',
          sttApiKey: '${STT_KEY}',
          sttModel: '${STT_MODEL}',
          llmBaseUrl: 'http://127.0.0.1:${API_PORT}/v1',
          llmApiKey: 'test-key',
          llmModel: 'gpt-4o-mini',
          sourceLang: 'en',
          targetLang: 'ru',
          brief: 'Пилот: 2 недели, фиксированная цена. Нужен доступ к тикетам и владелец процесса.',
          glossary: 'pilot, January',
          autoAnswer: true,
        };
        await chrome.storage.local.set({ settings });
        return 'OK';
      })()`,
    );
    check('настройки сохранены', settingsSet === 'OK');

    // Горячая клавиша расширения даёт activeTab — без неё tabCapture не разрешён.
    await cdp.send('Page.bringToFront', {}, page);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, page);
    for (const type of ['rawKeyDown', 'keyUp']) {
      await cdp.send(
        'Input.dispatchKeyEvent',
        {
          type,
          modifiers: 9, // Alt + Shift
          windowsVirtualKeyCode: 84,
          nativeVirtualKeyCode: 84,
          code: 'KeyT',
          key: 'T',
        },
        page,
      );
    }

    const started = await evaluate(
      cdp,
      page,
      `new Promise((resolve) => {
        const t0 = Date.now();
        const tick = () => {
          const host = document.getElementById('ci-root');
          const root = host && host.shadowRoot;
          if (root && !root.getElementById('panel').hidden) return resolve('UI_OK');
          if (Date.now() - t0 > 12000) return resolve('NO_UI');
          setTimeout(tick, 300);
        };
        tick();
      })`,
    );
    check('горячая клавиша запустила перевод', started === 'UI_OK', started);

    // ждём, пока VAD нарежет фразы и пройдут запросы к моделям
    const deadline = Date.now() + 45000;
    while (
      Date.now() < deadline &&
      (stats.chats === 0 || (!USE_LOCAL_STT && stats.transcriptions === 0))
    ) {
      await sleep(500);
    }

    if (!USE_LOCAL_STT) {
      check('звук дошёл до распознавания', stats.transcriptions > 0, `запросов: ${stats.transcriptions}`);
      check('WAV не пустой', stats.audioBytes > 40000, `байт: ${stats.audioBytes}`);
    }
    check('перевод запрошен', stats.chats >= 2, `запросов: ${stats.chats} (перевод + ответ)`);

    const view = await evaluate(
      cdp,
      page,
      `(() => {
        const host = document.getElementById('ci-root');
        if (!host || !host.shadowRoot) return { ok: false, subtitle: '', answer: '' };
        const root = host.shadowRoot;
        return {
          ok: true,
          subtitle: (root.getElementById('dst') || {}).textContent || '',
          answer: (root.getElementById('ansEn') || {}).textContent || '',
          src: (root.getElementById('src') || {}).textContent || '',
        };
      })()`,
    );
    check('субтитр с переводом появился в UI', view.subtitle.includes('январю'), view.subtitle.slice(0, 80));
    check('ответ из материалов показан', view.answer.includes('Three things'), view.answer.slice(0, 80));
    check('оригинал реплики виден (речь распознана)', /january/i.test(view.src), view.src.slice(0, 80));

    if (failures) {
      const diag = await evaluate(
        cdp,
        page,
        `(() => {
          const root = document.getElementById('ci-root');
          const toast = root && root.shadowRoot ? root.shadowRoot.getElementById('toast') : null;
          return JSON.stringify({
            toast: toast ? (toast.hidden ? '(скрыт)' : toast.textContent) : '(нет)',
            page: (document.getElementById('state') || {}).textContent,
            audioCtx: typeof AudioContext,
          });
        })()`,
      );
      console.log(`  ..  диагностика: ${diag}`);
    }

    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, page);
    const file = path.join(OUT, 'e2e.png');
    await writeFile(file, Buffer.from(data, 'base64'));
    console.log(`  ..  скриншот: ${file}`);
  } finally {
    if (cdp) cdp.close();
    chrome.kill('SIGTERM');
    await sleep(800);
    chrome.kill('SIGKILL');
    api.close();
    statics.close();
    await rm(PROFILE, { recursive: true, force: true }).catch(() => {});
  }

  console.log(failures ? `\nE2E: ${failures} провал(ов)` : '\nE2E прошёл');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('E2E упал:', err);
  process.exit(1);
});
