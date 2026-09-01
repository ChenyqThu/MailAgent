// P4a agent-config lane — 配置页输入控件的共用内联样式（取值沿用自已退役的 agent 配置抽屉）。
// 独立 .ts 叶子：component 文件导出非组件值会破 react-refresh 的 Fast Refresh 边界。
export const INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  fontFamily: 'inherit',
  fontSize: 13.5,
  color: 'rgb(var(--ink-fg))',
  background: 'rgb(var(--ink-1) / 0.55)',
  border: '1px solid rgb(var(--ink-border))',
  borderRadius: 8,
  padding: '9px 11px'
}
