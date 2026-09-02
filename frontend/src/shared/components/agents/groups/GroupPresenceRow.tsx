// L4 群聊 UX 批 — 消息流末尾的在场行（Cumora TypingRow 思路）：在写者「X 正在输入…」（只在
// 还没有正文时；有正文时流式气泡已在上面）+ 排队「A、B 排队中」（≥ 4：「A、B 等 N 位排队中」）
// + 三点 opacity 脉冲（DESIGN.md §8 禁 bounce 位移；motion-reduce 静止）。无头像。
// 🔴 在场态只来自事件 / 探针（红线 1）：props 为空就渲染 null，不会自己编一个。

import { useTranslation } from 'react-i18next'

export function GroupPresenceRow({
  typingName,
  queuedNames
}: {
  typingName: string | null
  queuedNames: readonly string[]
}): React.ReactElement | null {
  const { t } = useTranslation()
  if (typingName == null && queuedNames.length === 0) return null
  const queuedText =
    queuedNames.length === 0
      ? null
      : queuedNames.length <= 3
        ? t('groupChat.queuedOne', { name: queuedNames.join('、') })
        : t('groupChat.queuedMany', {
            names: queuedNames.slice(0, 2).join('、'),
            count: queuedNames.length
          })
  return (
    <div className="flex items-center gap-2 py-0.5 text-meta text-ink-fg-3" aria-live="polite">
      {typingName != null && <span>{t('groupChat.typing', { name: typingName })}</span>}
      {queuedText != null && <span>{queuedText}</span>}
      <span className="flex items-center gap-0.5" aria-hidden>
        <span className="size-1 animate-pulse rounded-full bg-current motion-reduce:animate-none" />
        <span className="size-1 animate-pulse rounded-full bg-current [animation-delay:150ms] motion-reduce:animate-none" />
        <span className="size-1 animate-pulse rounded-full bg-current [animation-delay:300ms] motion-reduce:animate-none" />
      </span>
    </div>
  )
}
