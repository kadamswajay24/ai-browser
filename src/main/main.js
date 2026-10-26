'use strict';

const {
  app, BrowserWindow, BrowserView,
  ipcMain, session, shell, Menu,
} = require('electron');
const path  = require('path');
const Store = require('electron-store');
const { v4: uuidv4 } = require('uuid');

const AgentController = require('../agent/agent-controller');
const OllamaClient    = require('../agent/ollama-client');
const PageInspector   = require('../agent/page-inspector');

// ── Security: block non-http(s) navigation ────────────────────────────────────
app.on('web-contents-created', (_, contents) => {
  contents.on('will-navigate', (event, url) => {
    try {
      const p = new URL(url).protocol;
      if (!['http:', 'https:', 'about:'].includes(p)) event.preventDefault();
    } catch { event.preventDefault(); }
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) return { action: 'allow' };
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
});

// ── Globals ───────────────────────────────────────────────────────────────────
const store  = new Store({ name: 'ai-browser-config' });
const DEV    = process.argv.includes('--dev');

// Tab registry: tabId → TabEntry
// TabEntry: { view, url, title, loading, tabId, agent: AgentController }
const tabs   = new Map();
let activeTabId = null;
let mainWindow  = null;

// Layout
const TOOLBAR_H = 76;
const SIDEBAR_W = 360;

function getContentBounds(win) {
  const [w, h] = win.getContentSize();
  return { x: 0, y: TOOLBAR_H, width: w - SIDEBAR_W, height: h - TOOLBAR_H };
}

// ── Renderer bridge ───────────────────────────────────────────────────────────
function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send(channel, payload);
}

// ── Per-tab agent sender — prefixes every event with the tabId ────────────────
// The renderer uses tabId to decide whether to display this event
// (only shown when it matches the currently active tab).
function makeTabSender(tabId) {
  return (channel, payload) => send(channel, { ...payload, _tabId: tabId });
}

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    backgroundColor: '#1a1a2e',
    titleBarStyle: 'hidden', frame: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  if (DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
  mainWindow.on('resize', resizeActiveTab);
  mainWindow.webContents.on('did-finish-load', () => {
    if (tabs.size === 0) createTab('https://www.google.com');
  });
  buildMenu();
}

// ── Tab management ────────────────────────────────────────────────────────────
function createTab(url = 'about:blank') {
  const tabId = uuidv4();

  const view = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, '../preload/tab-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      session: session.defaultSession,   // shared cookies = shared login
    },
  });

  mainWindow.addBrowserView(view);

  // ── Per-tab AgentController ───────────────────────────────────────────────
  const agent = new AgentController({
    store,
    sendToRenderer: makeTabSender(tabId),
  });

  const tab = { view, url, title: 'New Tab', loading: false, tabId, agent };
  tabs.set(tabId, tab);

  const wc = view.webContents;

  wc.on('did-start-loading', () => updateTab(tabId, { loading: true }));

  wc.on('did-stop-loading', () => {
    const currentUrl   = wc.getURL();
    const currentTitle = wc.getTitle() || currentUrl;
    updateTab(tabId, { loading: false, url: currentUrl, title: currentTitle });
    // Let that tab's own agent know the page changed
    tab.agent.onPageChanged(tabId, currentUrl, wc);
    // If this is the active tab, push the "quiz detected" hint to UI
    if (tabId === activeTabId) {
      maybeShowQuizHint(currentUrl, tabId);
    }
  });

  wc.on('page-title-updated', (_, title) => updateTab(tabId, { title }));
  wc.on('did-fail-load', (_, code, desc) => {
    if (code !== -3) updateTab(tabId, { loading: false, title: `Error: ${desc}` });
  });
  wc.on('console-message', (_, level, msg) => {
    if (DEV) console.log(`[TAB-${tabId.slice(0, 6)}]`, msg);
  });

  activateTab(tabId);

  if (url && url !== 'about:blank') {
    wc.loadURL(url).catch(console.error);
  } else {
    wc.loadFile(path.join(__dirname, '../renderer/newtab.html')).catch(() => {});
  }

  return tabId;
}

// Push a small hint to the sidebar when a quiz URL is detected
function maybeShowQuizHint(url, tabId) {
  const quizPatterns = [
    /\/mod\/quiz\/attempt/i,    // Moodle
    /\/quizzes\//i,             // Canvas
    /\/assessment\//i,          // generic
    /quiz|attempt|test/i,       // broad
  ];
  if (quizPatterns.some(re => re.test(url))) {
    send('quiz-page-detected', { tabId, url });
  }
}

function activateTab(tabId) {
  if (!tabs.has(tabId)) return;
  for (const [, t] of tabs) t.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });

  activeTabId = tabId;
  resizeActiveTab();

  const tab = tabs.get(tabId);
  send('tab-activated', {
    tabId,
    url:        tab.url,
    title:      tab.title,
    loading:    tab.loading,
    canGoBack:  tab.view.webContents.canGoBack(),
    canGoForward: tab.view.webContents.canGoForward(),
    agentState: tab.agent.state,         // ← send current agent state on switch
  });
}

function resizeActiveTab() {
  if (!activeTabId || !mainWindow || mainWindow.isDestroyed()) return;
  const tab = tabs.get(activeTabId);
  if (!tab) return;
  tab.view.setBounds(getContentBounds(mainWindow));
}

function closeTab(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  // Stop this tab's agent before destroying
  tab.agent.stop().catch(() => {});
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.removeBrowserView(tab.view);
  }
  tab.view.webContents.destroy();
  tabs.delete(tabId);

  if (tabs.size === 0) { createTab(); return; }
  if (activeTabId === tabId) {
    const keys = [...tabs.keys()];
    activateTab(keys[keys.length - 1]);
  }
}

function updateTab(tabId, partial) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  Object.assign(tab, partial);
  send('tab-updated', { tabId, url: tab.url, title: tab.title, loading: tab.loading });
  if (tabId === activeTabId) {
    send('nav-state', {
      canGoBack:    tab.view.webContents.canGoBack(),
      canGoForward: tab.view.webContents.canGoForward(),
      url:          tab.url,
      loading:      tab.loading,
    });
  }
}

// ── IPC: window controls ───────────────────────────────────────────────────────
ipcMain.on('win-minimize', () => mainWindow?.minimize());
ipcMain.on('win-maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('win-close', () => mainWindow?.close());

// ── IPC: tabs ─────────────────────────────────────────────────────────────────
ipcMain.on('tab-new',    (_, url)   => createTab(url));
ipcMain.on('tab-close',  (_, tabId) => closeTab(tabId));
ipcMain.on('tab-switch', (_, tabId) => activateTab(tabId));
ipcMain.handle('tab-list', () =>
  [...tabs.entries()].map(([id, t]) => ({
    tabId:      id,
    url:        t.url,
    title:      t.title,
    loading:    t.loading,
    active:     id === activeTabId,
    agentState: t.agent.state,
  }))
);

// ── IPC: navigation ───────────────────────────────────────────────────────────
ipcMain.on('nav-go', (_, url) => {
  const tab = tabs.get(activeTabId);
  if (!tab) return;
  let target = url.trim();
  if (!/^https?:\/\//i.test(target) && !target.startsWith('about:')) {
    target = target.includes('.') && !target.includes(' ')
      ? `https://${target}`
      : `https://www.google.com/search?q=${encodeURIComponent(target)}`;
  }
  tab.view.webContents.loadURL(target).catch(console.error);
});
ipcMain.on('nav-back',    () => tabs.get(activeTabId)?.view.webContents.goBack());
ipcMain.on('nav-forward', () => tabs.get(activeTabId)?.view.webContents.goForward());
ipcMain.on('nav-reload',  () => tabs.get(activeTabId)?.view.webContents.reload());
ipcMain.on('nav-stop',    () => tabs.get(activeTabId)?.view.webContents.stop());

// ── IPC: agent — always operates on the ACTIVE tab's own agent ────────────────
function activeAgent() {
  return tabs.get(activeTabId)?.agent ?? null;
}

ipcMain.handle('agent-start', async (_, { instruction }) => {
  const tab = tabs.get(activeTabId);
  if (!tab) return { ok: false, error: 'No active tab' };
  try {
    await tab.agent.start({
      instruction,
      tabId:       activeTabId,
      webContents: tab.view.webContents,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('agent-pause',  async () => activeAgent()?.pause());
ipcMain.handle('agent-resume', async () => activeAgent()?.resume());
ipcMain.handle('agent-stop',   async () => activeAgent()?.stop());
ipcMain.handle('agent-status', async () => activeAgent()?.getStatus() ?? null);

// ── IPC: Ollama check ─────────────────────────────────────────────────────────
ipcMain.handle('ollama-check', async (_, { host, model }) =>
  new OllamaClient({ host, model }).healthCheck()
);

// ── IPC: settings ─────────────────────────────────────────────────────────────
ipcMain.handle('settings-get', async () => ({
  ollamaHost:  store.get('ollamaHost',  'http://127.0.0.1:11434'),
  ollamaModel: store.get('ollamaModel', 'qwen2.5:3b'),
  maxSteps:    store.get('maxSteps',    50),
  stepDelay:   store.get('stepDelay',   1000),
}));

ipcMain.handle('settings-set', async (_, s) => {
  const allowed = ['ollamaHost', 'ollamaModel', 'maxSteps', 'stepDelay'];
  for (const [k, v] of Object.entries(s)) {
    if (allowed.includes(k)) store.set(k, v);
  }
  return { ok: true };
});

// ── IPC: page inspection ──────────────────────────────────────────────────────
ipcMain.handle('inspect-page', async () => {
  const tab = tabs.get(activeTabId);
  if (!tab) return null;
  return new PageInspector(tab.view.webContents).inspect();
});

// ── App menu ──────────────────────────────────────────────────────────────────
function buildMenu() {
  const template = [
    {
      label: 'File', submenu: [
        { label: 'New Tab',   accelerator: 'CmdOrCtrl+T', click: () => createTab() },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => closeTab(activeTabId) },
        { type: 'separator' }, { role: 'quit' },
      ],
    },
    {
      label: 'Navigate', submenu: [
        { label: 'Back',    accelerator: 'Alt+Left',    click: () => tabs.get(activeTabId)?.view.webContents.goBack() },
        { label: 'Forward', accelerator: 'Alt+Right',   click: () => tabs.get(activeTabId)?.view.webContents.goForward() },
        { label: 'Reload',  accelerator: 'CmdOrCtrl+R', click: () => tabs.get(activeTabId)?.view.webContents.reload() },
        { label: 'Address Bar', accelerator: 'CmdOrCtrl+L', click: () => send('focus-addressbar', {}) },
      ],
    },
    {
      label: 'View', submenu: [
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
        ...(DEV ? [{ role: 'toggleDevTools' }] : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  session.defaultSession.cookies.on('changed', () => {});
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('before-quit', () => {
  for (const [, t] of tabs) t.agent.stop().catch(() => {});
});
