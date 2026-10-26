# AI Browser

A real Chromium-powered desktop browser with an integrated autonomous AI agent.
Built with Electron + Chromium. Uses your local Ollama (`qwen2.5:3b`) — no paid APIs.

---

## Requirements

| Dependency | Version | Notes |
|---|---|---|
| Windows 10/11 | 64-bit | Primary target |
| Node.js | 18+ | [nodejs.org](https://nodejs.org) |
| npm | 8+ | Bundled with Node |
| Ollama | latest | [ollama.ai](https://ollama.ai) |
| qwen2.5:3b model | — | `ollama pull qwen2.5:3b` |

Recommended hardware: 16 GB RAM, Intel Core i3-1215U or better (matches your machine).

---

## Quick Start

### 1. Install Ollama and the model

```bat
# Install Ollama from https://ollama.ai/download
# Then pull the model:
ollama pull qwen2.5:3b
# Verify it runs:
ollama run qwen2.5:3b "Hello"
```

### 2. Install dependencies

```bat
git clone <this-repo> ai-browser
cd ai-browser
npm install
```

### 3. Run in development mode

```bat
npm run dev
```

### 4. Run the test suite (no Electron needed)

```bat
npm test
```

### 5. Test against the built-in quiz server

In one terminal:
```bat
node tests/quiz-server.js
```

In the AI Browser:
1. Navigate to `http://localhost:7777/quiz`
2. Open the AI sidebar (🤖 button top-right)
3. Paste the instruction below and click **Start**

```
Solve this practice quiz. Read every question, analyze the options, choose the best
answer, select it on the page, move to the next question, and continue until all
questions have been processed. Report any uncertain questions and stop before final
submission.
```

### 6. Build a Windows installer

```bat
npm run build
# Installer appears in dist/
```

---

## Using with your LMS

1. Launch AI Browser: `npm start`
2. Navigate to your LMS login page in the address bar
3. Log in manually (credentials never touch the agent)
4. Navigate to an **authorized practice quiz**
5. Open the AI sidebar with the 🤖 button
6. Enter your instruction and click **▶ Start**

The agent will:
- Read each question and all answer options from the live page
- Send them to your local Ollama model for analysis
- Click the chosen answer on the real page
- Verify the selection was registered
- Click Next and wait for the next question to load
- Repeat until complete or blocked
- **Stop and ask you before any final submission**

---

## Architecture

```
src/
├── main/
│   └── main.js              Electron main process, BrowserView tabs, IPC router
├── preload/
│   ├── preload.js           Secure contextBridge for renderer ↔ main
│   └── tab-preload.js       Minimal sandbox for web content
├── renderer/
│   ├── index.html           Browser UI shell
│   ├── renderer.js          UI logic: tabs, nav bar, sidebar
│   └── styles.css           Dark theme
└── agent/
    ├── agent-controller.js  State machine: IDLE→OBSERVING→ANALYZING→EXECUTING→VERIFYING
    ├── ollama-client.js     HTTP client for Ollama /api/chat
    ├── page-inspector.js    DOM extraction via executeJavaScript
    └── quiz-analyzer.js     Question→structured answer via Ollama
tests/
├── quiz-server.js           Local 5-question quiz for smoke testing
└── test-runner.js           Headless unit tests (no Electron)
```

---

## Agent State Machine

```
IDLE
 └─► OBSERVING      (inspect active tab DOM)
      └─► ANALYZING  (send to Ollama, get structured answer)
           └─► EXECUTING    (click answer on real page)
                └─► VERIFYING    (confirm selection registered)
                     └─► WAITING_FOR_PAGE  (click Next, wait for DOM update)
                          └─► OBSERVING    (loop)

At any point:
  PAUSED       ← user clicked Pause, or login/CAPTCHA detected
  COMPLETED    ← no more questions or max steps reached
  FAILED       ← unrecoverable error (Ollama down, page unreadable)
  CANCELLED    ← user clicked Stop
```

---

## Safety boundaries

| Action | Autonomous | Requires confirmation |
|--------|------------|----------------------|
| Read page content | ✅ | — |
| Select a radio / checkbox | ✅ | — |
| Click Next question | ✅ | — |
| Navigate within quiz | ✅ | — |
| Final submit / finish | ❌ | **Always pauses** |
| Login / credentials | ❌ | User does this manually |
| Any restricted assessment | ❌ | Pauses immediately |
| CAPTCHA detected | ❌ | Pauses immediately |

---

## Settings (AI Sidebar → ⚙ Settings)

| Setting | Default | Description |
|---------|---------|-------------|
| Ollama Host | `http://127.0.0.1:11434` | URL of your Ollama instance |
| Model | `qwen2.5:3b` | Any model installed in Ollama |
| Step delay (ms) | `800` | Pause between steps (increase if LMS is slow) |
| Max steps | `50` | Safety limit on questions per run |

---

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+T` | New tab |
| `Ctrl+W` | Close tab |
| `Ctrl+L` | Focus address bar |
| `Ctrl+R` | Reload |
| `Alt+Left` | Back |
| `Alt+Right` | Forward |

---

## Troubleshooting

**"Cannot reach Ollama"**
- Make sure `ollama serve` is running (it starts automatically on Windows after install)
- Check the host is `http://127.0.0.1:11434` in Settings
- Click **Check Ollama** in the sidebar

**"No quiz found on the active page"**
- Make sure you are on the actual quiz question page, not the course landing page
- Some LMS platforms load quiz content in iframes — the agent inspects the top-level page; navigate directly to the quiz URL

**"Selection verification uncertain"**
- The answer may still be selected; some LMS platforms use custom UI that does not set standard `checked` attributes
- Increase **Step delay** to give the page more time to update

**Agent answers incorrectly**
- `qwen2.5:3b` is a small model; accuracy varies by subject
- Review the reasoning column in the Results panel
- For factual/calculation questions, confidence < 0.7 will be flagged as uncertain and skipped

**Slow performance**
- On i3-1215U, expect ~3–8 seconds per question (DOM extraction + Ollama inference)
- Reduce `max_tokens` by switching to a faster model like `qwen2.5:1.5b` (`ollama pull qwen2.5:1.5b`)

---

## License

MIT — for personal educational use. Check your institution's academic integrity policy
before using any AI assistance on assessed coursework.
