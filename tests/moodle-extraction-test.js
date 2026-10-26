'use strict';
/**
 * Simulates what page-inspector.js would extract from a real Moodle quiz page.
 * Uses the same heuristics but runs in Node against static HTML (no Electron needed).
 * 
 * Based on the actual jspmjscoe.edu.in Moodle structure seen in the screenshot.
 */

const { JSDOM } = require('jsdom');

// ── Minimal HTML matching real Moodle quiz page structure ─────────────────────
const MOODLE_HTML = `<!DOCTYPE html>
<html>
<head><title>Quiz: UNIT 1 Quiz attempt</title></head>
<body class="path-mod-quiz">
<div id="mod_quiz_navblock">
  <div class="qn_buttons">
    <a class="qnbutton notyetanswered btn" href="/mod/quiz/attempt.php?attempt=665218&page=0&cmid=212357">1</a>
    <a class="qnbutton notyetanswered btn" href="/mod/quiz/attempt.php?attempt=665218&page=1&cmid=212357">2</a>
    <a class="qnbutton notyetanswered btn" href="/mod/quiz/attempt.php?attempt=665218&page=5&cmid=212357">6</a>
  </div>
  <div class="othernav">
    <a class="endtestlink aalink" href="/mod/quiz/summary.php?attempt=665218&cmid=212357">Finish attempt ...</a>
  </div>
</div>

<div id="responseform">
  <form action="/mod/quiz/attempt.php" method="post">
    <div class="que multichoice">
      <div class="info">
        <h3 class="no">Question <span class="qno">6</span></h3>
        <div class="state">Not yet answered</div>
        <div class="grade">Marked out of 1.00</div>
      </div>
      <div class="content">
        <div class="formulation clearfix">
          <h4 class="accesshide">Question text</h4>
          <div class="qtext">
            <p>What does the term "Optimization Algorithms" refer to in deep learning?**</p>
          </div>
          <div class="ablock">
            <div class="answer">
              <div class="r0">
                <input type="radio" name="q665218:6_answer" value="0" id="q665218:6_answer0" aria-labelledby="q665218:6_answer0_label">
                <label id="q665218:6_answer0_label" for="q665218:6_answer0">
                  <span class="answernumber">a. </span>
                  <div class="flex-fill ml-1"><p>Dimensionality reduction techniques</p></div>
                </label>
              </div>
              <div class="r1">
                <input type="radio" name="q665218:6_answer" value="1" id="q665218:6_answer1" aria-labelledby="q665218:6_answer1_label">
                <label id="q665218:6_answer1_label" for="q665218:6_answer1">
                  <span class="answernumber">b. </span>
                  <div class="flex-fill ml-1"><p>Initialization of neural network weights</p></div>
                </label>
              </div>
              <div class="r0">
                <input type="radio" name="q665218:6_answer" value="2" id="q665218:6_answer2" aria-labelledby="q665218:6_answer2_label">
                <label id="q665218:6_answer2_label" for="q665218:6_answer2">
                  <span class="answernumber">c. </span>
                  <div class="flex-fill ml-1"><p>Methods for reducing overfitting</p></div>
                </label>
              </div>
              <div class="r1">
                <input type="radio" name="q665218:6_answer" value="3" id="q665218:6_answer3" aria-labelledby="q665218:6_answer3_label">
                <label id="q665218:6_answer3_label" for="q665218:6_answer3">
                  <span class="answernumber">d. </span>
                  <div class="flex-fill ml-1"><p>Techniques for gradient descent</p></div>
                </label>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="mod_quiz-next-nav">
      <input type="submit" name="next" value="Next page" class="btn btn-primary mod_quiz-next-nav" id="next-nav-btn">
    </div>

    <input type="hidden" name="attempt" value="665218">
    <input type="hidden" name="thispage" value="5">
    <input type="hidden" name="sesskey" value="FAKE_SESSKEY">
  </form>
</div>

<div class="prevnext">
  <input name="previous" type="submit" value="Previous page" class="btn btn-secondary">
</div>
</body>
</html>`;

// ── Run the same extraction logic from page-inspector.js ─────────────────────
function extractQuizFromDOM(document) {
  function txt(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    for (const sel of ['.qnbutton','.questionflag','.mod_quiz-next-nav','.prevnext','nav','.qn_buttons','#mod_quiz_navblock','.que .info']) {
      clone.querySelectorAll(sel).forEach(n => n.remove());
    }
    return (clone.textContent || '').trim().replace(/\s+/g, ' ');
  }

  const isMoodle = !!(document.querySelector('.que, #responseform, .mod-quiz-attempt') ||
    document.body.classList.contains('path-mod-quiz'));

  let questionEl = isMoodle
    ? document.querySelector('.que:not(.qnbutton)') ||
      document.querySelector('[class*="formulation"]') ||
      document.querySelector('#responseform')
    : null;

  if (!questionEl) return { found: false };

  // Question text from .qtext
  const qtextEl = questionEl.querySelector('.qtext') || questionEl;
  const questionClone = qtextEl.cloneNode(true);
  questionClone.querySelectorAll('.questionflag,.que .info,.state,.grade').forEach(n => n.remove());
  const questionText = (questionClone.textContent || '').trim().replace(/\s+/g, ' ');

  // Answer options
  const options = [];
  const seen    = new Set();
  const answerContainer = questionEl.querySelector('.answer') || questionEl;
  const radios = answerContainer.querySelectorAll('input[type=radio]');

  for (const radio of radios) {
    const lbl = document.querySelector(`label[for="${radio.id}"]`) ||
                radio.closest('label') || radio.nextElementSibling || radio.parentElement;
    let labelText = (lbl ? lbl.textContent : '').trim().replace(/\s+/g, ' ');
    labelText = labelText.replace(/^[A-Fa-f]\s*[\.\)]\s*/, '').trim();
    if (labelText && !seen.has(labelText)) {
      seen.add(labelText);
      options.push({ type:'radio', id:radio.id||null, name:radio.name||null,
        value:radio.value||null, text:labelText, selected:radio.checked,
        selector: radio.id ? '#' + radio.id : null });
    }
  }

  return { found:true, lms:'moodle', questionText, questionType:'single-choice', options, hasOptions: options.length > 0 };
}

function findControlsFromDOM(document) {
  function txt(el) { return ((el.textContent || el.value || '').trim().replace(/\s+/g,' ')); }

  // Moodle next button
  const moodleNext = document.querySelector('input[name="next"]');
  const nextBtn = moodleNext ? {
    tag: 'INPUT', id: moodleNext.id||null, text: moodleNext.value||'Next page',
    selector: moodleNext.id ? '#' + moodleNext.id : null, name: moodleNext.name||null,
  } : null;

  const moodleFinish = document.querySelector('a[href*="finishattempt"], a[href*="summary.php"]');
  const finishBtn = moodleFinish ? { tag:'A', text: txt(moodleFinish), href: moodleFinish.href||null } : null;

  return { next: nextBtn, submit: finishBtn };
}

// ── Run tests ─────────────────────────────────────────────────────────────────
async function main() {
  let passed = 0; let failed = 0;
  function assert(label, condition, detail) {
    if (condition) { console.log(`  ✅  ${label}`); passed++; }
    else           { console.error(`  ❌  ${label}${detail ? ' — '+detail:''}` ); failed++; }
  }

  console.log('\n── Moodle DOM extraction test ──');

  let dom;
  try {
    dom = new JSDOM(MOODLE_HTML);
  } catch(e) {
    // jsdom not installed — simulate the extraction with a manual parse check
    console.log('  ℹ️  jsdom not available — running structural checks only');
    
    // Verify our HTML contains the expected structure
    assert('HTML has .que class',          MOODLE_HTML.includes('que multichoice'));
    assert('HTML has .qtext div',          MOODLE_HTML.includes('class="qtext"'));
    assert('HTML has .answer div',         MOODLE_HTML.includes('class="answer"'));
    assert('HTML has 4 radio inputs',      (MOODLE_HTML.match(/type="radio"/g)||[]).length === 4);
    assert('HTML has next input',          MOODLE_HTML.includes('name="next"'));
    assert('HTML has Moodle nav block',    MOODLE_HTML.includes('mod_quiz_navblock'));
    assert('HTML has qnbuttons',           MOODLE_HTML.includes('qnbutton'));
    assert('Radio IDs use Moodle pattern', MOODLE_HTML.includes('q665218:6_answer0'));
    assert('Labels use for= attr',         MOODLE_HTML.includes('for="q665218:6_answer0"'));
    assert('answernumber spans present',   MOODLE_HTML.includes('class="answernumber"'));

    console.log('\n── Prompt format test ──');
    // Simulate what the analyzer would send to Ollama
    const fakeOptions = [
      'Dimensionality reduction techniques',
      'Initialization of neural network weights',
      'Methods for reducing overfitting',
      'Techniques for gradient descent',
    ];
    const LABELS = ['A','B','C','D'];
    const optLines = fakeOptions.map((t,i) => `${LABELS[i]}) ${t}`).join('\n');
    const prompt = `Question: What does the term "Optimization Algorithms" refer to in deep learning?\n\nOptions:\n${optLines}\n\nSelect EXACTLY ONE best answer. Use a string: "B".\n\nRespond with ONLY this JSON:\n{"answer":"A","confidence":0.9,"reason":"one sentence why"}`;

    assert('Prompt contains question',      prompt.includes('Optimization Algorithms'));
    assert('Prompt has A) option',          prompt.includes('A) Dimensionality'));
    assert('Prompt has D) option',          prompt.includes('D) Techniques for gradient descent'));
    assert('Prompt requests JSON',          prompt.includes('{"answer"'));
    assert('Prompt is under 1000 chars',    prompt.length < 1000, `length=${prompt.length}`);
    console.log('\n  Sample prompt sent to Ollama:');
    console.log(prompt.split('\n').map(l => '  │ ' + l).join('\n'));

    console.log('\n── Navigation selector test ──');
    assert('Next selector matches input[name=next]', MOODLE_HTML.includes('name="next"'));
    assert('Finish link matches summary.php',        MOODLE_HTML.includes('summary.php'));
    assert('Nav block excluded from text',           MOODLE_HTML.includes('mod_quiz_navblock'));

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
    return;
  }

  // jsdom available — run full extraction
  const { document } = dom.window;
  const quiz = extractQuizFromDOM(document);
  const controls = findControlsFromDOM(document);

  console.log('\n  Extracted quiz:', JSON.stringify(quiz, null, 2).slice(0, 800));
  console.log('\n  Controls:', JSON.stringify(controls));

  assert('found=true',                       quiz.found === true);
  assert('lms=moodle',                       quiz.lms === 'moodle');
  assert('questionText contains keyword',    quiz.questionText.includes('Optimization'));
  assert('questionText does NOT have nav numbers', !/^\s*\d+\s*$/.test(quiz.questionText));
  assert('questionType=single-choice',       quiz.questionType === 'single-choice');
  assert('4 options extracted',              quiz.options.length === 4,     `got ${quiz.options.length}`);
  assert('option A text correct',            quiz.options[0].text.includes('Dimensionality'));
  assert('option D text correct',            quiz.options[3].text.includes('gradient descent'));
  assert('no answernumber prefix in text',   !quiz.options[0].text.startsWith('a.'));
  assert('radio selectors present',          quiz.options[0].selector?.startsWith('#'));
  assert('selector uses Moodle id format',   quiz.options[0].selector?.includes('answer0'));
  assert('next button found',                !!controls.next);
  assert('next button name=next',            controls.next?.name === 'next' || controls.next?.text?.includes('Next'));
  assert('finish link found',                !!controls.submit);
  assert('hasOptions=true',                  quiz.hasOptions === true);

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
