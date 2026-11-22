// S5 W2 — 完全自定义 Agent（type='custom'）配置抽屉。三段式脚手架
//（进/退场动效 + header/body/footer glass 面板），字段是 custom agent 所需：
// title / prompt / model / enabled + trigger 判别式（无 | cron | email_filter）+ allowed_tools
// 多选 + budget 两门 + run 历史（9 状态穷举）。
//
// 纪律：
//  • 校验只做浅校验（必填 / 数值范围 / cron 5 段 / email 谓词至少一个）；深校验（croniter /
//    正则可编译 / ReDoS 长度）交后端 validate_agent_config_patch，保存失败展示后端 detail。
//  • trigger 类型「无」用非空 sentinel（seg 控件，避开 radix SelectItem 空串必崩）。
//  • run 历史 state 由后端 derive_agent_run_state 单源投影，前端**只穷举渲染不推导**；
//    paused_* 永不渲染为成功（ADR-003 D4 / ADR-004 P6）。
//  • 新建两段式：createAgent({type:'custom'}) 建草稿 → setConfig 补 trigger/tool_policy/budget。
//
// Lane C2（07-07 review 拆分）：run 历史 / 自动化策略 / 额外能力三个 section 已机械搬迁到
// ./custom-agent/ 子目录（逻辑逐字节不变）；RunStateBadge 在此 re-export，供
// AgentRecordView 沿用 './CustomAgentDrawer' 导入路径不变。
import type React from 'react'

import { Drawer } from '@shared/components/ui/drawer'
import { Select, SelectContent, SelectTrigger, SelectValue } from '@shared/components/ui/select'
import { AgentIdentityHeader } from './AgentAvatar'
import { AutomationPolicySection } from './custom-agent/AutomationPolicySection'
import { CapabilityCards } from './custom-agent/CapabilityCards'
import {
  CustomAgentDrawerFooter,
  CustomAgentErrorBanner
} from './custom-agent/CustomAgentDrawerFooter'
import {
  CustomAgentField,
  CustomAgentTriggerSection
} from './custom-agent/CustomAgentTriggerSection'
import { CUSTOM_AGENT_INPUT_STYLE } from './custom-agent/shared'
import {
  type CustomAgentDrawerProps,
  MAX_RUN_SECONDS_CEILING,
  slugifyTitle,
  useCustomAgentForm
} from './custom-agent/useCustomAgentForm'
import { ModelSelectItems } from './drawers/ModelSelectItems'
import { ReportIcon, Switch } from './primitives'

export { RunStateBadge } from './custom-agent/RunHistorySection'

export function CustomAgentDrawer({
  cfg,
  open,
  create = false,
  initial,
  onClose
}: CustomAgentDrawerProps): React.ReactElement | null {
  const form = useCustomAgentForm({ cfg, open, create, initial, onClose })
  const {
    t,
    enabledModels,
    toolOptions,
    opennessFlags,
    connectorSummaries,
    enabled,
    setEnabled,
    title,
    setTitle,
    description,
    setDescription,
    avatar,
    setAvatar,
    setAvatarDirty,
    prompt,
    setPrompt,
    setPromptDirty,
    model,
    setModel,
    selectedTools,
    setSelectedTools,
    setToolsDirty,
    grantExec,
    setGrantExec,
    setGrantDirty,
    grantWeb,
    setGrantWeb,
    setWebDirty,
    grantSessions,
    setGrantSessions,
    setSessionsDirty,
    grantConnectors,
    setGrantConnectors,
    grantConnectorTools,
    setGrantConnectorTools,
    setConnectorsDirty,
    grantComputerUse,
    setGrantComputerUse,
    setComputerUseDirty,
    mountedSkills,
    setMountedSkills,
    skillsMode,
    setSkillsMode,
    setSkillsDirty,
    maxRunsPerDay,
    setMaxRunsPerDay,
    maxRunSeconds,
    setMaxRunSeconds,
    policyTriggerKind
  } = form

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
        <span style={{ color: 'rgb(var(--c-accent))', display: 'flex' }}>
          <ReportIcon name="cog" size={16} />
        </span>
        <h2 style={{ fontSize: 15, fontWeight: 600, color: 'rgb(var(--ink-fg))', flex: 1 }}>
          {create ? t('agents.custom.newTitle') : t('agents.custom.configTitle', { title })}
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
          {/* enable */}
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
                {t('agents.config.enable')}
              </div>
              <div style={{ fontSize: 12, color: 'rgb(var(--ink-fg-3))', marginTop: 2 }}>
                {t('agents.custom.enableHint')}
              </div>
            </div>
            <Switch on={enabled} onChange={setEnabled} />
          </div>

          {/* 名称 + 头像并排（0804 dogfood 3b/3e）：头像编辑器默认折叠在「更换」后面，
              抽屉首屏不再被形状/配色两张网格吃掉。 */}
          <CustomAgentField label={t('agents.avatar.identityLabel')} hint={t('agents.avatar.hint')}>
            <AgentIdentityHeader
              agentId={cfg?.id ?? slugifyTitle(title)}
              value={avatar}
              onChange={(next) => {
                setAvatar(next)
                setAvatarDirty(true)
              }}
              name={title}
              onNameChange={setTitle}
              namePlaceholder={t('agents.custom.titlePlaceholder')}
              inputStyle={CUSTOM_AGENT_INPUT_STYLE}
            />
          </CustomAgentField>

          <CustomAgentField
            label={t('agents.custom.descriptionLabel')}
            hint={t('agents.custom.descriptionHint')}
          >
            <textarea
              value={description}
              maxLength={1000}
              rows={3}
              placeholder={t('agents.custom.descriptionPlaceholder')}
              onChange={(event) => setDescription(event.target.value)}
              className="scrollbar-thin"
              style={{
                ...CUSTOM_AGENT_INPUT_STYLE,
                resize: 'vertical',
                lineHeight: 1.5,
                minHeight: 72
              }}
            />
          </CustomAgentField>

          {/* prompt (task) */}
          <CustomAgentField
            label={t('agents.custom.promptLabel')}
            hint={t('agents.custom.promptHint')}
          >
            <textarea
              value={prompt}
              placeholder={t('agents.custom.promptPlaceholder')}
              onChange={(e) => {
                setPrompt(e.target.value)
                setPromptDirty(true)
              }}
              rows={8}
              className="scrollbar-thin"
              style={{
                ...CUSTOM_AGENT_INPUT_STYLE,
                resize: 'vertical',
                lineHeight: 1.6,
                fontSize: 13,
                minHeight: 150
              }}
            />
          </CustomAgentField>

          {/* model */}
          <CustomAgentField label={t('agents.config.model')}>
            <Select value={model || undefined} onValueChange={setModel}>
              <SelectTrigger>
                <SelectValue placeholder={t('agents.config.model')} />
              </SelectTrigger>
              <SelectContent className="z-[70]">
                <ModelSelectItems models={enabledModels} current={model || null} />
              </SelectContent>
            </Select>
          </CustomAgentField>

          <CustomAgentTriggerSection form={form} />

          <CapabilityCards
            selectedTools={selectedTools}
            onSelectedToolsChange={(next) => {
              setSelectedTools(next)
              setToolsDirty(true)
            }}
            agentTitle={title.trim() || (cfg ? cfg.title : t('agents.custom.newTitle'))}
            triggerKind={policyTriggerKind}
            grantExec={grantExec}
            onGrantExecChange={(next) => {
              setGrantExec(next)
              setGrantDirty(true)
            }}
            grantWeb={grantWeb}
            onGrantWebChange={(next) => {
              setGrantWeb(next)
              setWebDirty(true)
            }}
            grantSessions={grantSessions}
            onGrantSessionsChange={(next) => {
              setGrantSessions(next)
              setSessionsDirty(true)
            }}
            flags={opennessFlags}
            toolOptions={toolOptions}
            connectorOptions={connectorSummaries.map((c) => ({
              id: c.connector_id,
              label: c.display_name,
              status: c.status
            }))}
            grantConnectors={grantConnectors}
            onGrantConnectorsChange={(next) => {
              setGrantConnectors(next)
              setConnectorsDirty(true)
            }}
            grantConnectorTools={grantConnectorTools}
            onGrantConnectorToolsChange={(next) => {
              setGrantConnectorTools(next)
              setConnectorsDirty(true)
            }}
            grantComputerUse={grantComputerUse}
            onGrantComputerUseChange={(next) => {
              setGrantComputerUse(next)
              setComputerUseDirty(true)
            }}
          />

          {/* budget 两门 */}
          <CustomAgentField
            label={t('agents.custom.budget.label')}
            hint={t('agents.custom.budget.hint')}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className="flex items-center" style={{ gap: 10 }}>
                <span style={{ fontSize: 12.5, color: 'rgb(var(--ink-fg-2))', flex: 1 }}>
                  {t('agents.custom.budget.maxRunsPerDay')}
                </span>
                <input
                  type="number"
                  min={0}
                  value={maxRunsPerDay}
                  onChange={(e) => setMaxRunsPerDay(Number(e.target.value))}
                  style={{ ...CUSTOM_AGENT_INPUT_STYLE, width: 110 }}
                />
              </div>
              <div className="flex items-center" style={{ gap: 10 }}>
                <span style={{ fontSize: 12.5, color: 'rgb(var(--ink-fg-2))', flex: 1 }}>
                  {t('agents.custom.budget.maxRunSeconds', { max: MAX_RUN_SECONDS_CEILING })}
                </span>
                <input
                  type="number"
                  min={1}
                  max={MAX_RUN_SECONDS_CEILING}
                  value={maxRunSeconds}
                  onChange={(e) => setMaxRunSeconds(Number(e.target.value))}
                  style={{ ...CUSTOM_AGENT_INPUT_STYLE, width: 110 }}
                />
              </div>
            </div>
          </CustomAgentField>

          {/* 自动化策略（S5 W5b；仅编辑既有时 —— 建规归属校验要求 agent 行已存在） */}
          {!create && cfg && (
            <AutomationPolicySection
              agentId={cfg.id}
              agentTitle={title.trim() || cfg.title}
              triggerKind={policyTriggerKind}
              writeToolChoices={toolOptions.tools
                .filter((tl) => tl.class === 'domain_write' && selectedTools.includes(tl.name))
                .map((tl) => tl.name)}
              mountedSkills={mountedSkills}
              skillsMode={skillsMode}
              onSkillsChange={(next) => {
                setMountedSkills(next)
                setSkillsDirty(true)
                setSkillsMode('explicit')
              }}
            />
          )}

          {/* P4a：run 历史从配置面移走（r7 §三 判据 6）—— 归团队页记录列，组件本体
              RunHistorySection 保留（RunStateBadge 仍从本文件 re-export）。 */}

          <CustomAgentErrorBanner err={form.err} />
        </div>
      </div>

      <CustomAgentDrawerFooter form={form} cfg={cfg} create={create} onClose={onClose} />
    </Drawer>
  )
}
