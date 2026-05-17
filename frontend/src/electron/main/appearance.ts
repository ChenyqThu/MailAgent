// Electron main process appearance bridge. REVIEW-LOG C-07: call
// bootNativeTheme() BEFORE createWindow() so the system chrome (traffic
// lights, vibrancy) matches the renderer's first paint — no light flash.

import { app, ipcMain, nativeTheme } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

type ThemeMode = 'system' | 'dark' | 'light'

interface PersistedSettings {
  themeMode: ThemeMode
}

const SETTINGS_FILE = join(app.getPath('userData'), 'appearance.json')

function readSettings(): PersistedSettings {
  try {
    if (existsSync(SETTINGS_FILE)) {
      const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as Partial<PersistedSettings>
      const mode = raw.themeMode
      if (mode === 'system' || mode === 'dark' || mode === 'light') return { themeMode: mode }
    }
  } catch {
    /* corrupt file or first run — fall through */
  }
  return { themeMode: 'system' }
}

function writeSettings(s: PersistedSettings): void {
  try {
    writeFileSync(SETTINGS_FILE, JSON.stringify(s), 'utf8')
  } catch {
    /* best effort — losing this on disk is not fatal */
  }
}

export function bootNativeTheme(): void {
  nativeTheme.themeSource = readSettings().themeMode
}

export function registerAppearanceIpc(): void {
  ipcMain.on('appearance:nativeTheme', (_evt, mode: ThemeMode) => {
    if (mode !== 'system' && mode !== 'dark' && mode !== 'light') return
    nativeTheme.themeSource = mode
    writeSettings({ themeMode: mode })
  })

  // appearance:theme and appearance:accent are renderer→main broadcasts that
  // Island plugin forwarding will hook into (REVIEW-LOG M-01). Sprint 0 just
  // sinks them so the renderer's `window.electron.send(...)` does not warn.
  ipcMain.on('appearance:theme', () => {
    /* Sprint 0 sink; Island Sprint 2 will forward to plugin */
  })
  ipcMain.on('appearance:accent', () => {
    /* Sprint 0 sink */
  })
}
