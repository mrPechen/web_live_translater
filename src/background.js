// Service worker: управляет захватом звука вкладки и проксирует сообщения
// между offscreen-документом (там живёт аудио и WebSocket) и страницей.

import { DEFAULTS, migrateSettings, missingKeys } from './lib/prompts.mjs';

const OFFSCREEN_URL = 'src/offscreen.html';
const capturing = new Map(); // tabId -> { demo: boolean }
let creating = null;

async function loadSettings() {
  const stored = await chrome.storage.local.get('settings');
  return migrateSettings({ ...DEFAULTS, ...(stored.settings || {}) });
}

async function hasOffscreen() {
  if (!chrome.runtime.getContexts) return false;
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['USER_MEDIA'],
        justification: 'Захват звука вкладки для распознавания и перевода речи звонка',
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

async function ensureContentScript(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'ci:ping' });
    if (res && res.ok) return true;
  } catch {
    /* не внедрён — внедрим */
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content.js', 'src/demo.js'],
    });
    return true;
  } catch (err) {
    console.warn('[call-interpreter] не удалось внедрить контент-скрипт', err);
    return false;
  }
}

async function setBadge(tabId, text, color) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
    await chrome.action.setBadgeText({ tabId, text });
  } catch {
    /* вкладка могла закрыться */
  }
}

async function start(tab) {
  const tabId = tab.id;
  const settings = await loadSettings();
  const injected = await ensureContentScript(tabId);
  if (!injected) throw new Error('Не удалось внедрить интерфейс на эту страницу');

  if (settings.provider === 'demo') {
    capturing.set(tabId, { demo: true });
    await chrome.tabs.sendMessage(tabId, { type: 'ci:start-demo' });
    await setBadge(tabId, 'DEMO', '#7c5cff');
    return;
  }

  const missing = missingKeys(settings);
  if (missing.length) {
    await chrome.tabs.sendMessage(tabId, {
      type: 'ci:error',
      message: `Не задано: ${missing.join(', ')}. Откройте настройки расширения.`,
      needsSetup: true,
    });
    await chrome.runtime.openOptionsPage();
    return;
  }

  await ensureOffscreen();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  capturing.set(tabId, { demo: false });
  await chrome.runtime.sendMessage({ type: 'ci:start', tabId, streamId, settings });
  await setBadge(tabId, 'REC', '#e5484d');
}

async function stop(tabId) {
  if (!capturing.has(tabId)) return;
  capturing.delete(tabId);
  try {
    await chrome.runtime.sendMessage({ type: 'ci:stop', tabId });
  } catch {
    /* offscreen уже закрыт */
  }
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'ci:stopped' });
  } catch {
    /* страница уже ушла */
  }
  await setBadge(tabId, '', '#000000');
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || tab.id === undefined) return;
  try {
    if (capturing.has(tab.id)) await stop(tab.id);
    else await start(tab);
  } catch (err) {
    console.warn('[call-interpreter]', err);
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'ci:error',
        message: String(err && err.message ? err.message : err),
      });
    } catch {
      /* ignore */
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  stop(tabId).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && capturing.has(tabId)) {
    // при переходе на другую страницу захват умирает — снимаем флаг
    stop(tabId).catch(() => {});
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined) return;
  if (command === 'toggle-capture') {
    if (capturing.has(tab.id)) await stop(tab.id);
    else await start(tab).catch((e) => console.warn(e));
  } else if (command === 'gen-answer') {
    chrome.runtime.sendMessage({ type: 'ci:regenerate', tabId: tab.id }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  switch (msg.type) {
    case 'ci:to-tab':
      chrome.tabs.sendMessage(msg.tabId, msg.payload).catch(() => {});
      return;
    case 'ci:regenerate': {
      // от страницы приходит без tabId, берём его из sender
      const tabId = msg.tabId ?? sender.tab?.id;
      if (tabId !== undefined) {
        chrome.runtime.sendMessage({ type: 'ci:regenerate', tabId }).catch(() => {});
      }
      return;
    }
    case 'ci:open-options':
      chrome.runtime.openOptionsPage();
      return;
    case 'ci:get-settings':
      loadSettings().then((s) =>
        sendResponse({ provider: s.provider, targetLang: s.targetLang, showSource: s.showSource }),
      );
      return true;
    default:
      return;
  }
});
