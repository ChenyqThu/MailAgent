// @vitest-environment happy-dom
//
// nav shell 的两组闸（task 09-01-sidebar-fluid-optimization）：
//
// A. 左列宽度的一致性闸（authored CSS 手抄互锁）。
//    08-27 修正批把折叠删掉后这里只剩「左列恒 392」一条；09-01 批按域折叠 / 拖宽回来了，
//    不变量变成：`.nav-rail`(56) + `--app-second-w` 默认(336) = `--app-nav-w` 默认(392)，
//    且 `.nav-panel` / `.nav-panel-inner` / `.topbar-left` 都读变量而不是手抄 336 / 392；两个
//    变量用 @property 注册并在 :root 上挂过渡（design.md §2.3）。
//    🔴 抽取失败也必须红 —— 正则任一抽不到就是 CSS 结构变了，不许静默放过。
//
// B. store（state/nav-shell.ts）：每域独立的 {collapsed,width}、clamp、持久化键与形状、
//    切域回放写变量、跨窗 storage 回灌、`--app-nav-w` **只有一处写入**（源码文本闸）。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { isWebBuild, resolveBuildTarget } from '../../src/shared/lib/buildTarget'
import {
  __resetNavShellForTest,
  clampSecondWidth,
  domainPref,
  NAV_SHELL_STORAGE_KEY,
  navWidths,
  RAIL_W,
  SECOND_W_DEFAULT,
  SECOND_W_MAX,
  SECOND_W_MIN,
  useNavShell
} from '../../src/shared/state/nav-shell'

const css = readFileSync(resolve(process.cwd(), 'src/electron/renderer/index.css'), 'utf8')

function mustMatch(re: RegExp, what: string): RegExpExecArray {
  const m = re.exec(css)
  expect(m, `${what} 抽不到 —— index.css 结构变了，先修这个闸`).toBeTruthy()
  return m as RegExpExecArray
}

describe('左列宽度 —— index.css 手抄互锁', () => {
  test('rail(56) + --app-second-w 默认(336) = --app-nav-w 默认(392)，与 store 常量一致', () => {
    const rail = Number(mustMatch(/\.nav-rail\s*\{[^}]*?width:\s*(\d+)px/s, '.nav-rail width')[1])
    const second = Number(mustMatch(/--app-second-w:\s*(\d+)px/, '--app-second-w 默认值')[1])
    const nav = Number(mustMatch(/--app-nav-w:\s*(\d+)px/, '--app-nav-w 默认值')[1])
    expect(rail).toBe(RAIL_W)
    expect(second).toBe(SECOND_W_DEFAULT)
    expect(nav).toBe(rail + second)
    // @property 的 initial-value 也是同一份数（第三处手抄）。
    expect(
      Number(
        mustMatch(/@property --app-nav-w\s*\{[^}]*?initial-value:\s*(\d+)px/s, '@property nav')[1]
      )
    ).toBe(nav)
    expect(
      Number(
        mustMatch(
          /@property --app-second-w\s*\{[^}]*?initial-value:\s*(\d+)px/s,
          '@property second'
        )[1]
      )
    ).toBe(second)
  })

  test('.nav-panel / .nav-panel-inner / .nav-second-col 读 --app-second-w，.topbar-left 读 --app-nav-w', () => {
    for (const sel of [
      '.nav-panel',
      '.nav-panel-inner',
      '.nav-second-col',
      '.nav-second-col-inner'
    ]) {
      const block = mustMatch(
        new RegExp(`\\n${sel.replace('.', '\\.')}\\s*\\{([^}]*)\\}`, 's'),
        sel
      )[1]
      expect(block, `${sel} 必须读变量而不是手抄像素`).toMatch(/width:\s*var\(--app-second-w/)
    }
    const topbar = mustMatch(/\n\.topbar-left\s*\{([^}]*)\}/s, '.topbar-left')[1]
    expect(topbar).toMatch(/width:\s*var\(--app-nav-w/)
    // 🔴 内层也必须跟随：定宽 392 时二级栏拖窄到 280（左列 336）会被 .topbar-left 的
    // overflow:hidden 裁掉行尾控件簇（「?」与亮暗钮），拖宽则簇与右缘 hairline 脱节。
    const topbarInner = mustMatch(/\n\.topbar-left-inner\s*\{([^}]*)\}/s, '.topbar-left-inner')[1]
    expect(topbarInner, '.topbar-left-inner 必须跟随 --app-nav-w，不能手抄 392').toMatch(
      /width:\s*var\(--app-nav-w/
    )
  })

  // 0902 dogfood 轮 1 修的两条几何：peek 被折叠规则连坐、折叠态红绿灯压标签条。
  test('折叠隐藏只作用常驻 .nav-panel（子代组合器）—— peek 变体在同一个 .app-nav 下', () => {
    const block = mustMatch(
      /\n\.app-nav\[data-collapsed='true'\]\s*>\s*\.nav-panel\s*\{([^}]*)\}/s,
      '折叠隐藏规则（子代组合器）'
    )[1]
    expect(block).toMatch(/visibility:\s*hidden/)
    // 🔴 后代选择器会把浮层里那份 DomainPanel（.nav-panel--peek，同在 .app-nav 内）一起
    // 隐藏，且特异度 (0,2,0) 压过 .nav-panel--peek —— 「折叠态 hover 今日/日历/运维/设置
    // 一片空白」的真因。常驻那份是 .app-nav 的直接子节点，子代组合器正好把两者分开。
    expect(css, '折叠隐藏不许退回后代选择器').not.toMatch(
      /\.app-nav\[data-collapsed='true'\]\s+\.nav-panel[\s,{]/
    )
  })

  test('.topbar-left 非抽屉态保底 80 —— 折叠后红绿灯不压标签条', () => {
    const block = mustMatch(
      /\n\.topbar-left:not\(\[data-nav-mode='drawer'\]\)\s*\{([^}]*)\}/s,
      '.topbar-left 非抽屉态宽度'
    )[1]
    const m = /width:\s*max\(var\(--app-nav-w,\s*(\d+)px\),\s*(\d+)px\)/.exec(block)
    expect(m, '非抽屉态宽度必须是 max(var(--app-nav-w, 兜底), 保底)').toBeTruthy()
    const [, fallback, floor] = m as RegExpExecArray
    expect(Number(fallback)).toBe(RAIL_W + SECOND_W_DEFAULT)
    // 保底值必须盖住 TitleBar 里那 72px 红绿灯占位 + 8px 间隙（两处手抄，这里互锁）。
    const titleBar = readFileSync(
      resolve(process.cwd(), 'src/shared/components/layout/TitleBar.tsx'),
      'utf8'
    )
    const lights = /w-\[(\d+)px\] shrink-0" aria-hidden/.exec(titleBar)
    expect(lights, 'TitleBar 的红绿灯占位抽不到 —— 先修这个闸').toBeTruthy()
    expect(Number(floor)).toBeGreaterThanOrEqual(Number((lights as RegExpExecArray)[1]) + 8)
    // 80 的右缘与 rail 的 56 边界错位 ⇒ 折叠态不画那条竖 hairline。
    expect(css).toMatch(
      /\.topbar-left\[data-collapsed='true'\]\s*\{[^}]*border-right-color:\s*transparent/s
    )
  })

  test(':root 上挂了两个变量的过渡；拖拽 / reduced-motion 关', () => {
    const rootTransition = mustMatch(/:root\s*\{\s*transition:\s*([^;]+);/s, ':root transition')[1]
    expect(rootTransition).toMatch(/--app-nav-w 220ms var\(--ease-out-strong\)/)
    expect(rootTransition).toMatch(/--app-second-w 220ms var\(--ease-out-strong\)/)
    expect(css).toMatch(/:root\[data-nav-dragging\]\s*\{\s*transition:\s*none;/)
    const reduced = mustMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*:root,[^}]*\}/s,
      'reduced-motion :root'
    )[0]
    expect(reduced).toMatch(/transition:\s*none/)
  })
})

describe('nav-shell store —— 每域一份记忆', () => {
  beforeEach(() => __resetNavShellForTest())
  afterEach(() => __resetNavShellForTest())

  const vars = (): { nav: string; second: string } => ({
    nav: document.documentElement.style.getPropertyValue('--app-nav-w'),
    second: document.documentElement.style.getPropertyValue('--app-second-w')
  })

  test('默认：每域展开 336，变量 392 / 336（与 v2.31.1 逐像素一致）', () => {
    expect(domainPref({}, 'today')).toEqual({ collapsed: false, width: SECOND_W_DEFAULT })
    expect(vars()).toEqual({ nav: '392px', second: '336px' })
  })

  test('折叠按域独立：today 折叠不影响 ops；切回 today 回放折叠态', () => {
    const s = useNavShell.getState()
    s.setDomain('today')
    s.toggleCollapsed()
    expect(vars()).toEqual({ nav: '56px', second: '0px' })
    s.setDomain('ops')
    expect(domainPref(useNavShell.getState().prefs, 'ops').collapsed).toBe(false)
    expect(vars()).toEqual({ nav: '392px', second: '336px' })
    s.setDomain('today')
    expect(vars()).toEqual({ nav: '56px', second: '0px' })
    expect(useNavShell.getState().peekDomain).toBeNull()
  })

  test('setWidth 夹在 280–420；resetWidth 回 336；只写当前域时才动变量', () => {
    const s = useNavShell.getState()
    s.setDomain('matters')
    s.setWidth('matters', 396)
    expect(vars().second).toBe('396px')
    expect(vars().nav).toBe('452px')
    s.setWidth('matters', 100)
    expect(domainPref(useNavShell.getState().prefs, 'matters').width).toBe(SECOND_W_MIN)
    s.setWidth('matters', 9999)
    expect(domainPref(useNavShell.getState().prefs, 'matters').width).toBe(SECOND_W_MAX)
    // 改别的域不碰变量
    s.setWidth('mail', 300)
    expect(vars().second).toBe(`${SECOND_W_MAX}px`)
    s.resetWidth('matters')
    expect(vars()).toEqual({ nav: '392px', second: '336px' })
    expect(clampSecondWidth(Number.NaN)).toBe(SECOND_W_DEFAULT)
  })

  test('持久化：新键 mailagent.nav.domainPrefs，JSON map，只含写过的域', () => {
    const s = useNavShell.getState()
    s.setCollapsed('calendar', true)
    s.setWidth('mail', 300)
    const raw = window.localStorage.getItem(NAV_SHELL_STORAGE_KEY)
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw ?? '{}')).toEqual({
      calendar: { collapsed: true, width: 336 },
      mail: { collapsed: false, width: 300 }
    })
    // 语义已换（单布尔 → 每域 map），老键有意不迁也不写。
    expect(window.localStorage.getItem('mailagent.nav.panelCollapsed')).toBeNull()
  })

  test('跨窗 storage 事件回灌：另一窗写的记忆立刻生效并重算变量', () => {
    useNavShell.getState().setDomain('settings')
    window.localStorage.setItem(
      NAV_SHELL_STORAGE_KEY,
      JSON.stringify({ settings: { collapsed: true, width: 410 } })
    )
    window.dispatchEvent(new StorageEvent('storage', { key: NAV_SHELL_STORAGE_KEY }))
    expect(domainPref(useNavShell.getState().prefs, 'settings')).toEqual({
      collapsed: true,
      width: 410
    })
    expect(vars()).toEqual({ nav: '56px', second: '0px' })
  })

  test('抽屉态：顶栏左段 44、第二列按记忆宽（它在抽屉里可见）', () => {
    expect(navWidths({ mail: { collapsed: true, width: 300 } }, 'mail', 'drawer')).toEqual({
      second: 300,
      nav: 44
    })
    expect(navWidths({ mail: { collapsed: true, width: 300 } }, 'mail', 'fixed')).toEqual({
      second: 0,
      nav: RAIL_W
    })
  })

  test('折叠 / 切域 / 切形态都会收掉 peek；拖拽给 html 挂 data-nav-dragging', () => {
    const s = useNavShell.getState()
    s.openPeek('today')
    expect(useNavShell.getState().peekDomain).toBe('today')
    s.toggleCollapsed()
    expect(useNavShell.getState().peekDomain).toBeNull()
    s.openPeek('today')
    s.setMode('drawer')
    expect(useNavShell.getState().peekDomain).toBeNull()
    s.setDragging(true)
    expect(document.documentElement.hasAttribute('data-nav-dragging')).toBe(true)
    s.setDragging(false)
    expect(document.documentElement.hasAttribute('data-nav-dragging')).toBe(false)
  })
})

describe('--app-nav-w 唯一写入点（源码文本闸）', () => {
  test("全仓 src 只有 state/nav-shell.ts 一处 setProperty('--app-nav-w'", () => {
    const { execSync } = require('node:child_process') as typeof import('node:child_process')
    const out = execSync('grep -rl "setProperty(\'--app-nav-w\'" src || true', {
      cwd: process.cwd(),
      encoding: 'utf8'
    })
    const files = out.split('\n').filter(Boolean).sort()
    expect(files).toEqual(['src/shared/state/nav-shell.ts'])
  })
})

// Sidebar 的抽屉判据是 `isWebBuild() && belowMd` —— 桌面主窗 minWidth 940 永远不 <768，
// 但 Electron 里把窗口拖不到那么窄不是保证，判据的另一半必须真的挡住。
describe('buildTarget —— <768 抽屉只在 web build 生效', () => {
  afterEach(() => vi.unstubAllEnvs())

  test('缺省 / electron 都不是 web；只有 VITE_BUILD_TARGET=web 才是', () => {
    vi.stubEnv('VITE_BUILD_TARGET', '')
    expect(isWebBuild()).toBe(false)
    vi.stubEnv('VITE_BUILD_TARGET', 'electron')
    expect(resolveBuildTarget()).toBe('electron')
    expect(isWebBuild()).toBe(false)
    vi.stubEnv('VITE_BUILD_TARGET', 'web')
    expect(resolveBuildTarget()).toBe('web')
    expect(isWebBuild()).toBe(true)
  })
})
