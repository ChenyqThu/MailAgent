// S5 —— 报告里的「事项进展」条目（`matter_item` 块）。
//
// 视觉语言照 BlockRenderer 的 `email_item` 列表行（同一份报告里两种条目不该长成两个
// 世界）：左侧 tone 竖条 + 首行标识/标题/到期 + 次行元信息 + 悬停底色。语义（状态色、
// 优先级色、到期色阶）**不在这里重新发明**，一律取 `matterVocab` 的既有单源表。
//
// 🔴 icon 纪律：报告块的既有形态里事项没有专属 icon，这里也不发明一个。
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'

import type { ReportMatterItemBlock } from '@shared/api/types'
import { formatMatterDueRelative } from '@shared/lib/matterDerive'
import type { RenderCtx } from '../agents/lib'
import { toneColor } from '../agents/lib'
import { Pip } from '../agents/primitives'
import { useMatterNavigation } from '../matters/navigation'
import {
  MATTER_PRIORITY_TONES,
  MATTER_STATUS_TONES,
  matterDueTone,
  type MatterTone
} from '../matters/matterVocab'

/** 未知枚举值（后端加了新状态而前端还没跟上）→ neutral，不让整块塌掉。 */
function toneOf<T extends string>(table: Record<T, MatterTone>, value: string): MatterTone {
  return (table as Record<string, MatterTone | undefined>)[value] ?? 'neutral'
}

export function MatterItemBlock({
  block,
  ctx
}: {
  block: ReportMatterItemBlock
  ctx: RenderCtx
}): React.ReactElement {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const [hover, setHover] = useState(false)

  // render 期不许调 Date.now()（react-hooks/purity）—— 挂载时取一次快照（同
  // MatterList / ContactDetail 的模式；一份报告的到期色阶不需要逐秒重算）。
  const [now] = useState(() => Date.now())
  const statusTone = toneOf(MATTER_STATUS_TONES, block.status)
  const priorityTone = toneOf(MATTER_PRIORITY_TONES, block.priority)
  const dueTone = block.due_at != null ? (matterDueTone(block.due_at, now) ?? 'neutral') : null
  // 行首竖条只在「真的要紧」时出现（p0/p1 或到期告急），否则一排事项全带色条 = 没有重点。
  const accent: MatterTone | null =
    priorityTone !== 'neutral' ? priorityTone : dueTone && dueTone !== 'neutral' ? dueTone : null

  // 报告页内跳转走 router（`mailagent://matter/…` 不在 main 的 deeplink 词表里，
  // block.deeplink 是给外部引用的稳定形）。
  const open = (): void => {
    useMatterNavigation.getState().open(block.public_id)
    void navigate({ to: '/matters' })
  }

  const meta: React.ReactNode[] = []
  if (block.progress) {
    meta.push(
      <span key="progress" style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-2))' }}>
        {t('agents.block.matter.progress', {
          done: block.progress.done,
          total: block.progress.total
        })}
      </span>
    )
  }
  if (block.waiting_on?.length) {
    meta.push(
      <span key="waiting" style={{ fontSize: 11.5, color: 'rgb(var(--c-warn))' }}>
        {t('agents.block.matter.waitingOn', { names: block.waiting_on.join('、') })}
      </span>
    )
  }
  if (block.next_action) {
    meta.push(
      <span
        key="next"
        style={{
          fontSize: 11.5,
          color: 'rgb(var(--ink-fg-2))',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0
        }}
      >
        {t('agents.block.matter.nextAction', { title: block.next_action })}
      </span>
    )
  }
  if (block.signal_count) {
    meta.push(
      <span key="signals" style={{ fontSize: 11.5, color: 'rgb(var(--c-crit))' }}>
        {t('agents.block.matter.signals', { count: block.signal_count })}
      </span>
    )
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={t('agents.block.matter.open', { id: block.public_id })}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter') open()
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      id={`matter-${block.public_id}`}
      style={{
        position: 'relative',
        display: 'block',
        width: '100%',
        textAlign: 'left',
        cursor: 'pointer',
        padding: ctx.dense ? '9px 12px' : '13px 14px',
        paddingLeft: 16,
        borderRadius: 10,
        background: hover ? 'rgb(var(--ink-fg) / 0.03)' : 'rgb(var(--ink-2))',
        border: `1px solid ${hover ? 'rgb(var(--ink-border))' : 'rgb(var(--ink-border-soft))'}`,
        transition: 'background 120ms, border-color 120ms'
      }}
    >
      {accent && (
        <span
          style={{
            position: 'absolute',
            left: 0,
            top: 6,
            bottom: 6,
            width: 3,
            borderRadius: 2,
            background: toneColor(accent)
          }}
        />
      )}
      <div className="flex items-baseline" style={{ gap: 8 }}>
        <span
          style={{
            fontFamily: 'ui-monospace, monospace',
            fontSize: 11,
            color: 'rgb(var(--ink-fg-3))',
            flexShrink: 0
          }}
        >
          {block.public_id}
        </span>
        <span
          style={{
            fontSize: 13.5,
            fontWeight: 600,
            color: 'rgb(var(--ink-fg))',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
            minWidth: 0
          }}
        >
          {block.title}
        </span>
        {block.due_at != null && dueTone && (
          <span
            style={{
              fontSize: 11.5,
              color: dueTone === 'neutral' ? 'rgb(var(--ink-fg-3))' : toneColor(dueTone),
              flexShrink: 0
            }}
          >
            {t('agents.block.matter.due', {
              value: formatMatterDueRelative(block.due_at, now, i18n.language || 'zh-CN')
            })}
          </span>
        )}
      </div>
      <div className="flex items-center" style={{ gap: 8, marginTop: 5, flexWrap: 'wrap' }}>
        <Pip tone={statusTone}>
          {t(`matters.status.${block.status}`, { defaultValue: block.status })}
        </Pip>
        {block.health !== 'unknown' && (
          <span
            style={{
              fontSize: 11.5,
              color: block.health === 'on_track' ? 'rgb(var(--c-ok))' : 'rgb(var(--c-warn))'
            }}
          >
            {t(`matters.health.${block.health}`, { defaultValue: block.health })}
          </span>
        )}
        {priorityTone !== 'neutral' && (
          <Pip tone={priorityTone}>{block.priority.toUpperCase()}</Pip>
        )}
        {meta}
      </div>
      {block.summary && (
        <p
          style={{
            fontSize: 12.5,
            color: 'rgb(var(--ink-fg-1))',
            marginTop: 5,
            lineHeight: 1.55,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden'
          }}
        >
          {block.summary}
        </p>
      )}
    </div>
  )
}
