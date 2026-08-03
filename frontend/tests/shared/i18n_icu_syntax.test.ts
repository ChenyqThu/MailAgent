import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

/**
 * i18n 占位符语法闸。
 *
 * 本项目的 i18n 走 **i18next-icu**（`src/shared/i18n/index.ts` 的 `.use(ICU)`），所以占位符是
 * ICU MessageFormat 的**单括号** `{name}` —— 不是 i18next 默认的 `{{name}}`。两者在运行时的
 * 差别是静默的：ICU 拿到 `{{name}}` 会**原样输出字面 `{{name}}`**，不报错、不警告，测试也不会
 * 红，只有用户在界面上看到一串花括号。
 *
 * 🔴 这道闸是被真事故催生的（08-02）：本批新加的 `capabilityCards.subsetHint` 按 i18next 默认
 * 语法写成了 `{{tier}}` 并已提交，靠人工复核才发现。既有 260 处单括号占位符全是对的 —— 错的
 * 是新加的那一处。
 */

const LOCALES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../src/shared/i18n/locales'
)
const LOCALES = ['zh-CN', 'en-US'] as const

/** ICU 下必错的双括号占位符：`{{name}}`。 */
const DOUBLE_BRACE = /\{\{\s*[A-Za-z_][\w.]*\s*\}\}/g

function flatten(
  node: unknown,
  path = '',
  out: Array<[string, string]> = []
): Array<[string, string]> {
  if (typeof node === 'string') {
    out.push([path, node])
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      flatten(value, path ? `${path}.${key}` : key, out)
    }
  }
  return out
}

function entriesOf(locale: string): Array<[string, string]> {
  const raw = readFileSync(resolve(LOCALES_DIR, locale, 'common.json'), 'utf-8')
  const entries = flatten(JSON.parse(raw))
  // canary：文案表缩水到疑似解析失效的量级时拦下（空表 → 下面的断言恒真）。
  expect(entries.length).toBeGreaterThan(500)
  return entries
}

describe('i18n placeholder syntax (ICU, not i18next default)', () => {
  test.each(LOCALES)('%s has no {{double-brace}} placeholders', (locale) => {
    // 🔴 每条新建 RegExp：带 /g 的正则 `.test()` 会推进 lastIndex，复用同一个对象会**隔条漏报**
    // （本闸初版就栽在这，第一轮只报出两个 offender 里的一个）。
    const offenders = entriesOf(locale)
      .filter(([, text]) => new RegExp(DOUBLE_BRACE.source).test(text))
      .map(([path, text]) => `${path}: ${text}`)
    expect(
      offenders,
      '这些文案用了 i18next 默认的 {{name}} 语法，但本项目走 i18next-icu —— ICU 会原样输出\n' +
        '字面花括号（不报错、不警告）。改成 ICU 单括号 {name}：\n  ' +
        offenders.join('\n  ')
    ).toEqual([])
  })

  test('both locales declare the same placeholder set per key', () => {
    // 顺带钉住另一个静默形态：某语言漏了占位符 → 该语言少显示一段信息，也不会报错。
    const single = /\{\s*([A-Za-z_][\w]*)\s*[,}]/g
    const [zh, en] = LOCALES.map((l) => new Map(entriesOf(l)))
    const drift: string[] = []
    for (const [key, zhText] of zh) {
      const enText = en.get(key)
      if (enText === undefined) continue // 缺 key 是另一个问题，不归本闸
      const names = (t: string): string[] => [...t.matchAll(single)].map((m) => m[1]).sort()
      const a = names(zhText)
      const b = names(enText)
      if (JSON.stringify(a) !== JSON.stringify(b)) drift.push(`${key}: zh=${a} en=${b}`)
    }
    expect(drift, `两语言占位符集合不一致：\n  ${drift.join('\n  ')}`).toEqual([])
  })
})
