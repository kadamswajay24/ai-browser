'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_SEND = new Set([
  'win-minimize','win-maximize','win-close',
  'tab-new','tab-close','tab-switch',
  'nav-go','nav-back','nav-forward','nav-reload','nav-stop',
]);

const ALLOWED_INVOKE = new Set([
  'tab-list',
  'agent-start','agent-pause','agent-resume','agent-stop','agent-status',
  'ollama-check',
  'settings-get','settings-set',
  'inspect-page',
]);

const ALLOWED_ON = new Set([
  'tab-activated','tab-updated','nav-state',
  'agent-log','agent-state','agent-progress','agent-complete',
  'focus-addressbar',
  'quiz-page-detected',   // new: hint when quiz URL is detected
]);

function sanitize(v) {
  if (typeof v === 'string')  return v.slice(0, 8192);
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v;
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (typeof k === 'string') out[k] = sanitize(val);
    }
    return out;
  }
  return String(v).slice(0, 8192);
}

contextBridge.exposeInMainWorld('electronAPI', {
  send(channel, payload) {
    if (!ALLOWED_SEND.has(channel)) return;
    ipcRenderer.send(channel, sanitize(payload));
  },
  async invoke(channel, payload) {
    if (!ALLOWED_INVOKE.has(channel)) return null;
    return ipcRenderer.invoke(channel, sanitize(payload));
  },
  on(channel, callback) {
    if (!ALLOWED_ON.has(channel)) return () => {};
    const h = (_, data) => callback(data);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
  once(channel, callback) {
    if (!ALLOWED_ON.has(channel)) return;
    ipcRenderer.once(channel, (_, data) => callback(data));
  },
});
