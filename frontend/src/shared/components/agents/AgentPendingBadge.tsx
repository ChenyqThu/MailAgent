// S6 W2（PRD P5 红点链）— custom-agent 待审批（paused_pending）红点面。现只剩一件：
//   - PendingDot：脉冲红点（run 历史区的 run 行）。oklch token `--c-fail`（bg-fail），
//     不发明新色。
//
// 原来的 `TitleBarAgentPendingBadge`（全局徽标，5s 轮询 + popover 列待审批 run）已在
// M3 批 C5 收编进统一通知中心：待办条目落通知面板的 Action Required tab，TitleBar 只留通知
// 铃铛一个入口（铃铛的「待办点」承接它的 level 型指示）。per-agent 计数徽标
// `AgentPendingCountBadge` 随 L4 退役批一起下线（唯一消费点 CustomAgentCard 已删）。
// `useAgentPendingCount` 仍在用（SystemHealthRow）；`usePendingRuns` 是预存零消费的死代码，
// 本批不删。

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
