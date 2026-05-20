// Three-state theme + 6-swatch accent (DESIGN.md §17 + §2.7).
// REVIEW-LOG C-06 fix: op-id + rAF coalescing so manual setThemeMode and OS
// prefers-color-scheme change never both commit to DOM in the same frame.

import { create } from 'zustand'

export type ThemeMode = 'system' | 'dark' | 'light'
export type AccentId = 'coral' | 'cobalt' | 'teal' | 'rose' | 'slate' | 'olive'
// Sprint 18 #4 — 表面材质风格. 跟 themeMode / accent 平行的第三个独立维度,
// 让用户在主题色之外也能控制 glass-*  的视觉:
//   frosted (默认): 半透 + backdrop blur (Apple Liquid Glass 的轻量版)
//   solid:           不透明 + 无 backdrop, 性能最好, 也是 prefers-reduced-
//                    transparency 的等价物
//   liquid:          更高 alpha + 高 blur + saturate + brightness + 高光,
//                    模拟 Apple Liquid Glass / iOS 26 全量样式
export type SurfaceStyle = 'frosted' | 'solid' | 'liquid'

interface AppearanceStore {
  themeMode: ThemeMode
  resolvedTheme: 'dark' | 'light'
  accent: AccentId
  surface: SurfaceStyle
  setThemeMode(next: ThemeMode): void
  setAccent(next: AccentId): void
  setSurface(next: SurfaceStyle): void
}

const THEME_KEY = 'mailagent.themeMode'
const ACCENT_KEY = 'mailagent.accent'
const SURFACE_KEY = 'mailagent.surface'

function readTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_KEY)
    if (v === 'system' || v === 'dark' || v === 'light') return v
  } catch {
    /* localStorage may throw in privacy modes */
  }
  return 'system'
}

function readAccent(): AccentId {
  try {
    const v = localStorage.getItem(ACCENT_KEY)
    if (
      v === 'coral' ||
      v === 'cobalt' ||
      v === 'teal' ||
      v === 'rose' ||
      v === 'slate' ||
      v === 'olive'
    ) {
      return v
    }
  } catch {
    /* ignore */
  }
  return 'coral'
}

function readSurface(): SurfaceStyle {
  try {
    const v = localStorage.getItem(SURFACE_KEY)
    if (v === 'frosted' || v === 'solid' || v === 'liquid') return v
  } catch {
    /* ignore */
  }
  return 'frosted'
}

function readResolved(themeMode: ThemeMode): 'dark' | 'light' {
  if (themeMode !== 'system') return themeMode
  if (typeof window === 'undefined') return 'dark'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

const initialTheme = readTheme()

export const useAppearance = create<AppearanceStore>((set) => ({
  themeMode: initialTheme,
  resolvedTheme: readResolved(initialTheme),
  accent: readAccent(),
  surface: readSurface(),
  setThemeMode(next) {
    try {
      localStorage.setItem(THEME_KEY, next)
    } catch {
      /* ignore */
    }
    set({ themeMode: next })
    applyResolvedTheme()
  },
  setAccent(next) {
    try {
      localStorage.setItem(ACCENT_KEY, next)
    } catch {
      /* ignore */
    }
    set({ accent: next })
    applyAccent(next)
  },
  setSurface(next) {
    try {
      localStorage.setItem(SURFACE_KEY, next)
    } catch {
      /* ignore */
    }
    set({ surface: next })
    applySurface(next)
  }
}))

// REVIEW-LOG C-06: op-id + rAF guard. Multiple rapid triggers collapse to last.
let opCounter = 0

// Sprint 10 reviewer L7: coalesce `island:appearance` envelope emits so a
// rapid theme + accent flip in the same tick produces ONE envelope instead
// of two. The main side dedupes by sessionKey, but each emit still burns a
// socket connect (~ms-scale latency) that we'd rather not waste.
let islandAppearanceRafId: ReturnType<typeof requestAnimationFrame> | null = null

function scheduleIslandAppearance(): void {
  if (islandAppearanceRafId !== null) return
  islandAppearanceRafId = requestAnimationFrame(() => {
    islandAppearanceRafId = null
    const w = window as unknown as {
      electron?: { ipcRenderer?: { send: (ch: string, v: unknown) => void } }
    }
    const { accent, resolvedTheme } = useAppearance.getState()
    w.electron?.ipcRenderer?.send('island:appearance', { accent, theme: resolvedTheme })
  })
}

export function applyResolvedTheme(): void {
  const myOp = ++opCounter
  requestAnimationFrame(() => {
    if (myOp !== opCounter) return
    const { themeMode } = useAppearance.getState()
    const resolved: 'dark' | 'light' = readResolved(themeMode)
    const root = document.documentElement
    root.setAttribute('data-theme', resolved)
    root.classList.toggle('dark', resolved === 'dark')
    useAppearance.setState({ resolvedTheme: resolved })
    // Electron IPC broadcast (no-op in Web build)
    // `@electron-toolkit/preload`'s electronAPI exposes `ipcRenderer.send`,
    // NOT `electron.send` directly. Sprint 1 had this typo'd — it never fired
    // because Sprint 1 didn't really run the app; Sprint 2 surfaced it as
    // "w.electron?.send is not a function" crashing the entire renderer tree.
    const w = window as unknown as {
      electron?: { ipcRenderer?: { send: (ch: string, v: unknown) => void } }
    }
    w.electron?.ipcRenderer?.send('appearance:theme', resolved)
    w.electron?.ipcRenderer?.send('appearance:nativeTheme', themeMode)
    // Sprint 9 §2.3 — broadcast a combined (accent, theme) snapshot to the
    // ping-island bridge. main/handlers/island.ts wraps this into a
    // `AppearanceChange` envelope; ping-island's fork uses metadata.* to
    // repaint accent + theme. The send is silently no-op'd by main when
    // the integration is disabled / dev-disabled / disconnected, so the
    // renderer never has to gate on connection state itself.
    // Sprint 10 L7: coalesced via scheduleIslandAppearance() so back-to-back
    // applyResolvedTheme + applyAccent in the same tick → one envelope.
    scheduleIslandAppearance()
  })
}

export function applyAccent(accent: AccentId): void {
  const root = document.documentElement
  if (accent === 'coral') root.removeAttribute('data-accent')
  else root.setAttribute('data-accent', accent)
  const w = window as unknown as {
    electron?: { ipcRenderer?: { send: (ch: string, v: unknown) => void } }
  }
  w.electron?.ipcRenderer?.send('appearance:accent', accent)
  // Sprint 9 §2.3 + Sprint 10 L7 — combined payload coalesced into one rAF.
  scheduleIslandAppearance()
}

// Sprint 18 #4 — Surface 是 UI 视觉风格, 不广播到 Island (Island 是 ping-
// island 单独的视觉, 没有 glass-* layer 共享需求). 默认 'frosted' 不写
// attribute, 让 CSS 的 base .glass-* 自然生效; solid / liquid 才写 attribute
// 触发 :root[data-surface='...'] selector 覆盖.
export function applySurface(surface: SurfaceStyle): void {
  const root = document.documentElement
  if (surface === 'frosted') root.removeAttribute('data-surface')
  else root.setAttribute('data-surface', surface)
}

// Boot: register OS-change listener once. Caller should also call
// applyResolvedTheme() once after mount to commit initial state (the inline
// bootstrap in index.html already set the DOM before paint — this just keeps
// the zustand store in sync).
export function bootAppearance(): void {
  applyResolvedTheme()
  applyAccent(useAppearance.getState().accent)
  applySurface(useAppearance.getState().surface)
  if (typeof window === 'undefined') return
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  mq.addEventListener('change', () => {
    if (useAppearance.getState().themeMode === 'system') applyResolvedTheme()
  })
}
