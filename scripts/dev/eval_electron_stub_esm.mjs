// Sprint 19 §B eval — ESM stub for `import * from 'electron'`.
// Provides minimal shapes so handler module-load doesn't crash on
// `import { ipcMain } from 'electron'`. ipcMain is only referenced from
// `registerEmailHandlers()` etc., which we never call in eval mode.

export const ipcMain = {
  handle: () => {},
  on: () => {},
  removeHandler: () => {},
  removeAllListeners: () => {},
  emit: () => {}
}

import { homedir } from 'node:os'
export const app = {
  getPath(name) {
    if (name === 'userData') return '/tmp/eval-electron-userdata'
    if (name === 'downloads') return `${homedir()}/Downloads`
    if (name === 'home') return homedir()
    return `/tmp/eval-electron-${name}`
  },
  whenReady() { return Promise.resolve() },
  on() {}
}

export class BrowserWindow {
  static getAllWindows() { return [] }
  static fromWebContents() { return null }
}

export const dialog = {
  async showOpenDialog() { return { canceled: true, filePaths: [] } }
}

export const shell = {
  async openPath() { return '' }
}

export default { ipcMain, app, BrowserWindow, dialog, shell }
