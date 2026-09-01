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
  // hint 独占一行而非贴在 label 右边：这些说明多是整句中文，挤在标题行里会把 label
  // 顶成一条长带、也读不出「标题 → 说明 → 控件」的层级。
  return (
    <div>
      <label className="block text-[13px] font-semibold leading-[1.4] text-ink-fg">{label}</label>
      {hint && <p className="mt-1 text-[11.5px] leading-[1.5] text-ink-fg-3">{hint}</p>}
      <div className="mt-2">{children}</div>
    </div>
  )
}
