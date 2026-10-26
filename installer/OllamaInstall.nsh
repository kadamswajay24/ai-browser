; ═══════════════════════════════════════════════════════════════════════════════
; OllamaInstall.nsh
; Included by electron-builder's NSIS installer via the "include" option.
; Adds Ollama download + model pull as extra install sections after the
; main AI Browser app files are written.
;
; electron-builder injects this via:   nsis.include: "installer/OllamaInstall.nsh"
; ═══════════════════════════════════════════════════════════════════════════════

!define OLLAMA_VERSION  "0.4.7"
!define OLLAMA_MODEL    "qwen2.5:3b"
!define OLLAMA_DL_URL   "https://github.com/ollama/ollama/releases/download/v${OLLAMA_VERSION}/OllamaSetup.exe"

; ── Macro called by electron-builder after its own sections finish ─────────────
!macro customInstall
  ; ── Page: custom install options ────────────────────────────────────────────
  ; electron-builder doesn't support extra sections natively, so we implement
  ; Ollama install as a sequential step inside customInstall.

  ; ── Step 1: Check / install Ollama ──────────────────────────────────────────
  DetailPrint "━━ Step 2/3: Checking Ollama runtime ━━"

  ; Check if ollama.exe is already on PATH
  nsExec::ExecToStack 'cmd /c where ollama 2>nul'
  Pop $R0  ; exit code
  Pop $R1  ; stdout

  ${If} $R0 == 0
    DetailPrint "  Ollama already installed — skipping download."
  ${Else}
    ; Check in default install location
    IfFileExists "$LOCALAPPDATA\Programs\Ollama\ollama.exe" OllamaAlready OllamaDownload

    OllamaDownload:
      DetailPrint "  Downloading Ollama v${OLLAMA_VERSION}..."
      SetOutPath "$TEMP"

      ; Use Electron's bundled PowerShell via inetc or just PowerShell download
      ; We use nsExec + powershell (available on all Windows 10+)
      nsExec::ExecToLog `powershell.exe -NoProfile -NonInteractive -Command \
        "& { $ProgressPreference='SilentlyContinue'; \
             Invoke-WebRequest -Uri '${OLLAMA_DL_URL}' \
             -OutFile '$TEMP\OllamaSetup.exe' \
             -UseBasicParsing }"`
      Pop $R0

      ${If} $R0 != 0
        MessageBox MB_ICONEXCLAMATION|MB_OK \
          "Could not download Ollama automatically (code $R0).$\n$\nPlease install Ollama manually:$\n$\n  1. Go to https://ollama.ai/download$\n  2. Download and run OllamaSetup.exe$\n  3. Open a terminal and run:  ollama pull ${OLLAMA_MODEL}$\n$\nAI Browser will work normally once Ollama is running."
        Goto OllamaDone
      ${EndIf}

      DetailPrint "  Installing Ollama (silent)..."
      nsExec::ExecToLog '"$TEMP\OllamaSetup.exe" /SILENT /NORESTART'
      Pop $R0
      ${If} $R0 == 0
        DetailPrint "  ✓ Ollama installed."
      ${Else}
        DetailPrint "  Ollama installer returned $R0 — may already be installed."
      ${EndIf}

      Delete "$TEMP\OllamaSetup.exe"
      Goto OllamaDone

    OllamaAlready:
      DetailPrint "  Found Ollama at $LOCALAPPDATA\Programs\Ollama\"

    OllamaDone:
  ${EndIf}

  ; ── Step 2: Pull the AI model ─────────────────────────────────────────────
  DetailPrint "━━ Step 3/3: Downloading AI model (${OLLAMA_MODEL}) ━━"
  DetailPrint "  This downloads ~2 GB. Please wait..."
  DetailPrint "  (The installer window may appear unresponsive during download)"

  ; Give Ollama service time to start after install
  Sleep 5000

  ; Check if model already downloaded
  nsExec::ExecToStack 'cmd /c ollama list 2>nul'
  Pop $R0
  Pop $R1

  StrStr $R2 $R1 "${OLLAMA_MODEL}"
  ${If} $R2 != ""
    DetailPrint "  ✓ Model ${OLLAMA_MODEL} already downloaded."
    Goto ModelDone
  ${EndIf}

  ; Try via PATH first, then full path
  nsExec::ExecToLog 'cmd /c ollama pull ${OLLAMA_MODEL}'
  Pop $R0

  ${If} $R0 != 0
    ; Retry with full path
    nsExec::ExecToLog '"$LOCALAPPDATA\Programs\Ollama\ollama.exe" pull ${OLLAMA_MODEL}'
    Pop $R0
  ${EndIf}

  ${If} $R0 == 0
    DetailPrint "  ✓ Model ${OLLAMA_MODEL} ready."
  ${Else}
    MessageBox MB_ICONEXCLAMATION|MB_OK \
      "The AI model could not be downloaded automatically (code $R0).$\n$\nTo download it manually, open a terminal after installation and run:$\n$\n  ollama pull ${OLLAMA_MODEL}$\n$\nThis will download ~2 GB. AI Browser will not work until this is done."
  ${EndIf}

  ModelDone:

  ; ── Write Ollama host to app config ─────────────────────────────────────────
  ; electron-store saves to %APPDATA%\ai-browser\config.json
  ; We pre-create it so the user doesn't need to configure anything
  SetOutPath "$APPDATA\ai-browser"
  FileOpen $R9 "config.json" w
  FileWrite $R9 '{"ollamaHost":"http://127.0.0.1:11434","ollamaModel":"${OLLAMA_MODEL}","stepDelay":1000,"maxSteps":50}'
  FileClose $R9
  DetailPrint "  ✓ AI Browser configured to use Ollama at 127.0.0.1:11434"

!macroend

; ── Cleanup on uninstall ──────────────────────────────────────────────────────
!macro customUnInstall
  ; Remove pre-written config (user's own changes preserved otherwise)
  ; We only delete if the file exactly matches our default
  ; (simple approach: just leave it — user may have customised it)
  DetailPrint "Keeping Ollama and model files (uninstall Ollama separately if needed)."
!macroend
