// /llm dashboard 的统计卡片。
//
// 从 LlmDashboardPage 抽出来是因为 issue #59 的「知识库入库」区（KosIngestSection）
// 要用同一张卡 —— 留在页面文件里会形成 page ⇄ section 的循环 import。
// 默认 tone='accent' 与抽出前逐字节一致；'warn' 是 dead 行专用的警示态。

import { cn } from '@shared/lib/cn'

export type StatCardTone = 'accent' | 'warn'

export function StatCard({
  label,
  value,
  hint,
  accent,
  tone = 'accent'
}: {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
  accent?: boolean
  tone?: StatCardTone
}): React.ReactElement {
  return (
    <div
      className={cn(
        // round 8c — 容器统一 accent 染色卡 (用户定稿「都要已处理那样的」),
        // accent prop 只剩数字字色/字重差异。
        'rounded-md border p-3',
        tone === 'warn' ? 'border-warn/30 bg-warn/10' : 'border-coral/30 bg-coral/5'
      )}
    >
      <div className="text-micro font-mono uppercase text-ink-fg-2 mb-1">{label}</div>
      <div
        className={cn(
          'text-lead tabular-nums',
          tone === 'warn'
            ? 'text-warn font-semibold'
            : accent
              ? 'text-coral font-semibold'
              : 'text-ink-fg'
        )}
      >
        {value}
      </div>
      {hint && <div className="text-meta text-ink-fg-3 mt-1">{hint}</div>}
    </div>
  )
}
