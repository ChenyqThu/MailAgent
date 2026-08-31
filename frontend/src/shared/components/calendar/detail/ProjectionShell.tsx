// task 08-27 P4d —— matter / agent 两个投影形态共用的抽屉外壳。
//
// 与 mail 形态共用 Drawer 本体与 .dw-* 那套版式，差三处：
//   ① dw-accent 与角色徽标取**源色**（--cal-src-matter / --cal-src-agent），与月/周/日
//      视图确立的三源色语言同一套（token 在 index.css，此处只引用不新造）；
//   ② 脚上只有一条「去源头」按钮 —— 投影**不给编辑与删除**，为什么写在按钮下面那行，
//      否则用户找不到删除会当成 bug；
//   ③ 时间行的标签随源变（截止时间 / 计划时刻），值恒是一个时间点（投影没有跨度）。

import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { AgendaEntry } from '@shared/api/types'

import { MetaRow } from './MetaRow'
import { pad, ymd } from '../lib/format'

/** 投影条目恒是时间点（endIso 为 null）—— `YYYY-MM-DD  HH:MM`，与 mail 形态同排版。 */
function formatMoment(iso: string): string {
  const d = new Date(iso)
  return `${ymd(d)}  ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function sourceVar(entry: AgendaEntry): string {
  return entry.source === 'agent' ? '--cal-src-agent' : '--cal-src-matter'
}

interface ProjectionShellProps {
  entry: AgendaEntry
  onClose: () => void
  /** 角色徽标：这条是哪一类投影（事项 / Agent 排程）。 */
  roleLabel: string
  /** 时间行的标签（截止时间 / 计划时刻）。 */
  timeLabel: string
  /** 「它是投影，改要去源头」那一句。 */
  note: string
  jumpLabel: string
  jumpTitle: string
  jumpIcon: React.ReactNode
  onJump: () => void
  /** 时间行之后的主体行。 */
  children: React.ReactNode
}

export function ProjectionShell({
  entry,
  onClose,
  roleLabel,
  timeLabel,
  note,
  jumpLabel,
  jumpTitle,
  jumpIcon,
  onJump,
  children
}: ProjectionShellProps): React.ReactElement {
  const { t } = useTranslation()
  const cssVar = sourceVar(entry)
  return (
    <>
      <div className="dw-head">
        <span
          className="dw-accent"
          style={{ background: `rgb(var(${cssVar}))` }}
          aria-hidden
          data-src={entry.source}
        />
        <div className="flex-1 min-w-0">
          <span
            className="dw-role"
            data-src={entry.source}
            style={{
              color: `rgb(var(${cssVar}))`,
              background: `rgb(var(${cssVar}) / 0.13)`,
              border: `1px solid rgb(var(${cssVar}) / 0.3)`
            }}
          >
            {roleLabel}
          </span>
          <h2 className="dw-title">
            {entry.title || (
              <span className="empty-field">{t('calendar.shared.untitled', '未命名事件')}</span>
            )}
          </h2>
        </div>
        <button
          type="button"
          className="dw-close"
          onClick={onClose}
          title={t('calendar.drawer.closeTitle', '关闭 (Esc)')}
          aria-label={t('calendar.shared.closeAria', '关闭')}
        >
          <X size={16} strokeWidth={2} />
        </button>
      </div>

      <div className="dw-body scrollbar-thin">
        <MetaRow label={timeLabel}>
          <span className="meta-v mono">{formatMoment(entry.startIso)}</span>
        </MetaRow>
        {children}
      </div>

      <div className="dw-foot">
        <div className="owner-ops-row">
          <button type="button" className="btn-op edit" onClick={onJump} title={jumpTitle}>
            {jumpIcon}
            {jumpLabel}
          </button>
        </div>
        <div className="ops-note">{note}</div>
        <div className="fm">
          {t('calendar.drawer.sourceLabel', '源')}: {entry.source}
          <br />
          ID: {entry.id}
        </div>
      </div>
    </>
  )
}
