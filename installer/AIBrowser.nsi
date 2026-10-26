; ═══════════════════════════════════════════════════════════════════════════════
; AI Browser — All-in-One NSIS Installer
; Installs: AI Browser (Electron app) + Ollama + qwen2.5:3b model
;
; Build requirements (on Windows):
;   - NSIS 3.x  https://nsis.sourceforge.io/
;   - nsisunz   plugin (for zip extraction)
;   - InetC     plugin (for HTTP downloads)
;   - Run:  makensis AIBrowser.nsi
;
; The output is a single AIBrowserSetup.exe the end-user runs.
; ═══════════════════════════════════════════════════════════════════════════════

!define APP_NAME        "AI Browser"
!define APP_VERSION     "1.0.0"
!define APP_PUBLISHER   "AI Browser"
!define APP_URL         "https://github.com/your-repo/ai-browser"
!define APP_EXE         "AI Browser.exe"
!define OLLAMA_VERSION  "0.4.7"
!define OLLAMA_MODEL    "qwen2.5:3b"
!define REGKEY          "Software\AIBrowser"
!define UNINSTKEY       "Software\Microsoft\Windows\CurrentVersion\Uninstall\AIBrowser"

; ── Compression ───────────────────────────────────────────────────────────────
SetCompressor /SOLID lzma
SetCompressorDictSize 64

; ── Metadata ──────────────────────────────────────────────────────────────────
Name            "${APP_NAME} ${APP_VERSION}"
OutFile         "AIBrowserSetup.exe"
InstallDir      "$PROGRAMFILES64\AI Browser"
InstallDirRegKey HKLM "${REGKEY}" "InstallDir"
RequestExecutionLevel admin
ShowInstDetails show
ShowUnInstDetails show

; ── Modern UI ─────────────────────────────────────────────────────────────────
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "WinVer.nsh"

!define MUI_ABORTWARNING
!define MUI_ICON        "..\assets\icon.ico"
!define MUI_UNICON      "..\assets\icon.ico"
!define MUI_WELCOMEPAGE_TITLE "Welcome to AI Browser Setup"
!define MUI_WELCOMEPAGE_TEXT  "This wizard will install AI Browser and all required components:$\n$\n  • AI Browser (Chromium-powered desktop browser)$\n  • Ollama (local AI runtime)$\n  • qwen2.5:3b AI model (~2 GB download)$\n$\nA working internet connection is required for the first install.$\n$\nClick Next to continue."
!define MUI_FINISHPAGE_RUN         "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT    "Launch AI Browser now"
!define MUI_FINISHPAGE_SHOWREADME  ""

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE     "..\LICENSE.txt"
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; ── Sections ──────────────────────────────────────────────────────────────────

; Core app (required)
Section "AI Browser" SecApp
  SectionIn RO   ; cannot deselect

  SetOutPath "$INSTDIR"
  SetOverwrite on

  ; Extract the bundled Electron app (packed by electron-builder beforehand)
  File /r "..\dist\win-unpacked\*.*"

  ; Start Menu shortcut
  CreateDirectory "$SMPROGRAMS\AI Browser"
  CreateShortcut  "$SMPROGRAMS\AI Browser\AI Browser.lnk" \
                  "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
  CreateShortcut  "$DESKTOP\AI Browser.lnk" \
                  "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0

  ; Registry: install dir + uninstaller info
  WriteRegStr   HKLM "${REGKEY}"    "InstallDir"    "$INSTDIR"
  WriteRegStr   HKLM "${REGKEY}"    "Version"       "${APP_VERSION}"
  WriteRegStr   HKLM "${UNINSTKEY}" "DisplayName"   "${APP_NAME}"
  WriteRegStr   HKLM "${UNINSTKEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr   HKLM "${UNINSTKEY}" "Publisher"     "${APP_PUBLISHER}"
  WriteRegStr   HKLM "${UNINSTKEY}" "URLInfoAbout"  "${APP_URL}"
  WriteRegStr   HKLM "${UNINSTKEY}" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr   HKLM "${UNINSTKEY}" "DisplayIcon"   "$INSTDIR\${APP_EXE}"
  WriteRegDWORD HKLM "${UNINSTKEY}" "NoModify"      1
  WriteRegDWORD HKLM "${UNINSTKEY}" "NoRepair"      1

  WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd

; Ollama runtime
Section "Ollama (Local AI Runtime)" SecOllama
  SectionIn 1   ; selected by default

  ; Check if Ollama is already installed
  nsExec::ExecToStack 'cmd /c where ollama 2>nul'
  Pop $0
  ${If} $0 == 0
    DetailPrint "Ollama already installed — skipping download"
    Goto OllamaDone
  ${EndIf}

  DetailPrint "Downloading Ollama ${OLLAMA_VERSION}..."
  SetOutPath "$TEMP\AIBrowserSetup"

  InetC::get /CAPTION "Downloading Ollama..." \
    /BANNER "Downloading Ollama runtime (~200 MB)..." \
    "https://github.com/ollama/ollama/releases/download/v${OLLAMA_VERSION}/OllamaSetup.exe" \
    "$TEMP\AIBrowserSetup\OllamaSetup.exe" \
    /END

  Pop $0
  ${If} $0 != "OK"
    MessageBox MB_ICONEXCLAMATION "Failed to download Ollama: $0$\n$\nPlease install manually from https://ollama.ai/download and re-run this installer."
    Goto OllamaDone
  ${EndIf}

  DetailPrint "Installing Ollama silently..."
  nsExec::ExecToLog '"$TEMP\AIBrowserSetup\OllamaSetup.exe" /SILENT /NORESTART'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION "Ollama installer returned code $0. Please check if it installed correctly."
  ${Else}
    DetailPrint "Ollama installed successfully."
  ${EndIf}

  Delete "$TEMP\AIBrowserSetup\OllamaSetup.exe"

  OllamaDone:
SectionEnd

; AI Model download
Section "qwen2.5:3b AI Model (~2 GB)" SecModel
  SectionIn 1   ; selected by default

  ; Wait for Ollama service to be available (it auto-starts after install)
  DetailPrint "Waiting for Ollama service to start..."
  Sleep 3000

  ; Check if model already exists
  nsExec::ExecToStack 'cmd /c ollama list 2>nul'
  Pop $0
  Pop $1
  ${If} $1 != ""
    StrStr $2 $1 "qwen2.5:3b"
    ${If} $2 != ""
      DetailPrint "Model qwen2.5:3b already downloaded — skipping"
      Goto ModelDone
    ${EndIf}
  ${EndIf}

  DetailPrint "Pulling qwen2.5:3b model (~2 GB). This may take several minutes..."
  DetailPrint "You can see progress in the log below."

  ; Pull the model — this runs synchronously (can take 5-20 min on slow connection)
  nsExec::ExecToLog 'cmd /c ollama pull qwen2.5:3b'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION "Model download failed (code $0).$\n$\nYou can download it later by running this command in a terminal:$\n$\n  ollama pull qwen2.5:3b$\n$\nThe AI Browser will show a connection error until the model is available."
  ${Else}
    DetailPrint "Model qwen2.5:3b ready."
  ${EndIf}

  ModelDone:
SectionEnd

; ── Section descriptions ───────────────────────────────────────────────────────
!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecApp}    "The AI Browser desktop application (required)."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecOllama} "Ollama local AI runtime. Required to run the AI agent. Skipped if already installed."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecModel}  "The qwen2.5:3b language model (~2 GB download). Required for the AI agent to answer questions."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; ── System requirements check ─────────────────────────────────────────────────
Function .onInit
  ; Require Windows 10 or later
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP "AI Browser requires Windows 10 or later."
    Abort
  ${EndIf}

  ; Require 64-bit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "AI Browser requires a 64-bit version of Windows."
    Abort
  ${EndIf}

  ; Check available RAM (recommend 8 GB minimum)
  System::Call 'kernel32::GlobalMemoryStatusEx(i, *i, *l, *l, *l, *l, *l, *l, *l) i \
    (64, .r0, .r1, .r2) .r9'
  ; r1 = total physical memory in bytes
  IntOp $0 $1 / 1073741824   ; convert to GB
  ${If} $0 < 4
    MessageBox MB_ICONEXCLAMATION "Warning: Only ${$0} GB RAM detected.$\nAI Browser and qwen2.5:3b require at least 8 GB for good performance.$\nInstallation will continue but performance may be poor."
  ${EndIf}
FunctionEnd

; ── Uninstaller ───────────────────────────────────────────────────────────────
Section "Uninstall"
  ; Remove app files
  RMDir /r "$INSTDIR"

  ; Remove shortcuts
  Delete "$SMPROGRAMS\AI Browser\AI Browser.lnk"
  RMDir  "$SMPROGRAMS\AI Browser"
  Delete "$DESKTOP\AI Browser.lnk"

  ; Remove registry
  DeleteRegKey HKLM "${REGKEY}"
  DeleteRegKey HKLM "${UNINSTKEY}"

  ; Note: Ollama and the model are NOT uninstalled here
  ; (user may have other apps using Ollama)
  MessageBox MB_ICONINFORMATION \
    "AI Browser has been uninstalled.$\n$\nOllama and the AI model were kept.$\nTo remove them: uninstall Ollama from Windows Settings > Apps,$\nthen delete %USERPROFILE%\.ollama\models"
SectionEnd
