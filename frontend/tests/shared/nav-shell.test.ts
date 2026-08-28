// 左列宽度的一致性闸（authored CSS 三处手抄互锁）。
//
// 08-27 dogfood 修正批：二级栏折叠能力整体移除（useNavCollapsed store 随之删除，
// 原本这里的 toggle / setCollapsed / storage 五条用例一并退场），`--app-nav-w`
// 从「store 按收起态写入的 CSS 变量」降为 index.css 的静态 token。剩下的不变量
// 只有一条，也正是那一批的头条：**左列总宽恒 392，切域时边界不动**。
//
// 它压在三个手抄的数字上：`.nav-rail`(56) + `.nav-panel`/`.nav-panel-inner`(336)
// 与 `:root` 的 `--app-nav-w`(392) —— 后者是 `.topbar-left`（顶栏左段与左列共宽）
// 和 `#batch-bar.floating`（portal 到 body、量不到左列）唯一能读到的宽度。
// TS 读不到 authored CSS，只能建闸：改一处不改另一处这里必红。
//
// 🔴 抽取失败也必须红 —— 下面的正则任一抽不到就是 CSS 结构变了，不许静默放过。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, test } from 'vitest'

describe('左列宽度 —— index.css 内部三处手抄', () => {
  // 同 ComposeEditor / chat_fab_avatar 两条既有 CSS 闸的取文件方式（cwd = frontend）。
  const css = readFileSync(resolve(process.cwd(), 'src/electron/renderer/index.css'), 'utf8')

  function widthOf(selector: string): number {
    const m = new RegExp(`\\${selector}\\s*\\{[^}]*?width:\\s*(\\d+)px`, 's').exec(css)
    expect(m, `${selector} 的 width 抽不到 —— index.css 结构变了，先修这个闸`).toBeTruthy()
    return Number(m?.[1])
  }

  /** `:root` 里的 `--app-nav-w: 392px`（静态 token，没有 JS 写入路径了）。 */
  function navWidthToken(): number {
    const m = /--app-nav-w:\s*(\d+)px/.exec(css)
    expect(m, '--app-nav-w 抽不到 —— token 被改名或删了，先修这个闸').toBeTruthy()
    return Number(m?.[1])
  }

  test('rail(56) + panel(336) = --app-nav-w(392)，且 panel 与 inner 同宽', () => {
    const rail = widthOf('.nav-rail')
    const panel = widthOf('.nav-panel')
    const inner = widthOf('.nav-panel-inner')
    // inner 定宽是「面板 overflow:hidden 时行不换行不挤压」的前提。
    expect(inner, '.nav-panel 与 .nav-panel-inner 必须同宽').toBe(panel)
    expect(navWidthToken(), '--app-nav-w 必须等于 rail + panel').toBe(rail + panel)
  })

  test('顶栏左段内容宽 = --app-nav-w（.topbar-left-inner 与左列共宽，右缘 hairline 共线）', () => {
    expect(widthOf('.topbar-left-inner')).toBe(navWidthToken())
  })
})
