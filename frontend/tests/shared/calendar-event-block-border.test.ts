// task 08-27 F24 — 日/周 EventBlock (`.evt`) 边框造型对齐月视图 `.m-evt` 的防复发闸。
//
// 根因（见 research/r9-calendar-event-visual-audit.md）：月视图重做（P3, `54f7ca06`）与
// 日/周重做（lane-day-week, `7980f30d`）各自的验收范围都只圈定「数据/颜色源统一」，从未把
// 「EventBlock 的边框造型是否等价于 .m-evt 的 border:0」列进验收 —— owner 因此连续三轮反馈
// 同一件事（白/极浅底 + ~2px 蓝色粗描边）。改动本身是 CSS-only 的属性对齐，容易在下一次
// 「顺手改点样式」时被无意中加回一行 border，且没有任何自动化闸会发现。
//
// 断言方式：直接读 index.css 源文本（TS 读不到 authored CSS，只能建文本级闸），定位
// `.evt` 家族规则块（含状态形态化 TENTATIVE/NEEDS-ACTION/DECLINED/CANCELLED），确认
// 里面不再出现任何真实 border 声明（`border: 0` 除外）。
//
// 🔴 抽取失败也必须红 —— 定位锚点抽不到就是 CSS 结构变了，不许静默放过。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, test } from 'vitest'

describe('.evt 家族（日/周时间轴事件块）不得出现真实 border', () => {
  // 同 nav-shell.test.ts / chat_fab_avatar.test.tsx 两条既有 CSS 闸的取文件方式（cwd = frontend）。
  const css = readFileSync(resolve(process.cwd(), 'src/electron/renderer/index.css'), 'utf8')

  function extractEvtFamilyBlock(): string {
    const start = css.indexOf('.evt {')
    expect(start, '.evt 基础规则抽不到 —— index.css 结构变了，先修这个闸').toBeGreaterThanOrEqual(0)
    // `.evt-join` 是块内 hover 浮出的独立按钮组件，不属于「事件块本体」的边框造型范围，
    // 拿它当 .evt 家族（含 TENTATIVE/NEEDS-ACTION/DECLINED/CANCELLED 状态形态化）的右边界。
    const end = css.indexOf('.evt-join {', start)
    expect(
      end,
      '.evt-join 抽不到（用作 .evt 家族边界锚点）—— index.css 结构变了，先修这个闸'
    ).toBeGreaterThan(start)
    return css.slice(start, end)
  }

  test('.evt 基础态 border:0，radius 与 .m-evt 同档 (5px)', () => {
    const block = extractEvtFamilyBlock()
    expect(block).toMatch(/\.evt\s*\{[^}]*border:\s*0;/s)
    expect(block).toMatch(/\.evt\s*\{[^}]*border-radius:\s*5px;/s)
  })

  test('.evt 家族（含状态形态化）不含任何真实 border 声明', () => {
    const block = extractEvtFamilyBlock()

    // 匹配所有 border / border-left / border-color / border-style / border-width 等
    // CSS 声明（要求紧跟冒号，避免误命中中文注释里散落的 "border" 字样）；
    // border-radius 是圆角不是描边，显式排除。
    const declRe = /\bborder(?!-radius)(?:-[a-z]+)*\s*:\s*([^;]+);/g
    const offenders: string[] = []
    let match: RegExpExecArray | null
    while ((match = declRe.exec(block))) {
      const full = match[0]
      const value = match[1].trim()
      const isBareZero = /^border\s*:/.test(full) && value === '0'
      if (!isBareZero) offenders.push(full)
    }

    expect(offenders, `.evt 家族仍有真实 border 声明: ${JSON.stringify(offenders)}`).toEqual([])
  })

  test('状态形态化用 inset box-shadow / 渐变底纹承载，不用真实描边', () => {
    const block = extractEvtFamilyBlock()
    // NEEDS-ACTION：inset 环 + wash 底（不是透明底 —— 透明底正是「白底粗框」的来源）。
    expect(block).toMatch(/\[data-resp='NEEDS-ACTION'\]\s*\{[^}]*box-shadow:\s*inset/s)
    expect(block).toMatch(
      /\[data-resp='NEEDS-ACTION'\]\s*\{[^}]*background:\s*rgb\(var\(--src\)\s*\/\s*0\.15\);/s
    )
  })
})
