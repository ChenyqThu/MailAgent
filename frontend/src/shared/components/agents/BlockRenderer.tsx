// Sprint 20 — BlockRenderer：渲染 ReportDoc.blocks[]（types.ts ReportBlock 契约）。
// 一 block 一组件；未知类型优雅降级。移植自 ~/Downloads/agents/blocks.jsx。
//
// 固定渲染：layout=console / rowStyle=list / aiSummary=hover / dense（用户定稿）。
// section 与其后续 email_item / callout / kos_context / action_suggestion 收拢进
// 一个 <section> 容器（console+list → 收件箱式行组）。
import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  ReportActionSuggestionBlock,
  ReportBlock,
  ReportCalloutBlock,
  ReportChecklistBlock,
  ReportEmailItemBlock,
  ReportHeaderBlock,
  ReportImageBlock,
  ReportKeyPointsBlock,
  ReportKosContextBlock,
  ReportMarkdownBlock,
  ReportMatterItemBlock,
  ReportMetricDeltaBlock,
  ReportOverviewBlock,
  ReportProgressBlock,
  ReportQuoteBlock,
  ReportSectionBlock,
  ReportStatRowBlock,
  ReportTimelineBlock,
  ReportTrendBlock
} from '@shared/api/types'
import { validateReportBlocks } from '@shared/api/reportBlocks'
import { MatterItemBlock } from '@shared/components/reports/MatterItemBlock'
import { type RenderCtx, priorityTone, scrollToEmail } from './lib'
import { ReportIcon } from './primitives'
import {
  ChecklistBlock,
  ImageBlock,
  MetricDeltaBlock,
  ProgressBlock,
  QuoteBlock,
  TimelineBlock
} from './blocks/ArtifactBlocks'
import { EmailItemBlock } from './blocks/EmailItemBlock'
import {
  ActionSuggestionBlock,
  CalloutBlock,
  KeyPointsBlock,
  KosContextBlock,
  MarkdownBlock
} from './blocks/InsightBlocks'
import {
  HeaderBlock,
  OverviewBlock,
  SectionHeader,
  SectionSummary,
  StatRowBlock
} from './blocks/ReportHeaderBlocks'
import { DividerBlock, TrendBlock, UnknownBlock } from './blocks/TrendAndMiscBlocks'

function renderLeaf(block: ReportBlock, key: number, ctx: RenderCtx): React.ReactElement {
  switch (block.type) {
    case 'header':
      return <HeaderBlock key={key} block={block as ReportHeaderBlock} ctx={ctx} />
    case 'overview':
      return <OverviewBlock key={key} block={block as ReportOverviewBlock} ctx={ctx} />
    case 'stat_row':
      return <StatRowBlock key={key} block={block as ReportStatRowBlock} ctx={ctx} />
    case 'key_points':
      return <KeyPointsBlock key={key} block={block as ReportKeyPointsBlock} ctx={ctx} />
    case 'callout':
      return <CalloutBlock key={key} block={block as ReportCalloutBlock} ctx={ctx} />
    case 'kos_context':
      return <KosContextBlock key={key} block={block as ReportKosContextBlock} ctx={ctx} />
    case 'action_suggestion':
      return <ActionSuggestionBlock key={key} block={block as ReportActionSuggestionBlock} />
    case 'trend':
      return <TrendBlock key={key} block={block as ReportTrendBlock} ctx={ctx} />
    case 'markdown':
      return <MarkdownBlock key={key} block={block as ReportMarkdownBlock} />
    case 'timeline':
      return <TimelineBlock key={key} block={block as ReportTimelineBlock} />
    case 'checklist':
      return <ChecklistBlock key={key} block={block as ReportChecklistBlock} />
    case 'progress':
      return <ProgressBlock key={key} block={block as ReportProgressBlock} />
    case 'quote':
      return <QuoteBlock key={key} block={block as ReportQuoteBlock} />
    case 'metric_delta':
      return <MetricDeltaBlock key={key} block={block as ReportMetricDeltaBlock} />
    case 'image':
      return <ImageBlock key={key} block={block as ReportImageBlock} />
    // S5 事项进展条目。渲染器住 components/reports/（事项条目不是 /agents 页的原子，
    // 它跟着报告块契约走）；这里只做分发。
    case 'matter_item':
      return <MatterItemBlock key={key} block={block as ReportMatterItemBlock} ctx={ctx} />
    case 'divider':
      return <DividerBlock key={key} />
    default:
      return <UnknownBlock key={key} block={block} />
  }
}

const _SECTION_CHILDREN = new Set([
  'email_item',
  'callout',
  'kos_context',
  'action_suggestion',
  'trend',
  'markdown',
  'timeline',
  'checklist',
  'progress',
  'quote',
  'metric_delta',
  'image'
])

// ─── section group — 折叠容器 ────────────────────────────────────────────────
// 默认折叠：报告默认呈"摘要视图"（header + 汇总一句话 + 邮件数/重点数），长邮件
// 列表按需展开，不被海量 FYI/已处理刷屏。summary 折叠态保留（它是浓缩结论，不是
// 长列表）；email 列表只在展开时渲染。
function SectionGroup({
  sec,
  items,
  ctx,
  expanded,
  onToggle
}: {
  sec: ReportSectionBlock
  items: ReportBlock[]
  ctx: RenderCtx
  expanded: boolean
  onToggle: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const collapsed = !expanded
  const groupedList = ctx.rowStyle === 'list' && ctx.layout === 'console'
  const emails = items.filter((it) => it.type === 'email_item') as ReportEmailItemBlock[]
  const total = emails.length
  // 简单统计：priority 非 neutral（紧急 / 重要）的封数 —— 该组里值得优先看的"重点"数。
  const flagged = emails.filter((e) => priorityTone(e.priority) !== 'neutral').length
  // 有邮件列表才折叠；纯文字概述的 section（周 / 月报 email_refs 留空）无列表可展开，
  // 直接常显，不挂无效的展开箭头。
  const collapsible = total > 0

  const headerBody = (
    <>
      <div style={{ flex: 1, minWidth: 0 }}>
        <SectionHeader block={sec} ctx={ctx} />
      </div>
      {collapsible && (
        <>
          <span
            style={{
              fontSize: 12,
              color: 'rgb(var(--ink-fg-2))',
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
              flexShrink: 0
            }}
          >
            {t('agents.block.emailCount', { total })}
            {flagged > 0 ? ` · ${t('agents.block.flaggedCount', { flagged })}` : ''}
          </span>
          <ReportIcon
            name={collapsed ? 'chevrondown' : 'chevronup'}
            size={16}
            style={{ color: 'rgb(var(--ink-fg-3))', flexShrink: 0 }}
          />
        </>
      )}
    </>
  )

  return (
    <section
      style={{ display: 'flex', flexDirection: 'column', gap: ctx.layout === 'document' ? 12 : 8 }}
    >
      {collapsible ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            width: '100%',
            textAlign: 'left',
            background: 'transparent',
            border: 0,
            padding: 0,
            cursor: 'pointer',
            fontFamily: 'inherit'
          }}
        >
          {headerBody}
        </button>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>{headerBody}</div>
      )}
      {sec.summary && <SectionSummary text={sec.summary} ctx={ctx} />}
      {collapsible && !collapsed && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: groupedList ? 0 : ctx.dense ? 8 : 10,
            ...(groupedList
              ? {
                  border: '1px solid rgb(var(--ink-border-soft))',
                  borderRadius: 10,
                  overflow: 'hidden',
                  background: 'rgb(var(--ink-1))'
                }
              : {})
          }}
        >
          {items.map((it, k) =>
            it.type === 'email_item' ? (
              <EmailItemBlock key={k} block={it as ReportEmailItemBlock} ctx={ctx} />
            ) : (
              renderLeaf(it, k, ctx)
            )
          )}
        </div>
      )}
    </section>
  )
}

// 把 blocks[] 折成"段"（命令式扫描的结果）：section 组 / 顶层 callout 组 / 顶层 leaf。
// 与原 while 扫描语义逐字对齐，仅把结果物化成数据（再 map 渲染）。key 仍是各段起始索引 i。
type RenderSegment =
  | { kind: 'section'; key: number; sec: ReportSectionBlock; items: ReportBlock[] }
  | { kind: 'callout-group'; key: number; group: ReportBlock[] }
  | { kind: 'leaf'; key: number; block: ReportBlock }

interface BlockLayout {
  segments: RenderSegment[]
  // email_item internal_id → 所属 section 段的 key（仅 section 内 email_item；顶层 email_item 不入表）。
  emailToSection: Map<number, number>
}

function planBlocks(blocks: ReportBlock[]): BlockLayout {
  const segments: RenderSegment[] = []
  const emailToSection = new Map<number, number>()
  let i = 0
  while (i < blocks.length) {
    const b = blocks[i]
    if (b.type === 'section') {
      const sec = b as ReportSectionBlock
      const items: ReportBlock[] = []
      let j = i + 1
      while (j < blocks.length && _SECTION_CHILDREN.has(blocks[j].type)) {
        const child = blocks[j]
        items.push(child)
        if (child.type === 'email_item') {
          emailToSection.set((child as ReportEmailItemBlock).internal_id, i)
        }
        j++
      }
      segments.push({ kind: 'section', key: i, sec, items })
      i = j
    } else if (b.type === 'callout') {
      // 连续顶层 callout 收成一组，组内间距收紧（"几个核心"成组陈列，而非松散卡片）。
      const group: ReportBlock[] = []
      let j = i
      while (j < blocks.length && blocks[j].type === 'callout') {
        group.push(blocks[j])
        j++
      }
      segments.push({ kind: 'callout-group', key: i, group })
      i = j
    } else {
      segments.push({ kind: 'leaf', key: i, block: b })
      i++
    }
  }
  return { segments, emailToSection }
}

export function BlockRenderer({
  blocks,
  ctx
}: {
  blocks: ReportBlock[]
  ctx: RenderCtx
}): React.ReactElement {
  const gap = ctx.dense ? 12 : 16

  // 受控折叠态：key = section 段起始索引（planBlocks 里的 i）。空集 = 全折叠（保持现状默认）。
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set())
  const [pendingScrollId, setPendingScrollId] = useState<number | null>(null)

  const safeBlocks = useMemo(() => validateReportBlocks(blocks), [blocks])
  const { segments, emailToSection } = useMemo(() => planBlocks(safeBlocks), [safeBlocks])

  const handleToggle = useCallback((key: number) => {
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })
  }, [])

  // 跳转包装：目标 email 在某折叠 section 内 → 先展开该 section（受控），再排队滚动。
  // 顶层 / 无映射的 email_item 锚点本就在 DOM，直接排队滚动即可。
  const handleJump = useCallback(
    (id: number) => {
      const secKey = emailToSection.get(id)
      if (secKey != null) {
        setExpanded((s) => {
          if (s.has(secKey)) return s
          const n = new Set(s)
          n.add(secKey)
          return n
        })
      }
      setPendingScrollId(id)
    },
    [emailToSection]
  )

  // DOM commit 后再滚动：依赖 expanded 让"展开 section 引发的重渲染"提交后才执行，
  // 此时目标 email_item 锚点已挂载 → getElementById 命中（不靠 rAF 猜时序）。
  // 滚动后清 pendingScrollId（响应"展开 commit"这一异步信号、做一次性副作用），
  // 是 effect 的合理用法；render 期间替代会改写 ref/触 react-hooks/refs。React Compiler 迁移债。
  useEffect(() => {
    if (pendingScrollId == null) return
    scrollToEmail(pendingScrollId)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPendingScrollId(null)
  }, [pendingScrollId, expanded])

  // 给 section 及其子块的 ctx 覆盖 onJump（SectionSummary 直接读 ctx.onJump）。
  const childCtx = useMemo(() => ({ ...ctx, onJump: handleJump }), [ctx, handleJump])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap }}>
      {segments.map((seg) => {
        if (seg.kind === 'section') {
          return (
            <SectionGroup
              key={seg.key}
              sec={seg.sec}
              items={seg.items}
              ctx={childCtx}
              expanded={expanded.has(seg.key)}
              onToggle={() => handleToggle(seg.key)}
            />
          )
        }
        if (seg.kind === 'callout-group') {
          return (
            <div key={seg.key} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {seg.group.map((c, k) => renderLeaf(c, k, childCtx))}
            </div>
          )
        }
        if (seg.block.type === 'email_item') {
          return (
            <EmailItemBlock
              key={seg.key}
              block={seg.block as ReportEmailItemBlock}
              ctx={childCtx}
            />
          )
        }
        return renderLeaf(seg.block, seg.key, childCtx)
      })}
    </div>
  )
}
