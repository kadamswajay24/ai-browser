'use strict';

const OllamaClient = require('../src/agent/ollama-client');
const QuizAnalyzer = require('../src/agent/quiz-analyzer');

let passed = 0;
let failed = 0;

function assert(label, condition, detail) {
  if (condition) { console.log(`  ✅  ${label}`); passed++; }
  else           { console.error(`  ❌  ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

async function section(title, fn) {
  console.log(`\n── ${title} ──`);
  try { await fn(); }
  catch (e) { console.error(`  💥 threw: ${e.message}`); failed++; }
}

// ── Standard options used in multiple tests ────────────────────────────────────
const CPU_OPTIONS = [
  { id: 'q1a', text: 'Store large amounts of data permanently',      selector: '#q1a' },
  { id: 'q1b', text: 'Execute instructions and perform calculations', selector: '#q1b' },
  { id: 'q1c', text: 'Display output to the monitor',                 selector: '#q1c' },
  { id: 'q1d', text: 'Connect the computer to a network',             selector: '#q1d' },
];

// Mock ollama that returns the NEW schema: {answer, confidence, reason}
function mockOllama(answer, confidence, canOverride) {
  // canOverride: if false, confidence forces canAnswer=false in analyzer
  return {
    chatJSON: async () => ({
      ok: true,
      data: { answer, confidence: confidence !== undefined ? confidence : 0.9, reason: 'Test reason.' },
    }),
  };
}

async function main() {

  // ── 1. OllamaClient health (live or graceful fail) ──────────────────────────
  await section('OllamaClient: health check', async () => {
    const client = new OllamaClient({ host: 'http://127.0.0.1:11434', model: 'qwen2.5:3b' });
    const h = await client.healthCheck();
    console.log('    health:', JSON.stringify(h));
    assert('returns object',   typeof h === 'object');
    assert('has ok field',     'ok' in h);
    assert('has host field',   'host' in h);
    if (!h.ok) console.log(`    ℹ️  Ollama offline (${h.error}) — skipping live tests`);
  });

  // ── 2. OllamaClient: bad host ────────────────────────────────────────────────
  await section('OllamaClient: unreachable host', async () => {
    const client = new OllamaClient({ host: 'http://127.0.0.1:19999', model: 'qwen2.5:3b' });
    const h = await client.healthCheck();
    assert('ok:false for bad host', h.ok === false);
    assert('error is string',       typeof h.error === 'string');
  });

  // ── 3. Single-choice: model returns letter string ────────────────────────────
  await section('QuizAnalyzer: single-choice — model returns "B"', async () => {
    const analyzer = new QuizAnalyzer(mockOllama('B', 0.95));
    const result = await analyzer.analyzeQuestion({
      questionText: 'What is the primary purpose of the CPU?',
      questionType: 'single-choice',
      options: CPU_OPTIONS,
      instruction: 'Solve quiz.',
    });
    assert('canAnswer true',              result.canAnswer === true,           JSON.stringify(result));
    assert('confidence 0.95',             result.confidence === 0.95);
    assert('chosenTexts is array',        Array.isArray(result.chosenTexts));
    assert('chose option B text',         result.chosenTexts[0]?.includes('Execute'));
    assert('selectedSelectors non-empty', result.selectedSelectors.length > 0);
    assert('selector is #q1b',           result.selectedSelectors[0] === '#q1b');
    assert('rawLabels has B',             result.rawLabels.includes('B'));
  });

  // ── 4. Single-choice: model returns lowercase ────────────────────────────────
  await section('QuizAnalyzer: single-choice — model returns lowercase "b"', async () => {
    const analyzer = new QuizAnalyzer(mockOllama('b', 0.85));
    const result = await analyzer.analyzeQuestion({
      questionText: 'What is the primary purpose of the CPU?',
      questionType: 'single-choice',
      options: CPU_OPTIONS,
      instruction: 'Solve quiz.',
    });
    assert('canAnswer true',     result.canAnswer === true);
    assert('chose option B',     result.chosenTexts[0]?.includes('Execute'));
    assert('selector is #q1b',  result.selectedSelectors[0] === '#q1b');
  });

  // ── 5. Low confidence → canAnswer false ─────────────────────────────────────
  await section('QuizAnalyzer: low confidence → canAnswer false', async () => {
    const analyzer = new QuizAnalyzer(mockOllama('A', 0.3));
    const result = await analyzer.analyzeQuestion({
      questionText: 'Ambiguous question?',
      questionType: 'single-choice',
      options: [{ id:'a1', text:'Option A', selector:'#a1' }, { id:'a2', text:'Option B', selector:'#a2' }],
      instruction: 'test',
    });
    assert('canAnswer false (conf < 0.45)', result.canAnswer === false);
  });

  // ── 6. Empty question guard ──────────────────────────────────────────────────
  await section('QuizAnalyzer: empty question guard', async () => {
    const analyzer = new QuizAnalyzer({});
    const result = await analyzer.analyzeQuestion({ questionText: '', questionType: 'single-choice', options: [], instruction: 'test' });
    assert('canAnswer false',     result.canAnswer === false);
    assert('has reasoning',       result.reasoning.length > 0);
  });

  // ── 7. No options guard ──────────────────────────────────────────────────────
  await section('QuizAnalyzer: no options guard', async () => {
    const analyzer = new QuizAnalyzer({});
    const result = await analyzer.analyzeQuestion({ questionText: 'A question?', questionType: 'single-choice', options: [], instruction: 'test' });
    assert('canAnswer false',     result.canAnswer === false);
  });

  // ── 8. JSON failure ──────────────────────────────────────────────────────────
  await section('QuizAnalyzer: JSON failure handled gracefully', async () => {
    const bad = { chatJSON: async () => ({ ok: false, data: null, error: 'Malformed' }) };
    const analyzer = new QuizAnalyzer(bad);
    const result = await analyzer.analyzeQuestion({ questionText: '2+2?', questionType: 'single-choice',
      options: [{ id:'x1', text:'4', selector:'#x1' }], instruction: 'test' });
    assert('canAnswer false', result.canAnswer === false);
    assert('has reasoning',   result.reasoning.length > 0);
  });

  // ── 9. Multiple-select: array response ───────────────────────────────────────
  await section('QuizAnalyzer: multiple-select — array ["A","C"]', async () => {
    const analyzer = new QuizAnalyzer(mockOllama(['A','C'], 0.88));
    const options = [
      { id:'m1', text:'Alpha', selector:'#m1' },
      { id:'m2', text:'Beta',  selector:'#m2' },
      { id:'m3', text:'Gamma', selector:'#m3' },
      { id:'m4', text:'Delta', selector:'#m4' },
    ];
    const result = await analyzer.analyzeQuestion({
      questionText: 'Which are Greek letters? Select all that apply.',
      questionType: 'multiple-select',
      options,
      instruction: 'test',
    });
    assert('canAnswer true',    result.canAnswer === true,       JSON.stringify(result));
    assert('two chosen',        result.chosenTexts.length === 2, `got: ${result.chosenTexts}`);
    assert('Alpha chosen',      result.chosenTexts.includes('Alpha'));
    assert('Gamma chosen',      result.chosenTexts.includes('Gamma'));
    assert('two selectors',     result.selectedSelectors.length === 2);
  });

  // ── 10. Multiple-select: comma-string response ────────────────────────────────
  await section('QuizAnalyzer: multiple-select — string "A,C"', async () => {
    const analyzer = new QuizAnalyzer(mockOllama('A,C', 0.80));
    const options = [
      { id:'m1', text:'Alpha', selector:'#m1' },
      { id:'m2', text:'Beta',  selector:'#m2' },
      { id:'m3', text:'Gamma', selector:'#m3' },
    ];
    const result = await analyzer.analyzeQuestion({
      questionText: 'Pick Greek letters.', questionType: 'multiple-select', options, instruction: 'test',
    });
    assert('canAnswer true',   result.canAnswer === true);
    assert('two chosen',       result.chosenTexts.length === 2, `got: ${result.chosenTexts}`);
    assert('Alpha chosen',     result.chosenTexts.includes('Alpha'));
    assert('Gamma chosen',     result.chosenTexts.includes('Gamma'));
  });

  // ── 11. Single-choice enforces max 1 even if model returns array ──────────────
  await section('QuizAnalyzer: single-choice enforces exactly 1 selection', async () => {
    const analyzer = new QuizAnalyzer(mockOllama(['A','B'], 0.80));
    const result = await analyzer.analyzeQuestion({
      questionText: 'Pick one.',
      questionType: 'single-choice',
      options: [{ id:'s1', text:'First', selector:'#s1' }, { id:'s2', text:'Second', selector:'#s2' }],
      instruction: 'test',
    });
    assert('only 1 chosen', result.chosenTexts.length === 1, `got: ${result.chosenTexts}`);
  });

  // ── 12. Model returns option index instead of letter (fallback) ───────────────
  await section('QuizAnalyzer: model returns "1" (invalid label) → canAnswer false', async () => {
    const analyzer = new QuizAnalyzer(mockOllama('1', 0.80));
    const result = await analyzer.analyzeQuestion({
      questionText: 'A question?', questionType: 'single-choice',
      options: [{ id:'p1', text:'X', selector:'#p1' }], instruction: 'test',
    });
    // "1" is not a valid A-F label, so rawLabels will be empty → canAnswer false
    assert('invalid label → canAnswer false', result.canAnswer === false);
  });

  // ── 13. Option without selector uses text-click fallback ─────────────────────
  await section('QuizAnalyzer: option without selector (text-click path)', async () => {
    const analyzer = new QuizAnalyzer(mockOllama('B', 0.90));
    const options = [
      { id: null, text: 'Wrong answer',  selector: null },
      { id: null, text: 'Right answer',  selector: null },
    ];
    const result = await analyzer.analyzeQuestion({
      questionText: 'Which is right?', questionType: 'single-choice', options, instruction: 'test',
    });
    assert('canAnswer true',                result.canAnswer === true);
    assert('chose Right answer',            result.chosenTexts[0] === 'Right answer');
    assert('selectedSelectors empty (ok)',  result.selectedSelectors.length === 0);  // no id → agent uses text
  });

  // ── Summary ────────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
