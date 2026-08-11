import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

interface MatterNavigatePayload {
  publicId: string
  signalId: number | string
}

const api = {
  matters: {
    onNavigate(handler: (payload: MatterNavigatePayload) => void): () => void {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: MatterNavigatePayload
      ): void => {
        handler(payload)
      }
      ipcRenderer.on('matters:navigate', listener)
      return () => ipcRenderer.removeListener('matters:navigate', listener)
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
