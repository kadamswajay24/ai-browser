'use strict';

const api = window.electronAPI;

// ── App state ─────────────────────────────────────────────────────────────────
// Per-tab agent state is stored here so switching tabs restores the sidebar.
const tabAgentState = new Map(); // tabId → { state, logs, results, total }

const appState = {
  tabs:        [],
  activeTabId: null,
  maxSteps:    50,
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const tabBar           = $('tab-bar');
const addressBar       = $('address-bar');
const securityIcon     = $('security-icon');
const btnBack          = $('btn-back');
const btnForward       = $('btn-forward');
const btnReload        = $('btn-reload');
const btnNewTab        = $('btn-new-tab');
const btnToggleSidebar = $('btn-toggle-sidebar');
const sidebar          = $('sidebar');
const agentBadge       = $('agent-status-badge');
const taskInput        = $('task-input');
const btnStart         = $('btn-start');
const btnPause         = $('btn-pause');
const btnResume        = $('btn-resume');
const btnStop          = $('btn-stop');
const logEntries       = $('log-entries');
const progressBar      = $('progress-bar');
const progressCount    = $('progress-count');
const resultsSection   = $('results-section');
const resultsBody      = $('results-body');
const ollamaStatus     = $('ollama-status');
const quizHintBanner   = $('quiz-hint-banner');
const tabAgentLabel    = $('tab-agent-label');

// ── Tab agent state helpers ───────────────────────────────────────────────────
function getTabState(tabId) {
  if (!tabAgentState.has(tabId)) {
    tabAgentState.set(tabId, {
      agentState: 'IDLE',
      logs:       [],      // [{level, message, step, time}]
      results:    [],      // result cards
      total:      0,
      instruction: '',
    });
  }
  return tabAgentState.get(tabId);
}

// ── Render sidebar for the active tab ────────────────────────────────────────
function renderSidebarForTab(tabId) {
  const ts = getTabState(tabId);

  // Label: "Tab 2 Agent" etc
  const tabIdx = appState.tabs.findIndex(t => t.tabId === tabId);
  if (tabAgentLabel) tabAgentLabel.textContent = `Tab ${tabIdx + 1} Agent`;

  // Badge
  updateAgentBadge(ts.agentState);

  // Restore instruction if we have one
  if (ts.instruction) taskInput.value = ts.instruction;

  // Restore log
  logEntries.innerHTML = '';
  for (const entry of ts.logs.slice(-200)) {  // last 200 lines
    _appendLogDOM(entry.level, `[${entry.step ?? '?'}] ${entry.message}`, entry.time);
  }

  // Restore results
  resultsBody.innerHTML = '';
  resultsSection.style.display = ts.results.length > 0 ? 'block' : 'none';
  for (const r of ts.results) _appendResultDOM(r);

  // Progress
  progressCount.textContent = `${ts.total} question${ts.total !== 1 ? 's' : ''}`;
  const pct = appState.maxSteps > 0
    ? Math.min(100, (ts.total / appState.maxSteps) * 100) : 0;
  progressBar.style.width = pct + '%';

  // Button states
  syncButtonsToState(ts.agentState);
}

// ── Agent badge ───────────────────────────────────────────────────────────────
function updateAgentBadge(state) {
  agentBadge.textContent = state;
  agentBadge.className   = 'badge ' + state.toLowerCase();
}

// ── Button state sync ─────────────────────────────────────────────────────────
function syncButtonsToState(state) {
  const running  = ['OBSERVING','ANALYZING','EXECUTING','WAITING_FOR_PAGE','VERIFYING'].includes(state);
  const paused   = state === 'PAUSED';
  const terminal = ['IDLE','COMPLETED','FAILED','CANCELLED'].includes(state);

  btnStart.disabled  = running || paused;
  btnPause.disabled  = !running;
  btnResume.disabled = !paused;
  btnStop.disabled   = terminal;
}

// ── Settings ──────────────────────────────────────────────────────────────────
async function loadSettings() {
  const s = await api.invoke('settings-get');
  if (!s) return;
  $('set-host').value     = s.ollamaHost  ?? 'http://127.0.0.1:11434';
  $('set-model').value    = s.ollamaModel ?? 'qwen2.5:3b';
  $('set-delay').value    = s.stepDelay   ?? 1000;
  $('set-maxsteps').value = s.maxSteps    ?? 50;
  appState.maxSteps       = s.maxSteps    ?? 50;
}

$('btn-save-settings').addEventListener('click', async () => {
  const settings = {
    ollamaHost:  $('set-host').value.trim(),
    ollamaModel: $('set-model').value.trim(),
    stepDelay:   parseInt($('set-delay').value, 10)    || 1000,
    maxSteps:    parseInt($('set-maxsteps').value, 10) || 50,
  };
  await api.invoke('settings-set', settings);
  appState.maxSteps = settings.maxSteps;
  appendLog('info', 'Settings saved.');
});

$('btn-check-ollama').addEventListener('click', async () => {
  ollamaStatus.textContent = 'Checking…';
  const host  = $('set-host').value.trim();
  const model = $('set-model').value.trim();
  const res   = await api.invoke('ollama-check', { host, model });
  if (res.ok) {
    ollamaStatus.style.color = '#22c55e';
    ollamaStatus.textContent = `✓ ${model} ${res.modelAvailable ? '✓' : '⚠ not found'} | All: ${res.models.slice(0,3).join(', ')}`;
  } else {
    ollamaStatus.style.color = '#ef4444';
    ollamaStatus.textContent = `✗ ${res.error}`;
  }
});

// ── Tab rendering ─────────────────────────────────────────────────────────────
function renderTabs() {
  tabBar.innerHTML = '';
  for (const tab of appState.tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.active ? ' active' : '');
    el.dataset.tabId = tab.tabId;

    // Agent state dot on the tab
    const ts = getTabState(tab.tabId);
    const running = ['OBSERVING','ANALYZING','EXECUTING','WAITING_FOR_PAGE','VERIFYING'].includes(ts.agentState);
    const paused  = ts.agentState === 'PAUSED';

    const dot = document.createElement('span');
    dot.className = 'tab-agent-dot';
    dot.style.background = running ? 'var(--green)' : paused ? 'var(--orange)' : 'transparent';
    dot.title = running ? 'Agent running' : paused ? 'Agent paused' : '';

    const favicon = document.createElement('span');
    favicon.className = 'tab-favicon';
    if (tab.loading) {
      const sp = document.createElement('div');
      sp.className = 'tab-spinner';
      favicon.appendChild(sp);
    } else {
      favicon.textContent = getFavicon(tab.url);
    }

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title || tab.url || 'New Tab';
    title.title       = tab.title || tab.url || '';

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '✕';
    close.addEventListener('click', e => { e.stopPropagation(); api.send('tab-close', tab.tabId); });

    el.appendChild(dot);
    el.appendChild(favicon);
    el.appendChild(title);
    el.appendChild(close);
    el.addEventListener('click', () => api.send('tab-switch', tab.tabId));
    tabBar.appendChild(el);
  }
}

function getFavicon(url) {
  if (!url || url === 'about:blank') return '🌐';
  try {
    const h = new URL(url).hostname;
    if (h.includes('google'))     return '🔍';
    if (h.includes('youtube'))    return '▶';
    if (h.includes('github'))     return '🐙';
    if (h.includes('wikipedia'))  return '📖';
    if (/canvas|moodle|blackboard|brightspace|lms/.test(h)) return '🎓';
    if (h.includes('localhost'))  return '💻';
    return '🌐';
  } catch { return '🌐'; }
}

// ── Navigation ────────────────────────────────────────────────────────────────
function navigateTo(raw) {
  if (!raw.trim()) return;
  api.send('nav-go', raw.trim());
}

addressBar.addEventListener('keydown', e => {
  if (e.key === 'Enter')  navigateTo(addressBar.value);
  if (e.key === 'Escape') addressBar.blur();
});
$('btn-go').addEventListener('click',  () => navigateTo(addressBar.value));
btnBack.addEventListener('click',      () => api.send('nav-back'));
btnForward.addEventListener('click',   () => api.send('nav-forward'));
btnReload.addEventListener('click',    () => {
  const tab = appState.tabs.find(t => t.active);
  api.send(tab?.loading ? 'nav-stop' : 'nav-reload');
});
btnNewTab.addEventListener('click', () => api.send('tab-new'));
btnToggleSidebar.addEventListener('click', () => {
  sidebar.classList.toggle('collapsed');
});
api.on('focus-addressbar', () => { addressBar.select(); addressBar.focus(); });

// ── IPC: tab events ───────────────────────────────────────────────────────────
api.on('tab-activated', data => {
  appState.activeTabId = data.tabId;
  appState.tabs.forEach(t => { t.active = t.tabId === data.tabId; });
  addressBar.value = data.url === 'about:blank' ? '' : (data.url || '');
  updateNavBtns(data);
  renderTabs();

  // ── Swap sidebar to show this tab's agent ──────────────────────────────
  // Seed the tab agent state with the state reported from main
  const ts = getTabState(data.tabId);
  if (data.agentState) ts.agentState = data.agentState;
  renderSidebarForTab(data.tabId);

  // Hide quiz hint when switching tabs
  if (quizHintBanner) quizHintBanner.style.display = 'none';
});

api.on('tab-updated', data => {
  const idx = appState.tabs.findIndex(t => t.tabId === data.tabId);
  if (idx >= 0) appState.tabs[idx] = { ...appState.tabs[idx], ...data };
  renderTabs();
  if (data.tabId === appState.activeTabId) {
    if (data.url) addressBar.value = data.url === 'about:blank' ? '' : data.url;
    setLoadingUI(data.loading);
  }
});

api.on('nav-state', data => {
  addressBar.value = data.url === 'about:blank' ? '' : (data.url || '');
  updateNavBtns(data);
  setLoadingUI(data.loading);
  securityIcon.textContent = data.url?.startsWith('https://') ? '🔒' : '🌐';
  securityIcon.style.color = data.url?.startsWith('https://') ? 'var(--green)' : 'var(--text2)';
});

function updateNavBtns(data) {
  btnBack.disabled    = !data.canGoBack;
  btnForward.disabled = !data.canGoForward;
}
function setLoadingUI(loading) {
  btnReload.textContent = loading ? '✕' : '↻';
  btnReload.title = loading ? 'Stop' : 'Reload';
}

// ── Quiz page detected banner ─────────────────────────────────────────────────
api.on('quiz-page-detected', data => {
  // Only show for the currently active tab
  if (data._tabId !== appState.activeTabId) return;
  const ts = getTabState(data._tabId);
  // Only show if agent isn't already running
  if (['IDLE','COMPLETED','FAILED','CANCELLED'].includes(ts.agentState)) {
    if (quizHintBanner) {
      quizHintBanner.style.display = 'flex';
      $('quiz-hint-url').textContent = data.url?.slice(0, 60) || '';
    }
  }
});

// Dismiss banner
const dismissHint = () => { if (quizHintBanner) quizHintBanner.style.display = 'none'; };

// "Start Agent" button inside the banner — fills instruction and starts
const btnHintStart = $('hint-start-btn');
if (btnHintStart) {
  btnHintStart.addEventListener('click', () => {
    dismissHint();
    // If instruction box is empty, prefill default
    if (!taskInput.value.trim()) {
      taskInput.value = 'Solve this practice quiz. Read every question, analyze the options, ' +
        'choose the best answer, select it on the page, move to the next question, and continue ' +
        'until all questions are done. Report uncertain questions and stop before final submission.';
    }
    startAgent();
  });
}
$('hint-dismiss-btn')?.addEventListener('click', dismissHint);

// ── IPC: agent events — only apply to the currently active tab ────────────────
// All agent events carry _tabId so we know which tab they belong to.

api.on('agent-state', data => {
  const tabId = data._tabId;
  if (!tabId) return;

  const ts = getTabState(tabId);
  ts.agentState = data.state;

  // Update tab dot (visible on all tabs)
  renderTabs();

  // Only update sidebar if this is the active tab
  if (tabId !== appState.activeTabId) return;

  updateAgentBadge(data.state);
  syncButtonsToState(data.state);
  if (data.reason) appendLog('warn', `⚠ ${data.reason}`);

  // Auto-dismiss quiz hint when agent starts
  if (data.state !== 'IDLE') dismissHint();
});

api.on('agent-log', data => {
  const tabId = data._tabId;
  if (!tabId) return;

  const ts = getTabState(tabId);
  const entry = { level: data.level, message: data.message, step: data.step, time: data.time };
  ts.logs.push(entry);
  if (ts.logs.length > 500) ts.logs.shift();  // cap per-tab log

  if (tabId === appState.activeTabId) {
    _appendLogDOM(entry.level, `[${entry.step ?? '?'}] ${entry.message}`, entry.time);
  }
});

api.on('agent-progress', data => {
  const tabId = data._tabId;
  if (!tabId) return;

  const ts = getTabState(tabId);
  if (data.result) ts.results.push(data.result);
  ts.total = data.total ?? ts.total;

  if (tabId !== appState.activeTabId) return;

  if (data.result) _appendResultDOM(data.result);
  progressCount.textContent = `${ts.total} question${ts.total !== 1 ? 's' : ''}`;
  const pct = Math.min(100, (ts.total / appState.maxSteps) * 100);
  progressBar.style.width = pct + '%';
  resultsSection.style.display = 'block';
});

api.on('agent-complete', data => {
  const tabId = data._tabId;
  if (!tabId) return;

  const ts = getTabState(tabId);
  ts.agentState = data.finalState || 'COMPLETED';
  renderTabs();  // update dot

  if (tabId !== appState.activeTabId) return;

  appendLog('info',
    `━━ Complete ━━ Answered:${data.answered} Unverified:${data.unverified} ` +
    `Uncertain:${data.uncertain} Failed:${data.failed}`
  );
  progressBar.style.width = '100%';
  resultsSection.style.display = 'block';
});

// ── Agent controls ────────────────────────────────────────────────────────────
async function startAgent() {
  const instruction = taskInput.value.trim();
  if (!instruction) { appendLog('warn', 'Enter a task instruction first.'); return; }

  // Save instruction in this tab's state so it's restored on tab switch
  const ts = getTabState(appState.activeTabId);
  ts.instruction = instruction;

  // Clear this tab's log/results
  ts.logs    = [];
  ts.results = [];
  ts.total   = 0;
  clearSidebarDisplay();

  const res = await api.invoke('agent-start', { instruction });
  if (res && !res.ok) appendLog('error', `Failed to start: ${res.error}`);
}

btnStart.addEventListener('click', startAgent);
btnPause.addEventListener('click',  () => api.invoke('agent-pause'));
btnResume.addEventListener('click', () => api.invoke('agent-resume'));
btnStop.addEventListener('click',   () => api.invoke('agent-stop'));

// ── Log helpers ───────────────────────────────────────────────────────────────
function appendLog(level, message) {
  // Also persist to active tab's state
  const ts = getTabState(appState.activeTabId);
  const entry = { level, message, step: null, time: new Date().toISOString() };
  ts.logs.push(entry);
  if (ts.logs.length > 500) ts.logs.shift();
  _appendLogDOM(level, message, entry.time);
}

function _appendLogDOM(level, message, isoTime) {
  const el = document.createElement('div');
  el.className = `log-entry ${level}`;

  const t = document.createElement('span');
  t.className = 'log-time';
  t.textContent = isoTime
    ? new Date(isoTime).toLocaleTimeString('en-US', { hour12: false })
    : new Date().toLocaleTimeString('en-US', { hour12: false });

  const m = document.createElement('span');
  m.textContent = message;

  el.appendChild(t);
  el.appendChild(m);
  logEntries.appendChild(el);
  logEntries.scrollTop = logEntries.scrollHeight;

  while (logEntries.children.length > 500) logEntries.removeChild(logEntries.firstChild);
}

$('btn-clear-log').addEventListener('click', () => {
  logEntries.innerHTML = '';
  const ts = getTabState(appState.activeTabId);
  ts.logs = [];
});

// ── Result cards ──────────────────────────────────────────────────────────────
function _appendResultDOM(result) {
  resultsSection.style.display = 'block';
  const card = document.createElement('div');
  card.className = 'result-card';

  const qEl = document.createElement('div');
  qEl.className = 'rc-q';
  const badge = result.step ? `<span style="color:var(--text2);font-size:10px">Q${result.step}</span> ` : '';
  qEl.innerHTML = badge + esc((result.question ?? '').slice(0, 150)) + (result.question?.length > 150 ? '…' : '');

  const aEl = document.createElement('div');
  const sc   = result.status === 'answered' ? '' : result.status === 'uncertain' ? 'uncertain' : 'failed';
  aEl.className = `rc-a ${sc}`;
  if (result.status === 'answered' || result.status === 'answered-unverified') {
    const chosen = Array.isArray(result.chosen) ? result.chosen : [result.chosen];
    aEl.textContent = `✓ ${chosen.join('; ')}${result.status === 'answered-unverified' ? ' (unverified)' : ''}`;
  } else if (result.status === 'uncertain') {
    aEl.textContent = '⚠ Uncertain — skipped';
  } else {
    aEl.textContent = `✗ ${result.error ?? result.status}`;
  }

  const confEl = document.createElement('div');
  confEl.className = 'rc-conf';
  if (typeof result.confidence === 'number')
    confEl.textContent = `Confidence: ${(result.confidence * 100).toFixed(0)}%`;

  const reasonEl = document.createElement('div');
  reasonEl.className = 'rc-reason';
  if (result.reasoning) reasonEl.textContent = result.reasoning.slice(0, 160) + (result.reasoning.length > 160 ? '…' : '');

  card.appendChild(qEl);
  card.appendChild(aEl);
  if (result.confidence !== undefined) card.appendChild(confEl);
  if (result.reasoning) card.appendChild(reasonEl);

  resultsBody.appendChild(card);
  resultsSection.scrollTop = resultsSection.scrollHeight;
}

function clearSidebarDisplay() {
  logEntries.innerHTML  = '';
  resultsBody.innerHTML = '';
  resultsSection.style.display = 'none';
  progressBar.style.width = '0%';
  progressCount.textContent = '0 questions';
}

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Window controls ───────────────────────────────────────────────────────────
$('btn-minimize').addEventListener('click', () => api.send('win-minimize'));
$('btn-maximize').addEventListener('click', () => api.send('win-maximize'));
$('btn-close').addEventListener('click',    () => api.send('win-close'));

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  await loadSettings();
  const tabs = await api.invoke('tab-list');
  if (tabs) {
    appState.tabs = tabs;
    // Seed tab states from the reported agentState
    for (const t of tabs) {
      const ts = getTabState(t.tabId);
      if (t.agentState) ts.agentState = t.agentState;
    }
    renderTabs();
  }
})();

appendLog('info', 'AI Browser ready. Each tab has its own independent AI agent.');
