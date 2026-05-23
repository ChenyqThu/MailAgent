import { app, shell, BrowserWindow, ipcMain, Menu } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { bootNativeTheme, registerAppearanceIpc } from './appearance'
import { registerCliLifecycle } from './cli_runner'
import { registerEmailHandlers } from './handlers/email'
import { registerAttachmentHandlers } from './handlers/attachment'
import { registerTranslateHandlers, abortAllTranslations } from './handlers/translate'
import { abortAllChatSessions, registerChatHandlers } from './handlers/chat'
import { registerChatBackend } from './chat/registry'
import { CustomApiBackend } from './chat/backends/custom_api'
import { NotionAgentBackend } from './chat/backends/notion_agent'
// Sprint 19 PR-1d.1 — populate agent harness tool catalog at boot.
import { defaultToolRegistry } from './chat/tools/registry'
import { registerBuiltinTools } from './chat/tools/builtin'
import { registerWriteOpsHandlers } from './handlers/write_ops'
import { startEventsBridge } from './events_bridge'
import { registerDraftHandlers } from './handlers/draft'
// Sprint 6 §2.2 — admin / llm dashboard / calendar / settings IPC handlers.
import { registerAdminHandlers } from './handlers/admin'
import { registerLlmStatsHandlers } from './handlers/llm_stats'
import { registerCalendarHandlers } from './handlers/calendar'
import { registerSettingsHandlers } from './handlers/settings'
import { registerPromptHandlers } from './handlers/prompts'
// Sprint 8 §2.2 — electron-updater bridge (auto-updater state + IPC).
import { registerUpdaterHandlers } from './handlers/updater'
// Sprint 9 §2.2 — ping-island bridge (unix socket sender + appearance / AI
// draft envelopes + connection probe). The probe loop is auto-skipped in
// dev mode so a developer without ping-island.app doesn't see spurious
// probe-failure noise in the log.
import { registerIslandHandlers } from './handlers/island'
// Sprint 18 §PR B — repo-root .env read/write (env:get/:set) + pm2 restart
// bridge (services:restart/:status). Settings tabs use env:set on blur to
// persist managed keys to the Python-side .env, then surface RestartBanner
// (PR E) that calls services:restart('mail-sync').
import { registerEnvHandlers } from './handlers/env'
import { registerServicesHandlers } from './handlers/services'

// macOS menu bar + Dock label needs to be set BEFORE app.whenReady() —
// otherwise the menu reads from the Electron binary's Info.plist
// (CFBundleName="Electron") instead of our product name. Production builds
// (electron-builder, productName=MailAgent) already get this right via the
// signed .app bundle's Info.plist; this fixes the dev experience.
app.setName('MailAgent')

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    show: false,
    title: 'MailAgent',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0E1013',
    webPreferences: {
      // electron-vite outputs the preload bundle as `.mjs` (ESM); Electron 28+
      // loads .mjs preloads natively. Sprint 1 hardcoded `.js` and the file
      // never existed → preload silently failed to load → window.electron
      // was undefined → every IPC call from Sprint 2 onward threw
      // "ipcRenderer.invoke missing — preload not loaded".
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    if (is.dev) {
      // Open devtools so renderer-side errors are visible without Cmd+Opt+I.
      // Detached panel keeps the inbox layout undisturbed.
      mainWindow.webContents.openDevTools({ mode: 'detach' })
    }
  })

  // Forward renderer console errors to the main process stdout so they
  // show up in `pnpm dev`'s log even without devtools open. Sprint 7 will
  // route these into a proper renderer-log panel; for Sprint 2 stdout is
  // good enough to catch React render exceptions.
  mainWindow.webContents.on('console-message', (event) => {
    const { level, message, sourceId, lineNumber } = event
    if (level === 'error' || level === 'warning') {
      console.error(`[renderer:${level}] ${message}\n  at ${sourceId}:${lineNumber}`)
    }
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[renderer GONE] reason=${details.reason} exitCode=${details.exitCode}`)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Sprint 14 PR E — chat popout chrome. Spawned by the renderer via
// `window:openChatPopout` IPC; carries the email id through the URL
// search string so renderer/main.tsx can boot the popout shell before
// React.render. Sized smaller than the main window since the popout
// only hosts a single AI chat panel (no inbox / detail / settings).
function createPopoutWindow(emailId: number): void {
  const popout = new BrowserWindow({
    width: 480,
    height: 760,
    minWidth: 360,
    minHeight: 520,
    show: false,
    title: 'MailAgent — AI Chat',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0E1013',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false
    }
  })

  popout.on('ready-to-show', () => {
    popout.show()
  })

  popout.webContents.on('console-message', (event) => {
    const { level, message, sourceId, lineNumber } = event
    if (level === 'error' || level === 'warning') {
      console.error(`[popout:${level}] ${message}\n  at ${sourceId}:${lineNumber}`)
    }
  })

  popout.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  const search = `popout=1&email=${emailId}`
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    popout.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?${search}`)
  } else {
    // Electron's loadFile accepts a `search` option that materialises
    // as `?popout=1&email=N` in window.location.search inside the
    // renderer — same shape the dev loadURL path produces, so the
    // bootPopoutModeFromQuery parser handles both transparently.
    popout.loadFile(join(__dirname, '../renderer/index.html'), { search })
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('ink.chenge.mailagent')

  // Sprint 11 user-feedback — dev-mode dock icon. Packaged builds inherit
  // the icon from electron-builder's `directories.buildResources: build`
  // (auto-applies `build/icon.icns` to the .app bundle); dev mode still
  // shows the generic Electron icon unless we set it explicitly here.
  // PNG path is more reliable than .icns for app.dock.setIcon on macOS in
  // dev mode (some macOS versions silently ignore .icns runtime overrides).
  if (process.platform === 'darwin' && app.dock && is.dev) {
    const iconPath = join(__dirname, '../../build/icons/1024.png')
    try {
      app.dock.setIcon(iconPath)
      console.log('[dock] dev icon set:', iconPath)
    } catch (err) {
      console.warn('[dock] dev icon load failed:', iconPath, err)
    }
  }

  // Sprint 11 user-feedback — macOS app menu name. Electron's binary
  // Info.plist hardcodes CFBundleName="Electron" so the leftmost macOS
  // app menu reads "Electron" in dev. Rebuild the app menu with the
  // product name explicitly to fix it. `app.setName` (done at module
  // load) drives `{appName}` substitution in the role labels — but the
  // menu first item label needs to be set explicitly because macOS hides
  // the literal label of the first menu and renders the app's CFBundleName.
  if (process.platform === 'darwin') {
    const appMenu = Menu.buildFromTemplate([
      {
        label: 'MailAgent',
        submenu: [
          { role: 'about', label: 'About MailAgent' },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide', label: 'Hide MailAgent' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit', label: 'Quit MailAgent' }
        ]
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' }
    ])
    Menu.setApplicationMenu(appMenu)
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // REVIEW-LOG C-07: set nativeTheme BEFORE BrowserWindow creation to avoid
  // first-paint flash; register appearance IPC sinks for renderer broadcasts.
  bootNativeTheme()
  registerAppearanceIpc()
  // REVIEW-LOG C-02: install before-quit hook so in-flight CLI subprocesses
  // get SIGTERM'd instead of orphaned when the user Cmd+Qs mid-call.
  registerCliLifecycle()
  // Sprint 1.2: IPC handlers (read-only — SQLite direct, ~4ms).
  // Write handlers (resync / update-flag) land in Sprint 5 atop cli_runner.
  registerEmailHandlers()
  registerAttachmentHandlers()
  registerTranslateHandlers()
  // Sprint 4 §2.1 — AI chat IPC stream bridge + the two production
  // backends (Custom API via Anthropic Messages SSE; Notion Agent via
  // `notion-agent chat --json` subprocess).
  registerChatBackend(new CustomApiBackend())
  registerChatBackend(new NotionAgentBackend())
  // Sprint 19 PR-1d.1 — populate the agent harness tool registry once at
  // boot. The harness only consults `defaultToolRegistry` when the
  // MAILAGENT_AGENT_HARNESS env flag is set, so registering tools here is
  // safe even when the harness is off — no behavioural change until the
  // flag flips.
  registerBuiltinTools(defaultToolRegistry)
  registerChatHandlers()
  // Sprint 5 §2.2 — Mail.app write commands (createDraft via AppleScript,
  // resync / llm:run / notion:updateFlag via `mailagent` CLI fork).
  registerDraftHandlers()
  registerWriteOpsHandlers()
  // Sprint 16 — 主进程持久连接 mail-sync 本地 SSE endpoint, 通过 IPC broadcast
  // 把事件转发给 renderer; 替换 EmailList / Sidebar 5s 硬轮询. 失败自动指数退避
  // 重连, renderer 通过 events:status 看连接状态决定是否启用 fallback polling.
  startEventsBridge()
  // Sprint 6 §2.2 — admin dashboard / LLM dashboard / calendar list /
  // settings page. Each handler group is read-only by default (admin:health,
  // admin:stats, llm:stats, calendar:recurringDiscover) with separate
  // write+auth channels for retry / replay / cleanup.
  registerAdminHandlers()
  registerLlmStatsHandlers()
  registerCalendarHandlers()
  registerSettingsHandlers()
  registerPromptHandlers()
  // Sprint 8 §2.2 — electron-updater bridge.
  //
  // We pass the real `autoUpdater` lazily (require-after-app-ready) so test
  // harnesses can opt-out by stubbing the module — see
  // `tests/main/updater.test.ts`. The handler registration itself is
  // unconditional; in dev mode the handler will record `state: 'dev-disabled'`
  // and skip the auto-tick (electron-updater can't read app-update.yml until
  // packaged), but the IPC channels still respond so the SettingsPage UI
  // shows the dev sentinel instead of throwing on `updater:status`.
  let updaterStub: import('./handlers/updater').AutoUpdaterLike | undefined
  if (!is.dev) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { autoUpdater } = require('electron-updater') as typeof import('electron-updater')
    updaterStub = autoUpdater as unknown as import('./handlers/updater').AutoUpdaterLike
  }
  registerUpdaterHandlers({ updater: updaterStub })
  // Sprint 9 §2.2 — register the IPC channels before createWindow so the
  // renderer's first `island:status` invoke (on TitleBar mount) hits a
  // handler that exists. Probe loop runs in production only.
  registerIslandHandlers()
  // Sprint 18 §PR B — env:* read/write + services:* pm2 control. Must be
  // wired before createWindow so SettingsPage's first env:get on mount has
  // a handler to hit. Both registrations are side-effect-only (no state).
  registerEnvHandlers()
  registerServicesHandlers()

  ipcMain.on('ping', () => console.log('pong'))

  // Sprint 14 PR E — popout opener. Fire-and-forget from the renderer
  // (the new BrowserWindow shows itself via ready-to-show); no return
  // value or envelope. Bad emailId is silently dropped — the renderer
  // already validates Number.isInteger before sending.
  ipcMain.on('window:openChatPopout', (_evt, emailId: number) => {
    if (!Number.isInteger(emailId) || emailId < 0) return
    createPopoutWindow(emailId)
  })

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Sprint 3 §2.2 + Sprint 4 §2.1 — abort any in-flight LLM async work on
// quit (translation requests + chat streams) so the CLI subprocess
// teardown (`registerCliLifecycle`) isn't the only path cleaning up.
app.on('before-quit', () => {
  abortAllTranslations()
  abortAllChatSessions()
})
