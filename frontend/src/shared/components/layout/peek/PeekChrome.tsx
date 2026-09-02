// peek 浮层里各域清单的共用件（task 09-01-sidebar-fluid-optimization）。
//
// 三个投影变体（邮件 / 通讯录 / 对话）没有自己的页头，用这里的 41px 头 + 骨架 + 空态；
// 走同一组件的域（事项 / 团队 / 报告）与 nav 域（DomainPanel）自带页头，不用。

export interface PeekListProps {
  /** 点行导航后关闭浮层（导航本身由各清单自己做）。 */
  onNavigate(): void
}

export function PeekHeader({ title, meta }: { title: string; meta?: string }): React.ReactElement {
  return (
    <div className="nav-panel-header gap-1.5">
      <span className="flex-1 min-w-0 text-[13px] font-semibold text-ink-fg truncate">{title}</span>
      {meta !== undefined && meta !== '' && (
        <span className="shrink-0 text-micro font-mono text-ink-fg-3">{meta}</span>
      )}
    </div>
  )
}

/** 未访问过的域：先骨架后到数据（30px 灰条 × 8）。 */
export function PeekSkeleton(): React.ReactElement {
  return (
    <div className="nav-peek-skeleton" aria-hidden="true" data-nav-peek-skeleton>
      {Array.from({ length: 8 }, (_, i) => (
        <i key={i} />
      ))}
    </div>
  )
}

export function PeekEmpty({ text }: { text: string }): React.ReactElement {
  return <div className="px-4 py-6 text-center text-aux text-ink-fg-3">{text}</div>
}
