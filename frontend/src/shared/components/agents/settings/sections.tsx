// P4a agent-config lane — 配置页骨架：八区词表 + 统一页头（启用 · 试运行一次 · 保存
// 恒在同一行，r7 §三 判据 3）+ 只读弱化卡（判据 2）。
//
// 「八区」中的「最近跑了什么」有意不在词表里：运行记录归团队页记录列（r7 §三 判据 6），
// 配置页只管「它该怎么干活」。每个 agent 的表单以 SectionMap（Partial）声明自己有哪些区，
// 没有的区整段不渲染 —— SectionMap 本身就是分区声明表，不另立第二份对照数据。
import { useContext } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Clock,
  Cpu,
  FileText,
  SlidersHorizontal,
  Trash2,
  Wrench,
  type LucideIcon
} from 'lucide-react'

import { StatefulButton, type StatefulButtonState } from '@shared/components/ui/stateful-button'
import { Switch } from '../primitives'
import { SettingsChromeContext } from './chrome'

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

// 分区图标：只做「一眼认出是哪一区」的辨识锚，不承载状态。identity / danger 两区
// 不走标准卡（见 renderSection），故不在表内。
const SECTION_ICON: Record<Exclude<SectionId, 'identity' | 'danger'>, LucideIcon> = {
  instructions: FileText,
  model: Cpu,
  when: Clock,
  capabilities: Wrench,
  specific: SlidersHorizontal
}

// 卡面（surface tier）：页底 → 卡 ink-2 → 卡内控件 ink-1（INPUT_STYLE / SwitchCard /
// ReadonlyCard 都在这一层）。暗色下 ink-1 比 ink-2 深 = 控件内凹；亮色下 ink-1 比
// ink-2 浅 = 输入框发白，两侧都读得出「卡上放着控件」。
const CARD_CLASS = 'rounded-[var(--r-card)] border border-ink-border-soft bg-ink-2/50'

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
  // 嵌在团队页成员详情里时，名字已由外层 52px 页头负责 —— 这里退成一条动作栏，
  // 左边只留角色副标题（那是外层页头没有的信息），标题不再说第二遍。
  const { embedded } = useContext(SettingsChromeContext)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: '1 1 0%', minHeight: 0 }}>
      <header
        className="flex items-center"
        style={{
          gap: 12,
          padding: embedded ? '9px 18px' : '13px 18px',
          borderBottom: '1px solid rgb(var(--ink-border-soft))',
          flexShrink: 0
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          {!embedded && (
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
          )}
          {subtitle && (
            <div
              className="truncate"
              style={{
                fontSize: 11.5,
                color: 'rgb(var(--ink-fg-3))',
                marginTop: embedded ? 0 : 1
              }}
            >
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
          style={{ maxWidth: 720, padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}
        >
          {banner}
          {SECTION_ORDER.filter((id) => sections[id] != null).map((id) => (
            <SettingsSection key={id} id={id} label={t(`agentSettings.section.${id}`)}>
              {sections[id]}
            </SettingsSection>
          ))}
        </div>
      </div>
    </div>
  )
}

/** 一个分区的外壳。三种形态：
 *  • identity —— hero 面（ink-3 提亮一档 + 实线边），不出「身份」小标题：头像和名字
 *    自己就是标题，再压一行标签只是噪音（aria-label 仍在，读屏不丢分区名）。
 *  • danger —— 不成卡：一条 hairline 分隔 + 弱化标题，收尾而不喊叫。
 *  • 其余 —— 标准卡：图标 + 标题的页眉行 + hairline + 表单体。 */
function SettingsSection({
  id,
  label,
  children
}: {
  id: SectionId
  label: string
  children: React.ReactNode
}): React.ReactElement {
  if (id === 'identity') {
    return (
      <section
        aria-label={label}
        className="flex flex-col gap-4 rounded-[var(--r-card)] border border-ink-border bg-ink-3/45 p-4"
      >
        {children}
      </section>
    )
  }
  if (id === 'danger') {
    return (
      <section aria-label={label} className="mt-2 border-t border-ink-border-soft pt-4">
        <div className="mb-2.5 flex items-center gap-2 text-[12px] font-medium text-ink-fg-3">
          <Trash2 size={12} strokeWidth={1.9} aria-hidden="true" className="shrink-0" />
          {label}
        </div>
        <div className="flex flex-col gap-3">{children}</div>
      </section>
    )
  }
  const Icon = SECTION_ICON[id]
  return (
    <section aria-label={label} className={CARD_CLASS}>
      <div className="flex items-center gap-2 border-b border-ink-border-soft px-4 py-3">
        <Icon size={13} strokeWidth={1.9} aria-hidden="true" className="shrink-0 text-ink-fg-3" />
        <span className="text-[13px] font-semibold text-ink-fg-1">{label}</span>
      </div>
      <div className="flex flex-col gap-4 p-4">{children}</div>
    </section>
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
    <div className="rounded-[var(--r-ctl)] border border-dashed border-ink-border bg-ink-1/40 px-3.5 py-3">
      <div className="mb-1.5 flex items-center gap-2">
        {title && <span className="text-[12.5px] font-medium text-ink-fg-2">{title}</span>}
        <span className="rounded-[4px] border border-ink-border px-1.5 py-px text-[10.5px] text-ink-fg-3">
          {t('agentSettings.readonly')}
        </span>
      </div>
      <div className="text-[12px] leading-[1.6] text-ink-fg-2">{children}</div>
    </div>
  )
}

/** 内建成员在「能碰什么」区位置的一句话（design §8.2：比留一堆灰掉的开关诚实）。 */
export function BuiltinToolsNote(): React.ReactElement {
  const { t } = useTranslation()
  return <ReadonlyCard>{t('agentSettings.builtinToolsNote')}</ReadonlyCard>
}
