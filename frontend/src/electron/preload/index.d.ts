import type { ElectronAPI } from '@electron-toolkit/preload'

interface MatterNavigatePayload {
  publicId: string
  signalId: number | string
}

interface MailAgentPreloadApi {
  matters: {
    onNavigate(handler: (payload: MatterNavigatePayload) => void): () => void
  }
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: MailAgentPreloadApi
  }
}

export {}
