// @vitest-environment happy-dom
//
// Sprint 11 V1.4 — useNavCollapsed store test.
//
// Covers: toggle round-trip, setCollapsed direct write, cross-window
// storage-event reactivity (the listener that keeps pop-out windows in
// sync with the main inbox window).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { useNavCollapsed } from '../../src/shared/state/nav-shell'

const KEY = 'mailagent.nav.panelCollapsed'

// happy-dom's Storage shape varies across versions (some builds drop
// getItem/removeItem). We only need to verify store mutation semantics
// here — the localStorage path inside nav-shell.ts is wrapped in try-catch
// and exercised at runtime in the Electron renderer.
function resetState(): void {
  useNavCollapsed.setState({ collapsed: false })
}

describe('useNavCollapsed', () => {
  beforeEach(resetState)
  afterEach(resetState)

  test('toggle flips state', () => {
    expect(useNavCollapsed.getState().collapsed).toBe(false)
    useNavCollapsed.getState().toggle()
    expect(useNavCollapsed.getState().collapsed).toBe(true)
    useNavCollapsed.getState().toggle()
    expect(useNavCollapsed.getState().collapsed).toBe(false)
  })

  test('setCollapsed writes directly', () => {
    useNavCollapsed.getState().setCollapsed(true)
    expect(useNavCollapsed.getState().collapsed).toBe(true)
    useNavCollapsed.getState().setCollapsed(false)
    expect(useNavCollapsed.getState().collapsed).toBe(false)
  })

  test('storage event from another window updates the store', () => {
    expect(useNavCollapsed.getState().collapsed).toBe(false)
    // Simulate the event that fires when a DIFFERENT renderer window
    // writes the same key — same `key` + `newValue` shape that the real
    // browser ships when a sibling window mutates localStorage.
    window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: 'true' }))
    expect(useNavCollapsed.getState().collapsed).toBe(true)
  })

  test('storage event for a different key is ignored', () => {
    useNavCollapsed.getState().setCollapsed(true)
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'mailagent.unrelated',
        newValue: 'false'
      })
    )
    expect(useNavCollapsed.getState().collapsed).toBe(true)
  })

  test('storage event with the same value is a no-op (idempotent)', () => {
    useNavCollapsed.getState().setCollapsed(true)
    const before = useNavCollapsed.getState().collapsed
    window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: 'true' }))
    expect(useNavCollapsed.getState().collapsed).toBe(before)
  })
})

// ── 左列总宽的一致性闸（authored CSS ↔ TS 常量）────────────────────────────
//
// 08-27 标签工作区批的头条不变量是「切域时左列边界不动」，它压在三个手抄的数字上：
// `.nav-rail`(56) + `.nav-panel`/`.nav-panel-inner`(336) 在 index.css，`NAV_W_EXPANDED`
// (392) 在 nav-shell.ts（喂 `--app-nav-w`，`#batch-bar.floating` 靠它对齐）。TS 读不到
// authored CSS，只能建闸：改一处不改另一处这里必红。
//
// 🔴 抽取失败也必须红 —— 下面三个正则任一抽不到就是 CSS 结构变了，不许静默放过。
describe('左列宽度 —— index.css ↔ NAV_W_EXPANDED', () => {
  // 同 ComposeEditor / chat_fab_avatar 两条既有 CSS 闸的取文件方式（cwd = frontend）。
  const css = readFileSync(resolve(process.cwd(), 'src/electron/renderer/index.css'), 'utf8')

  function widthOf(selector: string): number {
    const m = new RegExp(`\\${selector}\\s*\\{[^}]*?width:\\s*(\\d+)px`, 's').exec(css)
    expect(m, `${selector} 的 width 抽不到 —— index.css 结构变了，先修这个闸`).toBeTruthy()
    return Number(m?.[1])
  }

  test('rail(56) + panel(336) = --app-nav-w 展开值(392)，且 panel 与 inner 同宽', () => {
    const rail = widthOf('.nav-rail')
    const panel = widthOf('.nav-panel')
    const inner = widthOf('.nav-panel-inner')
    // inner 定宽是折叠过渡期间行不换行的前提 —— 只改一处过渡期间列会错位。
    expect(inner, '.nav-panel 与 .nav-panel-inner 必须同宽').toBe(panel)

    useNavCollapsed.getState().setCollapsed(false)
    expect(document.documentElement.style.getPropertyValue('--app-nav-w')).toBe(`${rail + panel}px`)
    useNavCollapsed.getState().setCollapsed(true)
    expect(document.documentElement.style.getPropertyValue('--app-nav-w')).toBe(`${rail}px`)
  })
})
