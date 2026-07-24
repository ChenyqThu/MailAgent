// CustomAgentDrawer 拆分（Lane C2 纯机械搬迁）：跨 section 复用的常量 / 类型 / 纯 helper /
// 小组件，原样自 CustomAgentDrawer.tsx 抽出，逻辑逐字节不变。

export type WebGrant = 'off' | 'gated' | 'open'
export const WEB_GRANTS: WebGrant[] = ['off', 'gated', 'open']

// 结构化 ApiError / Electron err → 用户可读一行（code + message）。保存失败时把后端
// validate_agent_config_patch 的 detail（TriggerValidationError message）渲染出来。
export function errText(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown }
  const code = typeof e?.code === 'string' ? e.code : null
  const msg = typeof e?.message === 'string' ? e.message : String(err)
  return code ? `${code}: ${msg}` : msg
}

/** trigger.kind → headless context_mode（与后端 _derive_rule_context_mode / gateway
 *  deriveContextMode 同表，只读展示用）。
 *  `schedule`（07-24 结构化排程）与 `cron` 同族 —— 到点就跑、无攻击者可控输入。漏了这一行，
 *  排程型 agent 的自动化策略区会显示「无 headless 模式」并把所有免卡规则标成 dormant。 */
export function deriveHeadlessMode(
  kind: string | null
): 'cron_headless' | 'untrusted_trigger' | null {
  if (kind === 'cron' || kind === 'schedule') return 'cron_headless'
  if (kind === 'email_filter') return 'untrusted_trigger'
  return null
}

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
