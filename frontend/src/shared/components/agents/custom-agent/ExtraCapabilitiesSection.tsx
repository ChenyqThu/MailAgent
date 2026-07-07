// CustomAgentDrawer 拆分（Lane C2 纯机械搬迁）：额外能力区（grant_web 三档 + grant_exec）。
// 原样自 CustomAgentDrawer.tsx 抽出，逻辑逐字节不变。
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { ChatOpennessFlags } from '@shared/api/types'
import { Switch } from '../primitives'
import { deriveHeadlessMode, DangerBlock, WEB_GRANTS, type WebGrant } from './shared'

// ── 额外能力（R3 task 07-05）──────────────────────────────────────────────────
// grant_web 三档 + grant_exec 从 AutomationPolicySection 深处物理提升到「可用工具」紧邻
// 位置（保存语义逐字节不变：仍由父层 grantDirty/webDirty 按需并入 tool_policy）。新建
// 模式也渲染 —— 两段式 create 的第二段 setConfig（PUT）本就接受 grant 键。flag 接线：
// /chat/config 的 webToolsEnabled / execPolicyEnabled 明确 false（flag off）→ 控件禁用 +
// 提示，消除「UI 授权但 gateway 未注册工具」的静默 no-op；undefined（旧后端 / 不可达）
// → 按现状渲染不禁用。
export function ExtraCapabilitiesSection({
  agentTitle,
  triggerKind,
  grantExec,
  onGrantChange,
  grantWeb,
  onWebChange,
  flags
}: {
  agentTitle: string
  /** untrusted 叠加警示基准：编辑 = 已保存 trigger 的 kind（原语义）；新建 = 表单当前选择。 */
  triggerKind: string | null
  grantExec: boolean
  /** 翻转 grant_exec（已过确认对话）；父层置 grantDirty，保存时并入 tool_policy。 */
  onGrantChange: (next: boolean) => void
  /** grant_web 三档（S6 W3-3）；父层置 webDirty，保存时并入 tool_policy。 */
  grantWeb: WebGrant
  onWebChange: (next: WebGrant) => void
  flags: ChatOpennessFlags
}): React.ReactElement {
  const { t } = useTranslation()
  // untrusted_trigger（email_filter 触发）× open 全开放联网 = 最大暴露面（ADR-004 §6 残余面③）→ 叠加警示。
  const untrustedTrigger = deriveHeadlessMode(triggerKind) === 'untrusted_trigger'
  const [grantConfirming, setGrantConfirming] = useState(false)
  const webDisabled = flags.webToolsEnabled === false
  const execDisabled = flags.execToolsEnabled === false

  const smallBtn: React.CSSProperties = {
    fontFamily: 'inherit',
    fontSize: 12,
    padding: '4px 10px',
    borderRadius: 7,
    cursor: 'pointer',
    color: 'rgb(var(--ink-fg-2))',
    background: 'transparent',
    border: '1px solid rgb(var(--ink-border))'
  }

  return (
    <div>
      <div className="flex items-baseline" style={{ gap: 8, marginBottom: 7 }}>
        <label style={{ fontSize: 13, fontWeight: 500, color: 'rgb(var(--ink-fg))' }}>
          {t('agents.custom.capabilities.label')}
        </label>
        <span style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))' }}>
          {t('agents.custom.capabilities.hint')}
        </span>
      </div>

      {/* grant_web 三档（S6 W3-3 ADR-004 rev3.1 §3.1）：off / gated（域名白名单）/ open（全开放，红样式）。
          gated/open 均连带 web_search 免审批外送（§6 残余面①）；open × 邮件触发 = 最大暴露面（残余面③）。 */}
      <div
        style={{
          padding: '12px 13px',
          borderRadius: 10,
          background:
            grantWeb === 'open' ? 'rgb(var(--c-fail) / 0.05)' : 'rgb(var(--ink-2) / 0.55)',
          border: `1px solid ${
            grantWeb === 'open' ? 'rgb(var(--c-fail) / 0.25)' : 'rgb(var(--ink-border))'
          }`,
          opacity: webDisabled ? 0.6 : undefined
        }}
      >
        <div
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: grantWeb === 'open' ? 'rgb(var(--c-fail))' : 'rgb(var(--ink-fg))'
          }}
        >
          {t('agents.custom.policy.web.label')}
        </div>
        <div
          style={{
            fontSize: 11.5,
            color: 'rgb(var(--ink-fg-3))',
            margin: '2px 0 9px',
            lineHeight: 1.5
          }}
        >
          {t('agents.custom.policy.web.hint')}
        </div>
        <div className="seg" style={{ width: '100%' }}>
          {WEB_GRANTS.map((g) => (
            <button
              key={g}
              type="button"
              disabled={webDisabled}
              className={grantWeb === g ? 'on' : ''}
              style={{
                flex: 1,
                justifyContent: 'center',
                ...(webDisabled ? { cursor: 'not-allowed' } : {}),
                ...(g === 'open' && grantWeb === 'open' ? { color: 'rgb(var(--c-fail))' } : {})
              }}
              onClick={() => {
                if (!webDisabled) onWebChange(g)
              }}
            >
              {t(`agents.custom.policy.web.grant.${g}`)}
            </button>
          ))}
        </div>
        {webDisabled && (
          <div
            style={{ fontSize: 11.5, color: 'rgb(var(--c-warn))', marginTop: 8, lineHeight: 1.5 }}
          >
            {t('agents.custom.capabilities.webDisabled')}
          </div>
        )}
        {grantWeb !== 'off' && (
          <div
            style={{
              marginTop: 9,
              fontSize: 12,
              lineHeight: 1.6,
              color: grantWeb === 'open' ? 'rgb(var(--c-fail))' : 'rgb(var(--c-warn))',
              padding: '10px 12px',
              borderRadius: 9,
              background:
                grantWeb === 'open' ? 'rgb(var(--c-fail) / 0.10)' : 'rgb(var(--c-warn) / 0.10)',
              border: `1px solid ${
                grantWeb === 'open' ? 'rgb(var(--c-fail) / 0.35)' : 'rgb(var(--c-warn) / 0.30)'
              }`,
              wordBreak: 'break-word'
            }}
          >
            {/* gated/open 均含 web_search 免审批外送（query → DuckDuckGo）—— §6 残余面① UI 明示义务。 */}
            <div>{t('agents.custom.policy.web.searchWarn')}</div>
            {grantWeb === 'open' && (
              <div style={{ marginTop: 6 }}>{t('agents.custom.policy.web.openWarn')}</div>
            )}
            {grantWeb === 'open' && untrustedTrigger && (
              <div style={{ marginTop: 6, fontWeight: 600 }}>
                {t('agents.custom.policy.web.untrustedOpenWarn')}
              </div>
            )}
          </div>
        )}
        {grantWeb === 'gated' && (
          <div
            style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))', marginTop: 8, lineHeight: 1.5 }}
          >
            {t('agents.custom.policy.web.gatedHint')}
          </div>
        )}
      </div>

      {/* grant_exec 开关（红样式 + 同一确认形态；保存时并入 tool_policy —— 触碰即触碰 tool_policy） */}
      <div
        style={{
          marginTop: 10,
          padding: '12px 13px',
          borderRadius: 10,
          background: 'rgb(var(--c-fail) / 0.05)',
          border: '1px solid rgb(var(--c-fail) / 0.25)',
          opacity: execDisabled ? 0.6 : undefined
        }}
      >
        <div className="flex items-center" style={{ gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'rgb(var(--c-fail))' }}>
              {t('agents.custom.policy.grant.label')}
            </div>
            <div
              style={{
                fontSize: 11.5,
                color: 'rgb(var(--ink-fg-3))',
                marginTop: 2,
                lineHeight: 1.5
              }}
            >
              {t('agents.custom.policy.grant.hint')}
            </div>
          </div>
          <Switch
            on={grantExec}
            onChange={(next) => {
              if (execDisabled) return
              if (next) {
                setGrantConfirming(true)
              } else {
                // 关方向 = 收窄，直改（保存后该 agent 回恒 HITL）。
                setGrantConfirming(false)
                onGrantChange(false)
              }
            }}
          />
        </div>
        {execDisabled && (
          <div
            style={{ fontSize: 11.5, color: 'rgb(var(--c-warn))', marginTop: 8, lineHeight: 1.5 }}
          >
            {t('agents.custom.capabilities.execDisabled')}
          </div>
        )}
        {grantConfirming && !grantExec && (
          <div style={{ marginTop: 9, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <DangerBlock>{t('agents.custom.policy.grant.warn', { agent: agentTitle })}</DangerBlock>
            <div className="flex items-center" style={{ gap: 8 }}>
              <span style={{ flex: 1 }} />
              <button type="button" style={smallBtn} onClick={() => setGrantConfirming(false)}>
                {t('agents.custom.policy.cancel')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setGrantConfirming(false)
                  onGrantChange(true)
                }}
                style={{
                  fontFamily: 'inherit',
                  fontSize: 12.5,
                  fontWeight: 500,
                  padding: '6px 13px',
                  borderRadius: 8,
                  cursor: 'pointer',
                  color: 'rgb(var(--c-fail))',
                  background: 'rgb(var(--c-fail) / 0.12)',
                  border: '1px solid rgb(var(--c-fail) / 0.4)'
                }}
              >
                {t('agents.custom.policy.grant.confirm')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
