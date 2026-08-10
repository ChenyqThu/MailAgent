// Matters MVP P3 (lane ③) — 上下文缺口卡 (design 附录 C, 消息区 warn card).
//
// 🔴 Deliberately NOT rendered in P3. The card and its action exist; what does not exist yet is a
// TRIGGER — deciding "the answer needed evidence this matter does not reach" is the P6 context-gap
// work (D10: 「组件与「扩大到全库」action 写好但 P3 无触发路径；不造假触发」). Wiring a fake
// trigger now would teach the user to distrust the signal, so the only consumer today is its unit
// test.
//
// `onExpand` is the SAME scope-switch action the panel's Segmented drives (audit first, flip
// second) — the gap card must never be a second, unaudited way to widen the search reach.

import { useTranslation } from 'react-i18next'
import { HelpCircle } from 'lucide-react'

export function MatterContextGapCard({
  onExpand,
  disabled = false
}: {
  onExpand(): void
  disabled?: boolean
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div
      data-testid="matter-context-gap"
      className="mt-2 flex items-center gap-2 rounded-lg border border-warn/25 bg-warn/[0.07] px-2.5 py-2"
    >
      <HelpCircle size={13} strokeWidth={2} className="shrink-0 text-warn" />
      <span className="min-w-0 flex-1 text-aux text-ink-fg-1">{t('matters.chat.gap.title')}</span>
      <button
        type="button"
        disabled={disabled}
        onClick={onExpand}
        className="shrink-0 rounded-[var(--r-ctl)] border border-ink-border px-2 py-1 text-meta text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3 disabled:opacity-50"
      >
        {t('matters.chat.gap.expand')}
      </button>
    </div>
  )
}
