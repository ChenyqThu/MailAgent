// S6 W2（PRD P5 红点链）— custom-agent 待审批（paused_pending）红点面。两个可复用件：
//   - PendingDot：脉冲红点（run 行 ① + Custom AI Agents 区 header ③）。oklch token
//     `--c-fail`（bg-fail），不发明新色。
//   - AgentPendingCountBadge：per-agent 待审批计数徽标（CustomAgentCard ②）。count<=0 → null。
//
// 原来的第三件 `TitleBarAgentPendingBadge`（全局徽标 ④，5s 轮询 + popover 列待审批 run）已在
// M3 批 C5 收编进统一通知中心：待办条目落通知面板的 Action Required tab，TitleBar 只留通知
// 铃铛一个入口（铃铛的「待办点」承接它的 level 型指示）。`useAgentPendingCount` /
// `usePendingRuns` 保留 —— Agents 页与 run 历史区仍在用。
import { useTranslation } from 'react-i18next'

/** 脉冲红点（animate-ping 淡入淡出）。装饰性，title 供无障碍提示。 */
export function PendingDot({ title }: { title?: string }): React.ReactElement {
  return (
    <span
      className="relative inline-flex shrink-0"
      style={{ width: 7, height: 7 }}
      title={title}
      aria-label={title}
    >
      <span className="absolute inset-0 rounded-full bg-fail opacity-75 animate-ping" aria-hidden />
      <span className="absolute inset-0 rounded-full bg-fail" aria-hidden />
    </span>
  )
}

/** per-agent 待审批计数徽标（CustomAgentCard ②）。count<=0 → 不渲染。 */
export function AgentPendingCountBadge({ count }: { count: number }): React.ReactElement | null {
  const { t } = useTranslation()
  if (count <= 0) return null
  const label = t('agents.custom.runs.pendingBadge', { count })
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border border-fail/40 bg-fail/15 px-1.5 py-0.5 text-micro font-mono text-fail"
      title={label}
    >
      <PendingDot />
      <span className="tabular-nums">{label}</span>
    </span>
  )
}
