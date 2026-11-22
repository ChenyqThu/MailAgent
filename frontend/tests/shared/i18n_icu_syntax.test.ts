import { describe, expect, test } from 'vitest'

import { loadLocaleDict, loadLocaleFiles, type SupportedLocale } from '../helpers/loadLocale'

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

function entriesOf(locale: SupportedLocale): Array<[string, string]> {
  const entries = flatten(loadLocaleDict(locale))
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

describe('i18n domain split integrity', () => {
  test('zh-CN and en-US expose identical domain JSON file sets', () => {
    const zhFiles = loadLocaleFiles('zh-CN').map((f) => f.file)
    const enFiles = loadLocaleFiles('en-US').map((f) => f.file)
    expect(zhFiles.length).toBeGreaterThanOrEqual(9)
    expect(zhFiles).toEqual(enFiles)
  })

  test('domain JSON files have zero top-level collisions and full leaf-key parity per file', () => {
    const zhFiles = loadLocaleFiles('zh-CN')
    const enByFile = new Map(loadLocaleFiles('en-US').map((f) => [f.file, f]))
    const zhDict = loadLocaleDict('zh-CN')
    const enDict = loadLocaleDict('en-US')
    expect(Object.keys(zhDict).sort()).toEqual(Object.keys(enDict).sort())
    expect(Object.keys(zhDict).length).toBeGreaterThanOrEqual(54)

    for (const zhFile of zhFiles) {
      const enFile = enByFile.get(zhFile.file)
      expect(enFile, `en-US missing domain file ${zhFile.file}`).toBeDefined()
      const zhKeys = flatten(zhFile.data)
        .map(([k]) => k)
        .sort()
      const enKeys = flatten(enFile!.data)
        .map(([k]) => k)
        .sort()
      expect(zhKeys, `${zhFile.file}: zh-CN vs en-US leaf keys drifted`).toEqual(enKeys)
    }
  })
})
