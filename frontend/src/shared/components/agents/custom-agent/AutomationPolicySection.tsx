// CustomAgentDrawer 拆分（Lane C2 纯机械搬迁）：自动化策略区（per-agent 免卡白名单的唯一
// 创建通道）+ per-agent skill 挂载。原样自 CustomAgentDrawer.tsx 抽出，逻辑逐字节不变。
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import type { ExecPolicyRule } from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'
import { qk } from '@shared/lib/queryKeys'
import { Checkbox } from '@shared/components/ui/checkbox'
import { Switch } from '../primitives'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shared/components/ui/select'
import { deriveHeadlessMode, DangerBlock, errText } from './shared'

// ── 自动化策略（S5 W5b，ADR-004 D5/D6）──────────────────────────────────────
// per-agent 免卡白名单的**唯一**创建通道（模型零建规则工具、岛卡无「总是允许(此 agent)」）。
// 高危形态 = 红样式警示块 + 影响面声明 + 两步确认（先例 = 身份文档编辑器，无 PIN）。
// context_mode 由后端从 agent trigger.kind 派生（表单结构性不可选）；这里只做读侧 dormant
// 对比提示（规则 contextMode ≠ 当前已保存 trigger 的派生值 → 「休眠」，不迁移不删）。

type PolicyArgKind = 'pin' | 'enum' | 'pattern' | 'path_within'
const POLICY_ARG_KINDS: PolicyArgKind[] = ['pin', 'enum', 'pattern', 'path_within']

interface PolicyArgSlot {
  kind: PolicyArgKind
  /** pin=字面值；enum=逗号分隔允许值；pattern=锚定 regex；path_within=绝对前缀。 */
  value: string
}

/** matcher → 单行摘要（只读展示；放宽 = 删旧建新，无原地编辑）。受约束位显示 `<kind>`。 */
function formatRuleMatcher(rule: ExecPolicyRule): string {
  const m = rule.matcher
  if (rule.capability === 'domain_write') {
    return typeof m.tool === 'string' ? m.tool : '?'
  }
  if (rule.capability === 'web') {
    // origin 服务端已归一入库（canonical scheme://host:port，rev3.1 §4.2 ①）→ 直接展示。
    return typeof m.origin === 'string' ? m.origin : '?'
  }
  if (rule.capability === 'exec') {
    const argv0 = typeof m.argv0_realpath === 'string' ? m.argv0_realpath : '?'
    const tmpl = Array.isArray(m.argv_template) ? m.argv_template : []
    const parts = tmpl.map((it) => {
      const o = it as { pin?: unknown; any?: unknown; arg?: { kind?: unknown } }
      if (typeof o?.pin === 'string') return o.pin
      if (o?.any === true) return '<any>'
      return typeof o?.arg?.kind === 'string' ? `<${o.arg.kind}>` : '?'
    })
    return [argv0, ...parts].join(' ')
  }
  return JSON.stringify(m)
}

export function AutomationPolicySection({
  agentId,
  agentTitle,
  triggerKind,
  writeToolChoices,
  mountedSkills,
  skillsMode,
  onSkillsChange
}: {
  agentId: string
  agentTitle: string
  /** 已保存 trigger 的 kind（dormant 对比基准 + 影响面文案；null = 无触发）。 */
  triggerKind: string | null
  /** domain_write 规则可选工具 = 5 个 domain_write 工具 ∩ 该 agent allowed_tools。 */
  writeToolChoices: string[]
  /** per-agent skill 挂载集（当前 state）+ 两态（defaults=展示默认挂载集，explicit=显式列表）。 */
  mountedSkills: string[]
  skillsMode: 'defaults' | 'explicit'
  /** 覆写挂载集（父层置 skillsDirty + skillsMode='explicit'）。 */
  onSkillsChange: (next: string[]) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const qc = useQueryClient()
  const derivedMode = deriveHeadlessMode(triggerKind)

  // skill 挂载多选数据源 = 统一 registry 投影（builtin + installed；owner 全局关掉的 skill 仍列出，
  // 但挂载不能复活它 —— fail 方向恒收窄，见 ADR §5.1）。graceful []（后端不可达 → 空态提示）。
  const skillsListQ = useQuery({
    queryKey: qk.agent.skillsRegistry(),
    queryFn: () => api.chat.listSkills(),
    staleTime: 60_000
  })
  const availableSkills = skillsListQ.data ?? []
  // 挂载多选可选项 = registry skill 名 ∪ 当前挂载集（后者兜住「默认集在 registry 名不同/已卸载
  // skill 仍显式挂载」的可见性 —— 未安装名效果为零但仍可见/可解绑，ADR §5.1 strict-effect）。
  const mountSkillNames = Array.from(
    new Set([...availableSkills.map((s) => s.name), ...mountedSkills])
  )

  const rulesQ = useQuery({
    queryKey: qk.policy.rules(agentId),
    queryFn: () => api.chat.listPolicyRules({ agentId })
  })
  const rules = rulesQ.data ?? []
  const refetchRules = (): void => {
    void qc.invalidateQueries({ queryKey: qk.policy.rules(agentId) })
  }

  const [formOpen, setFormOpen] = useState(false)
  // entrypoint 候选仅建 exec 规则需要；graceful []（flag off / 无安装面 → 空态提示）。
  const entryQ = useQuery({
    queryKey: qk.policy.skillEntrypoints(),
    queryFn: () => api.chat.listSkillEntrypoints(),
    enabled: formOpen,
    staleTime: 60_000
  })
  const skills = entryQ.data ?? []

  const [capability, setCapability] = useState<'domain_write' | 'exec' | 'web'>('domain_write')
  const [tool, setTool] = useState('')
  // web 规则：owner 粘贴域名或完整 URL；提交 {v:1, origin} → 服务端归一入库（TS 不自实现归一，
  // rev3.1 D-fix-4 ④）→ 用返回行的 canonical origin 回显（refetchRules 后列表即显归一值）。
  const [origin, setOrigin] = useState('')
  const [skillName, setSkillName] = useState('')
  const [entryFile, setEntryFile] = useState('')
  const [interpreter, setInterpreter] = useState('')
  const [args, setArgs] = useState<PolicyArgSlot[]>([])
  const [pinCwd, setPinCwd] = useState(true)
  const [confirming, setConfirming] = useState(false)
  const [creating, setCreating] = useState(false)
  const [formErr, setFormErr] = useState<string | null>(null)

  const skill = skills.find((s) => s.name === skillName) ?? null
  const entryAbs = skill && entryFile ? `${skill.dir}/${entryFile}` : ''
  const actionSummary =
    capability === 'domain_write'
      ? tool
      : capability === 'web'
        ? origin.trim()
        : `${interpreter.trim()} ${entryAbs}`.trim()
  const modeLabel = derivedMode
    ? t(`agents.custom.policy.mode.${derivedMode}`)
    : t('agents.custom.policy.mode.none')

  const resetForm = (): void => {
    setCapability('domain_write')
    setTool('')
    setOrigin('')
    setSkillName('')
    setEntryFile('')
    setInterpreter('')
    setArgs([])
    setPinCwd(true)
    setConfirming(false)
    setFormErr(null)
  }

  // 浅校验（必选项 / 绝对路径 / 位值非空 / origin 非空）；canonical origin 深校验（含 IDN/userinfo
  // 拒）在后端 _valid_origin 权威，400/422 detail 原样展示。
  const shallowFormError = (): string | null => {
    if (capability === 'domain_write') {
      return tool ? null : t('agents.custom.policy.errToolRequired')
    }
    if (capability === 'web') {
      return origin.trim() ? null : t('agents.custom.policy.errOriginRequired')
    }
    if (!skill || !entryFile) return t('agents.custom.policy.errEntryRequired')
    if (!interpreter.trim().startsWith('/')) return t('agents.custom.policy.errInterpreterAbs')
    if (args.some((a) => !a.value.trim())) return t('agents.custom.policy.errArgEmpty')
    return null
  }

  // 无 raw {any} 选项：尾位词汇 = pin | enum | pattern | path_within（ADR-004 §4.3）。
  const buildMatcher = (): Record<string, unknown> => {
    if (capability === 'domain_write') return { v: 1, tool }
    // web：提交 owner 输入的 origin/URL 原文，服务端 _normalize_origin 归一入库（TS 不自归一）。
    if (capability === 'web') return { v: 1, origin: origin.trim() }
    const tmpl: Record<string, unknown>[] = [{ pin: entryAbs }]
    for (const a of args) {
      const v = a.value.trim()
      if (a.kind === 'pin') tmpl.push({ pin: v })
      else if (a.kind === 'enum') {
        tmpl.push({
          arg: {
            kind: 'enum',
            values: v
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          }
        })
      } else if (a.kind === 'pattern') tmpl.push({ arg: { kind: 'pattern', regex: v } })
      else tmpl.push({ arg: { kind: 'path_within', prefix: v } })
    }
    const m: Record<string, unknown> = {
      v: 1,
      argv0_realpath: interpreter.trim(),
      argv_template: tmpl
    }
    if (pinCwd && skill) m.cwd_scope = skill.dir
    return m
  }

  const onCreateClick = (): void => {
    const v = shallowFormError()
    if (v) {
      setFormErr(v)
      return
    }
    setFormErr(null)
    setConfirming(true)
  }

  const onConfirmCreate = (): void => {
    setCreating(true)
    api.chat
      .createPolicyRule({ capability, matcher: buildMatcher(), agentId })
      .then(() => {
        setFormOpen(false)
        resetForm()
        refetchRules()
      })
      .catch((e: unknown) => {
        setConfirming(false)
        setFormErr(errText(e))
      })
      .finally(() => setCreating(false))
  }

  const onToggleRule = (id: number, next: boolean): void => {
    api.chat
      .setPolicyRuleEnabled(id, next)
      .then(refetchRules)
      .catch((e: unknown) => setFormErr(errText(e)))
  }
  const onDeleteRule = (id: number): void => {
    api.chat
      .deletePolicyRule(id)
      .then(refetchRules)
      .catch((e: unknown) => setFormErr(errText(e)))
  }

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
  const inputStyle: React.CSSProperties = {
    width: '100%',
    fontFamily: 'inherit',
    fontSize: 12.5,
    color: 'rgb(var(--ink-fg))',
    background: 'rgb(var(--ink-1) / 0.55)',
    border: '1px solid rgb(var(--ink-border))',
    borderRadius: 8,
    padding: '7px 10px'
  }

  return (
    <div>
      <div className="flex items-center" style={{ gap: 8, marginBottom: 4 }}>
        <label style={{ fontSize: 13, fontWeight: 500, color: 'rgb(var(--ink-fg))', flex: 1 }}>
          {t('agents.custom.policy.section')}
        </label>
        {!formOpen && (
          <button
            type="button"
            style={smallBtn}
            onClick={() => {
              // 唯一可选写工具 → 预选（省一次下拉；多选项时留空强制显式选择）。
              setTool(writeToolChoices.length === 1 ? writeToolChoices[0] : '')
              setFormOpen(true)
            }}
          >
            {t('agents.custom.policy.add')}
          </button>
        )}
      </div>
      <div
        style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))', marginBottom: 9, lineHeight: 1.5 }}
      >
        {t('agents.custom.policy.hint')}
      </div>

      {/* 规则列表 */}
      {rules.length === 0 ? (
        <div
          style={{
            fontSize: 12.5,
            color: 'rgb(var(--ink-fg-3))',
            padding: '11px 13px',
            borderRadius: 9,
            background: 'rgb(var(--ink-1) / 0.5)',
            border: '1px solid rgb(var(--ink-border-soft))'
          }}
        >
          {rulesQ.isLoading ? t('agents.custom.policy.loading') : t('agents.custom.policy.empty')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rules.map((rule) => {
            const dormant = rule.contextMode !== derivedMode
            return (
              <div
                key={rule.id}
                style={{
                  padding: '10px 12px',
                  borderRadius: 9,
                  background: 'rgb(var(--ink-1) / 0.5)',
                  border: '1px solid rgb(var(--ink-border-soft))'
                }}
              >
                <div className="flex items-center" style={{ gap: 8 }}>
                  <span
                    style={{
                      fontSize: 11,
                      padding: '2px 8px',
                      borderRadius: 5,
                      whiteSpace: 'nowrap',
                      color: 'rgb(var(--c-warn))',
                      background: 'rgb(var(--c-warn) / 0.12)',
                      border: '1px solid rgb(var(--c-warn) / 0.28)'
                    }}
                  >
                    {t(`agents.custom.policy.capability.${rule.capability}`, {
                      defaultValue: rule.capability
                    })}
                  </span>
                  <span style={{ flex: 1 }} />
                  <Switch on={rule.enabled} onChange={(v) => onToggleRule(rule.id, v)} />
                  <button
                    type="button"
                    aria-label={t('agents.custom.policy.delete')}
                    onClick={() => onDeleteRule(rule.id)}
                    style={{
                      ...smallBtn,
                      color: 'rgb(var(--c-fail))',
                      borderColor: 'rgb(var(--c-fail) / 0.3)'
                    }}
                  >
                    {t('agents.custom.policy.delete')}
                  </button>
                </div>
                <div
                  style={{
                    marginTop: 6,
                    fontFamily: 'var(--font-mono, monospace)',
                    fontSize: 12,
                    color: 'rgb(var(--ink-fg))',
                    wordBreak: 'break-all'
                  }}
                >
                  {formatRuleMatcher(rule)}
                </div>
                <div style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))', marginTop: 3 }}>
                  {t('agents.custom.policy.hits', { n: rule.useCount })}
                  {rule.lastUsedAt ? ` · ${rule.lastUsedAt}` : ''}
                </div>
                {dormant && (
                  <div
                    style={{
                      fontSize: 11.5,
                      color: 'rgb(var(--c-warn))',
                      marginTop: 5,
                      lineHeight: 1.5
                    }}
                  >
                    {t('agents.custom.policy.dormant')}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* 创建表单 */}
      {formOpen && (
        <div
          style={{
            marginTop: 10,
            padding: '12px 13px',
            borderRadius: 10,
            background: 'rgb(var(--ink-2) / 0.55)',
            border: '1px solid rgb(var(--ink-border))',
            display: 'flex',
            flexDirection: 'column',
            gap: 10
          }}
        >
          <div className="seg" style={{ width: '100%' }}>
            {(['domain_write', 'exec', 'web'] as const).map((c) => (
              <button
                key={c}
                type="button"
                className={capability === c ? 'on' : ''}
                style={{ flex: 1, justifyContent: 'center' }}
                onClick={() => {
                  setCapability(c)
                  setConfirming(false)
                }}
              >
                {t(`agents.custom.policy.capability.${c}`)}
              </button>
            ))}
          </div>

          {/* context_mode 只读展示（自动派生，表单不可选） */}
          <div style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))', lineHeight: 1.5 }}>
            {t('agents.custom.policy.modeDerived', { mode: modeLabel })}
          </div>

          {capability === 'domain_write' &&
            (writeToolChoices.length === 0 ? (
              <div style={{ fontSize: 12, color: 'rgb(var(--ink-fg-3))', lineHeight: 1.5 }}>
                {t('agents.custom.policy.toolNone')}
              </div>
            ) : (
              <Select value={tool || undefined} onValueChange={setTool}>
                <SelectTrigger>
                  <SelectValue placeholder={t('agents.custom.policy.toolLabel')} />
                </SelectTrigger>
                <SelectContent className="z-[70]">
                  {writeToolChoices.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ))}

          {capability === 'exec' &&
            (skills.length === 0 ? (
              <div style={{ fontSize: 12, color: 'rgb(var(--ink-fg-3))', lineHeight: 1.5 }}>
                {t('agents.custom.policy.skillNone')}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <Select
                  value={skillName || undefined}
                  onValueChange={(v) => {
                    setSkillName(v)
                    setEntryFile('')
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t('agents.custom.policy.skillLabel')} />
                  </SelectTrigger>
                  <SelectContent className="z-[70]">
                    {skills.map((s) => (
                      <SelectItem key={s.name} value={s.name}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {skill && (
                  <Select value={entryFile || undefined} onValueChange={setEntryFile}>
                    <SelectTrigger>
                      <SelectValue placeholder={t('agents.custom.policy.entryLabel')} />
                    </SelectTrigger>
                    <SelectContent className="z-[70]">
                      {skill.files.map((f) => (
                        <SelectItem key={f} value={f}>
                          {f}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <input
                  type="text"
                  value={interpreter}
                  placeholder={t('agents.custom.policy.interpreterPlaceholder')}
                  onChange={(e) => setInterpreter(e.target.value)}
                  style={{ ...inputStyle, fontFamily: 'var(--font-mono, monospace)' }}
                />
                <div>
                  <div className="flex items-center" style={{ gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 12, color: 'rgb(var(--ink-fg-2))', flex: 1 }}>
                      {t('agents.custom.policy.argsLabel')}
                    </span>
                    <button
                      type="button"
                      style={smallBtn}
                      onClick={() => setArgs((prev) => [...prev, { kind: 'pattern', value: '' }])}
                    >
                      {t('agents.custom.policy.argAdd')}
                    </button>
                  </div>
                  <div
                    style={{
                      fontSize: 11.5,
                      color: 'rgb(var(--ink-fg-3))',
                      marginBottom: 6,
                      lineHeight: 1.5
                    }}
                  >
                    {t('agents.custom.policy.argsHint')}
                  </div>
                  {args.map((a, i) => (
                    <div key={i} className="flex items-center" style={{ gap: 6, marginBottom: 6 }}>
                      <select
                        value={a.kind}
                        aria-label={t('agents.custom.policy.argsLabel')}
                        onChange={(e) =>
                          setArgs((prev) =>
                            prev.map((x, j) =>
                              j === i ? { ...x, kind: e.target.value as PolicyArgKind } : x
                            )
                          )
                        }
                        style={{ ...inputStyle, width: 110, flexShrink: 0 }}
                      >
                        {POLICY_ARG_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {t(`agents.custom.policy.argKind.${k}`)}
                          </option>
                        ))}
                      </select>
                      <input
                        type="text"
                        value={a.value}
                        placeholder={t(`agents.custom.policy.argPlaceholder.${a.kind}`)}
                        onChange={(e) =>
                          setArgs((prev) =>
                            prev.map((x, j) => (j === i ? { ...x, value: e.target.value } : x))
                          )
                        }
                        style={{ ...inputStyle, fontFamily: 'var(--font-mono, monospace)' }}
                      />
                      <button
                        type="button"
                        style={smallBtn}
                        onClick={() => setArgs((prev) => prev.filter((_, j) => j !== i))}
                      >
                        {t('agents.custom.policy.argRemove')}
                      </button>
                    </div>
                  ))}
                </div>
                <label
                  className="flex items-center"
                  style={{ gap: 8, fontSize: 12, color: 'rgb(var(--ink-fg-2))', cursor: 'pointer' }}
                >
                  <Checkbox
                    checked={pinCwd}
                    onCheckedChange={setPinCwd}
                  />
                  {t('agents.custom.policy.cwdPin')}
                </label>
              </div>
            ))}

          {capability === 'web' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <input
                type="text"
                value={origin}
                placeholder={t('agents.custom.policy.originPlaceholder')}
                onChange={(e) => setOrigin(e.target.value)}
                style={{ ...inputStyle, fontFamily: 'var(--font-mono, monospace)' }}
              />
              <div style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))', lineHeight: 1.5 }}>
                {t('agents.custom.policy.originHint')}
              </div>
            </div>
          )}

          {formErr && (
            <div
              style={{
                fontSize: 12,
                color: 'rgb(var(--c-fail))',
                padding: '8px 10px',
                borderRadius: 8,
                background: 'rgb(var(--c-fail) / 0.10)',
                border: '1px solid rgb(var(--c-fail) / 0.25)',
                wordBreak: 'break-word'
              }}
            >
              {formErr}
            </div>
          )}

          {/* 影响面确认（红样式，两步）：先例 = 身份文档编辑器高危形态，无 PIN。 */}
          {confirming && (
            <DangerBlock>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                {t('agents.custom.policy.warnTitle')}
              </div>
              {t('agents.custom.policy.warnBody', {
                agent: agentTitle,
                action: actionSummary,
                mode: modeLabel
              })}
            </DangerBlock>
          )}

          <div className="flex items-center" style={{ gap: 8 }}>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              style={smallBtn}
              onClick={() => {
                setFormOpen(false)
                resetForm()
              }}
            >
              {t('agents.custom.policy.cancel')}
            </button>
            {confirming ? (
              <button
                type="button"
                disabled={creating}
                onClick={onConfirmCreate}
                style={{
                  fontFamily: 'inherit',
                  fontSize: 12.5,
                  fontWeight: 500,
                  padding: '6px 13px',
                  borderRadius: 8,
                  cursor: creating ? 'wait' : 'pointer',
                  color: 'rgb(var(--c-fail))',
                  background: 'rgb(var(--c-fail) / 0.12)',
                  border: '1px solid rgb(var(--c-fail) / 0.4)'
                }}
              >
                {t('agents.custom.policy.confirmCreate')}
              </button>
            ) : (
              <button
                type="button"
                onClick={onCreateClick}
                style={{
                  fontFamily: 'inherit',
                  fontSize: 12.5,
                  fontWeight: 500,
                  padding: '6px 13px',
                  borderRadius: 8,
                  cursor: 'pointer',
                  color: 'rgb(var(--c-cta-fg))',
                  background: 'rgb(var(--c-cta-bg))',
                  border: 0
                }}
              >
                {t('agents.custom.policy.create')}
              </button>
            )}
          </div>
        </div>
      )}

      {/* per-agent skill 挂载（S6 W3-3 §5.1）：多选 registry skill（builtin + installed）。未配置（NULL）
          = 默认挂载集（email/search），显式列表（含零挂载）verbatim；挂载不能复活全局关掉的 skill。 */}
      <div style={{ marginTop: 10 }}>
        <div className="flex items-baseline" style={{ gap: 8, marginBottom: 4 }}>
          <label style={{ fontSize: 13, fontWeight: 500, color: 'rgb(var(--ink-fg))' }}>
            {t('agents.custom.policy.mounts.label')}
          </label>
          {skillsMode === 'defaults' && (
            <span style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))' }}>
              {t('agents.custom.policy.mounts.defaultTag')}
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: 11.5,
            color: 'rgb(var(--ink-fg-3))',
            marginBottom: 9,
            lineHeight: 1.5
          }}
        >
          {t('agents.custom.policy.mounts.hint')}
        </div>
        {mountSkillNames.length === 0 ? (
          <div
            style={{
              fontSize: 12.5,
              color: 'rgb(var(--ink-fg-3))',
              padding: '11px 13px',
              borderRadius: 9,
              background: 'rgb(var(--ink-1) / 0.5)',
              border: '1px solid rgb(var(--ink-border-soft))'
            }}
          >
            {t('agents.custom.policy.mounts.empty')}
          </div>
        ) : (
          <div className="flex items-center" style={{ gap: 8, flexWrap: 'wrap' }}>
            {mountSkillNames.map((name) => {
              const on = mountedSkills.includes(name)
              return (
                <button
                  key={name}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    onSkillsChange(
                      on ? mountedSkills.filter((x) => x !== name) : [...mountedSkills, name]
                    )
                  }
                  style={{
                    padding: '6px 11px',
                    borderRadius: 8,
                    fontFamily: 'var(--font-mono, monospace)',
                    fontSize: 12.5,
                    cursor: 'pointer',
                    color: on ? 'rgb(var(--c-accent))' : 'rgb(var(--ink-fg-2))',
                    background: on ? 'rgb(var(--c-accent) / 0.14)' : 'rgb(var(--ink-1) / 0.5)',
                    border: `1px solid ${on ? 'rgb(var(--c-accent))' : 'rgb(var(--ink-border))'}`
                  }}
                >
                  {name}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
