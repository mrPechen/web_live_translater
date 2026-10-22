// Контент-скрипт: субтитры-перевод поверх звонка и панель с готовым ответом.
// Всё живёт в Shadow DOM, чтобы не конфликтовать со стилями Meet / Zoom / Telegram.

(() => {
  'use strict';
  if (window.__CI_CONTENT__) return;
  window.__CI_CONTENT__ = true;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap {
      position: fixed; inset: 0; pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Inter, system-ui, sans-serif;
      -webkit-font-smoothing: antialiased;
      --bg: rgba(18, 20, 26, 0.92);
      --fg: #eef1f7;
      --dim: rgba(238, 241, 247, 0.56);
      --line: rgba(255, 255, 255, 0.1);
      --accent: #7aa2ff;
    }
    .subs, .panel, .toast, .fab { pointer-events: auto; }

    .subs {
      position: fixed; left: 50%; bottom: 96px; transform: translateX(-50%);
      max-width: min(920px, 88vw); padding: 14px 20px;
      background: rgba(12, 14, 20, 0.86);
      -webkit-backdrop-filter: blur(22px) saturate(140%);
      backdrop-filter: blur(22px) saturate(140%);
      border: 1px solid var(--line); border-radius: 16px;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
      color: var(--fg); cursor: grab;
    }
    .subs:active { cursor: grabbing; }
    .subs .src { font-size: 13px; line-height: 1.35; color: var(--dim); margin-bottom: 6px; }
    .subs .dst { font-size: 21px; line-height: 1.38; font-weight: 500; letter-spacing: -0.01em; }
    .subs .src:empty { display: none; }

    .panel {
      position: fixed; right: 20px; top: 80px; width: 380px;
      display: flex; flex-direction: column;
      max-height: calc(100vh - 170px);
      background: var(--bg);
      -webkit-backdrop-filter: blur(24px) saturate(140%);
      backdrop-filter: blur(24px) saturate(140%);
      border: 1px solid var(--line); border-radius: 16px;
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.5);
      color: var(--fg); overflow: hidden;
    }
    .head {
      display: flex; align-items: center; gap: 8px;
      padding: 9px 10px 9px 12px; border-bottom: 1px solid var(--line);
      cursor: grab; user-select: none; flex: none;
    }
    .head:active { cursor: grabbing; }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: #3ddc84; flex: none; }
    .dot.off { background: #6b7280; }
    .dot.rec { background: #e5484d; animation: ci-pulse 1.8s ease-in-out infinite; }
    @keyframes ci-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
    .title { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--dim); font-weight: 600; }
    .grow { flex: 1 1 auto; }
    .minibtn {
      background: transparent; border: 1px solid transparent; color: var(--dim);
      font: inherit; font-size: 12px; padding: 4px 8px; border-radius: 8px; cursor: pointer;
    }
    .minibtn:hover { color: var(--fg); background: rgba(255, 255, 255, 0.06); }
    .minibtn.on { color: var(--fg); border-color: var(--line); background: rgba(255, 255, 255, 0.06); }

    .body { padding: 12px; overflow-y: auto; flex: 1 1 auto; }
    .cap { font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--dim); margin-bottom: 8px; }
    .ans { font-size: 15px; line-height: 1.45; white-space: pre-wrap; }
    .ans.empty { color: var(--dim); font-style: italic; }
    .ansru { font-size: 13px; line-height: 1.45; color: var(--dim); white-space: pre-wrap; margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--line); }
    .ansru:empty { display: none; }
    .actions { display: flex; gap: 8px; margin-top: 14px; }
    .btn {
      font: inherit; font-size: 13px; padding: 7px 12px; border-radius: 9px; cursor: pointer;
      border: 1px solid var(--line); background: rgba(255, 255, 255, 0.04); color: var(--fg);
    }
    .btn:hover { background: rgba(255, 255, 255, 0.09); }
    .btn.primary { background: var(--accent); border-color: transparent; color: #0a0d14; font-weight: 600; }
    .btn.primary:hover { filter: brightness(1.08); }

    .log { display: flex; flex-direction: column; gap: 12px; }
    .item .en { font-size: 12px; line-height: 1.35; color: var(--dim); margin-bottom: 3px; }
    .item .ru { font-size: 14px; line-height: 1.4; }
    .item .ru:empty::after { content: "…"; color: var(--dim); }

    .foot { flex: none; padding: 8px 12px; border-top: 1px solid var(--line); font-size: 10px; color: var(--dim); }
    kbd { font: inherit; font-size: 10px; border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; }

    .toast {
      position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
      max-width: min(560px, 90vw); padding: 10px 14px; border-radius: 12px;
      background: rgba(42, 20, 24, 0.96); border: 1px solid rgba(229, 72, 77, 0.45);
      color: #ffc2c6; font-size: 13px; line-height: 1.35;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
    }
    .toast .btn { margin-left: 10px; }

    .fab {
      position: fixed; right: 20px; bottom: 20px; width: 44px; height: 44px; border-radius: 50%;
      background: var(--bg); border: 1px solid var(--line); color: var(--fg);
      font: 600 10px/1 -apple-system, system-ui, sans-serif; letter-spacing: 0.02em;
      cursor: pointer; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
      -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px);
    }
    .fab:hover { border-color: var(--accent); }
  `;

  const SHELL = `
    <div class="wrap">
      <div class="subs" id="subs" hidden>
        <div class="src" id="src"></div>
        <div class="dst" id="dst"></div>
      </div>

      <div class="panel" id="panel" hidden>
        <div class="head" id="head">
          <span class="dot off" id="dot"></span>
          <span class="title">Call Interpreter</span>
          <span class="grow"></span>
          <button class="minibtn on" id="tabAnswer">Ответ</button>
          <button class="minibtn" id="tabLog">Лог</button>
          <button class="minibtn" id="btnHide" title="Свернуть">—</button>
        </div>
        <div class="body">
          <div id="paneAnswer">
            <div class="cap" id="cap">Ответ собеседнику · EN</div>
            <div class="ans empty" id="ansEn">Пока вопросов не было</div>
            <div class="ansru" id="ansRu"></div>
            <div class="actions">
              <button class="btn primary" id="btnCopy">Копировать</button>
              <button class="btn" id="btnRegen">Ещё вариант</button>
            </div>
          </div>
          <div id="paneLog" hidden>
            <div class="log" id="log"></div>
          </div>
        </div>
        <div class="foot">
          <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> — вкл/выкл · <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd> — другой ответ
        </div>
      </div>

      <div class="toast" id="toast" hidden></div>
      <button class="fab" id="fab" hidden>EN→RU</button>
    </div>
  `;

  const state = { log: [], hideTimer: null, demo: false, answer: null, running: false, tabPinned: false };
  let host = null;
  let root = null;
  let el = {};

  function ensureUI() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'ci-root';
    host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483640; pointer-events: none;';
    root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);
    const holder = document.createElement('div');
    holder.innerHTML = SHELL;
    root.appendChild(holder);

    el = {
      subs: root.getElementById('subs'),
      src: root.getElementById('src'),
      dst: root.getElementById('dst'),
      panel: root.getElementById('panel'),
      head: root.getElementById('head'),
      dot: root.getElementById('dot'),
      tabAnswer: root.getElementById('tabAnswer'),
      tabLog: root.getElementById('tabLog'),
      btnHide: root.getElementById('btnHide'),
      paneAnswer: root.getElementById('paneAnswer'),
      paneLog: root.getElementById('paneLog'),
      cap: root.getElementById('cap'),
      ansEn: root.getElementById('ansEn'),
      ansRu: root.getElementById('ansRu'),
      btnCopy: root.getElementById('btnCopy'),
      btnRegen: root.getElementById('btnRegen'),
      log: root.getElementById('log'),
      toast: root.getElementById('toast'),
      fab: root.getElementById('fab'),
    };

    el.tabAnswer.addEventListener('click', () => switchTab('answer', true));
    el.tabLog.addEventListener('click', () => switchTab('log', true));
    el.btnHide.addEventListener('click', () => setPanel(false));
    el.fab.addEventListener('click', () => setPanel(true));
    el.btnCopy.addEventListener('click', copyAnswer);
    el.btnRegen.addEventListener('click', regenerate);
    el.head.addEventListener('mousedown', (e) => makeDraggable(el.panel, e));
    el.subs.addEventListener('mousedown', (e) => makeDraggable(el.subs, e));

    restorePosition(el.panel, 'ci.panel.pos');
    restorePosition(el.subs, 'ci.subs.pos', true);

    document.documentElement.appendChild(host);
  }

  function savePosition(node, key) {
    try {
      localStorage.setItem(key, JSON.stringify({ left: node.style.left, top: node.style.top }));
    } catch {
      /* приватный режим */
    }
  }

  function restorePosition(node, key, centered) {
    try {
      const pos = JSON.parse(localStorage.getItem(key) || 'null');
      if (!pos || !pos.left) return;
      node.style.left = pos.left;
      node.style.top = pos.top;
      node.style.right = 'auto';
      node.style.bottom = 'auto';
      if (centered) node.style.transform = 'none';
    } catch {
      /* ignore */
    }
  }

  function makeDraggable(node, event) {
    if (event.target.closest('button')) return;
    event.preventDefault();
    const rect = node.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;

    node.style.left = `${rect.left}px`;
    node.style.top = `${rect.top}px`;
    node.style.right = 'auto';
    node.style.bottom = 'auto';
    if (node === el.subs) node.style.transform = 'none';

    const onMove = (e) => {
      const x = Math.max(8, Math.min(window.innerWidth - 120, e.clientX - offsetX));
      const y = Math.max(8, Math.min(window.innerHeight - 60, e.clientY - offsetY));
      node.style.left = `${x}px`;
      node.style.top = `${y}px`;
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
      savePosition(node, node === el.panel ? 'ci.panel.pos' : 'ci.subs.pos');
    };
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
  }

  function setPanel(visible) {
    ensureUI();
    el.panel.hidden = !visible;
    el.fab.hidden = visible;
  }

  function switchTab(name, manual = false) {
    if (manual) state.tabPinned = true;
    const answer = name === 'answer';
    el.paneAnswer.hidden = !answer;
    el.paneLog.hidden = answer;
    el.tabAnswer.classList.toggle('on', answer);
    el.tabLog.classList.toggle('on', !answer);
  }

  function setStatus(kind, text) {
    ensureUI();
    el.dot.className = `dot ${kind || ''}`.trim();
    if (text) el.cap.textContent = text;
  }

  function showSubs(en, ru) {
    ensureUI();
    el.subs.hidden = false;
    if (en !== undefined) el.src.textContent = en;
    if (ru !== undefined) el.dst.textContent = ru;
    clearTimeout(state.hideTimer);
    state.hideTimer = setTimeout(() => {
      el.subs.hidden = true;
    }, 12000);
  }

  function upsertLog(id, en, ru) {
    const key = String(id);
    let item = state.log.find((x) => x.key === key);
    if (!item) {
      item = { key, en, ru };
      state.log.push(item);
      if (state.log.length > 60) state.log.shift();
    } else {
      if (en) item.en = en;
      if (ru) item.ru = ru;
    }
    renderLog();
  }

  function renderLog() {
    if (!el.log) return;
    const frag = document.createDocumentFragment();
    for (const item of state.log) {
      const box = document.createElement('div');
      box.className = 'item';
      const en = document.createElement('div');
      en.className = 'en';
      en.textContent = item.en;
      const ru = document.createElement('div');
      ru.className = 'ru';
      ru.textContent = item.ru || '';
      box.append(en, ru);
      frag.appendChild(box);
    }
    el.log.replaceChildren(frag);
    const scroller = el.log.parentElement;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  function setAnswer(answer, answerRu) {
    ensureUI();
    state.answer = answer || null;
    if (answer) {
      el.ansEn.classList.remove('empty');
      el.ansEn.textContent = answer;
      el.ansRu.textContent = answerRu || '';
      // не выдёргиваем пользователя из «Лога», если он сам туда переключился
      if (!state.tabPinned) switchTab('answer');
    } else {
      el.ansEn.classList.add('empty');
      el.ansEn.textContent = 'Пока вопросов не было';
      el.ansRu.textContent = '';
    }
  }

  async function copyAnswer() {
    if (!state.answer) return;
    try {
      await navigator.clipboard.writeText(state.answer);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = state.answer;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch {
        /* ignore */
      }
      ta.remove();
    }
    const old = el.btnCopy.textContent;
    el.btnCopy.textContent = 'Скопировано';
    setTimeout(() => {
      el.btnCopy.textContent = old;
    }, 1400);
  }

  function regenerate() {
    if (state.demo) return;
    chrome.runtime.sendMessage({ type: 'ci:regenerate' }).catch(() => {});
    el.btnRegen.textContent = 'Готовлю…';
    setTimeout(() => {
      el.btnRegen.textContent = 'Ещё вариант';
    }, 2500);
  }

  function showToast(message, needsSetup) {
    ensureUI();
    el.toast.replaceChildren(document.createTextNode(message));
    if (needsSetup) {
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = 'Настройки';
      btn.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'ci:open-options' }));
      el.toast.appendChild(btn);
    }
    el.toast.hidden = false;
    setTimeout(() => {
      el.toast.hidden = true;
    }, 9000);
  }

  function shutdown() {
    state.demo = false;
    state.running = false;
    if (el.subs) el.subs.hidden = true;
    setPanel(false);
    setStatus('off');
  }

  // ---- демо-режим (без API: проверка интерфейса и сценария) ----
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function runDemo() {
    const demo = window.__CI_DEMO__;
    if (!demo) {
      showToast('Демо-данные не загружены');
      return;
    }
    state.demo = true;
    state.running = true;
    setPanel(true);
    setStatus('rec');
    el.cap.textContent = 'ДЕМО · ответ собеседнику · EN';

    for (const line of demo.lines) {
      if (!state.demo) break;
      upsertLog(line.id, line.en, '');
      showSubs(line.en, '…');
      await wait(900);
      if (!state.demo) break;
      upsertLog(line.id, line.en, line.ru);
      showSubs(line.en, line.ru);
      setAnswer(line.answer, line.answerRu);
      await wait(demo.gap || 4200);
    }
    if (state.demo) {
      state.demo = false;
      setStatus('off');
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'ci:ping':
        sendResponse({ ok: true });
        return;
      case 'ci:start-demo':
        ensureUI();
        runDemo();
        break;
      case 'ci:heard':
        ensureUI();
        upsertLog(msg.id, msg.text, '');
        showSubs(msg.text, '…');
        break;
      case 'ci:translated':
        ensureUI();
        upsertLog(msg.id, msg.text, msg.ru);
        showSubs(msg.text, msg.ru || '');
        break;
      case 'ci:answer':
        ensureUI();
        setAnswer(msg.answer, msg.answerRu);
        break;
      case 'ci:status':
        ensureUI();
        setPanel(true);
        setStatus('rec');
        break;
      case 'ci:error':
        ensureUI();
        showToast(msg.message || 'Ошибка перевода', msg.needsSetup);
        break;
      case 'ci:stopped':
        shutdown();
        break;
      case 'ci:regenerate':
        regenerate();
        break;
      default:
        break;
    }
  });

  window.addEventListener('pagehide', () => {
    if (state.demo) state.demo = false;
  });
})();
