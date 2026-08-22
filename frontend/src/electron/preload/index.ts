import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// task 08-20-notification-center M2 批 B4 — 系统通知点击深跳。payload 是通知行的
// payload_json（deep-link 在 payload.link），renderer 侧经单源解析器收窄，这里不校验。
interface NotificationNavigatePayload {
  id: number
  payload: unknown
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
  }
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
