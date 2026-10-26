'use strict';

/**
 * PageInspector — LMS-aware DOM extraction.
 * All scripts run in main-process authored JS via executeJavaScript.
 * Page content is never used as code — only as data.
 *
 * Priority LMS support: Moodle (jspm, lms.jspmjscoe.edu.in)
 * Also supports: Canvas, Blackboard, D2L Brightspace, generic quiz pages.
 */
class PageInspector {
  constructor(webContents) {
    this.wc = webContents;
  }

  async _exec(fn, ...args) {
    const src = `(${fn.toString()})(${args.map(a => JSON.stringify(a)).join(',')})`;
    try {
      return await this.wc.executeJavaScript(src, true);
    } catch (err) {
      return { error: err.message };
    }
  }

  async inspect() {
    const [meta, quiz, controls, pageText] = await Promise.all([
      this.getPageMeta(),
      this.extractQuiz(),
      this.findControls(),
      this.getVisibleText(),
    ]);
    return { meta, quiz, controls, pageText, timestamp: Date.now() };
  }

  async getPageMeta() {
    return this._exec(() => ({
      url:        window.location.href,
      title:      document.title,
      readyState: document.readyState,
    }));
  }

  // ── Quiz extraction ────────────────────────────────────────────────────────
  async extractQuiz() {
    return this._exec(() => {
      function txt(el) {
        if (!el) return '';
        // Clone and remove hidden navigation/sidebar elements before reading text
        const clone = el.cloneNode(true);
        // Remove Moodle quiz nav block and other sidebar noise
        for (const sel of [
          '.qnbutton', '.questionflag', '.mod_quiz-next-nav',
          '.prevnext', '[class*="quiznavbutton"]', '.breadcrumb',
          'nav', '.qn_buttons', '#mod_quiz_navblock', '.block_fake',
          '.que .info', // question metadata block in Moodle
        ]) {
          clone.querySelectorAll(sel).forEach(n => n.remove());
        }
        return (clone.innerText || clone.textContent || '').trim().replace(/\s+/g, ' ');
      }

      // ── 1. Detect LMS type ─────────────────────────────────────────────────
      const isMoodle = !!(
        document.querySelector('.que, #responseform, .mod-quiz-attempt') ||
        document.body.classList.contains('path-mod-quiz') ||
        window.location.href.includes('/mod/quiz/') ||
        window.location.href.includes('attempt.php')
      );
      const isCanvas = !!(document.querySelector('#questions .question') || window.location.href.includes('/quizzes/'));
      const isD2L    = !!(document.querySelector('[class*="d2l-question"]'));

      // ── 2. Find question container ─────────────────────────────────────────
      let questionEl = null;

      if (isMoodle) {
        // Moodle: single question per page uses .que, or formulation div
        questionEl =
          document.querySelector('.que:not(.qnbutton)') ||
          document.querySelector('[class*="formulation"]') ||
          document.querySelector('.content .formulation') ||
          document.querySelector('#responseform');
      } else if (isCanvas) {
        questionEl =
          document.querySelector('.question_holder') ||
          document.querySelector('[data-question-id]');
      } else if (isD2L) {
        questionEl = document.querySelector('[class*="d2l-question"]');
      }

      // Generic fallback: find element that contains radios/checkboxes
      if (!questionEl) {
        const inputs = document.querySelectorAll('input[type=radio], input[type=checkbox]');
        if (inputs.length > 0) {
          questionEl = inputs[0].closest('fieldset, form, section, article, [class*="question"], [class*="quiz"], div') ||
                       document.body;
        }
      }

      if (!questionEl) return { found: false, lms: isMoodle ? 'moodle' : isCanvas ? 'canvas' : 'unknown' };

      // ── 3. Extract question text ───────────────────────────────────────────
      // In Moodle, the question text is in .qtext, not the whole .que
      let questionTextEl =
        questionEl.querySelector('.qtext') ||         // Moodle
        questionEl.querySelector('.question_text') || // Canvas
        questionEl.querySelector('[class*="qtext"]') ||
        questionEl.querySelector('p') ||
        questionEl;

      // Make a clean copy stripping nav/meta noise
      const questionClone = questionTextEl.cloneNode(true);
      questionClone.querySelectorAll('.questionflag, .que .info, .state, .grade').forEach(n => n.remove());
      const questionText = (questionClone.innerText || questionClone.textContent || '').trim().replace(/\s+/g, ' ');

      // ── 4. Find answer inputs ──────────────────────────────────────────────
      const options = [];
      const seen    = new Set();

      // Moodle specific: answers are in .answer > div.r0/r1 or .answer label
      const answerContainer =
        questionEl.querySelector('.answer') ||     // Moodle standard
        questionEl.querySelector('.answeroptions') ||
        questionEl;

      // Try radio inputs first
      const radios = answerContainer.querySelectorAll('input[type=radio]');
      for (const radio of radios) {
        // Find label: for= match, or wrapping label, or next sibling
        const lbl =
          document.querySelector(`label[for="${CSS.escape(radio.id)}"]`) ||
          radio.closest('label') ||
          radio.nextElementSibling ||
          radio.parentElement;

        let labelText = (lbl?.innerText || lbl?.textContent || '').trim().replace(/\s+/g, ' ');
        // Remove leading letter prefix like "a. " "b. " "A) " from Moodle
        labelText = labelText.replace(/^[A-Fa-f]\s*[\.\)]\s*/, '').trim();

        if (labelText && !seen.has(labelText) && labelText.length > 0 && labelText.length < 1000) {
          seen.add(labelText);
          options.push({
            type:     'radio',
            id:       radio.id || null,
            name:     radio.name || null,
            value:    radio.value || null,
            text:     labelText,
            selected: radio.checked,
            selector: radio.id ? '#' + CSS.escape(radio.id) : null,
          });
        }
      }

      // Try checkboxes
      if (options.length === 0) {
        const checks = answerContainer.querySelectorAll('input[type=checkbox]');
        for (const cb of checks) {
          const lbl =
            document.querySelector(`label[for="${CSS.escape(cb.id)}"]`) ||
            cb.closest('label') ||
            cb.nextElementSibling ||
            cb.parentElement;
          let labelText = (lbl?.innerText || lbl?.textContent || '').trim().replace(/\s+/g, ' ');
          labelText = labelText.replace(/^[A-Fa-f]\s*[\.\)]\s*/, '').trim();
          if (labelText && !seen.has(labelText)) {
            seen.add(labelText);
            options.push({
              type:     'checkbox',
              id:       cb.id || null,
              name:     cb.name || null,
              value:    cb.value || null,
              text:     labelText,
              selected: cb.checked,
              selector: cb.id ? '#' + CSS.escape(cb.id) : null,
            });
          }
        }
      }

      // Clickable div/li options (modern LMS or custom themes)
      if (options.length === 0) {
        const clickSels = [
          '[class*="answer"] label', '[class*="choice"] label',
          '[role="radio"]', '[role="checkbox"]',
          'li[data-value]', '.option',
        ];
        for (const sel of clickSels) {
          for (const el of questionEl.querySelectorAll(sel)) {
            const t = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ')
                        .replace(/^[A-Fa-f]\s*[\.\)]\s*/, '').trim();
            if (t && !seen.has(t) && t.length < 500) {
              seen.add(t);
              options.push({
                type: 'clickable', id: el.id || null, text: t,
                selected: el.getAttribute('aria-selected') === 'true' || el.classList.contains('selected'),
                selector: el.id ? '#' + CSS.escape(el.id) : null,
                ariaRole: el.getAttribute('role') || null,
              });
            }
          }
          if (options.length > 0) break;
        }
      }

      // ── 5. Question type ───────────────────────────────────────────────────
      const hasCheckbox = answerContainer.querySelectorAll('input[type=checkbox]').length > 0;
      const questionType = hasCheckbox ? 'multiple-select' :
                           options.some(o => o.type === 'radio') ? 'single-choice' :
                           options.length > 0 ? 'clickable-choice' : 'unknown';

      // ── 6. Question number / progress ──────────────────────────────────────
      const infoEl = questionEl.querySelector('.info, .que-info, .qno, h2, .question-number');
      const progressText = (infoEl?.innerText || '').trim().replace(/\s+/g, ' ');

      return {
        found:        true,
        lms:          isMoodle ? 'moodle' : isCanvas ? 'canvas' : isD2L ? 'd2l' : 'generic',
        questionText,
        questionType,
        options,
        progressText,
        hasOptions:   options.length > 0,
        containerTag: questionEl.tagName,
        containerId:  questionEl.id || null,
      };
    });
  }

  // ── Find navigation controls ───────────────────────────────────────────────
  async findControls() {
    return this._exec(() => {
      function txt(el) {
        return ((el.innerText || el.value || el.getAttribute('aria-label') || el.textContent || '').trim()
                .replace(/\s+/g, ' '));
      }

      function findBtn(patterns, exclude) {
        const re      = new RegExp(patterns.join('|'), 'i');
        const exclRe  = exclude ? new RegExp(exclude, 'i') : null;
        const scope   = 'button, input[type=button], input[type=submit], a[role=button], a.btn, [class*="btn"]';
        for (const el of document.querySelectorAll(scope)) {
          const t = txt(el);
          if (!re.test(t)) continue;
          if (exclRe && exclRe.test(t)) continue;
          // Skip invisible / disabled / quiz nav number buttons
          if (el.disabled) continue;
          if (el.offsetParent === null && !el.closest('form')) continue;
          // Skip Moodle quiz nav number buttons (they're just question jump links)
          if (/^\s*\d+\s*$/.test(t)) continue;
          if (el.closest('#mod_quiz_navblock, .qnbutton, .qn_buttons')) continue;
          return {
            tag:      el.tagName,
            id:       el.id || null,
            text:     t,
            type:     el.type || null,
            selector: el.id ? '#' + CSS.escape(el.id) : null,
            disabled: el.disabled || false,
            href:     el.tagName === 'A' ? (el.href || null) : null,
          };
        }
        return null;
      }

      // Moodle-specific: mod-quiz-next-nav input
      const moodleNext = document.querySelector('input[name="next"], [class*="mod_quiz-next"], .mod-quiz-next-nav input');
      const moodleNextBtn = moodleNext ? {
        tag: moodleNext.tagName, id: moodleNext.id || null,
        text: moodleNext.value || 'Next page',
        type: moodleNext.type || null,
        selector: moodleNext.id ? '#' + CSS.escape(moodleNext.id) : null,
        name: moodleNext.name || null,
        disabled: moodleNext.disabled || false,
      } : null;

      // Moodle finish attempt
      const moodleFinish = document.querySelector('input[name="finishattempt"], a[href*="finishattempt"], button[id*="finish"]');
      const moodleFinishBtn = moodleFinish ? {
        tag: moodleFinish.tagName, id: moodleFinish.id || null,
        text: moodleFinish.value || moodleFinish.innerText || 'Finish attempt',
        selector: moodleFinish.id ? '#' + CSS.escape(moodleFinish.id) : null,
        href: moodleFinish.href || null,
      } : null;

      return {
        next:     moodleNextBtn || findBtn(['next page', 'next question', 'next', 'continue', 'forward'], 'previous|back|finish|submit'),
        previous: findBtn(['previous page', 'previous question', 'previous', 'back', 'prev']),
        submit:   moodleFinishBtn || findBtn(['finish attempt', 'submit quiz', 'submit all', 'finish quiz', 'end test']),
        save:     findBtn(['save and next', 'save response', 'save answer']),
      };
    });
  }

  async getVisibleText() {
    return this._exec(() => {
      // Exclude nav/sidebar noise for cleaner context
      const skip = new Set();
      for (const sel of ['#mod_quiz_navblock', '.qn_buttons', 'nav', '.breadcrumb', 'footer', 'header']) {
        document.querySelectorAll(sel).forEach(el => skip.add(el));
      }
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          let p = node.parentElement;
          while (p) {
            if (skip.has(p)) return NodeFilter.FILTER_REJECT;
            p = p.parentElement;
          }
          try {
            const targetEl = node.parentElement || document.body;
            if (!targetEl) return NodeFilter.FILTER_REJECT;
            const style = window.getComputedStyle(targetEl);
            if (style && (style.display === 'none' || style.visibility === 'hidden')) return NodeFilter.FILTER_REJECT;
          } catch (_) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      const lines = [];
      let node;
      while ((node = walker.nextNode())) {
        const t = node.textContent.trim();
        if (t.length > 2) lines.push(t);
      }
      return lines.join(' ').replace(/\s+/g, ' ').slice(0, 4000);
    });
  }

  // ── Click by CSS selector ──────────────────────────────────────────────────
  async clickSelector(selector) {
    return this._exec((sel) => {
      const el = document.querySelector(sel);
      if (!el) return { ok: false, error: 'Not found: ' + sel };
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Fire full event sequence for SPA frameworks
      ['mousedown','mouseup','click'].forEach(type => {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
      });
      el.click();
      // For radio/checkbox also set checked explicitly and fire change
      if (el.type === 'radio' || el.type === 'checkbox') {
        el.checked = true;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input',  { bubbles: true }));
      }
      return { ok: true, tag: el.tagName, text: (el.innerText || el.value || '').trim().slice(0, 100) };
    }, selector);
  }

  // ── Click by input name=value (Moodle navigation inputs) ──────────────────
  async clickByName(name) {
    return this._exec((n) => {
      const el = document.querySelector(`input[name="${n}"], button[name="${n}"]`);
      if (!el) return { ok: false, error: 'No element with name: ' + n };
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.click();
      return { ok: true, tag: el.tagName, value: el.value || '' };
    }, name);
  }

  // ── Click by text pattern ──────────────────────────────────────────────────
  async clickByText(pattern, scope) {
    scope = scope || 'button, input[type=button], input[type=submit], a, [role=button]';
    return this._exec((pat, sc) => {
      const re = new RegExp(pat, 'i');
      for (const el of document.querySelectorAll(sc)) {
        const t = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
        // Skip quiz nav number buttons
        if (/^\s*\d+\s*$/.test(t)) continue;
        if (el.closest && el.closest('#mod_quiz_navblock, .qn_buttons')) continue;
        if (re.test(t) && !el.disabled && el.offsetParent !== null) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.click();
          el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return { ok: true, text: t };
        }
      }
      // Also try submit inputs
      for (const el of document.querySelectorAll('input[type=submit], input[type=button]')) {
        const t = (el.value || '').trim();
        if (/^\s*\d+\s*$/.test(t)) continue;
        if (re.test(t) && !el.disabled) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.click();
          return { ok: true, text: t };
        }
      }
      return { ok: false, error: 'No element matching "' + pat + '"' };
    }, pattern, scope);
  }

  // ── Submit Moodle form (click next-page input) ─────────────────────────────
  async submitMoodleNext() {
    return this._exec(() => {
      // Moodle quiz uses a form with input[name=next] or input.mod-quiz-next-nav
      const candidates = [
        document.querySelector('input[name="next"]'),
        document.querySelector('[class*="mod_quiz-next-nav"] input[type=submit]'),
        document.querySelector('[class*="mod_quiz-next-nav"] button'),
        document.querySelector('input[value="Next page"]'),
        document.querySelector('input[value*="Next"]'),
        document.querySelector('button[class*="next"]'),
      ];
      for (const el of candidates) {
        if (el && !el.disabled) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.click();
          return { ok: true, text: el.value || el.innerText || 'next' };
        }
      }
      return { ok: false, error: 'No Moodle next button found' };
    });
  }

  // ── Verify selection ───────────────────────────────────────────────────────
  async verifySelection(selector) {
    return this._exec((sel) => {
      const el = document.querySelector(sel);
      if (!el) return { found: false };
      return {
        found:    true,
        checked:  el.checked !== undefined ? el.checked : null,
        selected: el.getAttribute('aria-selected') === 'true' || el.classList.contains('selected'),
        value:    el.value || null,
      };
    }, selector);
  }

  // ── Wait for DOM to settle ─────────────────────────────────────────────────
  async waitForDOMQuiet(timeoutMs, quietMs) {
    timeoutMs = timeoutMs || 6000;
    quietMs   = quietMs   || 600;
    return this._exec((timeout, quiet) => {
      return new Promise((resolve) => {
        let timer;
        const reset = () => {
          clearTimeout(timer);
          timer = setTimeout(() => { obs.disconnect(); resolve({ settled: true }); }, quiet);
        };
        const obs = new MutationObserver(reset);
        obs.observe(document.body, { childList: true, subtree: true, attributes: true });
        reset(); // start timer immediately
        setTimeout(() => { obs.disconnect(); resolve({ settled: false, timeout: true }); }, timeout);
      });
    }, timeoutMs, quietMs);
  }

  // ── Page hash for change detection ────────────────────────────────────────
  async getPageHash() {
    return this._exec(() => {
      const t = document.body.innerText || '';
      let h = 0;
      for (let i = 0; i < Math.min(t.length, 3000); i++) {
        h = (Math.imul(31, h) + t.charCodeAt(i)) | 0;
      }
      return { hash: h, length: t.length, url: window.location.href };
    });
  }

  // ── Click radio by its value attribute (Moodle fallback) ─────────────────
  async clickByInputValue(valueOrSelector) {
    return this._exec((v) => {
      // v might be "#q665218:6_answer2" — extract the value="2" from it, or try direct
      // First try as selector
      let el = null;
      try { el = document.querySelector(v); } catch(_) {}
      // Fallback: find radio with matching value
      if (!el) {
        const val = v.replace(/.*answer/, '');
        el = document.querySelector(`input[type=radio][value="${val}"]`) ||
             document.querySelector(`input[type=checkbox][value="${val}"]`);
      }
      if (!el) return { ok: false, error: 'No input found for: ' + v };
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.checked = true;
      el.click();
      ['change','input'].forEach(t => el.dispatchEvent(new Event(t, { bubbles: true })));
      return { ok: true, value: el.value, id: el.id };
    }, valueOrSelector);
  }

  async scrollTo(selector) {
    return this._exec((sel) => {
      const el = document.querySelector(sel);
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); return { ok: true }; }
      return { ok: false };
    }, selector);
  }
}

module.exports = PageInspector;
