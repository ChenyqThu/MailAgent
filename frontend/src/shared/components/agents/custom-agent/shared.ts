// CustomAgentDrawer 拆分（Lane C2 纯机械搬迁）：跨 section 复用的常量 / 类型 / 纯 helper。
// 08-02 review F9 — 唯一的组件 DangerBlock 已拆去 DangerBlock.tsx，本文件保持零 JSX（.ts），
// 这样 react-refresh 的 Fast Refresh 边界干净；`from './shared'` 的既有导入路径不受影响。

import type { CustomAgentToolPolicy } from '@shared/api/types'

export type WebGrant = 'off' | 'gated' | 'open'
export const WEB_GRANTS: WebGrant[] = ['off', 'gated', 'open']

// MCP connector PR4 T3 — grant_connectors 的值域**派生自** CustomAgentToolPolicy（wire 契约
// 单源），不在这里手抄 'read'|'write'|'update' 字面量：服务端值域变了这里跟着编译期红。
export type ConnectorGrantMap = NonNullable<CustomAgentToolPolicy['grant_connectors']>
export type SessionsGrant = NonNullable<CustomAgentToolPolicy['grant_sessions']>
export type ConnectorGrantValue = ConnectorGrantMap[string]

export type CalendarLeadUnit = 'minutes' | 'hours' | 'days'

export function leadParts(seconds: number): { amount: number; unit: CalendarLeadUnit } {
  if (seconds % 86400 === 0) return { amount: seconds / 86400, unit: 'days' }
  if (seconds % 3600 === 0) return { amount: seconds / 3600, unit: 'hours' }
  return { amount: seconds / 60, unit: 'minutes' }
}

export function formatCalendarLead(
  t: (key: string, options?: Record<string, unknown>) => string,
  seconds: number
): string {
  const { amount, unit } = leadParts(seconds)
  const key =
    unit === 'days'
      ? 'agents.custom.trigger.leadDays'
      : unit === 'hours'
        ? 'agents.custom.trigger.leadHours'
        : 'agents.custom.trigger.leadMinutes'
  return t(key, { count: amount })
}

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
 *  排程型 agent 的自动化策略区会显示「无 headless 模式」并把所有免卡规则标成 dormant。
 *  `im`（阶段 0b 预置，harness-expansion epic grill Q10=A）→ 'im_chat'：阶段 2 飞书对话；
 *  当前没有任何行能带这个 kind（parse_trigger 尚不认识），本分支 dormant。 */
export function deriveHeadlessMode(
  kind: string | null
): 'cron_headless' | 'untrusted_trigger' | 'im_chat' | null {
  if (kind === 'cron' || kind === 'schedule') return 'cron_headless'
  if (kind === 'email_filter') return 'untrusted_trigger'
  if (kind === 'calendar_event_change') return 'untrusted_trigger'
  if (kind === 'calendar_before_start') return 'untrusted_trigger'
  if (kind === 'im') return 'im_chat'
  return null
}
