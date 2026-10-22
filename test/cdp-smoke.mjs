// Смоук-тест в реальном Chrome: грузим распакованное расширение через CDP,
// открываем макет звонка, запускаем демо из service worker и снимаем скриншоты.
// Запуск: node test/cdp-smoke.mjs
//
// Chrome 137+ не принимает --load-extension в сборках Google Chrome, поэтому
// используется домен Extensions (флаг --enable-unsafe-extension-debugging).

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
const HTTP_PORT = 8899;
const DEBUG_PORT = 9333;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILE = path.join(os.tmpdir(), `ci-smoke-${process.pid}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, condition, extra = '') {
  if (condition) console.log(`  ok  ${name}`);
  else {
    console.error(`  FAIL ${name} ${extra}`);
    failures++;
  }
}

// ---------- статический сервер ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const url = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(ROOT, url === '/' ? '/test/call.html' : url);
      if (!file.startsWith(ROOT) || !existsSync(file)) {
        res.writeHead(404).end('not found');
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(500).end('error');
    }
  });
  return new Promise((resolve) => server.listen(HTTP_PORT, '127.0.0.1', () => resolve(server)));
}

// ---------- минимальный CDP-клиент ----------
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      } else {
        this.events.push(msg);
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
      }, 20000);
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

function launchChrome() {
  const args = [
    '--headless=new',
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-breakpad',
    '--disable-features=Translate,MediaRouter',
    '--window-size=1440,900',
    'about:blank',
  ];
  const proc = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr.on('data', (d) => {
    const text = String(d);
    if (/Failed to load extension|Manifest/i.test(text)) {
      process.stderr.write(`[chrome] ${text.slice(0, 400)}\n`);
    }
  });
  return proc;
}

async function evaluate(cdp, sessionId, expression) {
  const res = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true, userGesture: true },
    sessionId,
  );
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || 'evaluate failed');
  }
  return res.result.value;
}

async function screenshot(cdp, sessionId, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  const file = path.join(OUT, name);
  await writeFile(file, Buffer.from(data, 'base64'));
  return file;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const server = await startServer();
  let chrome = null;
  let cdp = null;

  try {
    chrome = launchChrome();
    const browserWs = await waitForDevtools();
    cdp = await CDP.connect(browserWs);

    const { id: extensionId } = await cdp.send('Extensions.loadUnpacked', { path: ROOT });
    check('расширение загружено без ошибок манифеста', Boolean(extensionId), String(extensionId));
    console.log(`  ..  extension id: ${extensionId}`);

    // ждём service worker расширения
    let swTarget = null;
    const swDeadline = Date.now() + 10000;
    while (Date.now() < swDeadline && !swTarget) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      swTarget = targetInfos.find(
        (t) => t.type === 'service_worker' && t.url === `chrome-extension://${extensionId}/src/background.js`,
      );
      if (!swTarget) await sleep(300);
    }
    check('service worker запустился', Boolean(swTarget), swTarget ? '' : 'не найден');

    // страница-макет звонка
    const { targetId: pageTarget } = await cdp.send('Target.createTarget', {
      url: `http://127.0.0.1:${HTTP_PORT}/test/call.html`,
    });
    const { sessionId: page } = await cdp.send('Target.attachToTarget', { targetId: pageTarget, flatten: true });
    await cdp.send('Runtime.enable', {}, page);
    await cdp.send('Page.enable', {}, page);
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false },
      page,
    );
    await sleep(2000);

    const { sessionId: sw } = await cdp.send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sw);

    const started = await evaluate(
      cdp,
      sw,
      `(async () => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((t) => t.active) || tabs[tabs.length - 1];
        if (!tab) return 'NO_TAB';
        try { await chrome.tabs.sendMessage(tab.id, { type: 'ci:ping' }); }
        catch (e) { return 'NO_CS:' + tab.id + ':' + e.message; }
        await chrome.tabs.sendMessage(tab.id, { type: 'ci:start-demo' });
        return 'OK:' + tab.id;
      })()`,
    );
    check('контент-скрипт отвечает и демо запущено', String(started).startsWith('OK'), String(started));

    await sleep(5200);
    const view1 = await evaluate(
      cdp,
      page,
      `(() => {
        const host = document.getElementById('ci-root');
        if (!host || !host.shadowRoot) return { ok: false, answer: '', subtitle: '', text: '' };
        const root = host.shadowRoot;
        return {
          ok: true,
          answer: (root.getElementById('ansEn') || {}).textContent || '',
          subtitle: (root.getElementById('dst') || {}).textContent || '',
          text: root.textContent.replace(/\\s+/g, ' ').trim(),
        };
      })()`,
    );
    check('Shadow DOM с интерфейсом создан', view1.ok);
    check('панель показывает ответ на английском', /Sure\. Last quarter/.test(view1.answer), view1.answer.slice(0, 70));
    check('субтитр с русским переводом виден', /прошлом квартале/i.test(view1.subtitle), view1.subtitle.slice(0, 70));
    check('кнопки управления на месте', /Копировать/.test(view1.text) && /Ещё вариант/.test(view1.text));

    console.log(`  ..  скриншот: ${await screenshot(cdp, page, 'smoke-1.png')}`);

    // вкладка «Лог» и ещё несколько реплик
    await evaluate(cdp, page, "document.getElementById('ci-root').shadowRoot.getElementById('tabLog').click()");
    await sleep(9000);
    const view2 = await evaluate(
      cdp,
      page,
      `(() => {
        const root = document.getElementById('ci-root').shadowRoot;
        return {
          log: root.getElementById('log').textContent.replace(/\\s+/g, ' ').trim(),
          items: root.getElementById('log').children.length,
          logVisible: !root.getElementById('paneLog').hidden,
          answerHidden: root.getElementById('paneAnswer').hidden,
        };
      })()`,
    );
    check('вкладка «Лог» открылась и держится', view2.logVisible && view2.answerHidden);
    check('в логе накопились реплики', view2.items >= 3, `элементов: ${view2.items}`);
    check('в логе есть перевод', /[а-яА-Я]{6,}/.test(view2.log), view2.log.slice(0, 90));
    console.log(`  ..  скриншот: ${await screenshot(cdp, page, 'smoke-2.png')}`);

    // страница настроек: проверяем, что ES-модуль с импортом prompts.mjs реально выполнился
    const { targetId: optTarget } = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${extensionId}/src/options.html`,
    });
    const { sessionId: opt } = await cdp.send('Target.attachToTarget', { targetId: optTarget, flatten: true });
    await cdp.send('Runtime.enable', {}, opt);
    await sleep(1500);
    const optState = await evaluate(
      cdp,
      opt,
      `(() => ({
        provider: (document.getElementById('provider') || {}).value,
        sttBaseUrl: (document.getElementById('sttBaseUrl') || {}).value,
        llmBaseUrl: (document.getElementById('llmBaseUrl') || {}).value,
        hasSave: Boolean(document.getElementById('save')),
        sttDisabled: Boolean(document.getElementById('sttApiKey') && document.getElementById('sttApiKey').disabled),
        presets: document.querySelectorAll('[data-preset]').length,
      }))()`,
    );
    check(
      'страница настроек ожила (модуль + импорт .mjs)',
      optState.provider === 'demo' && optState.hasSave,
      JSON.stringify(optState),
    );
    check('поля подставлены из DEFAULTS', /api\.openai\.com/.test(optState.sttBaseUrl || ''), optState.sttBaseUrl);
    check('в демо-режиме ключи заблокированы', optState.sttDisabled === true);
    check('пресеты DeepSeek/Ollama на месте', optState.presets === 3, `кнопок: ${optState.presets}`);
    console.log(`  ..  скриншот: ${await screenshot(cdp, opt, 'options.png')}`);

    const errors = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown');
    check('нет необработанных исключений', errors.length === 0, `${errors.length}`);
  } finally {
    if (cdp) cdp.close();
    if (chrome) {
      chrome.kill('SIGTERM');
      await sleep(800);
      chrome.kill('SIGKILL');
    }
    server.close();
    await rm(PROFILE, { recursive: true, force: true }).catch(() => {});
  }

  console.log(failures ? `\nСмоук-тест: ${failures} провал(ов)` : '\nСмоук-тест прошёл');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('Смоук-тест упал:', err);
  process.exit(1);
});
