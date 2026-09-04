// 资料库 i18n 的**动态 key 子树**闸（dogfood 0903 owner 反馈第 4 件的防回归）。
//
// 起因：`FilePreview` 用 `t(\`library.common.app.${app}\`)` 渲染「用 X 打开」，而
// `library.common.app` 这整棵子树两个 locale 里都不存在 —— i18next 于是原样吐出
// `library.common.app.excel`，用户看到的按钮字面写着一个 key。`library.common.kind.*`
// （文件类别徽标）也是同一片缺口，只是没人报。
//
// 🔴 为什么静态扫描抓不到：模板字符串拼出来的 key 在源码里只有前缀，任何「grep 用到的 key
// 是否都在 locale 里」的检查都会跳过它们。所以判据必须反过来 —— 从**值域**（`KINDS` /
// `OPEN_WITH_APPS`，两份都是零依赖叶子里的运行时数组）出发逐个查表。
//
// 两层断言各有各的用处：
//   ① 直接读 locale JSON —— 不受 i18next fallback 影响，缺了就是缺了；
//   ② 过一遍真 `i18n.t` —— 用户看见的就是它的返回值，「返回值等于 key」就是这次的 bug 形态。

import { beforeAll, describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import i18n from '@shared/i18n'
import { KINDS } from '@shared/libraryConstants'
import { OPEN_WITH_APPS } from '@shared/components/library/fileMeta'

const LOCALES = ['zh-CN', 'en-US'] as const

function localeJson(locale: string): Record<string, unknown> {
  const path = resolve(__dirname, `../../../src/shared/i18n/locales/${locale}/common.json`)
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function lookup(tree: Record<string, unknown>, key: string): unknown {
  let node: unknown = tree
  for (const segment of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[segment]
  }
  return node
}

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN')
})

describe('资料库 i18n 的动态 key 子树', () => {
  test.each(LOCALES)('%s：每个 kind 都有 library.common.kind.<kind>', (locale) => {
    const tree = localeJson(locale)
    for (const kind of KINDS) {
      expect(lookup(tree, `library.common.kind.${kind}`), `缺 ${locale} 的 kind.${kind}`).toEqual(
        expect.any(String)
      )
    }
  })

  test.each(LOCALES)('%s：每个「用 X 打开」的 X 都有 library.common.app.<app>', (locale) => {
    const tree = localeJson(locale)
    for (const app of OPEN_WITH_APPS) {
      expect(lookup(tree, `library.common.app.${app}`), `缺 ${locale} 的 app.${app}`).toEqual(
        expect.any(String)
      )
    }
  })

  test.each(LOCALES)('%s：源码里点名过、但不在任何值域里的散 key 也在', (locale) => {
    const tree = localeJson(locale)
    // 这三条是同一批漏网的：废纸篓空态两句（FolderView）与检索的兜底告警（paletteLibrary）。
    for (const key of [
      'library.trash.emptyTitle',
      'library.trash.emptyHint',
      'library.search.warnGeneric'
    ]) {
      expect(lookup(tree, key), `缺 ${locale} 的 ${key}`).toEqual(expect.any(String))
    }
  })

  test('🔴 t() 不再原样吐 key —— 用户看见的就是它的返回值', () => {
    for (const kind of KINDS) {
      const key = `library.common.kind.${kind}`
      expect(i18n.t(key)).not.toBe(key)
    }
    for (const app of OPEN_WITH_APPS) {
      const key = `library.common.app.${app}`
      expect(i18n.t(key)).not.toBe(key)
    }
  })

  test.each(LOCALES)('🔴 %s 的「对话」预置指令里必须留着 {mention} 占位符', (locale) => {
    // 占位符没了 = `buildLibraryChatPrompt` 拼不出 directive ⇒ composer 里没有 chip ⇒
    // AgentComposer 的对账把那枚引用当「chip 已被删」摘掉 ⇒ 资料根本没进上下文。
    // 这正是 0903 owner 报的「对话没把资料注入」。ICU 占位符是**单花括号**。
    const prompt = lookup(localeJson(locale), 'library.chat.prompt')
    expect(prompt).toEqual(expect.any(String))
    expect(prompt as string).toContain('{mention}')
    expect(prompt as string).not.toContain('{{mention}}')
  })
})
