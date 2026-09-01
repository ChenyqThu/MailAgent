// /agents 共享字段容器：label + 可选 hint + children。八个 settings/ 配置页共用
//（CustomAgentDrawer 另有一份同形状的私有实现，未收编）。
export function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div>
      <div className="flex items-baseline" style={{ gap: 8, marginBottom: 7 }}>
        <label style={{ fontSize: 13, fontWeight: 500, color: 'rgb(var(--ink-fg))' }}>
          {label}
        </label>
        {hint && <span style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))' }}>{hint}</span>}
      </div>
      {children}
    </div>
  )
}
