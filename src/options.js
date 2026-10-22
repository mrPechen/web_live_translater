import { DEFAULTS, PRESETS, migrateSettings } from './lib/prompts.mjs';

const FIELDS = [
  'provider',
  'sttBaseUrl',
  'sttApiKey',
  'sttModel',
  'llmBaseUrl',
  'llmApiKey',
  'llmModel',
  'sourceLang',
  'targetLang',
  'userName',
  'userRole',
  'company',
  'brief',
  'glossary',
];
const CHECKS = ['thinkingEnabled', 'autoAnswer', 'showSource'];
const API_FIELDS = ['sttBaseUrl', 'sttApiKey', 'sttModel', 'llmBaseUrl', 'llmApiKey', 'llmModel'];

const $ = (id) => document.getElementById(id);

function setStatus(text, kind) {
  const node = $('status');
  node.textContent = text;
  node.className = kind || '';
}

function syncDisabled() {
  const demo = $('provider').value === 'demo';
  for (const id of API_FIELDS) $(id).disabled = demo;
  for (const btn of document.querySelectorAll('[data-preset]')) btn.disabled = demo;
  $('test').disabled = demo;
}

async function load() {
  const stored = await chrome.storage.local.get('settings');
  const settings = migrateSettings(stored.settings || {});
  for (const key of FIELDS) $(key).value = settings[key] ?? '';
  for (const key of CHECKS) $(key).checked = Boolean(settings[key]);
  syncDisabled();
}

function collect() {
  const settings = {};
  for (const key of FIELDS) settings[key] = $(key).value.trim();
  for (const key of CHECKS) settings[key] = $(key).checked;
  settings.provider = settings.provider || 'demo';
  settings.sourceLang = settings.sourceLang || DEFAULTS.sourceLang;
  settings.targetLang = settings.targetLang || DEFAULTS.targetLang;
  return settings;
}

async function save() {
  await chrome.storage.local.set({ settings: collect() });
  $('saved').textContent = `Сохранено в ${new Date().toLocaleTimeString('ru-RU')}`;
  setTimeout(() => {
    $('saved').textContent = '';
  }, 3000);
}

async function checkEndpoint(label, base, key) {
  const url = `${(base || '').replace(/\/+$/, '')}/models`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) return `${label}: HTTP ${res.status}`;
    const data = await res.json();
    const count = Array.isArray(data.data) ? data.data.length : 0;
    return `${label}: ок (${count} моделей)`;
  } catch (err) {
    return `${label}: ${err.message}`;
  }
}

async function testKeys() {
  const settings = collect();
  setStatus('Проверяю…');
  const results = [];
  if (settings.sttApiKey) results.push(await checkEndpoint('распознавание', settings.sttBaseUrl, settings.sttApiKey));
  if (settings.llmApiKey) results.push(await checkEndpoint('перевод', settings.llmBaseUrl, settings.llmApiKey));
  if (!results.length) {
    setStatus('Сначала вставьте хотя бы один ключ', 'err');
    return;
  }
  const failed = results.some((r) => /HTTP|error|Failed|fetch/i.test(r));
  setStatus(results.join(' · '), failed ? 'err' : 'ok');
}

for (const btn of document.querySelectorAll('[data-preset]')) {
  btn.addEventListener('click', () => {
    const preset = PRESETS[btn.dataset.preset];
    if (!preset) return;
    $('llmBaseUrl').value = preset.llmBaseUrl;
    $('llmModel').value = preset.llmModel;
    setStatus(`Пресет «${btn.textContent}» подставлен — не забудьте свой ключ`, '');
  });
}

$('save').addEventListener('click', save);
$('test').addEventListener('click', testKeys);
$('provider').addEventListener('change', syncDisabled);

load();
