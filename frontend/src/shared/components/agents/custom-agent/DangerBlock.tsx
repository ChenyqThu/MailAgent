// 从 shared.tsx 拆出（08-02 review F9）：react-refresh/only-export-components 要求一个文件
// 只导出组件；shared 那边现在是纯逻辑（.ts），本文件是它唯一的组件成员。

/** 红样式警示块（创建规则 / grant_exec 共用形态）。 */
export function DangerBlock({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div
      style={{
        fontSize: 12,
        lineHeight: 1.6,
        color: 'rgb(var(--c-fail))',
        padding: '10px 12px',
        borderRadius: 9,
        background: 'rgb(var(--c-fail) / 0.10)',
        border: '1px solid rgb(var(--c-fail) / 0.35)',
        wordBreak: 'break-word'
      }}
    >
      {children}
    </div>
  )
}
