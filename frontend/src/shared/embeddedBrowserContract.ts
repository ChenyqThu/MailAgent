export const EMBEDDED_BROWSER_PARTITION = 'persist:mailagent-browser'

export const EMBEDDED_BROWSER_IPC = {
  getState: 'embedded-browser:get-state',
  attach: 'embedded-browser:attach',
  setBounds: 'embedded-browser:set-bounds',
  detach: 'embedded-browser:detach',
  navigate: 'embedded-browser:navigate',
  newTab: 'embedded-browser:new-tab',
  switchTab: 'embedded-browser:switch-tab',
  closeTab: 'embedded-browser:close-tab',
  back: 'embedded-browser:back',
  forward: 'embedded-browser:forward',
  reload: 'embedded-browser:reload',
  openDevTools: 'embedded-browser:open-devtools',
  resetSession: 'embedded-browser:reset-session',
  stateChanged: 'embedded-browser:state-changed'
} as const

export interface EmbeddedBrowserTab {
  id: string
  title: string
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export interface EmbeddedBrowserState {
  tabs: EmbeddedBrowserTab[]
  activeTabId: string | null
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export interface EmbeddedBrowserBounds {
  x: number
  y: number
  width: number
  height: number
  visible: boolean
}

export interface EmbeddedBrowserPreloadApi {
  getState(): Promise<EmbeddedBrowserState>
  attach(bounds: EmbeddedBrowserBounds): Promise<EmbeddedBrowserState>
  setBounds(bounds: EmbeddedBrowserBounds): Promise<void>
  detach(): Promise<void>
  navigate(url: string): Promise<EmbeddedBrowserState>
  newTab(url?: string): Promise<EmbeddedBrowserState>
  switchTab(tabId: string): Promise<EmbeddedBrowserState>
  closeTab(tabId: string): Promise<EmbeddedBrowserState>
  back(): Promise<EmbeddedBrowserState>
  forward(): Promise<EmbeddedBrowserState>
  reload(): Promise<EmbeddedBrowserState>
  openDevTools(): Promise<void>
  resetSession(): Promise<EmbeddedBrowserState>
  onStateChanged(handler: (state: EmbeddedBrowserState) => void): () => void
}
