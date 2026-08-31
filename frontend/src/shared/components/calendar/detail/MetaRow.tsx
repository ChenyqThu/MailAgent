// 详情抽屉的一行「标签 → 值」。原在 EventDetailDrawer.tsx 内，P4d 起 mail 形态与
// matter / agent 两个投影形态共用同一行版式（.meta-row 网格），故上提成独立模块 ——
// 留在 EventDetailDrawer 里就得让投影组件反向 import 抽屉，成环。

export interface MetaRowProps {
  icon?: React.ReactNode
  label: string
  children: React.ReactNode
}

export function MetaRow({ icon, label, children }: MetaRowProps): React.ReactElement {
  return (
    <div className="meta-row">
      <div className="meta-k">
        {icon && (
          <span className="text-ink-fg-3" aria-hidden>
            {icon}
          </span>
        )}
        {label}
      </div>
      <div className="meta-v">{children}</div>
    </div>
  )
}
