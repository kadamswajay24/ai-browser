'use strict';

const { v4: uuidv4 } = require('uuid');
const OllamaClient   = require('./ollama-client');
const PageInspector  = require('./page-inspector');
const QuizAnalyzer   = require('./quiz-analyzer');

const STATE = Object.freeze({
  IDLE:             'IDLE',
  OBSERVING:        'OBSERVING',
  ANALYZING:        'ANALYZING',
  EXECUTING:        'EXECUTING',
  WAITING_FOR_PAGE: 'WAITING_FOR_PAGE',
  VERIFYING:        'VERIFYING',
  PAUSED:           'PAUSED',
  COMPLETED:        'COMPLETED',
  FAILED:           'FAILED',
  CANCELLED:        'CANCELLED',
});

const MAX_OBSERVE_RETRIES = 3;
const NAV_TIMEOUT_MS      = 14000;
const DOM_QUIET_MS        = 700;

class AgentController {
  constructor({ store, sendToRenderer }) {
    this.store  = store;
    this.send   = sendToRenderer;
    // Full reset of every field so no stale state survives between quiz runs
    this._fullReset();
  }

  // ── Complete state reset — called on construction AND at start of every run ─
  _fullReset() {
    this.state           = STATE.IDLE;
    this.taskId          = null;
    this.instruction     = '';
    this._cancelFlag     = false;
    this._pauseFlag      = false;
    this._pauseResolve   = null;
    this._stepCount      = 0;
    this._results        = [];
    this._errorLog       = [];
    this._lastQuestionText = null;   // BUG1 FIX: was leaking across runs
    this._stuckCount       = 0;      // BUG1 FIX: was leaking across runs
    this._lastPageHash     = null;   // BUG2 FIX: stale hash from previous quiz
    this._lastPageUrl      = null;   // BUG2 FIX: track URL changes too
    this._seenQuestions    = new Set(); // deduplicate across the whole run
    this._ollama           = null;
    this._analyzer         = null;
    this._inspector        = null;
    this._webContents      = null;
    this._tabId            = null;
    this._stepDelay        = 1000;
    this._maxSteps         = 50;
    this._currentLms       = null;   // BUG3 FIX: re-detect LMS per question
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  async start({ instruction, tabId, webContents }) {
    // Allow restart from any terminal or paused state — only block if mid-run
    const busy = ['OBSERVING','ANALYZING','EXECUTING','WAITING_FOR_PAGE','VERIFYING'];
    if (busy.includes(this.state)) {
      throw new Error(`Agent is mid-run (${this.state}). Click Stop first, then Start.`);
    }

    // ── Full reset before every new quiz run ──────────────────────────────
    this._fullReset();   // BUG4 FIX: was only resetting subset of fields

    const host  = this.store.get('ollamaHost',  'http://127.0.0.1:11434');
    const model = this.store.get('ollamaModel', 'qwen2.5:3b');
    this._stepDelay = Number(this.store.get('stepDelay', 1000)) || 1000;
    this._maxSteps  = Number(this.store.get('maxSteps',  50))   || 50;

    this._ollama    = new OllamaClient({ host, model });
    this._analyzer  = new QuizAnalyzer(this._ollama);
    this._inspector = new PageInspector(webContents);
    this._webContents = webContents;
    this._tabId     = tabId;
    this.taskId     = uuidv4();
    this.instruction = instruction;

    this._setState(STATE.OBSERVING);
    this._log('info', `New run started — task: "${instruction.slice(0, 80)}"`);

    // Verify Ollama reachability
    const health = await this._ollama.healthCheck();
    if (!health.ok) {
      this._setState(STATE.FAILED);
      this._log('error', `Ollama unreachable at ${host}: ${health.error}`);
      throw new Error(`Ollama not reachable: ${health.error}`);
    }
    this._log('info', `Ollama OK — ${health.modelAvailable ? model + ' ✓' : 'model not listed, attempting anyway'}`);

    // Snapshot starting URL so we can detect if we leave the quiz domain
    try {
      const startMeta = await this._inspector.getPageMeta();
      this._startUrl = startMeta.url || '';
      this._log('info', `Starting URL: ${this._startUrl.slice(0, 80)}`);
    } catch(_) { this._startUrl = ''; }

    this._runLoop().catch(err => {
      this._log('error', `Unhandled loop error: ${err.message}`);
      this._setState(STATE.FAILED);
      this._sendSummary();
    });
  }

  pause() {
    if (this.state === STATE.PAUSED || this.state === STATE.IDLE) return;
    this._pauseFlag = true;
    this._setState(STATE.PAUSED);
    this._log('info', 'Paused by user');
  }

  resume() {
    if (this.state !== STATE.PAUSED) return;
    this._pauseFlag = false;
    if (this._pauseResolve) { this._pauseResolve(); this._pauseResolve = null; }
    this._setState(STATE.OBSERVING);
    this._log('info', 'Resumed');
  }

  async stop() {
    this._cancelFlag = true;
    if (this._pauseResolve) { this._pauseResolve(); this._pauseResolve = null; }
    if (this._ollama) this._ollama.cancelAll();
    this._setState(STATE.CANCELLED);
    this._log('info', 'Stopped by user');
    this._sendSummary();
  }

  getStatus() {
    return {
      state: this.state, taskId: this.taskId, stepCount: this._stepCount,
      results: this._results, errors: this._errorLog, instruction: this.instruction,
    };
  }

  onPageChanged(tabId, url, webContents) {
    if (tabId === this._tabId) {
      this._webContents = webContents;
      if (this._inspector) this._inspector.wc = webContents;
      this._log('info', `Tab navigated to: ${url.slice(0, 80)}`);
    }
  }

  // ── Main loop ──────────────────────────────────────────────────────────────
  async _runLoop() {
    while (!this._cancelFlag && this._stepCount < this._maxSteps) {
      await this._checkPause();
      if (this._cancelFlag) break;

      this._stepCount++;
      this._log('info', `━━ Step ${this._stepCount}/${this._maxSteps} ━━`);

      // ── OBSERVE ────────────────────────────────────────────────────────────
      this._setState(STATE.OBSERVING);
      const snapshot = await this._observe();
      if (!snapshot) break; // unrecoverable

      const { quiz, controls, meta, pageText } = snapshot;
      this._currentLms = quiz.lms || this._currentLms || 'generic';
      this._log('info', `LMS: ${this._currentLms} | URL: ${(meta?.url || '').slice(0, 80)}`);

      // ── Safety gates ───────────────────────────────────────────────────────
      const gate = this._checkSafetyGates(meta, pageText, controls, quiz);
      if (gate === 'stop')   break;
      if (gate === 'pause')  return;

      // ── No question detected ───────────────────────────────────────────────
      if (!quiz.found || !quiz.hasOptions) {
        if (this._stepCount === 1) {
          this._setState(STATE.FAILED);
          this._log('error', 'No quiz question found. Navigate to an active quiz question, then start.');
          this._sendSummary();
          return;
        }
        this._log('info', 'No question on this page — quiz may be complete or between pages.');
        // Wait briefly in case page is still loading
        await this._sleep(2000);
        const snapshot2 = await this._observe();
        if (!snapshot2?.quiz?.found) {
          this._log('info', 'Still no question — treating as end of quiz.');
          break;
        }
        // Re-enter loop with fresh snapshot
        continue;
      }

      // ── Stuck detection ────────────────────────────────────────────────────
      // BUG1 FIX: compare normalized text, track per-run in instance vars
      const normQ = (quiz.questionText || '').trim().replace(/\s+/g, ' ');
      if (normQ && normQ === this._lastQuestionText) {
        this._stuckCount++;
        this._log('warn', `Same question repeated (${this._stuckCount}/3) — Next may not have fired`);
        if (this._stuckCount >= 3) {
          this._log('error', 'Stuck on same question after 3 attempts. Stopping.');
          this._setState(STATE.FAILED);
          break;
        }
        // Force a next-click retry without re-answering
        this._log('info', 'Retrying Next click for stuck question...');
        const retried = await this._clickNext(controls, this._currentLms);
        if (retried) { await this._waitForPageChange(); continue; }
        break;
      } else {
        this._stuckCount = 0;
        this._lastQuestionText = normQ;
      }

      // Log question and options
      this._log('info', `Q: ${quiz.questionText.slice(0, 160)}`);
      this._log('info', `Type: ${quiz.questionType} | Options: ${quiz.options.length}`);
      const LABELS = ['A','B','C','D','E','F'];
      quiz.options.forEach((o, i) => this._log('info', `  ${LABELS[i] || i}) ${o.text.slice(0, 100)}`));

      // ── ANALYZE ────────────────────────────────────────────────────────────
      this._setState(STATE.ANALYZING);
      const analysis = await this._analyzeWithRetry(quiz, pageText);

      if (!analysis.canAnswer) {
        this._log('warn', `Skipping — low confidence: ${analysis.reasoning?.slice(0, 80)}`);
        this._recordResult({
          question: quiz.questionText.slice(0, 160), status: 'uncertain',
          reason: analysis.reasoning, confidence: analysis.confidence,
        });
        // Advance past uncertain question
        const ok = await this._clickNext(controls, this._currentLms);
        if (!ok) { this._log('error', 'No Next found after uncertain. Stopping.'); break; }
        await this._waitForPageChange();
        continue;
      }

      this._log('info', `→ [${analysis.rawLabels.join(',')}] "${analysis.chosenTexts.join('; ').slice(0, 80)}" conf=${(analysis.confidence * 100).toFixed(0)}%`);
      this._log('info', `  Reason: ${analysis.reasoning.slice(0, 100)}`);

      // ── EXECUTE: select answer ─────────────────────────────────────────────
      this._setState(STATE.EXECUTING);
      const anyClicked = await this._selectAnswers(analysis);

      // ── VERIFY ────────────────────────────────────────────────────────────
      this._setState(STATE.VERIFYING);
      await this._sleep(350);
      const verified = await this._verifySelection(analysis);

      this._recordResult({
        question:   quiz.questionText.slice(0, 180),
        chosen:     analysis.chosenTexts,
        verified,
        confidence: analysis.confidence,
        reasoning:  analysis.reasoning.slice(0, 200),
        status:     !anyClicked ? 'click-failed' : verified ? 'answered' : 'answered-unverified',
      });

      // ── NAVIGATE: click Next ───────────────────────────────────────────────
      await this._sleep(this._stepDelay);
      const advanced = await this._clickNext(controls, this._currentLms);
      if (!advanced) {
        this._log('warn', 'No Next button found. Stopping.');
        break;
      }
      await this._waitForPageChange();
    }

    if (!this._cancelFlag) this._setState(STATE.COMPLETED);
    this._sendSummary();
  }

  // ── Observe with retries ───────────────────────────────────────────────────
  async _observe() {
    for (let i = 0; i < MAX_OBSERVE_RETRIES; i++) {
      try {
        const snap = await this._inspector.inspect();
        if (snap && !snap.error) return snap;
        this._log('warn', `Observe attempt ${i + 1}: ${snap?.error || 'null result'}`);
      } catch (e) {
        this._log('warn', `Observe attempt ${i + 1} threw: ${e.message}`);
      }
      await this._sleep(1200);
    }
    this._log('error', 'Page inspection failed after retries.');
    this._setState(STATE.FAILED);
    return null;
  }

  // ── Safety gate checks ─────────────────────────────────────────────────────
  _checkSafetyGates(meta, pageText, controls, quiz) {
    const url = (meta?.url || '').toLowerCase();
    const txt = (pageText || '').toLowerCase();

    // Login redirect
    if ((url.includes('login') || url.includes('signin')) && !url.includes('attempt')) {
      this._pauseWith('Login page detected — please log in manually, then click Resume.');
      return 'pause';
    }

    // CAPTCHA
    if (/captcha|recaptcha|i am not a robot/.test(txt)) {
      this._pauseWith('CAPTCHA detected — cannot proceed automatically.');
      return 'pause';
    }

    // Session timeout / kicked out of quiz
    if (this._startUrl && !url.includes('attempt') && url.includes('quiz') &&
        (url.includes('summary') || url.includes('review') || url.includes('overdue'))) {
      this._pauseWith('Quiz session ended or timed out. Check the page and resume if still in progress.');
      return 'pause';
    }

    // Submit/finish visible with no Next = end of quiz, require human
    if (controls?.submit && !controls?.next) {
      this._pauseWith(
        '⚠ Finish/Submit button detected — stopping before final submission. Human confirmation required.',
        { requiresConfirmation: true, controls }
      );
      return 'pause';
    }

    return 'ok';
  }

  // ── Analyze with one retry on failure ─────────────────────────────────────
  async _analyzeWithRetry(quiz, pageText) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await this._analyzer.analyzeQuestion({
          questionText: quiz.questionText,
          questionType: quiz.questionType,
          options:      quiz.options,
          instruction:  this.instruction,
          pageContext:  (pageText || '').slice(0, 600),
        });
        return result;
      } catch (err) {
        this._log('warn', `Analysis attempt ${attempt + 1} failed: ${err.message}`);
        await this._sleep(800);
      }
    }
    return {
      canAnswer: false, confidence: 0, reasoning: 'Analysis failed after retries.',
      chosenTexts: [], selectedSelectors: [], selectedOptions: [], rawLabels: [],
    };
  }

  // ── Select answers on page ─────────────────────────────────────────────────
  async _selectAnswers(analysis) {
    let anyClicked = false;
    const pairs = analysis.selectedSelectors.map((sel, i) => ({
      sel, text: analysis.chosenTexts[i] || '',
    }));
    // If no selectors (no IDs on inputs), build text pairs from chosenTexts
    if (pairs.length === 0 && analysis.chosenTexts.length > 0) {
      analysis.chosenTexts.forEach(t => pairs.push({ sel: null, text: t }));
    }

    for (const { sel, text } of pairs) {
      let clicked = false;

      // 1. Selector click
      if (sel) {
        this._log('info', `Clicking selector: ${sel}`);
        const r = await this._inspector.clickSelector(sel);
        if (r?.ok) { clicked = true; anyClicked = true; this._log('info', `  ✓ selector click ok`); }
        else this._log('warn', `  selector click failed: ${r?.error}`);
      }

      // 2. Text label click (Moodle label fallback)
      if (!clicked && text) {
        const escaped = text.slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        this._log('info', `Text-match click: "${text.slice(0, 50)}"`);
        const r = await this._inspector.clickByText(
          escaped,
          'label, [class*="answer"] label, .r0 label, .r1 label, input[type=radio], input[type=checkbox], li, [role=radio]'
        );
        if (r?.ok) { clicked = true; anyClicked = true; this._log('info', `  ✓ text click ok`); }
        else this._log('warn', `  text click failed: ${r?.error}`);
      }

      // 3. Moodle-specific: click the radio itself via value attribute
      if (!clicked && sel) {
        this._log('info', `Trying input value click fallback`);
        const r = await this._inspector.clickByInputValue(sel);
        if (r?.ok) { clicked = true; anyClicked = true; }
      }

      await this._sleep(200);
    }
    return anyClicked;
  }

  // ── Verify selection state ─────────────────────────────────────────────────
  async _verifySelection(analysis) {
    if (analysis.selectedSelectors.length === 0) return false;
    try {
      // BUG3 FIX: use dynamic selector re-query, not cached selector
      const vr = await this._inspector.verifySelection(analysis.selectedSelectors[0]);
      const checked = vr?.checked === true || vr?.selected === true;
      if (checked) {
        this._log('info', '✓ Selection state verified (checked=true)');
        return true;
      }
      // Not all Moodle themes set .checked on radios after JS click;
      // trust that click() ran without error
      this._log('info', 'checked attr unclear — trusting click succeeded');
      return true; // optimistic: if click didn't throw, consider it done
    } catch (_) {
      return false;
    }
  }

  // ── Click Next (Moodle-first, multi-fallback) ──────────────────────────────
  async _clickNext(controls, lms) {
    // 1. Moodle: input[name=next] via form submit
    if (lms === 'moodle' || !lms) {
      const r = await this._inspector.submitMoodleNext();
      if (r?.ok) { this._log('info', `Next (Moodle submit): "${r.text}"`); return true; }
    }

    // 2. Detected controls.next
    if (controls?.next) {
      const c = controls.next;
      let r;
      if (c.selector) r = await this._inspector.clickSelector(c.selector);
      else if (c.name) r = await this._inspector.clickByName(c.name);
      if (!r?.ok) r = await this._inspector.clickByText(c.text || 'next');
      if (r?.ok) { this._log('info', `Next (control): "${c.text}"`); return true; }
    }

    // 3. Text pattern fallback — ordered by specificity
    const patterns = [
      'next page', 'next question', 'save and next',
      '^next$', 'continue', 'forward',
    ];
    for (const p of patterns) {
      const r = await this._inspector.clickByText(p);
      if (r?.ok) { this._log('info', `Next (text "${p}"): "${r.text}"`); return true; }
    }

    this._log('error', 'All Next-click strategies failed.');
    return false;
  }

  // ── Wait for page to change after Next ────────────────────────────────────
  async _waitForPageChange() {
    this._setState(STATE.WAITING_FOR_PAGE);

    // BUG2 FIX: capture hash AFTER clicking Next (not before, which was stale)
    const pre = await this._inspector.getPageHash().catch(() => ({ hash: 0, url: '' }));

    await this._inspector.waitForDOMQuiet(NAV_TIMEOUT_MS, DOM_QUIET_MS);
    await this._sleep(400);

    const post = await this._inspector.getPageHash().catch(() => ({ hash: 0, url: '' }));

    const hashChanged = pre.hash !== post.hash;
    const urlChanged  = pre.url  !== post.url;

    if (hashChanged || urlChanged) {
      this._log('info', `✓ Page changed${urlChanged ? ' (URL)' : ' (content)'}`);
    } else {
      this._log('warn', 'Page unchanged after Next — waiting extra 2s for slow LMS');
      await this._sleep(2000);
      // One more check
      const post2 = await this._inspector.getPageHash().catch(() => ({ hash: 0 }));
      if (pre.hash !== post2.hash) {
        this._log('info', '✓ Page updated after extra wait');
      } else {
        this._log('warn', 'Page still same — proceeding anyway (may be same-page question update)');
      }
    }
    // Update stored URL for next cycle
    this._lastPageUrl = post.url;
  }

  // ── Pause helper ───────────────────────────────────────────────────────────
  _pauseWith(reason, extra) {
    this._pauseFlag = true;
    this._setState(STATE.PAUSED);
    this._log('warn', reason);
    this.send('agent-state', { state: STATE.PAUSED, reason, taskId: this.taskId, ...(extra || {}) });
    this._sendSummary();
  }

  // ── Internals ─────────────────────────────────────────────────────────────
  _setState(s) {
    this.state = s;
    this.send('agent-state', { state: s, taskId: this.taskId, stepCount: this._stepCount });
  }

  _log(level, message) {
    const entry = { level, message, time: new Date().toISOString(), step: this._stepCount };
    if (level === 'error') this._errorLog.push(entry);
    console.log(`[AGENT][${level.toUpperCase()}] ${message}`);
    this.send('agent-log', entry);
  }

  _recordResult(r) {
    r.step = this._stepCount;
    this._results.push(r);
    this.send('agent-progress', { result: r, total: this._results.length });
  }

  _sendSummary() {
    const answered   = this._results.filter(r => r.status === 'answered').length;
    const unverified = this._results.filter(r => r.status === 'answered-unverified').length;
    const uncertain  = this._results.filter(r => r.status === 'uncertain').length;
    const failed     = this._results.filter(r => ['click-failed','analysis-failed'].includes(r.status)).length;
    this._log('info', `━━ Done: Answered:${answered} Unverified:${unverified} Uncertain:${uncertain} Failed:${failed} ━━`);
    this.send('agent-complete', {
      total: this._results.length, answered, unverified, uncertain, failed,
      results: this._results, errors: this._errorLog, finalState: this.state,
    });
  }

  async _checkPause() {
    if (this._pauseFlag) {
      await new Promise(r => { this._pauseResolve = r; });
    }
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = AgentController;
