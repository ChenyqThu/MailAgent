// Electron main process appearance bridge. REVIEW-LOG C-07: call
// bootNativeTheme() BEFORE createWindow() so the system chrome (traffic
// lights, vibrancy) matches the renderer's first paint — no light flash.
//
// 主题 v2 — 新增原生材质腿:「一块玻璃」架构里整窗唯一一层重模糊由 OS 提供
// (macOS vibrancy / Win11 acrylic), CSS 只画 tint。renderer 的 applySurface
// 经 'appearance:surface' 通知这里开关原生材质; 处理后回写
// 'appearance:vibrancyState' → renderer 写 data-vib (off = CSS 走
// --wp-fallback 自绘回退)。surface 同时持久化到 appearance.json, 让下次
// createWindow 的构造参数 (vibrancy/backgroundColor) 首帧就正确, 防闪。

import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { release } from 'os'
import { join } from 'path'

type ThemeMode = 'system' | 'dark' | 'light'
type SurfaceStyle = 'frosted' | 'solid'

interface PersistedSettings {
  themeMode: ThemeMode
  surface: SurfaceStyle
}

const SETTINGS_FILE = join(app.getPath('userData'), 'appearance.json')

/* 不透明首帧底色 — 与 renderer pre-paint anchor 同色 (index.html bootstrap)。 */
const OPAQUE_BG = '#0E1013'

function readSettings(): PersistedSettings {
  const out: PersistedSettings = { themeMode: 'system', surface: 'frosted' }
  try {
    if (existsSync(SETTINGS_FILE)) {
      const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as Partial<PersistedSettings>
      const mode = raw.themeMode
      if (mode === 'system' || mode === 'dark' || mode === 'light') out.themeMode = mode
      if (raw.surface === 'frosted' || raw.surface === 'solid') out.surface = raw.surface
    }
  } catch {
    /* corrupt file or first run — fall through */
  }
  return out
}

function writeSettings(patch: Partial<PersistedSettings>): void {
  try {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ ...readSettings(), ...patch }), 'utf8')
  } catch {
    /* best effort — losing this on disk is not fatal */
  }
}

export function bootNativeTheme(): void {
  nativeTheme.themeSource = readSettings().themeMode
}

/** Win11 (build ≥ 22000) 才有 acrylic backgroundMaterial; Win10 设置会被
 *  静默忽略 → 当 vib off 处理。 */
function isWin11(): boolean {
  if (process.platform !== 'win32') return false
  const build = Number(release().split('.')[2] ?? 0)
  return Number.isFinite(build) && build >= 22000
}

/** 本平台 + frosted 下原生材质是否真实生效 (renderer data-vib 的值源)。 */
function nativeSurfaceActive(surface: SurfaceStyle): boolean {
  if (surface !== 'frosted') return false
  return process.platform === 'darwin' || isWin11()
}

export function getPersistedSurface(): SurfaceStyle {
  return readSettings().surface
}

/** createWindow 的材质构造参数 — 用持久化 surface 让首帧免切换闪烁。
 *  visualEffectState:'active' = 失焦不降档 (规范 §2); 它是 constructor-only
 *  选项, 运行时从 solid 切回 frosted 的窗口会退到 followWindow, 下次启动
 *  恢复 — 可接受的小差异。Linux / Win10 不透明回退 (不给透明底)。 */
export function surfaceWindowOptions(): Electron.BrowserWindowConstructorOptions {
  const surface = getPersistedSurface()
  if (!nativeSurfaceActive(surface)) return { backgroundColor: OPAQUE_BG }
  if (process.platform === 'darwin') {
    return {
      // 'fullscreen-ui' (Control Center / Spotlight 同款) — 透出桌面壁纸
      // 明显。初版用 'under-window', 是 macOS 透感最弱的材质 (模拟窗口
      // 下层背景, 暗色下近乎不透明深灰), 用户反馈"看不出玻璃"。
      //
      // 🔴 frosted 分支绝不能设 backgroundColor: Electron 对非 transparent
      // 窗口会丢弃 backgroundColor 的 alpha ('#00000000' 实际落成不透明),
      // 把 vibrancy 层整个挡死 (真机「零透明」事故)。vibrancy 窗口不设
      // backgroundColor 时 Electron 内部走透明 webContents 背景 — 官方
      // vibrancy 示例同款。调用方 (index.ts createWindow/createPopoutWindow)
      // 也不得在 spread 之外再写 backgroundColor。
      vibrancy: 'fullscreen-ui',
      visualEffectState: 'active'
    }
  }
  return { backgroundMaterial: 'acrylic' }
}

/** 运行时开关原生材质 + 回写 data-vib。solid → 关 vibrancy + 不透明底。 */
export function applyNativeSurface(win: BrowserWindow, surface: SurfaceStyle): void {
  if (win.isDestroyed()) return
  const frosted = surface === 'frosted'
  try {
    if (process.platform === 'darwin') {
      win.setVibrancy(frosted ? 'fullscreen-ui' : null)
    } else if (process.platform === 'win32' && typeof win.setBackgroundMaterial === 'function') {
      win.setBackgroundMaterial(frosted && isWin11() ? 'acrylic' : 'none')
    }
    // 透明腿不走 setBackgroundColor('#00000000') — alpha 同样被丢弃, 反而
    // 把构造时的透明背景盖死。只有切回 solid (无原生材质) 才设不透明锚;
    // solid → frosted 的运行时切换若留有不透明残留, 重启窗口即恢复
    // (构造路径已正确)。
    if (!nativeSurfaceActive(surface)) win.setBackgroundColor(OPAQUE_BG)
  } catch {
    /* 平台不支持的调用一律降级为「无原生材质」, 由下方回写让 CSS 走回退 */
  }
  win.webContents.send('appearance:vibrancyState', nativeSurfaceActive(surface))
}

export function registerAppearanceIpc(): void {
  ipcMain.on('appearance:nativeTheme', (_evt, mode: ThemeMode) => {
    if (mode !== 'system' && mode !== 'dark' && mode !== 'light') return
    nativeTheme.themeSource = mode
    writeSettings({ themeMode: mode })
  })

  // 主题 v2 — renderer applySurface 的原生材质腿。按 sender 定位窗口
  // (主窗 / popout 各自独立), 持久化后应用 + 回写 vibrancyState。
  ipcMain.on('appearance:surface', (evt, surface: unknown) => {
    if (surface !== 'frosted' && surface !== 'solid') return
    writeSettings({ surface })
    const win = BrowserWindow.fromWebContents(evt.sender)
    if (win) applyNativeSurface(win, surface)
  })

  // appearance:theme and appearance:accent are renderer→main broadcasts that
  // Island plugin forwarding will hook into (REVIEW-LOG M-01). Sprint 0 just
  // sinks them so the renderer's `window.electron.send(...)` does not warn.
  ipcMain.on('appearance:theme', () => {
    /* Sprint 0 sink; Island Sprint 2 will forward to plugin */
  })
  ipcMain.on('appearance:accent', () => {
    /* Sprint 0 sink */
  })
}
