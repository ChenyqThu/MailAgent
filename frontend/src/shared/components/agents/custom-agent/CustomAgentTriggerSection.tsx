// Extracted from CustomAgentDrawer.tsx — shared Field wrapper & multi-trigger editor section.

import type React from 'react'

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shared/components/ui/select'
import { Switch } from '../primitives'
import {
  cronToRuleSeed,
  DEFAULT_RULE,
  hostTimezone,
  newScheduleValue,
  ScheduleBuilder
} from '../schedule'
import { CUSTOM_AGENT_INPUT_STYLE } from './shared'
import { type CustomAgentFormController, type LeadUnit, TRIGGER_KINDS } from './useCustomAgentForm'

// 小 Field（label + hint + children）。与 ./drawers/Field 同形状但各自一份 —— 那份是
// settings/ 八个配置页的共用件，本文件维持私有副本，两边都没有依赖对方。
export function CustomAgentField({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div>
      <div className="flex items-baseline" style={{ gap: 8, marginBottom: 7 }}>
        <label style={{ fontSize: 13, fontWeight: 500, color: 'rgb(var(--ink-fg))' }}>
          {label}
        </label>
        {hint && <span style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))' }}>{hint}</span>}
      </div>
      {children}
    </div>
  )
}

export function CustomAgentTriggerSection({
  form
}: {
  form: CustomAgentFormController
}): React.ReactElement {
  const {
    t,
    triggerV2Enabled,
    calendarTriggerEnabled,
    triggerEntries,
    setTriggerEntries,
    editingTriggerIndex,
    setEditingTriggerIndex,
    triggerEnabled,
    setTriggerEnabled,
    triggerKind,
    setTriggerKind,
    cronMode,
    setCronMode,
    cron,
    setCron,
    triggerTz,
    setTriggerTz,
    schedule,
    setSchedule,
    senderPattern,
    setSenderPattern,
    subjectPattern,
    setSubjectPattern,
    folders,
    setFolders,
    threadIds,
    setThreadIds,
    calendarTitlePattern,
    setCalendarTitlePattern,
    calendarOrganizerPattern,
    setCalendarOrganizerPattern,
    calendarAttendeePattern,
    setCalendarAttendeePattern,
    calendarIds,
    setCalendarIds,
    leadAmount,
    setLeadAmount,
    leadUnit,
    setLeadUnit,
    tzOptions,
    editTrigger,
    addTrigger,
    triggerEntrySummary
  } = form

  return (
    <CustomAgentField
      label={t('agents.custom.trigger.label')}
      hint={t('agents.custom.trigger.hint')}
    >
      {triggerV2Enabled && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
          {triggerEntries.map((entry, index) => (
            <div
              key={entry.id ?? `new-${index}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: 8,
                border: '1px solid rgb(var(--ink-border))',
                borderRadius: 8
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5 }}>
                  {t(`agents.custom.trigger.kind.${entry.kind}`)}
                </div>
                <div
                  style={{
                    marginTop: 2,
                    color: 'rgb(var(--ink-fg-3))',
                    fontSize: 11.5,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {triggerEntrySummary(entry)}
                </div>
              </div>
              <Switch
                on={entry.enabled}
                onChange={(checked) => {
                  setTriggerEntries((items) =>
                    items.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, enabled: checked } : item
                    )
                  )
                  if (editingTriggerIndex === index) setTriggerEnabled(checked)
                }}
              />
              <button type="button" className="btn-ghost" onClick={() => editTrigger(index)}>
                {t('agents.custom.trigger.edit')}
              </button>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => {
                  setTriggerEntries((items) => items.filter((_, itemIndex) => itemIndex !== index))
                  setEditingTriggerIndex(null)
                }}
              >
                {t('agents.custom.trigger.delete')}
              </button>
            </div>
          ))}
          <button type="button" className="btn-ghost" onClick={addTrigger}>
            {t('agents.custom.trigger.add')}
          </button>
          {editingTriggerIndex !== null && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
              <Switch on={triggerEnabled} onChange={setTriggerEnabled} />
              {t('agents.custom.trigger.enabled')}
            </label>
          )}
        </div>
      )}
      <div className="seg" style={{ width: '100%' }}>
        {TRIGGER_KINDS.filter(
          (kind) => calendarTriggerEnabled || !kind.startsWith('calendar_')
        ).map((k) => (
          <button
            key={k}
            type="button"
            className={triggerKind === k ? 'on' : ''}
            style={{ flex: 1, justifyContent: 'center' }}
            onClick={() => {
              setTriggerKind(k)
              if (triggerV2Enabled && editingTriggerIndex === null && k !== 'none') {
                setEditingTriggerIndex(triggerEntries.length)
                setTriggerEnabled(false)
              }
            }}
          >
            {t(`agents.custom.trigger.kind.${k}`)}
          </button>
        ))}
      </div>

      {triggerKind === 'none' && (
        <div
          style={{
            fontSize: 11.5,
            color: 'rgb(var(--ink-fg-3))',
            marginTop: 8,
            lineHeight: 1.5
          }}
        >
          {t('agents.custom.trigger.noneHint')}
        </div>
      )}

      {/* 07-24 排程统一：默认走共享 ScheduleBuilder（与报告 Agent 同一组件）。
            老 `kind:'cron'` 行落在 legacy 分支原样编辑，用户显式点按钮才升级。 */}
      {triggerKind === 'cron' && cronMode === 'schedule' && (
        <div style={{ marginTop: 12 }}>
          <ScheduleBuilder value={schedule} onChange={setSchedule} />
        </div>
      )}

      {triggerKind === 'cron' && cronMode === 'legacy' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
          <div>
            <input
              type="text"
              value={cron}
              placeholder="0 9 * * 1-5"
              onChange={(e) => setCron(e.target.value)}
              style={{ ...CUSTOM_AGENT_INPUT_STYLE, fontFamily: 'var(--font-mono, monospace)' }}
            />
            <div
              style={{
                fontSize: 11.5,
                color: 'rgb(var(--ink-fg-3))',
                marginTop: 6,
                lineHeight: 1.5
              }}
            >
              {t('agents.custom.trigger.cronHint')}
            </div>
          </div>
          <Select value={triggerTz} onValueChange={setTriggerTz}>
            <SelectTrigger>
              <SelectValue placeholder={t('agents.custom.trigger.tz')} />
            </SelectTrigger>
            <SelectContent className="z-[70]">
              {tzOptions.map((tz) => (
                <SelectItem key={tz} value={tz}>
                  {tz}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* 升级入口：认得出的常见 cron 用它当种子，认不出就退默认规则。
           **单向** —— 构建器的值模型不覆盖任意 cron，回不去才是诚实的。 */}
          <button
            type="button"
            className="btn-ghost"
            style={{ fontFamily: 'inherit', alignSelf: 'flex-start' }}
            onClick={() => {
              const seed = cronToRuleSeed(cron)
              setSchedule(
                newScheduleValue(
                  seed ?? { ...DEFAULT_RULE, freq: 'weekly', weekdays: [1, 2, 3, 4, 5] },
                  triggerTz || hostTimezone()
                )
              )
              setCronMode('schedule')
            }}
          >
            {t('agents.custom.trigger.upgradeToBuilder')}
          </button>
          <div style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))', lineHeight: 1.5 }}>
            {t('agents.custom.trigger.legacyCronHint')}
          </div>
        </div>
      )}

      {triggerKind === 'email_filter' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
          <input
            type="text"
            value={senderPattern}
            placeholder={t('agents.custom.trigger.senderPlaceholder')}
            onChange={(e) => setSenderPattern(e.target.value)}
            style={{ ...CUSTOM_AGENT_INPUT_STYLE, fontFamily: 'var(--font-mono, monospace)' }}
          />
          <input
            type="text"
            value={subjectPattern}
            placeholder={t('agents.custom.trigger.subjectPlaceholder')}
            onChange={(e) => setSubjectPattern(e.target.value)}
            style={{ ...CUSTOM_AGENT_INPUT_STYLE, fontFamily: 'var(--font-mono, monospace)' }}
          />
          <input
            type="text"
            value={folders}
            placeholder={t('agents.custom.trigger.foldersPlaceholder')}
            onChange={(e) => setFolders(e.target.value)}
            style={CUSTOM_AGENT_INPUT_STYLE}
          />
          {triggerV2Enabled && (
            <input
              type="text"
              value={threadIds}
              placeholder={t('agents.custom.trigger.threadIdsPlaceholder')}
              onChange={(e) => setThreadIds(e.target.value)}
              style={CUSTOM_AGENT_INPUT_STYLE}
            />
          )}
          <div style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))', lineHeight: 1.5 }}>
            {t('agents.custom.trigger.emailHint')}
          </div>
        </div>
      )}

      {(triggerKind === 'calendar_event_change' || triggerKind === 'calendar_before_start') && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
          <input
            type="text"
            value={calendarTitlePattern}
            placeholder={t('agents.custom.trigger.titlePatternPlaceholder')}
            onChange={(e) => setCalendarTitlePattern(e.target.value)}
            style={{ ...CUSTOM_AGENT_INPUT_STYLE, fontFamily: 'var(--font-mono, monospace)' }}
          />
          <input
            type="text"
            value={calendarOrganizerPattern}
            placeholder={t('agents.custom.trigger.organizerPatternPlaceholder')}
            onChange={(e) => setCalendarOrganizerPattern(e.target.value)}
            style={{ ...CUSTOM_AGENT_INPUT_STYLE, fontFamily: 'var(--font-mono, monospace)' }}
          />
          <input
            type="text"
            value={calendarAttendeePattern}
            placeholder={t('agents.custom.trigger.attendeePatternPlaceholder')}
            onChange={(e) => setCalendarAttendeePattern(e.target.value)}
            style={{ ...CUSTOM_AGENT_INPUT_STYLE, fontFamily: 'var(--font-mono, monospace)' }}
          />
          <input
            type="text"
            value={calendarIds}
            placeholder={t('agents.custom.trigger.calendarIdsPlaceholder')}
            onChange={(e) => setCalendarIds(e.target.value)}
            style={CUSTOM_AGENT_INPUT_STYLE}
          />
          {triggerKind === 'calendar_before_start' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 150px', gap: 10 }}>
              <input
                type="number"
                min={1}
                value={leadAmount}
                aria-label={t('agents.custom.trigger.leadLabel')}
                onChange={(e) => setLeadAmount(Number(e.target.value))}
                style={CUSTOM_AGENT_INPUT_STYLE}
              />
              <Select value={leadUnit} onValueChange={(value) => setLeadUnit(value as LeadUnit)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-[70]">
                  <SelectItem value="minutes">
                    {t('agents.custom.trigger.leadUnitMinutes')}
                  </SelectItem>
                  <SelectItem value="hours">{t('agents.custom.trigger.leadUnitHours')}</SelectItem>
                  <SelectItem value="days">{t('agents.custom.trigger.leadUnitDays')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <div style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))', lineHeight: 1.5 }}>
            {t('agents.custom.trigger.calendarHint')}
          </div>
        </div>
      )}
    </CustomAgentField>
  )
}
