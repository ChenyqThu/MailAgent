// Sprint 19 Todo 2 — markdown 渲染层换 Vercel Streamdown.
//
// 之前是自写 regex + DOMPurify + auto-balance preprocess (150 LOC), 不
// 支持 nested list / table / triple ``` / single * italic, 也不处理流式
// unterminated block 视觉跳动. 调研结论 (docs/chat-markdown-streaming-
// research.md): Streamdown v2.5 — Vercel 2026 业界 de facto, drop-in
// 替代 react-markdown, 内置 GFM + unterminated block styling + rehype-
// harden + Tailwind typography. 删 ~120 LOC, 留 ~30 LOC props 转发,
// 顺带 fix handoff 列的所有 markdown 痛点.
//
// 调用方零改动: 两处用 site (MessageList.tsx:260 邮件草稿 read-only
// preview + MessageList.tsx:733 chat AssistantBubble) props 接口
// `{ text: string }` 不变.
//
// 命名沿用 TranslatedBody 是因为重命名/搬位置会牵连一连串 import,
// 收益不大; 等下次清理 chat 渲染层时再统一.
//
// 不加 plugin (code / math / mermaid / cjk): 邮件 + chat 场景一期都
// 不需要, 想加 shiki syntax highlight 后续加 `import code from
// '@streamdown/code'` 再传 plugins 即可.

import { Streamdown } from 'streamdown'

interface Props {
  text: string
}

export function TranslatedBody({ text }: Props): React.ReactElement {
  return (
    <div className="mail-body break-words">
      <Streamdown parseIncompleteMarkdown>{text}</Streamdown>
    </div>
  )
}
