// Three-state theme + 9-swatch accent (DESIGN.md §17 + §2.7).
// REVIEW-LOG C-06 fix: op-id + rAF coalescing so manual setThemeMode and OS
// prefers-color-scheme change never both commit to DOM in the same frame.

import { create } from 'zustand'

export type ThemeMode = 'system' | 'dark' | 'light'
export type AccentId =
  | 'coral'
  | 'cobalt'
  | 'teal'
  | 'rose'
  | 'slate'
  | 'olive'
  | 'amber'
  | 'emerald'
  | 'violet'
// Sprint 18 #4 — 表面材质风格. 跟 themeMode / accent 平行的第三个独立维度,
// 让用户在主题色之外也能控制 glass-*  的视觉:
//   frosted (默认): 「一块玻璃」— OS vibrancy/acrylic 扛唯一一层重模糊,
//                    CSS 只画 tint + 氛围光, 面板 .glass-* 是 tier overlay
//   solid:           不透明 + 无 backdrop, 性能最好, 也是 prefers-reduced-
//                    transparency 的等价物
// 主题 v2 (2026-06-12): 液态档移除 (评审结论: 区分度低 + 费 GPU)。存量
// localStorage 的 'liquid' 在 readSurface / index.html bootstrap 迁移为 frosted。
export type SurfaceStyle = 'frosted' | 'solid'

// 主题 v2 — 玻璃气质 (data-glass) + 高级玻璃调节 (knob 覆写)。
// 参照实现 = docs/mailagent-themes-v2 demo 的 `window.MA` store。气质是
// :root[data-glass] 的 CSS 预设档; knob 是「设置→通用→外观」的用户覆写,
// 以 inline CSS 变量盖在预设之上 — 未覆写的 knob 读 CSS 预设 (UI 显示生效值
// 用 getComputedStyle)。规范: HANDOFF-theme-spec-v2.md §3.1 / §3.5。
export type GlassMood = 'neutral' | 'tinted' | 'bright'

// 主题 v3 (C1): grain 噪点 knob 随 .grain 层整体退役 — localStorage 旧偏好
// 对象里的 grain 键被 readGlassKnobs 的按表遍历自然忽略, 无需迁移。
export interface GlassKnobs {
  alpha?: number
  blur?: number
  sat?: number
  mix?: number
  ambient?: number
}

/** knob → [CSS 变量, 单位]。设置页读生效值 / applyGlass 写覆写共用一张表。 */
export const GLASS_KNOB_VARS: Record<keyof GlassKnobs, [cssVar: string, unit: string]> = {
  alpha: ['--glass-alpha', ''],
  blur: ['--glass-blur', 'px'],
  sat: ['--glass-sat', ''],
  mix: ['--glass-accent-mix', '%'],
  ambient: ['--ambient', '']
}

/** 滑杆范围即护栏 (规范 §3.5 R5) — read / set 双侧 clamp 防 localStorage 离谱值。 */
export const GLASS_KNOB_RANGE: Record<keyof GlassKnobs, [min: number, max: number, step: number]> =
  {
    alpha: [0.5, 0.95, 0.01],
    blur: [8, 40, 1],
    sat: [1, 2.2, 0.05],
    mix: [0, 20, 1],
    ambient: [0, 0.3, 0.01]
  }

/** 亮色主题下基底不透明度护栏 (规范 §3.1) — 应用时 clamp, 不改存储值。 */
export const GLASS_ALPHA_LIGHT_MIN = 0.72

// 邮件正文外观 (字体族 / 字号 / 行高) — 跟 theme/accent/surface 平行的用户可调
// 维度, 仅作用于 EmailBodyFrame 的 sandboxed iframe 正文 (不影响 UI chrome /
// 列表 / 设置面板)。EmailBodyFrame 直接 read store 插值进 BODY_CSS, 无需像
// theme/accent 那样 apply 到主文档 DOM。
export type BodyFont = 'system' | 'serif' | 'mono'

/** 正文字号 px 安全范围 (clamp 防 localStorage 被手改成离谱值)。默认 14 = 现状。 */
export const BODY_FONT_SIZE_MIN = 12
export const BODY_FONT_SIZE_MAX = 20
/** 正文行高安全范围。默认 1.15 (用户偏好: 紧凑, 取代旧硬编码 1.7)。 */
export const BODY_LINE_HEIGHT_MIN = 1.1
export const BODY_LINE_HEIGHT_MAX = 2.2
export const BODY_FONT_SIZE_DEFAULT = 14
export const BODY_LINE_HEIGHT_DEFAULT = 1.15
/** 撰写行距默认值 —— composer 编辑区 CSS 变量 (`--ma-compose-lh`) 与出站 HTML 的
 *  `line-height` 内联样式同源, 所见即所得。取值范围沿用 BODY_LINE_HEIGHT_MIN/MAX。
 *  🔴 与阅读行距 (BODY_LINE_HEIGHT_DEFAULT=1.15) 是两个独立维度: 阅读行距只作用于
 *  EmailBodyFrame 的 iframe, 撰写行距会随邮件发出去 (收件端看到的就是这个值)。 */
export const COMPOSE_LINE_HEIGHT_DEFAULT = 1.5

interface AppearanceStore {
  themeMode: ThemeMode
  resolvedTheme: 'dark' | 'light'
  accent: AccentId
  surface: SurfaceStyle
  glassMood: GlassMood
  glassKnobs: GlassKnobs
  bodyFont: BodyFont
  bodyFontSize: number
  bodyLineHeight: number
  composeLineHeight: number
  setThemeMode(next: ThemeMode): void
  setAccent(next: AccentId): void
  setSurface(next: SurfaceStyle): void
  setGlassMood(next: GlassMood): void
  setGlassKnob(key: keyof GlassKnobs, value: number): void
  resetGlassKnobs(): void
  setBodyFont(next: BodyFont): void
  setBodyFontSize(next: number): void
  setBodyLineHeight(next: number): void
  setComposeLineHeight(next: number): void
}

const THEME_KEY = 'mailagent.themeMode'
const ACCENT_KEY = 'mailagent.accent'
const SURFACE_KEY = 'mailagent.surface'
const GLASS_MOOD_KEY = 'mailagent.glassMood'
const GLASS_KNOBS_KEY = 'mailagent.glassKnobs'
const BODY_FONT_KEY = 'mailagent.bodyFont'
const BODY_FONT_SIZE_KEY = 'mailagent.bodyFontSize'
const BODY_LINE_HEIGHT_KEY = 'mailagent.bodyLineHeight'
const COMPOSE_LINE_HEIGHT_KEY = 'mailagent.composeLineHeight'

function clampNum(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

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
      v === 'olive' ||
      v === 'amber' ||
      v === 'emerald' ||
      v === 'violet'
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
    if (v === 'frosted' || v === 'solid') return v
    if (v === 'liquid') return 'frosted' // v1 存量迁移 (主题 v2 删液态档)
  } catch {
    /* ignore */
  }
  return 'frosted'
}

function readGlassMood(): GlassMood {
  try {
    const v = localStorage.getItem(GLASS_MOOD_KEY)
    if (v === 'neutral' || v === 'tinted' || v === 'bright') return v
  } catch {
    /* ignore */
  }
  return 'tinted'
}

function readGlassKnobs(): GlassKnobs {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(GLASS_KNOBS_KEY) ?? '{}')
    if (raw === null || typeof raw !== 'object') return {}
    const out: GlassKnobs = {}
    for (const key of Object.keys(GLASS_KNOB_RANGE) as (keyof GlassKnobs)[]) {
      const v = (raw as Record<string, unknown>)[key]
      if (typeof v === 'number' && Number.isFinite(v)) {
        const [lo, hi] = GLASS_KNOB_RANGE[key]
        out[key] = clampNum(v, lo, hi)
      }
    }
    return out
  } catch {
    /* ignore */
  }
  return {}
}

function readBodyFont(): BodyFont {
  try {
    const v = localStorage.getItem(BODY_FONT_KEY)
    if (v === 'system' || v === 'serif' || v === 'mono') return v
  } catch {
    /* ignore */
  }
  return 'system'
}

function readBodyFontSize(): number {
  try {
    const v = Number(localStorage.getItem(BODY_FONT_SIZE_KEY))
    if (Number.isFinite(v) && v > 0) {
      return clampNum(Math.round(v), BODY_FONT_SIZE_MIN, BODY_FONT_SIZE_MAX)
    }
  } catch {
    /* ignore */
  }
  return BODY_FONT_SIZE_DEFAULT
}

function readBodyLineHeight(): number {
  try {
    const v = Number(localStorage.getItem(BODY_LINE_HEIGHT_KEY))
    if (Number.isFinite(v) && v > 0) {
      return clampNum(v, BODY_LINE_HEIGHT_MIN, BODY_LINE_HEIGHT_MAX)
    }
  } catch {
    /* ignore */
  }
  return BODY_LINE_HEIGHT_DEFAULT
}

function readComposeLineHeight(): number {
  try {
    const v = Number(localStorage.getItem(COMPOSE_LINE_HEIGHT_KEY))
    if (Number.isFinite(v) && v > 0) {
      return clampNum(v, BODY_LINE_HEIGHT_MIN, BODY_LINE_HEIGHT_MAX)
    }
  } catch {
    /* ignore */
  }
  return COMPOSE_LINE_HEIGHT_DEFAULT
}

function readResolved(themeMode: ThemeMode): 'dark' | 'light' {
  if (themeMode !== 'system') return themeMode
  if (typeof window === 'undefined') return 'dark'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

const initialTheme = readTheme()

export const useAppearance = create<AppearanceStore>((set, get) => ({
  themeMode: initialTheme,
  resolvedTheme: readResolved(initialTheme),
  accent: readAccent(),
  surface: readSurface(),
  glassMood: readGlassMood(),
  glassKnobs: readGlassKnobs(),
  bodyFont: readBodyFont(),
  bodyFontSize: readBodyFontSize(),
  bodyLineHeight: readBodyLineHeight(),
  composeLineHeight: readComposeLineHeight(),
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
  },
  setGlassMood(next) {
    try {
      localStorage.setItem(GLASS_MOOD_KEY, next)
      // 规范 §3.5 R2 — 切气质清空高级调节覆写 (滑杆回到该档预设)。
      localStorage.setItem(GLASS_KNOBS_KEY, '{}')
    } catch {
      /* ignore */
    }
    set({ glassMood: next, glassKnobs: {} })
    scheduleApplyGlass()
  },
  setGlassKnob(key, value) {
    const [lo, hi] = GLASS_KNOB_RANGE[key]
    const next: GlassKnobs = { ...get().glassKnobs, [key]: clampNum(value, lo, hi) }
    try {
      localStorage.setItem(GLASS_KNOBS_KEY, JSON.stringify(next))
    } catch {
      /* ignore */
    }
    set({ glassKnobs: next })
    scheduleApplyGlass()
  },
  resetGlassKnobs() {
    // 规范 §3.5 R2 — 「恢复默认」只清覆写, 不改气质。
    try {
      localStorage.setItem(GLASS_KNOBS_KEY, '{}')
    } catch {
      /* ignore */
    }
    set({ glassKnobs: {} })
    scheduleApplyGlass()
  },
  setBodyFont(next) {
    try {
      localStorage.setItem(BODY_FONT_KEY, next)
    } catch {
      /* ignore */
    }
    set({ bodyFont: next })
  },
  setBodyFontSize(next) {
    const v = clampNum(Math.round(next), BODY_FONT_SIZE_MIN, BODY_FONT_SIZE_MAX)
    try {
      localStorage.setItem(BODY_FONT_SIZE_KEY, String(v))
    } catch {
      /* ignore */
    }
    set({ bodyFontSize: v })
  },
  setBodyLineHeight(next) {
    const v = clampNum(next, BODY_LINE_HEIGHT_MIN, BODY_LINE_HEIGHT_MAX)
    try {
      localStorage.setItem(BODY_LINE_HEIGHT_KEY, String(v))
    } catch {
      /* ignore */
    }
    set({ bodyLineHeight: v })
  },
  setComposeLineHeight(next) {
    const v = clampNum(next, BODY_LINE_HEIGHT_MIN, BODY_LINE_HEIGHT_MAX)
    try {
      localStorage.setItem(COMPOSE_LINE_HEIGHT_KEY, String(v))
    } catch {
      /* ignore */
    }
    set({ composeLineHeight: v })
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
    const previousResolved = useAppearance.getState().resolvedTheme

    const commitTheme = (): void => {
      root.setAttribute('data-theme', resolved)
      root.classList.toggle('dark', resolved === 'dark')
      useAppearance.setState({ resolvedTheme: resolved })
      // 主题 v2 — 主题翻转后重放 glass 覆写: 亮色 alpha 护栏 clamp 依赖
      // resolvedTheme, 不重放的话「暗色调到 0.6 → 切亮色」会停在 0.6 漏过护栏。
      const { glassMood, glassKnobs } = useAppearance.getState()
      applyGlass(glassMood, glassKnobs)
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
    }

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (previousResolved === resolved || reduceMotion || !('startViewTransition' in document)) {
      commitTheme()
      return
    }

    root.dataset.themeVt = 'circle-blur'
    const transition = document.startViewTransition(commitTheme)
    void transition.finished.finally(() => {
      delete root.dataset.themeVt
    })
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
// attribute, 让 CSS 的 base .glass-* 自然生效; solid 才写 attribute
// 触发 :root[data-surface='...'] selector 覆盖.
export function applySurface(surface: SurfaceStyle): void {
  const root = document.documentElement
  if (surface === 'frosted') root.removeAttribute('data-surface')
  else root.setAttribute('data-surface', surface)
  // 主题 v2 — 联动原生材质 (solid=关 vibrancy)。main 的 registerSurfaceIpc
  // 处理后回写 appearance:vibrancyState → data-vib (见 bootAppearance)。
  // web build / 测试环境 electron 缺位 → optional chain 自然 no-op。
  const w = window as unknown as {
    electron?: { ipcRenderer?: { send: (ch: string, v: unknown) => void } }
  }
  w.electron?.ipcRenderer?.send('appearance:surface', surface)
}

// 主题 v2 — 玻璃气质 + 高级调节落 DOM。覆写以 inline CSS 变量盖在
// :root[data-glass] 预设上; 未覆写的 knob removeProperty 回落 CSS 预设。
// 亮色主题下 alpha 应用时 clamp ≥ GLASS_ALPHA_LIGHT_MIN (护栏, 不改存储值);
// applyResolvedTheme 在主题翻转后会重跑本函数让 clamp 跟上。
export function applyGlass(mood: GlassMood, knobs: GlassKnobs): void {
  const root = document.documentElement
  root.setAttribute('data-glass', mood)
  const resolved = useAppearance.getState().resolvedTheme
  for (const key of Object.keys(GLASS_KNOB_VARS) as (keyof GlassKnobs)[]) {
    const [cssVar, unit] = GLASS_KNOB_VARS[key]
    let v = knobs[key]
    if (v != null && key === 'alpha' && resolved === 'light') {
      v = Math.max(v, GLASS_ALPHA_LIGHT_MIN)
    }
    if (v != null) root.style.setProperty(cssVar, `${v}${unit}`)
    else root.style.removeProperty(cssVar)
  }
}

// 滑杆 input 高频触发 → rAF 合并 DOM 写入 (同上方 C-06 / Sprint 10 L7 模式)。
let glassRafId: ReturnType<typeof requestAnimationFrame> | null = null

function scheduleApplyGlass(): void {
  if (glassRafId !== null) return
  glassRafId = requestAnimationFrame(() => {
    glassRafId = null
    const { glassMood, glassKnobs } = useAppearance.getState()
    applyGlass(glassMood, glassKnobs)
  })
}

// Boot: register OS-change listener once. Caller should also call
// applyResolvedTheme() once after mount to commit initial state (the inline
// bootstrap in index.html already set the DOM before paint — this just keeps
// the zustand store in sync).
export function bootAppearance(): void {
  applyResolvedTheme()
  applyAccent(useAppearance.getState().accent)
  applySurface(useAppearance.getState().surface)
  applyGlass(useAppearance.getState().glassMood, useAppearance.getState().glassKnobs)
  if (typeof window === 'undefined') return
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  mq.addEventListener('change', () => {
    if (useAppearance.getState().themeMode === 'system') applyResolvedTheme()
  })
  // 主题 v2 — 主进程回写: 原生 vibrancy 是否生效 (macOS/Win11 frosted=on;
  // solid / Linux / Win10 = off)。CSS 以 :root[data-vib='off'] 切到
  // --wp-fallback 窗内自绘回退。App 生命周期单订阅, 不退订 (同窗口共存亡);
  // 注册发生在 applySurface() 发出请求之后、main 异步回包到达之前, 不丢首包。
  const w = window as unknown as {
    electron?: {
      ipcRenderer?: { on?: (ch: string, listener: (...args: unknown[]) => void) => void }
    }
  }
  w.electron?.ipcRenderer?.on?.('appearance:vibrancyState', (_evt: unknown, active: unknown) => {
    document.documentElement.setAttribute('data-vib', active ? 'on' : 'off')
  })
}
