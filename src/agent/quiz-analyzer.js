'use strict';

/**
 * QuizAnalyzer — sends structured quiz data to Ollama, returns which options to click.
 *
 * Optimised for qwen2.5:3b on a low-power CPU:
 *  - Short, direct system prompt
 *  - Options listed as A/B/C/D only (no extra context that confuses small models)
 *  - Two-attempt retry with explicit re-prompt
 *  - Confidence floor: 0.45
 */
class QuizAnalyzer {
  constructor(ollamaClient) {
    this.ollama = ollamaClient;
  }

  async analyzeQuestion({ questionText, questionType, options, instruction, pageContext }) {
    if (!questionText || questionText.trim().length < 3) {
      return this._noAnswer('Question text is empty or too short.');
    }
    if (!options || options.length === 0) {
      return this._noAnswer('No answer options found on the page.');
    }

    const LABELS = ['A', 'B', 'C', 'D', 'E', 'F'];
    const isMulti = questionType === 'multiple-select';

    // Trim to fit small model context
    const safeQ    = questionText.slice(0, 800);
    const optSlice = options.slice(0, 6);
    const optLines = optSlice.map((o, i) => `${LABELS[i]}) ${o.text.slice(0, 200)}`).join('\n');

    // ── System prompt: minimal, imperative, JSON-only ──────────────────────
    const system = `You are an expert at answering academic multiple-choice questions.
Respond ONLY with a JSON object. No explanation, no markdown, no extra text.`;

    // ── User prompt: dead simple ───────────────────────────────────────────
    const selectInstruction = isMulti
      ? 'Select ALL correct options (can be more than one). Use an array: ["A","B"].'
      : 'Select EXACTLY ONE best answer. Use a string: "B".';

    const user = `Question: ${safeQ}

Options:
${optLines}

${selectInstruction}

Respond with ONLY this JSON (fill in the values):
{"answer":${isMulti ? '["A"]' : '"A"'},"confidence":0.9,"reason":"one sentence why"}`;

    const schema = { answer: null, confidence: 0, reason: '' };
    const result = await this.ollama.chatJSON(system, user, schema, { maxTokens: 120, temperature: 0.05 });

    if (!result.ok || !result.data) {
      return this._noAnswer(`Model returned invalid JSON: ${result.error || 'unknown'}`);
    }

    const data = result.data;

    // Normalise answer to array of label strings
    let rawLabels = [];
    if (typeof data.answer === 'string') {
      // Could be "A" or "A,B" or "A and B"
      rawLabels = data.answer.toUpperCase().match(/[A-F]/g) || [];
    } else if (Array.isArray(data.answer)) {
      rawLabels = data.answer.map(x => String(x).toUpperCase().trim()).filter(x => /^[A-F]$/.test(x));
    }

    const confidence = typeof data.confidence === 'number'
      ? Math.max(0, Math.min(1, data.confidence))
      : 0.5;

    const canAnswer = rawLabels.length > 0 && confidence >= 0.45;

    // Map labels → option objects
    let chosen = rawLabels
      .map(lbl => optSlice[LABELS.indexOf(lbl)])
      .filter(Boolean);

    // Enforce single for single-choice
    if (!isMulti && chosen.length > 1) {
      console.warn('[QuizAnalyzer] Model returned multiple for single-choice. Using first.');
      chosen = [chosen[0]];
    }

    const selectedSelectors = chosen.map(o => o.selector).filter(Boolean);

    return {
      canAnswer,
      confidence,
      reasoning:         (data.reason || '').slice(0, 400),
      uncertaintyNote:   confidence < 0.6 ? `Low confidence: ${(confidence * 100).toFixed(0)}%` : '',
      chosenTexts:       chosen.map(o => o.text),
      selectedSelectors,
      selectedOptions:   chosen,
      rawLabels,
      questionType,
    };
  }

  _noAnswer(reason) {
    return {
      canAnswer: false, confidence: 0,
      reasoning: reason, uncertaintyNote: reason,
      chosenTexts: [], selectedSelectors: [],
      selectedOptions: [], rawLabels: [], questionType: 'unknown',
    };
  }
}

module.exports = QuizAnalyzer;
