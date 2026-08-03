// CustomAgentDrawer 拆分（Lane C2 纯机械搬迁）：跨 section 复用的常量 / 类型 / 纯 helper。
// 08-02 review F9 — 唯一的组件 DangerBlock 已拆去 DangerBlock.tsx，本文件保持零 JSX（.ts），
// 这样 react-refresh 的 Fast Refresh 边界干净；`from './shared'` 的既有导入路径不受影响。

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
