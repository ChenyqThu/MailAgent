// 资料库预览面「对话」按钮的那条预置指令（design §9.4 表里「资料库页 dock」那行 + L16）。
//
// 🔴 **不加 `ConversationContextSource` 第五档**（L16）：那四档是互斥单值、原则是「环境态永远
// 不能盖过显式声明」。给资料库页加一档 = 用户明明在跟某封邮件 / 某件事说话，只因为人站在
// 资料库页上就被换了身份 —— 0812 的 chip 串味 bug 就是这么来的。所以这条按钮走的是**显式
// 声明**那条路：预置一枚 `@` 提及，与用户自己在 composer 里 @ 出来的一模一样。
//
// 「一模一样」是逐字的：提及在 composer 里就是一段 directive 文本
// （`:library[文件名]{name=library-42}`，assistant-ui 的默认 formatter 序列化形状），id 前缀
// 由 `agentMention.ts::libraryMentionItemId` 给。两处都**只 import 不改**：
//   · 文本里有 directive ⇒ AgentComposer 那条「chip 被删就摘掉 mention」的对账认得它，
//     用户删掉 chip 时引用同样作废（隐私地板）；
//   · 同时把 `LibraryMentionRef` 交给 store，AgentConversation 用既有的 `onAddLibraryMention`
//     记进会随发送注入的那份列表 —— 信封只发标识四件（id / path / name / size），**不发正文**：
//     库里存着邮件附件，把正文当可信元数据注入等于绕过 `~~~email-excerpt` 围栏。模型要正文
//     自己调 `library_read`。

import { unstable_defaultDirectiveFormatter } from '@assistant-ui/react'

import type { LibraryFile } from '@shared/api/types/library'
import {
  LIBRARY_MENTION_CATEGORY_ID,
  libraryMentionItemId
} from '@shared/components/agents/agentMention'
import type { LibraryMentionRef } from '@shared/lib/mention-context'

/** 行对象 → 提及用的四字段投影（与 `useLibraryMentionAdapter` 收窄成的形状逐字一致）。 */
export function libraryMentionRefOf(
  file: Pick<LibraryFile, 'id' | 'path' | 'filename' | 'size_bytes'>
): LibraryMentionRef | null {
  if (file.id === null) return null
  return { file_id: file.id, path: file.path, name: file.filename, size_bytes: file.size_bytes }
}

/** 一枚库文件提及在 composer 正文里长的样子。 */
export function libraryMentionText(ref: LibraryMentionRef): string {
  return unstable_defaultDirectiveFormatter.serialize({
    id: libraryMentionItemId(ref.file_id),
    type: LIBRARY_MENTION_CATEGORY_ID,
    label: ref.name
  })
}

/** 「对话」按钮预置的指令。
 *
 *  🔴 `{mention}` 那一段是 directive 文本，**译文里必须留着这个占位符**：少了它，预填进
 *  composer 的就是一句没有 chip 的白话，AgentComposer 那条「chip 被删就摘掉 mention」的对账
 *  下一拍就把引用摘掉 —— 表现为「点了对话，agent 却完全不知道在说哪份资料」（0903 owner
 *  报的正是这个，两个 locale 当时都没有这个占位符）。闸在
 *  `tests/components/library/libraryI18nKeys.test.ts`。 */
export function buildLibraryChatPrompt(
  ref: LibraryMentionRef,
  t: (key: string, vars: Record<string, string>) => string
): string {
  return t('library.chat.prompt', { mention: libraryMentionText(ref) })
}
