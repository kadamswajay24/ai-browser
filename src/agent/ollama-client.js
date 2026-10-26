'use strict';

const http  = require('http');
const https = require('https');

/**
 * Thin client for the Ollama /api/chat endpoint.
 * Supports single-shot, structured JSON output, streaming, and cancellation.
 */
class OllamaClient {
  constructor({ host = 'http://127.0.0.1:11434', model = 'qwen2.5:3b' } = {}) {
    this.host  = host.replace(/\/$/, '');
    this.model = model;
    this._activeCancelFns = new Set();
  }

  // ── Health check ─────────────────────────────────────────────────────────
  async healthCheck() {
    try {
      const raw  = await this._fetchRaw('GET', '/api/tags', null, 5000);
      const json = JSON.parse(raw);
      const models = (json.models || []).map(function(m) { return m.name; });
      const self = this;
      const modelAvailable = models.some(function(m) { return m.startsWith(self.model); });
      return { ok: true, models: models, modelAvailable: modelAvailable, host: this.host };
    } catch (err) {
      return { ok: false, error: err.message, host: this.host };
    }
  }

  // ── Single-shot chat completion ────────────────────────────────────────────
  async chat(messages, opts) {
    opts = opts || {};
    var maxTokens   = opts.maxTokens   || 1500;
    var temperature = opts.temperature !== undefined ? opts.temperature : 0.1;

    var body = JSON.stringify({
      model:   this.model,
      messages: messages,
      stream:  false,
      options: { num_predict: maxTokens, temperature: temperature },
    });

    var raw  = await this._fetchRaw('POST', '/api/chat', body, 90000);
    var data = JSON.parse(raw);
    return {
      content: (data.message && data.message.content) ? data.message.content : '',
      done:    data.done !== undefined ? data.done : true,
      usage:   data.eval_count || null,
    };
  }

  // ── Structured JSON output (up to 2 retries) ──────────────────────────────
  async chatJSON(systemPrompt, userPrompt, schema, opts) {
    opts = opts || {};
    var messages = [
      { role: 'system', content: systemPrompt + '\n\nYou MUST respond with valid JSON only. No markdown, no code fences, no explanation outside JSON.' },
      { role: 'user',   content: userPrompt },
    ];

    for (var attempt = 0; attempt < 2; attempt++) {
      var result  = await this.chat(messages, { maxTokens: 1200, temperature: 0.05 });
      var content = result.content.trim();

      // Strip possible markdown fences
      var cleaned = content
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/,           '')
        .trim();

      // Sometimes model wraps in single backticks
      if (cleaned.startsWith('`') && cleaned.endsWith('`')) {
        cleaned = cleaned.slice(1, -1).trim();
      }

      var parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch (_) {
        // Try extracting first JSON object from mixed output
        var m = cleaned.match(/\{[\s\S]*\}/);
        if (m) {
          try { parsed = JSON.parse(m[0]); } catch (_2) { parsed = null; }
        }
      }

      if (parsed && this._validateSchema(parsed, schema)) {
        return { ok: true, data: parsed };
      }

      // Reprompt
      messages.push({ role: 'assistant', content: cleaned });
      var requiredKeys = Object.keys(schema).join(', ');
      messages.push({
        role: 'user',
        content: 'Your response was not valid JSON or was missing required keys: ' + requiredKeys + '. Respond ONLY with a valid JSON object containing those keys.',
      });
    }

    return { ok: false, data: null, error: 'Failed to get valid structured JSON after 2 attempts' };
  }

  // ── Streaming — returns an AsyncIterable of token strings ─────────────────
  streamChat(messages) {
    var self = this;
    var body = JSON.stringify({
      model:   self.model,
      messages: messages,
      stream:  true,
      options: { num_predict: 1000, temperature: 0.1 },
    });

    return {
      [Symbol.asyncIterator]: function() {
        var url     = new URL('/api/chat', self.host);
        var lib     = url.protocol === 'https:' ? https : http;
        var buffer  = '';
        var done    = false;
        var chunks  = [];
        var resolve = null;
        var reject  = null;
        var ended   = false;

        var req = lib.request(url, {
          method: 'POST',
          headers: {
            'Content-Type':   'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        }, function(res) {
          res.on('data', function(chunk) {
            buffer += chunk.toString();
            var lines = buffer.split('\n');
            buffer = lines.pop();
            for (var i = 0; i < lines.length; i++) {
              var line = lines[i].trim();
              if (!line) continue;
              try {
                var d = JSON.parse(line);
                if (d.message && d.message.content) {
                  chunks.push(d.message.content);
                  if (resolve) { var r = resolve; resolve = null; r({ value: chunks.shift(), done: false }); }
                }
                if (d.done) { ended = true; if (resolve) { var r2 = resolve; resolve = null; r2({ value: undefined, done: true }); } }
              } catch (_) {}
            }
          });
          res.on('end', function() {
            ended = true;
            if (resolve) { var r = resolve; resolve = null; r({ value: undefined, done: true }); }
          });
          res.on('error', function(err) {
            if (reject) { var rj = reject; reject = null; rj(err); }
          });
        });

        req.on('error', function(err) {
          if (reject) { var rj = reject; reject = null; rj(err); }
        });

        req.write(body);
        req.end();

        return {
          next: function() {
            if (chunks.length > 0) {
              return Promise.resolve({ value: chunks.shift(), done: false });
            }
            if (ended) {
              return Promise.resolve({ value: undefined, done: true });
            }
            return new Promise(function(res2, rej2) { resolve = res2; reject = rej2; });
          },
          return: function() {
            req.destroy();
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
  }

  cancelAll() {
    for (var fn of this._activeCancelFns) fn(new Error('Cancelled'));
    this._activeCancelFns.clear();
  }

  // ── Internal HTTP helper ──────────────────────────────────────────────────
  _fetchRaw(method, path, body, timeoutMs) {
    timeoutMs = timeoutMs || 30000;
    return new Promise(function(resolve, reject) {
      var url  = new URL(path, this.host);
      var lib  = url.protocol === 'https:' ? https : http;
      var opts = {
        method:  method,
        headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
        timeout: timeoutMs,
      };
      var req = lib.request(url, opts, function(res) {
        var chunks = [];
        res.on('data', function(c) { chunks.push(c); });
        res.on('end',  function()  { resolve(Buffer.concat(chunks).toString()); });
        res.on('error', reject);
      });
      req.on('error',   reject);
      req.on('timeout', function() { req.destroy(); reject(new Error('Ollama request timed out after ' + timeoutMs + 'ms')); });
      if (body) req.write(body);
      req.end();
    }.bind(this));
  }

  _validateSchema(obj, schema) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    var keys = Object.keys(schema);
    for (var i = 0; i < keys.length; i++) {
      if (!(keys[i] in obj)) return false;
    }
    return true;
  }
}

module.exports = OllamaClient;
