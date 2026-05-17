import type { ElectronAPI } from '@electron-toolkit/preload'

// @electron-toolkit/preload's electronAPI already exposes `ipcRenderer.invoke /
// send / on / once / removeListener / removeAllListeners`, so we don't add new
// surfaces in preload — the ElectronApi class in shared/api consumes
// `window.electron.ipcRenderer.invoke('email:list', opts)` directly. Keep this
// minimal until a real cross-process side-channel needs typed exposure.

declare global {
  interface Window {
    electron: ElectronAPI
    /** Reserved for future contextBridge-exposed helpers (e.g. attachment
     *  binary streaming). Sprint 1 leaves it as the empty object that the
     *  preload script bridges over. */
    api: Record<string, never>
  }
}

export {}
