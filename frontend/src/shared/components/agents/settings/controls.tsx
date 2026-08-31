// P4a agent-config lane — 配置页共用小控件。
//
// • ModelGroup：模型统一成「主力 + 失败时回退」一组（r7 §三 判据 1 —— 结束
//   Fallback / 兜底 / 轻活三个名字的分裂）。只管布局与统一文案，两个 Select 由各表单
//   自带（各家的哨兵值映射到不同存储载体，不在这里归一）。
// • DailyHourSchedule：画像 / 治理「每日运行时刻 0–23」并进排程编辑器的 UI 语言
//   （句子块 + 时刻行，视觉对齐 ScheduleBuilder），但受限成「每天 HH:00」。
//   🔴 写回格式不变：它只吐 0–23 的整数，trigger_json 仍存 {fire_hour,…} 字面字段
//   （profile_config.py 行内热读这个形状），绝不产出 schedule envelope。
// • ChoiceChip / SwitchCard：抽屉里手抄了十来份的 chip / 开关卡收敛成一份。
import { useTranslation } from 'react-i18next'

import { Switch } from '../primitives'

export function ChoiceChip({
  on,
  onClick,
  disabled,
  children
}: {
  on: boolean
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}): React.ReactElement {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      style={{
        padding: '6px 12px',
        borderRadius: 8,
        fontFamily: 'inherit',
        fontSize: 13,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        color: on ? 'rgb(var(--c-accent))' : 'rgb(var(--ink-fg-2))',
        background: on ? 'rgb(var(--c-accent) / 0.14)' : 'rgb(var(--ink-1) / 0.5)',
        border: `1px solid ${on ? 'rgb(var(--c-accent))' : 'rgb(var(--ink-border))'}`,
        transition:
          'color 120ms cubic-bezier(0.4,0,0.2,1), background-color 120ms cubic-bezier(0.4,0,0.2,1), border-color 120ms cubic-bezier(0.4,0,0.2,1)'
      }}
    >
      {children}
    </button>
  )
}

export function SwitchCard({
  label,
  hint,
  on,
  onChange,
  disabled
}: {
  label: string
  hint?: string
  on: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}): React.ReactElement {
  return (
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
        <div style={{ fontSize: 13.5, fontWeight: 500, color: 'rgb(var(--ink-fg))' }}>{label}</div>
        {hint && (
          <div
            style={{ fontSize: 12, color: 'rgb(var(--ink-fg-3))', marginTop: 2, lineHeight: 1.5 }}
          >
            {hint}
          </div>
        )}
      </div>
      <span style={disabled ? { opacity: 0.5, pointerEvents: 'none' } : undefined}>
        <Switch on={on} ariaLabel={label} onChange={onChange} />
      </span>
    </div>
  )
}

export function ModelGroup({
  primary,
  fallback
}: {
  primary: React.ReactNode
  /** 缺省 = 该成员没有行级回退链（报告 / 搜索 / 自定义），只渲染主力行。 */
  fallback?: React.ReactNode
}): React.ReactElement {
  const { t } = useTranslation()
  const rowLabel: React.CSSProperties = {
    width: 84,
    flexShrink: 0,
    fontSize: 12.5,
    color: 'rgb(var(--ink-fg-2))'
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="flex items-center" style={{ gap: 10 }}>
        <span style={rowLabel}>{t('agentSettings.model.primary')}</span>
        <div style={{ flex: 1, minWidth: 0 }}>{primary}</div>
      </div>
      {fallback && (
        <>
          <div className="flex items-center" style={{ gap: 10 }}>
            <span style={rowLabel}>{t('agentSettings.model.fallback')}</span>
            <div style={{ flex: 1, minWidth: 0 }}>{fallback}</div>
          </div>
          <div style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))', lineHeight: 1.5 }}>
            {t('agentSettings.model.note')}
          </div>
        </>
      )}
    </div>
  )
}

const HOURS = Array.from({ length: 24 }, (_, i) => i)

export function DailyHourSchedule({
  hour,
  onHourChange
}: {
  hour: number
  onHourChange: (h: number) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const timeText = `${String(hour).padStart(2, '0')}:00`
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* 句子块 —— 与 ScheduleBuilder 的「活的句子」同一装饰配方（--ink-1 半透 + soft 边）。 */}
      <div
        style={{
          padding: '8px 10px',
          borderRadius: 'var(--r-ctl)',
          background: 'rgb(var(--ink-1) / 0.55)',
          border: '1px solid rgb(var(--ink-border-soft))'
        }}
      >
        <p
          data-testid="daily-hour-sentence"
          style={{
            margin: 0,
            minHeight: '1.5em',
            fontSize: 14,
            lineHeight: 1.5,
            fontWeight: 500,
            letterSpacing: '-0.01em',
            color: 'rgb(var(--ink-fg))'
          }}
        >
          {t('agentSettings.when.dailySentence', { time: timeText })}
        </p>
      </div>
      <div className="flex items-center" style={{ gap: 8, minHeight: 30 }}>
        <span
          style={{
            width: 52,
            flexShrink: 0,
            fontSize: 12,
            fontWeight: 500,
            color: 'rgb(var(--ink-fg-2))'
          }}
        >
          {t('agents.schedule.at')}
        </span>
        <select
          value={hour}
          aria-label={t('agentSettings.when.dailyHourLabel')}
          onChange={(e) => onHourChange(Number(e.target.value))}
          style={{
            fontFamily: 'inherit',
            fontSize: 13,
            color: 'rgb(var(--ink-fg))',
            background: 'rgb(var(--ink-1) / 0.55)',
            border: '1px solid rgb(var(--ink-border))',
            borderRadius: 'var(--r-ctl)',
            padding: '6px 9px'
          }}
        >
          {HOURS.map((h) => (
            <option key={h} value={h}>
              {String(h).padStart(2, '0')}
            </option>
          ))}
        </select>
        <span style={{ fontSize: 13, color: 'rgb(var(--ink-fg-2))' }}>:00</span>
      </div>
      <div style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))', lineHeight: 1.5 }}>
        {t('agentSettings.when.dailyHourOnly')}
      </div>
    </div>
  )
}
