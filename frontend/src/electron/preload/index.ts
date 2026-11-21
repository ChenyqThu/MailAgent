import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

import {
  EMBEDDED_BROWSER_IPC,
  type EmbeddedBrowserBounds,
  type EmbeddedBrowserPreloadApi,
  type EmbeddedBrowserState
} from '@shared/embeddedBrowserContract'

// task 08-20-notification-center M2 批 B4 — 系统通知点击深跳。payload 是通知行的
// payload_json（deep-link 在 payload.link），renderer 侧经单源解析器收窄，这里不校验。
interface NotificationNavigatePayload {
  id: number
  payload: unknown
}

const embeddedBrowser: EmbeddedBrowserPreloadApi = {
  getState: () => ipcRenderer.invoke(EMBEDDED_BROWSER_IPC.getState),
  attach: (bounds: EmbeddedBrowserBounds) =>
    ipcRenderer.invoke(EMBEDDED_BROWSER_IPC.attach, bounds),
  setBounds: (bounds: EmbeddedBrowserBounds) =>
    ipcRenderer.invoke(EMBEDDED_BROWSER_IPC.setBounds, bounds),
  detach: () => ipcRenderer.invoke(EMBEDDED_BROWSER_IPC.detach),
  navigate: (url: string) => ipcRenderer.invoke(EMBEDDED_BROWSER_IPC.navigate, url),
  newTab: (url?: string) => ipcRenderer.invoke(EMBEDDED_BROWSER_IPC.newTab, url),
  switchTab: (tabId: string) => ipcRenderer.invoke(EMBEDDED_BROWSER_IPC.switchTab, tabId),
  closeTab: (tabId: string) => ipcRenderer.invoke(EMBEDDED_BROWSER_IPC.closeTab, tabId),
  back: () => ipcRenderer.invoke(EMBEDDED_BROWSER_IPC.back),
  forward: () => ipcRenderer.invoke(EMBEDDED_BROWSER_IPC.forward),
  reload: () => ipcRenderer.invoke(EMBEDDED_BROWSER_IPC.reload),
  openDevTools: () => ipcRenderer.invoke(EMBEDDED_BROWSER_IPC.openDevTools),
  resetSession: () => ipcRenderer.invoke(EMBEDDED_BROWSER_IPC.resetSession),
  onStateChanged(handler: (state: EmbeddedBrowserState) => void): () => void {
    const listener = (
      _event: Electron.IpcRendererEvent,
      state: EmbeddedBrowserState
    ): void => {
      handler(state)
    }
    ipcRenderer.on(EMBEDDED_BROWSER_IPC.stateChanged, listener)
    return () => ipcRenderer.removeListener(EMBEDDED_BROWSER_IPC.stateChanged, listener)
  }
}

const api = {
  notifications: {
    onNavigate(handler: (payload: NotificationNavigatePayload) => void): () => void {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: NotificationNavigatePayload
      ): void => {
        handler(payload)
      }
      ipcRenderer.on('notifications:navigate', listener)
      return () => ipcRenderer.removeListener('notifications:navigate', listener)
    }
  },
  embeddedBrowser
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
