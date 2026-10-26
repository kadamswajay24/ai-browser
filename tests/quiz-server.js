'use strict';

/**
 * Minimal HTTP server serving a multi-question practice quiz.
 * Simulates realistic LMS quiz page structure so the agent can be
 * tested without requiring a live LMS login.
 *
 * Usage:  node tests/quiz-server.js
 * Opens:  http://localhost:7777/quiz
 */

const http = require('http');
const PORT = 7777;

// ── Quiz data ─────────────────────────────────────────────────────────────────
const QUESTIONS = [
  {
    id: 1,
    text: 'What is the primary purpose of the Central Processing Unit (CPU) in a computer?',
    type: 'single',
    options: [
      { id: 'q1a', text: 'Store large amounts of data permanently' },
      { id: 'q1b', text: 'Execute instructions and perform calculations' },
      { id: 'q1c', text: 'Display output to the monitor' },
      { id: 'q1d', text: 'Connect the computer to a network' },
    ],
    correct: 'q1b',
  },
  {
    id: 2,
    text: 'Which data structure operates on a Last-In, First-Out (LIFO) principle?',
    type: 'single',
    options: [
      { id: 'q2a', text: 'Queue' },
      { id: 'q2b', text: 'Linked List' },
      { id: 'q2c', text: 'Stack' },
      { id: 'q2d', text: 'Binary Tree' },
    ],
    correct: 'q2c',
  },
  {
    id: 3,
    text: 'In object-oriented programming, which of the following best describes "encapsulation"?',
    type: 'single',
    options: [
      { id: 'q3a', text: 'The ability of a class to inherit from multiple parent classes' },
      { id: 'q3b', text: 'Bundling data and the methods that operate on that data within a single unit' },
      { id: 'q3c', text: 'Creating multiple methods with the same name but different parameters' },
      { id: 'q3d', text: 'Converting one data type to another automatically' },
    ],
    correct: 'q3b',
  },
  {
    id: 4,
    text: 'What does HTTP stand for?',
    type: 'single',
    options: [
      { id: 'q4a', text: 'HyperText Transfer Protocol' },
      { id: 'q4b', text: 'High-Tech Transmission Process' },
      { id: 'q4c', text: 'Hyperlink and Text Transmission Protocol' },
      { id: 'q4d', text: 'HyperText Translation Protocol' },
    ],
    correct: 'q4a',
  },
  {
    id: 5,
    text: 'Which sorting algorithm has an average time complexity of O(n log n)?',
    type: 'single',
    options: [
      { id: 'q5a', text: 'Bubble Sort' },
      { id: 'q5b', text: 'Insertion Sort' },
      { id: 'q5c', text: 'Merge Sort' },
      { id: 'q5d', text: 'Selection Sort' },
    ],
    correct: 'q5c',
  },
];

// Track per-session state (in a real LMS this is server-side)
const sessions = {};  // sessionId → { questionIndex, answers }

function getSessionId(req) {
  const cookie = req.headers.cookie ?? '';
  const m = cookie.match(/quiz_session=([^;]+)/);
  return m ? m[1] : null;
}

function newSession() {
  const id = Math.random().toString(36).slice(2);
  sessions[id] = { questionIndex: 0, answers: {} };
  return id;
}

function renderQuiz(sessionId, qIdx) {
  const q   = QUESTIONS[qIdx];
  const num = qIdx + 1;
  const total = QUESTIONS.length;

  const optionsHtml = q.options.map(o => `
    <div class="answer-option">
      <input type="radio" id="${o.id}" name="question_${q.id}" value="${o.id}">
      <label for="${o.id}">${o.text}</label>
    </div>`).join('\n');

  const isLast = qIdx === QUESTIONS.length - 1;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>CS101 Practice Quiz — Question ${num}</title>
<style>
  body { font-family: Arial, sans-serif; background: #f5f5f5; margin: 0; padding: 0; }
  .quiz-header { background: #2c3e50; color: white; padding: 12px 24px; display: flex; justify-content: space-between; align-items: center; }
  .quiz-header h1 { margin: 0; font-size: 18px; }
  .progress-info { font-size: 13px; opacity: 0.8; }
  .quiz-body { max-width: 760px; margin: 30px auto; background: white; border-radius: 8px; padding: 32px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
  .question-number { font-size: 12px; color: #7f8c8d; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; }
  .question-text { font-size: 17px; color: #2c3e50; line-height: 1.6; margin-bottom: 24px; font-weight: 500; }
  .answer-option { display: flex; align-items: flex-start; gap: 10px; padding: 12px 16px; margin-bottom: 8px; border: 2px solid #e0e0e0; border-radius: 6px; cursor: pointer; transition: border-color 0.15s, background 0.15s; }
  .answer-option:hover { border-color: #3498db; background: #f0f8ff; }
  .answer-option input[type=radio] { margin-top: 2px; accent-color: #3498db; width: 16px; height: 16px; cursor: pointer; flex-shrink: 0; }
  .answer-option input[type=radio]:checked + label { color: #2980b9; font-weight: 600; }
  .answer-option:has(input:checked) { border-color: #3498db; background: #ebf5fb; }
  label { cursor: pointer; font-size: 15px; color: #2c3e50; line-height: 1.5; }
  .quiz-footer { display: flex; justify-content: space-between; align-items: center; margin-top: 28px; padding-top: 20px; border-top: 1px solid #eee; }
  .btn { padding: 10px 24px; border: none; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; transition: background 0.15s; }
  .btn-next { background: #3498db; color: white; }
  .btn-next:hover { background: #2980b9; }
  .btn-submit { background: #27ae60; color: white; display: none; }
  .btn-submit:hover { background: #229954; }
  .progress-bar-wrap { background: #e0e0e0; height: 6px; border-radius: 3px; margin: 16px 0 0; }
  .progress-bar { background: #3498db; height: 6px; border-radius: 3px; width: ${(num / total * 100).toFixed(0)}%; transition: width 0.3s; }
  .quiz-info { font-size: 13px; color: #7f8c8d; }
</style>
</head>
<body>
<div class="quiz-header">
  <h1>CS101: Intro to Computer Science — Practice Quiz</h1>
  <div class="progress-info">Question ${num} of ${total}</div>
</div>
<div class="quiz-body">
  <div class="question-number">Question ${num} of ${total}</div>
  <div class="question" data-question-id="${q.id}">
    <div class="question-text">${q.text}</div>
    <form id="quiz-form" method="POST" action="/submit">
      <input type="hidden" name="session" value="${sessionId}">
      <input type="hidden" name="qid" value="${q.id}">
      ${optionsHtml}
      <div class="quiz-footer">
        <div class="quiz-info">Select one answer and click Next to continue.</div>
        ${isLast
          ? `<button type="button" class="btn btn-submit" id="btn-submit" onclick="submitQuiz()">Finish Quiz</button>
             <button type="button" class="btn btn-next" id="btn-next" onclick="nextQuestion()">Next Question →</button>`
          : `<button type="button" class="btn btn-next" id="btn-next" onclick="nextQuestion()">Next Question →</button>`}
      </div>
    </form>
  </div>
  <div class="progress-bar-wrap"><div class="progress-bar"></div></div>
</div>
<script>
  // Highlight selected answer visually
  document.querySelectorAll('input[type=radio]').forEach(r => {
    r.addEventListener('change', () => {
      document.querySelectorAll('.answer-option').forEach(o => o.classList.remove('selected'));
      r.closest('.answer-option')?.classList.add('selected');
    });
  });

  function nextQuestion() {
    const sel = document.querySelector('input[type=radio]:checked');
    const qid = document.querySelector('input[name=qid]').value;
    const sid = document.querySelector('input[name=session]').value;
    const answer = sel ? sel.value : '';
    // POST answer, then redirect to next question
    fetch('/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: sid, qid, answer }),
    }).then(r => r.json()).then(d => {
      if (d.next !== undefined) window.location.href = '/quiz?q=' + d.next + '&s=' + sid;
      else window.location.href = '/complete?s=' + sid;
    });
  }

  function submitQuiz() {
    const sel = document.querySelector('input[type=radio]:checked');
    const qid = document.querySelector('input[name=qid]').value;
    const sid = document.querySelector('input[name=session]').value;
    const answer = sel ? sel.value : '';
    fetch('/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: sid, qid, answer }),
    }).then(() => { window.location.href = '/complete?s=' + sid; });
  }

  // Show submit on last question after selection
  ${isLast ? `
  document.querySelectorAll('input[type=radio]').forEach(r => {
    r.addEventListener('change', () => {
      document.getElementById('btn-submit').style.display = 'inline-block';
      document.getElementById('btn-next').style.display = 'none';
    });
  });` : ''}
</script>
</body>
</html>`;
}

function renderComplete(sessionId) {
  const sess = sessions[sessionId] ?? { answers: {} };
  let correct = 0;
  const rows = QUESTIONS.map(q => {
    const ans = sess.answers[q.id];
    const isCorrect = ans === q.correct;
    if (isCorrect) correct++;
    const chosen = q.options.find(o => o.id === ans)?.text ?? '(no answer)';
    const correctText = q.options.find(o => o.id === q.correct)?.text ?? '';
    return `<tr>
      <td style="padding:8px;border-bottom:1px solid #eee">${q.text.slice(0,60)}…</td>
      <td style="padding:8px;border-bottom:1px solid #eee;color:${isCorrect?'#27ae60':'#e74c3c'}">${chosen}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;color:#27ae60">${correctText}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;font-size:18px">${isCorrect?'✅':'❌'}</td>
    </tr>`;
  }).join('');

  const pct = Math.round((correct / QUESTIONS.length) * 100);

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Quiz Complete</title>
<style>body{font-family:Arial,sans-serif;background:#f5f5f5;padding:40px}
.card{max-width:760px;margin:0 auto;background:white;border-radius:8px;padding:32px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
h1{color:#2c3e50}table{width:100%;border-collapse:collapse;margin-top:20px}
th{text-align:left;padding:10px 8px;background:#f8f9fa;font-size:12px;text-transform:uppercase;color:#7f8c8d}
.score{font-size:40px;font-weight:bold;color:#2c3e50;margin:16px 0}
.restart{display:inline-block;margin-top:24px;padding:10px 24px;background:#3498db;color:white;border-radius:6px;text-decoration:none;font-weight:600}
</style></head><body>
<div class="card">
  <h1>Practice Quiz Complete!</h1>
  <div class="score">${correct}/${QUESTIONS.length} &nbsp;<span style="font-size:20px;color:#7f8c8d">(${pct}%)</span></div>
  <p style="color:#7f8c8d">This was a practice quiz. Review the results below and try again to improve your score.</p>
  <table><thead><tr><th>Question</th><th>Your Answer</th><th>Correct Answer</th><th></th></tr></thead>
  <tbody>${rows}</tbody></table>
  <a href="/quiz" class="restart">Try Again</a>
</div></body></html>`;
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ── GET /quiz ──────────────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/quiz') {
    let sid = url.searchParams.get('s') ?? getSessionId(req);
    if (!sid || !sessions[sid]) { sid = newSession(); }

    const qParam = url.searchParams.get('q');
    const qIdx   = qParam !== null ? parseInt(qParam, 10) : sessions[sid].questionIndex;
    sessions[sid].questionIndex = qIdx;

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': `quiz_session=${sid}; Path=/; HttpOnly`,
    });
    res.end(renderQuiz(sid, Math.min(qIdx, QUESTIONS.length - 1)));
    return;
  }

  // ── POST /answer ───────────────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/answer') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const { session: sid, qid, answer } = JSON.parse(body);
        if (sessions[sid]) {
          sessions[sid].answers[parseInt(qid)] = answer;
          const currentIdx = QUESTIONS.findIndex(q => q.id === parseInt(qid));
          const nextIdx    = currentIdx + 1;
          if (nextIdx < QUESTIONS.length) {
            sessions[sid].questionIndex = nextIdx;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, next: nextIdx }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, complete: true }));
          }
        } else {
          res.writeHead(400); res.end(JSON.stringify({ error: 'Unknown session' }));
        }
      } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── GET /complete ──────────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/complete') {
    const sid = url.searchParams.get('s') ?? getSessionId(req);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderComplete(sid));
    return;
  }

  // ── GET / → redirect to /quiz ──────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(302, { Location: '/quiz' });
    res.end();
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n✅ Quiz test server running at http://localhost:${PORT}/quiz`);
  console.log('   Open that URL in the AI Browser to test the agent.\n');
});

process.on('SIGINT', () => { server.close(); process.exit(0); });
