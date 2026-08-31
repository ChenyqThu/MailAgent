// P4a agent-config lane — 配置页骨架：八区词表 + 统一页头（启用 · 试运行一次 · 保存
// 恒在同一行，r7 §三 判据 3）+ 只读弱化卡（判据 2）。
//
// 「八区」中的「最近跑了什么」有意不在词表里：运行记录归团队页记录列（r7 §三 判据 6），
// 配置页只管「它该怎么干活」。每个 agent 的表单以 SectionMap（Partial）声明自己有哪些区，
// 没有的区整段不渲染 —— SectionMap 本身就是分区声明表，不另立第二份对照数据。
import { useTranslation } from 'react-i18next'

import { StatefulButton, type StatefulButtonState } from '@shared/components/ui/stateful-button'
import { Switch } from '../primitives'

export type SectionId =
  | 'identity'
  | 'instructions'
  | 'model'
  | 'when'
  | 'capabilities'
  | 'specific'
  | 'danger'

// 渲染顺序（模块私有：component 文件不导出非组件值，保 react-refresh 边界）。
const SECTION_ORDER: readonly SectionId[] = [
  'identity',
  'instructions',
  'model',
  'when',
  'capabilities',
  'specific',
  'danger'
]

export type SectionMap = Partial<Record<SectionId, React.ReactNode>>

export function SettingsScaffold({
  title,
  subtitle,
  banner,
  enable,
  tryRun,
  save,
  sections
}: {
  title: string
  subtitle?: string
  /** 页头下方的横幅（web 只读提示 / 新建提示等），可缺省。 */
  banner?: React.ReactNode
  /** 缺省 = 页头不渲染启用开关（主 Agent 没有「停用」这回事）。 */
  enable?: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }
  /** 缺省 = 不渲染「试运行一次」（无定时行为 / 无 run-now 通道的成员）。 */
  tryRun?: { onRun: () => void; running: boolean }
  save: { state: StatefulButtonState; onSave: () => void; disabled?: boolean; label?: string }
  sections: SectionMap
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <header
        className="flex items-center"
        style={{
          gap: 12,
          padding: '13px 18px',
          borderBottom: '1px solid rgb(var(--ink-border-soft))',
          flexShrink: 0
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: 'rgb(var(--ink-fg))',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {title}
          </h2>
          {subtitle && (
            <div style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))', marginTop: 1 }}>
              {subtitle}
            </div>
          )}
        </div>
        {enable && (
          <label
            className="flex items-center"
            style={{
              gap: 8,
              fontSize: 12.5,
              color: 'rgb(var(--ink-fg-2))',
              flexShrink: 0,
              ...(enable.disabled ? { opacity: 0.5, pointerEvents: 'none' as const } : null)
            }}
          >
            {t('agents.config.enable')}
            <Switch
              on={enable.on}
              ariaLabel={t('agents.config.enable')}
              onChange={enable.onChange}
            />
          </label>
        )}
        {tryRun && (
          <button
            type="button"
            className="btn-ghost"
            style={{ fontFamily: 'inherit', flexShrink: 0 }}
            disabled={tryRun.running}
            onClick={tryRun.onRun}
          >
            {t('agentSettings.header.tryRun')}
          </button>
        )}
        <StatefulButton
          type="button"
          onClick={save.onSave}
          disabled={save.disabled || save.state === 'loading'}
          state={save.state}
          successText={t('agentSettings.saveDone')}
        >
          {save.label ?? t('agents.config.save')}
        </StatefulButton>
      </header>

      <div className="scrollbar-thin" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <div
          style={{ maxWidth: 720, padding: 18, display: 'flex', flexDirection: 'column', gap: 24 }}
        >
          {banner}
          {SECTION_ORDER.filter((id) => sections[id] != null).map((id) => (
            <section key={id} aria-label={t(`agentSettings.section.${id}`)}>
              <div
                style={{
                  fontSize: 11.5,
                  fontWeight: 600,
                  letterSpacing: '0.04em',
                  color: 'rgb(var(--ink-fg-3))',
                  marginBottom: 10
                }}
              >
                {t(`agentSettings.section.${id}`)}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {sections[id]}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}

/** 只读弱化卡（r7 §三 判据 2）：虚线边 + 更低对比 + 「只读」pip，与输入控件在视觉上分开。
 *  身份文档 / 内置能力 / 注入的工具 / 系统提示词默认段一律走它。 */
export function ReadonlyCard({
  title,
  children
}: {
  title?: string
  children: React.ReactNode
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div
      style={{
        padding: '11px 13px',
        borderRadius: 10,
        background: 'rgb(var(--ink-1) / 0.35)',
        border: '1px dashed rgb(var(--ink-border))'
      }}
    >
      <div className="flex items-center" style={{ gap: 7, marginBottom: 6 }}>
        {title && (
          <span style={{ fontSize: 12.5, fontWeight: 500, color: 'rgb(var(--ink-fg-2))' }}>
            {title}
          </span>
        )}
        <span
          style={{
            fontSize: 10.5,
            padding: '1px 6px',
            borderRadius: 4,
            color: 'rgb(var(--ink-fg-3))',
            border: '1px solid rgb(var(--ink-border))'
          }}
        >
          {t('agentSettings.readonly')}
        </span>
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.6, color: 'rgb(var(--ink-fg-2))' }}>{children}</div>
    </div>
  )
}

/** 内建成员在「能碰什么」区位置的一句话（design §8.2：比留一堆灰掉的开关诚实）。 */
export function BuiltinToolsNote(): React.ReactElement {
  const { t } = useTranslation()
  return <ReadonlyCard>{t('agentSettings.builtinToolsNote')}</ReadonlyCard>
}
