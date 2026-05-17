import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { bootNativeTheme, registerAppearanceIpc } from './appearance'
import { registerCliLifecycle } from './cli_runner'
import { registerEmailHandlers } from './handlers/email'
import { registerAttachmentHandlers } from './handlers/attachment'

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

app.whenReady().then(() => {
  electronApp.setAppUserModelId('ink.chenge.mailagent')

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

  ipcMain.on('ping', () => console.log('pong'))

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
