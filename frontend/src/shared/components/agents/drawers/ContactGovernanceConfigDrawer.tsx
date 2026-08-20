// 通讯录 agent 面 v2 —— /agents「通讯录治理」配置抽屉。后端 DB v65 播种单行
// （id='contact_governance_agent'、type='contact_governance'），只编辑、无新建无删除。
//
// 骨架逐字照 `ContactProfileConfigDrawer` 的三段式（头 / 可滚正文由 Field 块串起来 /
// 脚是取消 + 保存）——治理 agent 升格成标准内建 agent 行之后，配置面就该长得跟它的邻居
// 一样。与画像抽屉的差别只有三处，都是语义差别不是风格差别：
//
//   ① 排程只有「每日运行时刻」，没有「每轮人数上限」—— 治理扫描一次跑完增量，不像画像
//      那样按人计费。🔴 trigger_json 仍是**整列覆写不是 merge**，只有一个字段也按整列写。
//   ② 提示词区 = **默认全文只读展示（可折叠）+ 追加段编辑**（owner 拍板，偏离原型的
//      「全文替换」）。用途是贴公司背景 / 部门组织架构这类长期上下文，接在内置提示词之后
//      （后端 `_effective_prompt` = default + append）。语义与画像抽屉的「提示词追加段」同构，
//      载体不同：画像走 agent 行的 `prompt` 列，治理走 profile doc `contact_agent`。
//   ③ 多一段只读工具清单（从退役的 `ContactAgentToolFace` 迁来，内容一字未改，仍读零依赖
//      叶子 `@shared/lib/contactToolFace`）。
//
// 🔴 这里**没有**任何「总闸未开 / 已开」的状态说明段（owner 08-19 拍板，压过画像抽屉先例）：
// `MAILAGENT_CONTACT_AGENT_ENABLED` 即将默认开并撤出 Labs，现在再教用户一个马上会消失的概念
// 只是噪声。字节级 flag 门不受影响 —— 通讯录列表头的 ✨Agent 胶囊与它上游的查询照旧由
// `useContactFlags` 门着，这里撤的只是给用户看的提示文案。
//
// 🔴 保存是**两次串行调用**（agent 行 + profile doc），任一失败如实报错、不关抽屉、不吞：
// 一个抽屉两个后端载体是事实，把它藏起来只会让「保存成功但提示词没存上」变成静默缺陷。

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, FileText } from 'lucide-react'

import type { AgentAvatarConfig, ReportAgentConfig, ReportConfigPatch } from '@shared/api/types'
import { Drawer } from '@shared/components/ui/drawer'
import { StatefulButton } from '@shared/components/ui/stateful-button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shared/components/ui/select'
import { ContactPip } from '@shared/components/contacts/parts'
import {
  useContactAgentPrompt,
  useContactOrgFrame,
  useSaveContactAgentPrompt,
  useSaveContactOrgFrame
} from '@shared/components/contacts/hooks'
import { useEnabledModels } from '@shared/hooks/useLlmModels'
import { cn } from '@shared/lib/cn'
import { CONTACT_TOOL_FACE_GROUPS, type ContactToolGroup } from '@shared/lib/contactToolFace'
import { errorMessage } from '@shared/lib/ipcErrors'

import { AgentIdentityHeader } from '../AgentAvatar'
import { ReportIcon, Switch } from '../primitives'
import { useSetConfig } from '../hooks'
import { CONTACT_GOVERNANCE_AGENT_ID } from '../shared'
import { Field } from './Field'
import { ModelSelectItems } from './ModelSelectItems'

/** 模型下拉「跟随全局默认」哨兵（radix SelectItem 禁空串 value）。 */
const FOLLOW_GLOBAL_MODEL = '__follow_global__'
/** fallback「跟随全局」哨兵（行级列 NULL）。 */
const FALLBACK_FOLLOW_GLOBAL = '__follow_global_fb__'
/** fallback「不设」哨兵（行级列 '[]'）。 */
const FALLBACK_NONE = '__none__'

/** 排程缺省 —— 与后端治理配置的 dataclass 默认同值（行没配 trigger_json 时就按它跑）。 */
const DEFAULT_FIRE_HOUR = 4
/** 🔴 「参考 KOS」缺字段默认 **true**（与后端同口径）：老行的 trigger_json 里没有这个键，
 *  读成 false 会让一个从没被关过的开关在界面上显示成「关着」。 */
const DEFAULT_USE_KOS = true

const PERMISSION_TONE: Record<ContactToolGroup['permission'], 'neutral' | 'info' | 'warn'> = {
  read: 'neutral',
  propose: 'info',
  write: 'warn'
}

const TOOL_FACE_COUNT = CONTACT_TOOL_FACE_GROUPS.reduce((n, group) => n + group.tools.length, 0)

/** 从 trigger_json 读字面配置字段。这行的 trigger **不是** `CustomAgentTrigger` 判别式
 *  （没有 `v`/`kind`），故 `ReportAgentConfig['trigger']` 的静态类型对不上 —— 在这里就地
 *  过一次 `unknown` 并做运行时形状检查（同 `ContactProfileConfigDrawer::readSchedule`）。 */
function readTrigger(cfg: ReportAgentConfig | null): { fireHour: number; useKos: boolean } {
  const raw = cfg?.trigger as unknown as
    | { fire_hour?: unknown; use_kos?: unknown }
    | null
    | undefined
  const hour = raw?.fire_hour
  const kos = raw?.use_kos
  return {
    fireHour:
      typeof hour === 'number' && Number.isInteger(hour) && hour >= 0 && hour <= 23
        ? hour
        : DEFAULT_FIRE_HOUR,
    // 只有明确的 boolean 才算数：缺字段 / null / 野值一律回落 true。
    useKos: typeof kos === 'boolean' ? kos : DEFAULT_USE_KOS
  }
}

/** 只读工具清单 —— 迁自退役的 `ContactAgentToolFace`，行样式与 i18n key 一字未改。 */
function ToolFaceList(): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-1">
      {CONTACT_TOOL_FACE_GROUPS.map((group) =>
        group.tools.map((name) => (
          <div
            key={name}
            className="flex items-baseline gap-2 rounded-[var(--r-ctl)] bg-ink-fg/[0.025] px-[9px] py-1.5"
          >
            <code className="shrink-0 font-mono text-micro text-ink-fg">{name}</code>
            <ContactPip tone={PERMISSION_TONE[group.permission]}>
              {t(`contacts.agent.perm.${group.permission}`)}
            </ContactPip>
            <span className="min-w-0 flex-1 text-micro leading-[1.5] text-ink-fg-2 [text-wrap:pretty]">
              {t(`contacts.agent.desc.${name}`)}
            </span>
          </div>
        ))
      )}
    </div>
  )
}

export function ContactGovernanceConfigDrawer({
  cfg,
  open,
  onClose
}: {
  cfg: ReportAgentConfig | null
  open: boolean
  onClose: () => void
}): React.ReactElement | null {
  const { t } = useTranslation()
  const { save, isSaving } = useSetConfig()
  const { models: enabledModels } = useEnabledModels()
  // 提示词文档：`content` = 追加段，`defaultContent` = 内置默认全文（只读展示）。
  const promptDoc = useContactAgentPrompt(open)
  const savePrompt = useSaveContactAgentPrompt()
  // 组织架构框架：同机制的另一份 profile doc，没有默认全文，只有 owner 自己写的内容。
  const orgFrameDoc = useContactOrgFrame(open)
  const saveOrgFrame = useSaveContactOrgFrame()

  const [enabled, setEnabled] = useState(false)
  const [model, setModel] = useState('')
  const [modelDirty, setModelDirty] = useState(false)
  const [fallbackModel, setFallbackModel] = useState<string>(FALLBACK_FOLLOW_GLOBAL)
  const [fallbackModelDirty, setFallbackModelDirty] = useState(false)
  const [fireHour, setFireHour] = useState(DEFAULT_FIRE_HOUR)
  const [useKos, setUseKos] = useState(DEFAULT_USE_KOS)
  // trigger_json 这一列的脏标记（时刻与 KOS 开关共用 —— 整列覆写，改一个就得把另一个也写回）。
  const [scheduleDirty, setScheduleDirty] = useState(false)
  const [avatar, setAvatar] = useState<AgentAvatarConfig | null>(null)
  const [avatarDirty, setAvatarDirty] = useState(false)
  const [append, setAppend] = useState('')
  const [appendDirty, setAppendDirty] = useState(false)
  const [orgFrame, setOrgFrame] = useState('')
  const [orgFrameDirty, setOrgFrameDirty] = useState(false)
  const [defaultOpen, setDefaultOpen] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open || !cfg) return
    setEnabled(cfg.enabled)
    setModel(cfg.model ?? '')
    setModelDirty(false)
    setFallbackModel(
      cfg.fallback_models == null
        ? FALLBACK_FOLLOW_GLOBAL
        : cfg.fallback_models.length === 0
          ? FALLBACK_NONE
          : cfg.fallback_models[0]
    )
    setFallbackModelDirty(false)
    const trigger = readTrigger(cfg)
    setFireHour(trigger.fireHour)
    setUseKos(trigger.useKos)
    setScheduleDirty(false)
    setAvatar(cfg.avatar ?? null)
    setAvatarDirty(false)
    setDefaultOpen(false)
    setErr(null)
    setSaveFailed(false)
  }, [open, cfg])

  // 追加段单独回填：它来自另一条查询（profile doc），落定时间与 cfg 无关。
  // 🔴 回显的是 `content` 原样，**不再** `content || defaultContent` —— 新语义下库里存的
  // 就是追加段，把默认全文灌进编辑框会在下一次保存时把它物化成用户自定义。
  useEffect(() => {
    if (!open || promptDoc.data === undefined) return
    setAppend(promptDoc.data.content)
    setAppendDirty(false)
  }, [open, promptDoc.data])

  // 同上，另一条查询各自落定。
  useEffect(() => {
    if (!open || orgFrameDoc.data === undefined) return
    setOrgFrame(orgFrameDoc.data)
    setOrgFrameDirty(false)
  }, [open, orgFrameDoc.data])
  /* eslint-enable react-hooks/set-state-in-effect */

  const busy = isSaving || savePrompt.isPending || saveOrgFrame.isPending
  const defaultContent = promptDoc.data?.defaultContent ?? ''
  const usingDefault = append.trim() === ''

  const inputStyle: React.CSSProperties = {
    width: '100%',
    fontFamily: 'inherit',
    fontSize: 13.5,
    color: 'rgb(var(--ink-fg))',
    background: 'rgb(var(--ink-1) / 0.55)',
    border: '1px solid rgb(var(--ink-border))',
    borderRadius: 8,
    padding: '9px 11px'
  }

  const onSave = async (): Promise<void> => {
    if (!cfg) return
    setSaveFailed(false)
    if (scheduleDirty && (!Number.isInteger(fireHour) || fireHour < 0 || fireHour > 23)) {
      setErr(t('agents.contactGovernance.errFireHour'))
      return
    }
    setErr(null)
    const patch: ReportConfigPatch = { enabled }
    if (modelDirty) patch.model = model
    if (fallbackModelDirty) {
      patch.fallback_models =
        fallbackModel === FALLBACK_FOLLOW_GLOBAL
          ? null
          : fallbackModel === FALLBACK_NONE
            ? []
            : [fallbackModel]
    }
    // 🔴 trigger_json 整列覆写：两个字段一起发，少发一个会把它抹回缺省。
    if (scheduleDirty) patch.trigger = { fire_hour: fireHour, use_kos: useKos }
    if (avatarDirty) patch.avatar = avatar
    try {
      await save(CONTACT_GOVERNANCE_AGENT_ID, patch)
      // 🔴 追加段读失败时那个框是一份空草稿 —— 不许拿它去覆盖 owner 可能已有的内容。
      if (appendDirty && !promptDoc.isError) await savePrompt.mutateAsync(append)
      // 🔴 同一条纪律：框架读失败时不回写（空框 = 清空整份组织架构，代价比提示词更大）。
      if (orgFrameDirty && !orgFrameDoc.isError) await saveOrgFrame.mutateAsync(orgFrame)
      onClose()
    } catch (e: unknown) {
      setErr(errorMessage(e))
      setSaveFailed(true)
    }
  }

  return (
    <Drawer open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <header
        className="flex items-center"
        style={{
          gap: 10,
          padding: '15px 18px',
          borderBottom: '1px solid rgb(var(--ink-border-soft))',
          flexShrink: 0
        }}
      >
        <span style={{ color: 'rgb(var(--c-ai))', display: 'flex' }}>
          <ReportIcon name="sparkles" size={16} />
        </span>
        <h2 style={{ fontSize: 15, fontWeight: 600, color: 'rgb(var(--ink-fg))', flex: 1 }}>
          {t('agents.contactGovernance.configTitle', { title: cfg?.title ?? '' })}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('agents.source.close')}
          style={{
            display: 'grid',
            placeItems: 'center',
            width: 28,
            height: 28,
            borderRadius: 7,
            background: 'transparent',
            border: 0,
            cursor: 'pointer',
            color: 'rgb(var(--ink-fg-2))'
          }}
        >
          <ReportIcon name="x" size={16} />
        </button>
      </header>

      <div className="scrollbar-thin" style={{ flex: 1, overflowY: 'auto', padding: 18 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* 启用（row.enabled，保存即生效）。 */}
          <div
            className="flex items-center"
            style={{
              gap: 12,
              padding: '13px 14px',
              borderRadius: 10,
              background: 'rgb(var(--ink-2) / 0.55)',
              border: '1px solid rgb(var(--ink-border))'
            }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 500, color: 'rgb(var(--ink-fg))' }}>
                {t('agents.contactGovernance.enable')}
              </div>
              <div style={{ fontSize: 12, color: 'rgb(var(--ink-fg-3))', marginTop: 2 }}>
                {t('agents.contactGovernance.enableHint')}
              </div>
            </div>
            <Switch
              on={enabled}
              ariaLabel={t('agents.contactGovernance.enable')}
              onChange={setEnabled}
            />
          </div>

          {/* 头像 + 名称（专型单例行，名称不可编辑，patch 只带 avatar）。 */}
          <Field label={t('agents.avatar.label')} hint={t('agents.avatar.hint')}>
            <AgentIdentityHeader
              agentId={CONTACT_GOVERNANCE_AGENT_ID}
              value={avatar}
              onChange={(next) => {
                setAvatar(next)
                setAvatarDirty(true)
              }}
              name={cfg?.title ?? ''}
            />
          </Field>

          {/* 排程 + 参考 KOS（同一列 trigger_json 的两个字面字段）。
              治理扫描一次跑完增量、不按人计费 → 有时刻，没有「每轮上限」。 */}
          <Field
            label={t('agents.contactGovernance.schedule')}
            hint={t('agents.contactGovernance.scheduleHint')}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className="flex items-center" style={{ gap: 10 }}>
                <span style={{ fontSize: 12.5, color: 'rgb(var(--ink-fg-2))', flex: 1 }}>
                  {t('agents.contactGovernance.dailyHour')}
                </span>
                <input
                  type="number"
                  min={0}
                  max={23}
                  aria-label={t('agents.contactGovernance.dailyHour')}
                  value={fireHour}
                  onChange={(e) => {
                    setFireHour(Number(e.target.value))
                    setScheduleDirty(true)
                  }}
                  style={{ ...inputStyle, width: 110 }}
                />
              </div>
              {/* 参考 KOS —— 同住 trigger_json，所以放在这个 Field 里、共用 scheduleDirty。 */}
              <div className="flex items-center" style={{ gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12.5, color: 'rgb(var(--ink-fg-2))' }}>
                    {t('agents.contactGovernance.useKos')}
                  </div>
                  <div
                    style={{
                      fontSize: 11.5,
                      color: 'rgb(var(--ink-fg-3))',
                      marginTop: 2,
                      lineHeight: 1.5
                    }}
                  >
                    {t('agents.contactGovernance.useKosHint')}
                  </div>
                </div>
                <Switch
                  on={useKos}
                  ariaLabel={t('agents.contactGovernance.useKos')}
                  onChange={(v) => {
                    setUseKos(v)
                    setScheduleDirty(true)
                  }}
                />
              </div>
            </div>
          </Field>

          {/* 模型（行级 model 列，空串 = 跟随全局 LLM_MODEL）。 */}
          <Field label={t('agents.config.model')} hint={t('agents.contactProfile.modelHint')}>
            <Select
              value={model || FOLLOW_GLOBAL_MODEL}
              onValueChange={(v) => {
                setModel(v === FOLLOW_GLOBAL_MODEL ? '' : v)
                setModelDirty(true)
              }}
              disabled={busy}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-[70]">
                <SelectItem value={FOLLOW_GLOBAL_MODEL}>
                  {t('agents.contactProfile.modelFollowGlobal')}
                </SelectItem>
                <ModelSelectItems models={enabledModels} current={model || null} />
              </SelectContent>
            </Select>
          </Field>

          {/* fallback（行级列；null = 跟随全局、[] = 显式不设、[m] = 单模型链）。 */}
          <Field
            label={t('agents.contactProfile.fallback')}
            hint={t('agents.contactProfile.fallbackHint')}
          >
            <Select
              value={fallbackModel}
              onValueChange={(v) => {
                setFallbackModel(v)
                setFallbackModelDirty(true)
              }}
              disabled={busy}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-[70]">
                <SelectItem value={FALLBACK_FOLLOW_GLOBAL}>
                  {t('agents.contactProfile.fallbackFollowGlobal')}
                </SelectItem>
                <SelectItem value={FALLBACK_NONE}>
                  {t('agents.contactProfile.fallbackNone')}
                </SelectItem>
                <ModelSelectItems
                  models={enabledModels}
                  current={
                    fallbackModel !== FALLBACK_FOLLOW_GLOBAL && fallbackModel !== FALLBACK_NONE
                      ? fallbackModel
                      : null
                  }
                />
              </SelectContent>
            </Select>
          </Field>

          {/* 提示词：默认全文只读（可折叠）+ 追加段编辑。 */}
          <Field
            label={t('agents.contactGovernance.prompt')}
            hint={t('agents.contactGovernance.promptHint')}
          >
            <div className="mb-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setDefaultOpen((prev) => !prev)}
                aria-expanded={defaultOpen}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-[var(--r-ctl)] px-2 py-1 text-meta text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg"
              >
                <ChevronDown
                  size={12}
                  aria-hidden
                  className={cn(
                    'transition-transform duration-fast ease-standard',
                    defaultOpen && 'rotate-180'
                  )}
                />
                {t('agents.contactGovernance.promptDefaultToggle')}
              </button>
              <span aria-hidden className="flex-1" />
              <span
                className={cn(
                  'shrink-0 rounded-full px-2 py-0.5 text-micro',
                  usingDefault ? 'bg-ok/[0.12] text-ok' : 'bg-ai/[0.12] text-ai'
                )}
              >
                {t(
                  usingDefault
                    ? 'contacts.agent.prompt.usingDefault'
                    : 'contacts.agent.prompt.customized'
                )}
              </span>
            </div>
            {defaultOpen ? (
              <pre className="scrollbar-thin mb-2 max-h-[260px] overflow-auto whitespace-pre-wrap rounded-[var(--r-ctl)] border border-ink-border bg-ink-0/40 p-2.5 font-mono text-micro leading-[1.7] text-ink-fg-2">
                {defaultContent}
              </pre>
            ) : null}
            {promptDoc.isError ? (
              <p className="mb-1.5 text-meta leading-[1.6] text-warn">
                {t('contacts.agent.prompt.loadFailed')}
              </p>
            ) : null}
            <textarea
              value={append}
              disabled={promptDoc.isPending || promptDoc.isError}
              placeholder={t('agents.contactGovernance.promptAppendPlaceholder')}
              aria-label={t('agents.contactGovernance.promptAppend')}
              onChange={(e) => {
                setAppend(e.target.value)
                setAppendDirty(true)
              }}
              rows={7}
              className="scrollbar-thin"
              style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.6, fontSize: 13 }}
            />
            <div
              style={{
                fontSize: 11.5,
                color: 'rgb(var(--ink-fg-3))',
                marginTop: 6,
                lineHeight: 1.5
              }}
            >
              {t('agents.contactGovernance.promptAppendNote')}
            </div>
          </Field>

          {/* 组织架构框架：owner 自己写的公司 / 部门层级，治理 Agent 拿它判「框架外」。
              交互与上面的提示词追加段同构（同一份 inputStyle、同一条「读失败不回写」纪律），
              少一个「默认全文」折叠 —— 这份文档没有默认。 */}
          <Field
            label={t('agents.contactGovernance.orgFrame')}
            hint={t('agents.contactGovernance.orgFrameHint')}
          >
            {orgFrameDoc.isError ? (
              <p className="mb-1.5 text-meta leading-[1.6] text-warn">
                {t('contacts.agent.prompt.loadFailed')}
              </p>
            ) : null}
            <textarea
              value={orgFrame}
              disabled={orgFrameDoc.isPending || orgFrameDoc.isError}
              placeholder={t('agents.contactGovernance.orgFramePlaceholder')}
              aria-label={t('agents.contactGovernance.orgFrame')}
              onChange={(e) => {
                setOrgFrame(e.target.value)
                setOrgFrameDirty(true)
              }}
              rows={8}
              className="scrollbar-thin"
              style={{
                ...inputStyle,
                resize: 'vertical',
                lineHeight: 1.7,
                // 层级靠 ` / ` 对齐着读，等宽字体下才不会歪。
                fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace',
                fontSize: 12.5
              }}
            />
            <div
              style={{
                fontSize: 11.5,
                color: 'rgb(var(--ink-fg-3))',
                marginTop: 6,
                lineHeight: 1.5
              }}
            >
              {t('agents.contactGovernance.orgFrameNote')}
            </div>
          </Field>

          {/* 工具清单只读。搬自退役的工作台「它能做什么」tab，内容一字未改。 */}
          <Field
            label={t('agents.contactGovernance.tools', { count: TOOL_FACE_COUNT })}
            hint={t('agents.contactGovernance.toolsHint')}
          >
            <ToolFaceList />
            <p className="mt-[7px] text-micro leading-[1.6] text-ink-fg-3">
              {t('contacts.agent.tools.footnote')}
            </p>
            {/* 🔴 工作台副标写着「它读、它提议，你确认」，这里却列着三件写工具 —— 不说清场地
                就是撒谎。policy.ts 的 `contact_governance` 行 deny 掉整个 domain_write 类。 */}
            <p className="mt-1 text-micro leading-[1.6] text-ink-fg-3">
              {t('contacts.agent.tools.governanceOff')}
            </p>
          </Field>

          <div className="flex items-start gap-2 rounded-[var(--r-ctl)] border border-ink-border-soft bg-ink-1/40 px-3 py-2.5">
            <FileText size={13} aria-hidden className="mt-0.5 shrink-0 text-ink-fg-3" />
            <p className="text-micro leading-[1.6] text-ink-fg-3">
              {t('agents.contactGovernance.queueNote')}
            </p>
          </div>

          {err && (
            <div style={{ fontSize: 12.5, color: 'rgb(var(--c-danger, var(--ink-fg-1)))' }}>
              {err}
            </div>
          )}
        </div>
      </div>

      <footer
        className="flex items-center"
        style={{
          gap: 10,
          padding: '13px 18px',
          borderTop: '1px solid rgb(var(--ink-border-soft))',
          flexShrink: 0,
          justifyContent: 'flex-end'
        }}
      >
        <button
          type="button"
          onClick={onClose}
          className="btn-ghost"
          style={{ fontFamily: 'inherit' }}
        >
          {t('agents.config.cancel')}
        </button>
        <StatefulButton
          type="button"
          onClick={() => void onSave()}
          disabled={busy}
          state={busy ? 'loading' : saveFailed ? 'error' : 'idle'}
        >
          {t('agents.config.save')}
        </StatefulButton>
      </footer>
    </Drawer>
  )
}
