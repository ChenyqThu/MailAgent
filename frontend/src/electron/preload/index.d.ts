import type { ElectronAPI } from '@electron-toolkit/preload'

interface NotificationNavigatePayload {
  id: number
  payload: unknown
}

interface MailAgentPreloadApi {
  notifications: {
    onNavigate(handler: (payload: NotificationNavigatePayload) => void): () => void
  }
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: MailAgentPreloadApi
  }
}

export {}
