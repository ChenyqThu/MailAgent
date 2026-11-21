import type { ElectronAPI } from '@electron-toolkit/preload'
import type { EmbeddedBrowserPreloadApi } from '../../shared/embeddedBrowserContract'

interface NotificationNavigatePayload {
  id: number
  payload: unknown
}

interface MailAgentPreloadApi {
  notifications: {
    onNavigate(handler: (payload: NotificationNavigatePayload) => void): () => void
  }
  embeddedBrowser?: EmbeddedBrowserPreloadApi
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: MailAgentPreloadApi
  }
}

export {}
