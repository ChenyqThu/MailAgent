// task 08-27 P5「拖出成独立窗口」形态 B —— 轻窗的壳。
//
// App.tsx 在 useDetachedMode.isDetached 为真时挂它（判据由 renderer/main.tsx 在
// React.render 之前从 query 解析好，首帧就是对的壳）。对照 PopoutShell（Sprint 14
// PR E）：同样绕过 TanStack Router，只把**一件内容**钉满整窗。
//
// 🔴 形态 B 有意不做的事（判据见 .trellis/tasks/08-27-l4-tab-workspace/research/
// r13-p5-landscape.md §2.4-2.5）：
//   · **不挂 router** —— 轻窗没有侧栏 / 列表 / 设置页可导航。连带的两个后果都是有意的：
//     ① GlobalShortcuts 只挂在 RootLayout（router 内），所以它对 ⌘W 的「恒 preventDefault
//     + 恒消费」在轻窗里不生效，⌘W 落回 macOS windowMenu 的 close role = 关掉这个窗口
//     （正是轻窗该有的语义，同 popout）；② 跨域跳转（人物页 / 事项页 / 日历）在轻窗里
//     没有落点 —— popout 里 AIChatPanel 的「去设置」也一样够不着，是这个范式的既有性质，
//     不是本批新增的缺口。
//   · **不渲染标签条、不写任何标签 store** —— 标签集与主窗共用同一个 localStorage 键且
//     有意不挂 storage 监听，轻窗写一次就把主窗的标签集覆盖掉。tab-workspace-bridge 的
//     tabsInert() 已把本模式一并短路。
//   · 因此它不是「把标签拖出去」（那是形态 A，前提是先翻掉 tab-workspace 的所有权模型），
//     而是「在新窗口打开这一封 / 这一份」。

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useActiveEmail } from '@shared/state/active-email'
import { useDetachedMode } from '@shared/state/detached-mode'
import { ErrorBoundary } from '@shared/components/ErrorBoundary'
import { EmailDetail } from '@shared/components/email/EmailDetail'
import { EmailSourcePanel } from '@shared/components/agents/EmailSourcePanel'
import { ReportDetailView } from '@shared/components/agents/ReportsPage'
import { useReport, useRunNow } from '@shared/components/agents/hooks'
import {
  FIXED_RENDER,
  scrollToEmail,
  type RenderCtx,
  type ReportEmailItemForPanel
} from '@shared/components/agents/lib'

/** 邮件轻窗 —— 整窗就是一个 EmailDetail（工具栏 / 正文 / 附件 / 回复转发都在里面）。
 *  同 PopoutShell：用 effect（不是 render 期写）把 activeInternalId 灌进本进程的
 *  active-email store —— 详情里的置顶 / 归档等动作读它，独立 renderer 是新实例。 */
function DetachedEmail({ internalId }: { internalId: number }): React.ReactElement {
  const setActive = useActiveEmail((s) => s.setActive)
  useEffect(() => {
    setActive(internalId)
  }, [internalId, setActive])
  return <EmailDetail internalId={internalId} />
}

/** 报告轻窗 —— 复用 /reports 的详情组件本体（ReportDetailView）。
 *  它要的 `item` 是 ReportListItem，而 `report.get()` 返回的 ReportDetail 正是它的超集，
 *  所以轻窗不必先拉一遍分页列表去找那一行；ReportDetailView 内部再 useReport(item.id)
 *  命中的是同一个 query key（react-query 缓存，不产生第二次请求）。 */
function DetachedReport({ reportId }: { reportId: string }): React.ReactElement {
  const { t } = useTranslation()
  const { report, isLoading } = useReport(reportId)
  const { run, isRunning } = useRunNow()
  const [sourceEmail, setSourceEmail] = useState<ReportEmailItemForPanel | null>(null)
  const ctx: RenderCtx = useMemo(
    () => ({
      ...FIXED_RENDER,
      onOpenEmail: (block) => setSourceEmail(block),
      onJump: (id) => scrollToEmail(id)
    }),
    []
  )
  if (report === null) {
    return (
      <div
        className="flex items-center"
        style={{ flex: 1, justifyContent: 'center', color: 'rgb(var(--ink-fg-3))', fontSize: 13 }}
      >
        {isLoading ? t('agents.reports.loading') : t('agents.reports.none')}
      </div>
    )
  }
  return (
    <div style={{ position: 'relative', display: 'flex', flex: 1, minHeight: 0 }}>
      <ReportDetailView
        item={report}
        ctx={ctx}
        onRetry={() => {
          if (!isRunning) void run(report.agent_id, { cadence: report.cadence })
        }}
        retrying={isRunning}
      />
      {/* 溯源面板 scope 到本窗的相对容器（同 ReportsPage 的放法）。 */}
      <EmailSourcePanel email={sourceEmail} onClose={() => setSourceEmail(null)} />
    </div>
  )
}

export function DetachedShell(): React.ReactElement {
  const { t } = useTranslation()
  const target = useDetachedMode((s) => s.target)
  return (
    // 主题 v2 —— 轻窗同走「一块玻璃」：不给不透明底，基底 tint 由 body::before 提供。
    <div className="h-screen w-screen flex flex-col">
      {/* 40px 标题条 —— 抄 AIChatPanel 的 fullScreen 头（popout 用的同一条）：
          `titleBarStyle: 'hiddenInset'` 下窗口内容铺满整窗，① 没有 app-region:drag 的
          区域这个窗就拖不动，② pl-[78px] 是给 OS 红绿灯让位，不让它压住下面的工具栏。
          标题用现成的域名词（nav.domain.*），轻窗不为此新造文案。 */}
      <div
        className="relative flex h-10 shrink-0 items-center border-b border-ink-border pl-[78px] pr-3 text-aux font-medium text-ink-fg"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        {target === null ? null : t(`nav.domain.${target.kind === 'email' ? 'mail' : 'reports'}`)}
      </div>
      {/* 轻窗**就是**这一件内容，render 崩掉会把整个窗口变成堆栈（同 PopoutShell 的
          ChatPanelBoundary 理由），故自带边界。 */}
      <div className="flex min-h-0 flex-1">
        <ErrorBoundary label="detached-shell">
          {target === null ? null : target.kind === 'email' ? (
            <DetachedEmail internalId={target.emailId} />
          ) : (
            <DetachedReport reportId={target.reportId} />
          )}
        </ErrorBoundary>
      </div>
    </div>
  )
}
