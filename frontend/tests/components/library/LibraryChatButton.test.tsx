// @vitest-environment happy-dom
//
// 资料库预览面的「对话」按钮（task 09-03 P2-L14；design §9.4 「资料库页 dock」+ 拍板 L16）。
//
// L16：**不加 `ConversationContextSource` 第五档**（环境态盖过显式声明 = 0812 chip 串味 bug），
// 这条按钮走显式声明那条路 —— 预置一枚与用户自己 @ 出来**逐字一样**的库文件提及。
// 「逐字一样」有两半，缺一半功能就是坏的，所以两半都钉：
//   ① composer 正文里那段 directive（`:library[名]{name=library-42}`）—— 它让
//      `parseComposerMentionIds` 认得这枚 chip；正文里没有它，AgentComposer 的对账下一拍就把
//      引用摘了（那条对账是隐私地板，不能绕）。
//   ② 交给 store 的 `LibraryMentionRef` —— 信封（`buildLibraryMentionEnvelope`）靠它。
//      🔴 只发标识四件，**不发正文**：库里存着邮件附件，正文当可信元数据注入等于绕过围栏。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { parseComposerMentionIds } from '@shared/components/agents/agentMention'
import {
  buildLibraryChatPrompt,
  libraryMentionRefOf,
  libraryMentionText
} from '@shared/components/library/libraryChat'
import { buildLibraryMentionEnvelope } from '@shared/lib/mention-context'
import { startLibraryChatWithPrompt, useAIChatPanel } from '@shared/state/ai-chat-panel'
import type { LibraryFile } from '@shared/api/types/library'

const FILE = {
  id: 42,
  path: 'my-docs/plans/定价.md',
  filename: '定价.md',
  size_bytes: 900
} as Pick<LibraryFile, 'id' | 'path' | 'filename' | 'size_bytes'>

/** 假 t：把 `{x}` 直接换成值，形状与 i18next 的插值一致，不依赖 locale 是否已落地。 */
const t = (key: string, vars: Record<string, string>): string =>
  Object.entries(vars).reduce((out, [k, v]) => out.replaceAll(`{${k}}`, v), `${key}|{mention}|{path}`)

beforeEach(() => {
  useAIChatPanel.setState({ pendingPrompt: null })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('P2-L14 资料库「对话」按钮', () => {
  test('行对象 → 提及四件（不含正文 / snippet）', () => {
    const ref = libraryMentionRefOf(FILE)
    expect(ref).toEqual({
      file_id: 42,
      path: 'my-docs/plans/定价.md',
      name: '定价.md',
      size_bytes: 900
    })
    // 投影行（邮件附件）没有 library id ⇒ 提及不出来（`library_read` 对它结构上不可调）。
    expect(libraryMentionRefOf({ ...FILE, id: null })).toBeNull()
  })

  test('🔴 预置的指令正文里是**真的 directive**：composer 的解析器认得这枚 chip', () => {
    const ref = libraryMentionRefOf(FILE)!
    const prompt = buildLibraryChatPrompt(ref, t)
    expect(prompt).toContain(libraryMentionText(ref))
    // 这一条是全套的地基：解析不出 id ⇒ 对账把引用当「chip 已被删」当场摘掉。
    expect(parseComposerMentionIds(prompt).libraryIds.has(42)).toBe(true)
  })

  test('信封只发标识四件，不含正文字段', () => {
    const envelope = buildLibraryMentionEnvelope([libraryMentionRefOf(FILE)!])
    expect(envelope).toContain('id="42"')
    expect(envelope).toContain('my-docs/plans/定价.md')
    expect(envelope).not.toContain('snippet')
  })

  test('按钮 = 展开 dock + 递一条带这枚提及的指令（同一个 nonce 生命周期）', () => {
    const ref = libraryMentionRefOf(FILE)!
    startLibraryChatWithPrompt(ref, buildLibraryChatPrompt(ref, t))
    const state = useAIChatPanel.getState()
    expect(state.visible).toBe(true)
    // 🔴 提及挂在 pendingPrompt 上，不是另一条 pending 通道 —— 两条通道就有两个生命周期，
    // 落单的那条会在之后某次重挂时把引用注入进一场无关的对话。
    expect(state.pendingPrompt?.library).toEqual(ref)
    expect(state.pendingPrompt?.text).toContain(libraryMentionText(ref))
    // 不带邮件：这条指令不等任何邮件 chip 就位。
    expect(state.pendingPrompt?.emailId).toBeNull()
    // 事项身份不继承（与 startChatWithPrompt 同姿态）。
    expect(state.matterTarget).toBeNull()
  })
})
