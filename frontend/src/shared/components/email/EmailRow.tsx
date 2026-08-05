// Sprint 12 — Outlook-inspired row per mockup-inbox.html lines 1573-2027.
// Layout: 32px avatar (or cb checkbox in batch mode) + grid 1fr content
// (sender-line / subject-row / body-preview / ai-strip). Row state is
// data-attribute driven so the authored CSS in index.css (.email-row
// [data-read=…] / [data-flag=…] / [data-priority=…]) handles every state
// wash without per-state JSX branches.
//
// Sprint 12.5 (this revision): real action wiring
//   • cb checkbox visible in batch mode (CSS-gated via body[data-batch-mode]).
//   • ricon-flag → 3-state cycle (none → flagged → done) via email.flag (Sprint 15).
//   • ricon-pin → toggles SQLite-backed pinned set via useTogglePin (v8).
//   • ricon-delete → 已退役 (主题 v3 2026-07-12 owner 拍板): 低频操作 + 悬浮
//     行角易误点, 删除/归档统一走正文顶部工具栏 (草稿走 ComposePanel 删草稿)。
//
// Sprint 15 D 块 — ricon-flag callsite 已切到
// `mailApi.email.flag(...)` (SSoT inversion: 写 SQLite intent + outbox 双 target,
// FanoutWorker 异步派发 Mail.app + Notion). 回退路径见
// `frontend/archive/2026-05/SPRINT15-D-FRONTEND-HANDOFF.md` §8 — 老 `mailApi.notion.updateFlag`
// 在 ElectronApi.ts / HttpApi.ts 仍保留, 一周稳定期后删除.
//
// CSS class names are the contract — see index.css Sprint 12 block.

import { memo, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { ChevronDown, Paperclip } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { actionLabelChinese } from '@shared/lib/ai_labels'
import { parseSender, cleanSnippet } from '@shared/lib/mail_parse'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { formatRelativeTime } from '@shared/format'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useTogglePin } from '@shared/hooks/usePinnedSync'
import { useBatch } from '@shared/state/batch'
import { usePinned } from '@shared/state/pinned'
import { toastError } from '@shared/state/toast'
import type { EnrichedEmailMeta, AIPriority } from '@shared/api/types'

import type { ThreadHeadAgg } from './emailListRows'

interface Props {
  email: EnrichedEmailMeta
  selected: boolean
  /** Set when 5s polling notices this id appeared after the prior poll. */
  isNew?: boolean
  /** Sprint 14 round 10 — thread bundle children keep the avatar column
   *  but render it invisibly, so the avatar slot becomes a 32px indent
   *  that visually marks the child row as folded under its head.  The
   *  row layout (grid 32px+1fr) is unchanged so sender / subject /
   *  meta columns still align with the head's. */
  noAvatar?: boolean
  /** Sprint 14 round 12 — compact mode skips the body-preview snippet
   *  and the AI strip.  Used by thread children whose data comes from
   *  listByThread (no snippet / AI fields) so the row reads as a
   *  single-line digest with sender + subject + time only. */
  compact?: boolean
  /** Sprint 17 — 线程折叠 icon / 占位列 (见 ThreadChevronProps doc).
   *  undefined → 单封, 第一格空; isHead → 显示可点 chevron; isChild → 渲染
   *  竖向 tether 线表示属于父线程 bundle. */
  threadChevron?: ThreadChevronProps
  /** 线程「虚拟头」聚合 (见 ThreadHeadProps). 只有折叠/展开的母行有; 子行 /
   *  单封 / 发件箱 sent-anchor 行为 undefined = 逐字节的单封语义. */
  threadHead?: ThreadHeadProps
  onSelect(): void
}

/**
 * Sprint 17 — thread chevron 从 EmailList 的外层 wrapper div 内移到 EmailRow
 * 的第一格 grid cell, 让 flag/done/selected wash + 未读 dot 跟 chevron 共享
 * 同一个 row 容器 (背景能 cover 折叠 icon 区域).
 */
export interface ThreadChevronProps {
  isHead?: boolean
  isChild?: boolean
  expanded?: boolean
  onToggle?: () => void
}

/**
 * 线程「虚拟头」(2026-08 owner 拍板的 Outlook 语义) —— 母行代表**整条线程**而不是
 * 最新那一封: 内容仍是最新一封的, 但旗标/置顶按成员聚合显示, 点击走级联写。
 * 展开后子行 (含最新一封自己那行)、发件箱 sent-anchor 头恒是单封语义, 拿不到它。
 *
 * 形状不在这里第二次声明 —— 生产者是 flattenGroups, 直接复用它的类型 (type-only
 * import, 运行时不引入 emailListRows)。`aggFlagged` 由 flatten 算好; 置顶聚合则在
 * 下面读 zustand 现算 —— 它有乐观翻转, 读 store 才能在同一帧反映刚点的那下。
 */
export type ThreadHeadProps = ThreadHeadAgg

const PRIORITY_SLUG: Record<AIPriority, 'crit' | 'urg' | 'impt' | 'norm' | 'low'> = {
  critical: 'crit',
  urgent: 'urg',
  important: 'impt',
  normal: 'norm',
  low: 'low'
}
const PRIORITY_UPPER: Record<AIPriority, string> = {
  critical: 'CRITICAL',
  urgent: 'URGENT',
  important: 'IMPORTANT',
  normal: 'NORMAL',
  low: 'LOW'
}

function shortTime(iso: string | null | undefined): string {
  if (!iso) return ''
  try {
    return formatRelativeTime(iso)
  } catch {
    return ''
  }
}

// djb2 hash for deterministic avatar slot selection (1..6).
function avatarSlot(seed: string): 1 | 2 | 3 | 4 | 5 | 6 {
  let hash = 5381
  for (let i = 0; i < seed.length; i++) hash = (hash * 33) ^ seed.charCodeAt(i)
  return (((hash >>> 0) % 6) + 1) as 1 | 2 | 3 | 4 | 5 | 6
}

function avatarInitials(name: string): string {
  const t = name.trim()
  if (!t) return '?'
  if (/[一-鿿]/.test(t)) return t.slice(0, 2)
  const parts = t.split(/\s+/).filter(Boolean)
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + (parts[1]?.[0] ?? '')).toUpperCase()
}

const flagSvg = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
    <line x1="4" y1="22" x2="4" y2="15" />
  </svg>
)
const doneSvg = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2.5}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="20 6 9 17 4 12" />
  </svg>
)
const pinSvg = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M16 4v6.59l3.71 3.71A1 1 0 0 1 19 16h-6v5l-1 1-1-1v-5H5a1 1 0 0 1-.71-1.71L8 10.59V4a1 1 0 0 1-1-1V2h10v1a1 1 0 0 1-1 1z" />
  </svg>
)
const attachSvg = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
)
// ❗️ Fluent ic_fluent_important_24_regular —— 无外圈的轮廓感叹号（上竖线 +
// 下圆点, path 自带轮廓形状, fill 渲染）。用户定稿: 之前的圆圈版在 14px
// 下外圈读成「灰色圆点」, 换无外圈轮廓 + 警示红 (色值在 .ricon-important)。
const importantSvg = (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path
      fillRule="nonzero"
      d="M12,17.0015 C13.3813,17.0015 14.5011,18.1213 14.5011,19.5026 C14.5011,20.8839 13.3813,22.0037 12,22.0037 C10.6187,22.0037 9.49888,20.8839 9.49888,19.5026 C9.49888,18.1213 10.6187,17.0015 12,17.0015 Z M12,18.5015 C11.4471,18.5015 10.9989,18.9497 10.9989,19.5026 C10.9989,20.0555 11.4471,20.5037 12,20.5037 C12.5529,20.5037 13.0011,20.0555 13.0011,19.5026 C13.0011,18.9497 12.5529,18.5015 12,18.5015 Z M11.999,2.00244 C14.1393,2.00244 15.8744,3.7375 15.8744,5.87781 C15.8744,8.71128 14.8844,12.4318 14.339,14.2756 C14.0294,15.322 13.0657,16.0039 12.0006,16.0039 C10.9332,16.0039 9.96846,15.3191 9.65995,14.2708 L9.43749451,13.4935787 C8.88270062,11.4994608 8.12366,8.3311 8.12366,5.87781 C8.12366,3.7375 9.85872,2.00244 11.999,2.00244 Z M11.999,3.50244 C10.6871,3.50244 9.62366,4.56593 9.62366,5.87781 C9.62366,8.43944 10.5512,11.9861 11.0989,13.8473 C11.2125,14.2332 11.573,14.5039 12.0006,14.5039 C12.4275,14.5039 12.7869,14.2344 12.9006,13.8501 L13.0583294,13.3056653 C13.6088628,11.3652034 14.3744,8.23351909 14.3744,5.87781 C14.3744,4.56593 13.3109,3.50244 11.999,3.50244 Z"
    />
  </svg>
)
function EmailRowInner({
  email,
  selected,
  isNew,
  noAvatar,
  compact,
  threadChevron,
  threadHead,
  onSelect
}: Props): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const queryClient = useQueryClient()
  const batchMode = useBatch((s) => s.mode)
  const batchToggle = useBatch((s) => s.toggle)
  const batchIsSelected = useBatch((s) => s.selectedIds.includes(email.internal_id))
  // 虚拟头: 任一成员置顶 → 亮 (「固定也是整个线程固定」的显示面对称). 单封 / 子行
  // 仍只看自己. 读 store 而非 flatten 时算死: store 有乐观翻转, 级联 unpin 的
  // 那一帧就能翻过来.
  const pinned = usePinned((s) =>
    threadHead
      ? threadHead.memberIds.some((id) => s.pinned.includes(id))
      : s.pinned.includes(email.internal_id)
  )
  const togglePin = useTogglePin()

  const unread = !email.is_read
  // Sprint 15 D 块: 'done' 三态用 Notion Processing Status 镜像判. 之前用
  // `sync_status === 'deleted'` 永远 false (sync_status 没这个枚举值), 导致
  // done 状态 / 绿色 check icon 从来不显示.
  const isDone = email.processing_status === '已完成'
  const isFlagged = email.is_flagged && !isDone
  const failed = email.sync_status === 'failed' || email.sync_status === 'dead_letter'
  const parsed = parseSender(email.sender)
  const senderName = email.sender_name || parsed.name || parsed.email.split('@')[0] || ''
  const senderEmail = parsed.email
  const snippet = cleanSnippet(email.snippet)
  const actionLabel = actionLabelChinese(email.ai_action)

  // 「❗ 重要」语义现在来自邮件原生 Importance / X-Priority 头部
  // （reader._parse_importance → email_metadata.is_important）。
  // ai_priority 仍然驱动 data-priority 颜色 wash，但不参与 ❗ 判定 —— 这两条
  // 信号互相独立：发件人主动标 high priority vs LLM 推断的紧急度。
  const important = email.is_important === true

  const slot = avatarSlot(email.sender || String(email.internal_id))
  const initials = avatarInitials(senderName || senderEmail)

  const aiStripVisible = Boolean(email.ai_priority || actionLabel || failed || isNew)

  // Flag state for the .ricon-flag[data-flag-state=...] CSS hook.
  // 0 = none, 1 = flagged (coral), 2 = done (green check).
  //
  // 虚拟头按线程聚合: 任一成员带旗 → 红旗 (优先, 它是「这条线程还有待办」的信号);
  // 否则退到最新一封自己的 done 态; 都没有 → 无标记.
  const flagState: '0' | '1' | '2' = threadHead
    ? threadHead.aggFlagged
      ? '1'
      : isDone
        ? '2'
        : '0'
    : isDone
      ? '2'
      : isFlagged
        ? '1'
        : '0'
  const flagSvgEl = flagState === '2' ? doneSvg : flagSvg

  // Row-level click — batch toggle in batch mode, otherwise standard select.
  const handleRowClick = useCallback(() => {
    if (batchMode === 'on') batchToggle(email.internal_id)
    else onSelect()
  }, [batchMode, batchToggle, email.internal_id, onSelect])

  const handleRowKey = useCallback(
    (evt: React.KeyboardEvent) => {
      if (evt.key !== 'Enter' && evt.key !== ' ') return
      evt.preventDefault()
      handleRowClick()
    },
    [handleRowClick]
  )

  // Write actions — every one stops propagation so the parent row doesn't
  // also fire select / toggle on the same click.
  const stopAnd = (handler: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation()
    handler()
  }

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: qk.emails.all() })
  }, [queryClient])

  // Sprint 15 D 块 — Optimistic UI helper.
  //
  // CLI fork (~500ms-1s Python startup) + invalidate refetch 的连环 await 让
  // 点 flag 后 UI 反应卡顿好几秒. 改成 TanStack Query 的 optimistic update 模式:
  //   1. 立即把目标状态写回 ['emails'] cache, UI 瞬时翻
  //   2. 后台跑 CLI; SQLite 已经被 CLI 写入新状态, 后续真 refetch 会一致
  //   3. CLI 失败 -> rollback (invalidateQueries 把 cache 重读到真实状态) + toast
  //
  // 我们 mutate 所有 ['emails', ...] query key 的 cache (列表 / mailbox 切分等),
  // 因为 EmailList 的 useQuery key 可能是 ['emails', mailbox, view]. setQueriesData
  // 的 type predicate 让我们一次性命中所有.
  const optimisticPatch = useCallback(
    (patch: Partial<EnrichedEmailMeta>, ids: ReadonlyArray<number>) => {
      // ids 是集合而非单个 —— 线程级联要在同一帧翻掉所有成员 (owner 红线「秒反应」),
      // 而不是等后端 SSE 回来才动 (那是几百毫秒后的校正, 不是反馈).
      const targets = new Set(ids)
      queryClient.setQueriesData<EnrichedEmailMeta[]>({ queryKey: qk.emails.all() }, (old) => {
        if (!Array.isArray(old)) return old
        return old.map((e) => (targets.has(e.internal_id) ? { ...e, ...patch } : e))
      })
    },
    [queryClient]
  )

  const handleFlagClick = useCallback(async () => {
    // 计算目标状态 + CLI opts.  三态 cycle (单封):
    //   none(0)    → flagged(1)  : isFlagged=true,  processing_status 不动
    //   flagged(1) → done(2)     : isFlagged=false, processing_status='已完成'
    //   done(2)    → none(0)     : isFlagged=false, processing_status='已同步'
    //                              (写非 '已完成' 才能脱离 isDone, 不能省略 status)
    //
    // 虚拟头 (threadHead) 的 flagged(1) 分支 = 「这条线程办完了」: 最新一封转已完成,
    // **同时**级联清掉线程内其他成员的旗标 (一次调用, 服务端按 thread_id 展开权威
    // 成员集; 前端只对已知可见成员做乐观翻转). 另两个分支仍是纯单封语义 ——
    // 「加旗」加在最新一封上, 「清 done」清最新一封的.
    let patch: Partial<EnrichedEmailMeta>
    let opts: { isFlagged?: boolean; processingStatus?: string; cascadeThread?: boolean }
    if (flagState === '0') {
      patch = { is_flagged: true }
      opts = { isFlagged: true }
    } else if (flagState === '1') {
      patch = { is_flagged: false, processing_status: '已完成' }
      opts = { isFlagged: false, processingStatus: '已完成' }
      if (threadHead) opts.cascadeThread = true
    } else {
      patch = { is_flagged: false, processing_status: '已同步' }
      opts = { isFlagged: false, processingStatus: '已同步' }
    }
    // Optimistic — UI 瞬时翻
    optimisticPatch(patch, [email.internal_id])
    if (opts.cascadeThread && threadHead) {
      // 其他成员只摘旗, 不动 processing_status (与服务端级联语义逐字对齐).
      const others = threadHead.memberIds.filter((id) => id !== email.internal_id)
      if (others.length > 0) optimisticPatch({ is_flagged: false }, others)
    }
    try {
      await mailApi.email.flag(email.internal_id, opts)
      // 成功: CLI 已写 SQLite, 下一次 refetch 会拿到一致数据. 不主动 invalidate
      // 避免一来一回的双重渲染; EmailList 自身的 5s poll 会拉真实 state, 失败时
      // 才回放真值.
    } catch (err) {
      // 失败: rollback cache 到 SQLite 真值 + toast
      await invalidate()
      const msg = errorMessage(err)
      toastError('Flag toggle failed', msg)
    }
  }, [email.internal_id, flagState, invalidate, mailApi, optimisticPatch, threadHead])

  const cbClass = useMemo(() => cn('cb', batchIsSelected && 'cb-on'), [batchIsSelected])

  return (
    <article
      role="button"
      tabIndex={0}
      onClick={handleRowClick}
      onKeyDown={handleRowKey}
      data-internal-id={email.internal_id}
      data-read={String(!unread)}
      data-flag={flagState === '2' ? 'done' : flagState === '1' ? 'flagged' : 'none'}
      data-pinned={String(pinned)}
      data-important={String(important)}
      data-priority={email.ai_priority ? PRIORITY_SLUG[email.ai_priority] : 'norm'}
      data-thread={threadChevron?.isHead ? 'head' : threadChevron?.isChild ? 'child' : 'none'}
      className={cn('row email-row', selected && 'is-selected')}
    >
      {/* Sprint 17 — 第一格 chevron-cell (24px). 单封邮件空; thread head 显示
          可点 chevron; child 显示竖向 tether 线. flag / selected / unread-dot
          的背景与定位都基于这格 (CSS .email-row.thread-chevron-cell). */}
      <span className="thread-chevron-cell" aria-hidden={!threadChevron?.isHead}>
        {threadChevron?.isHead && (
          <button
            type="button"
            aria-label="toggle-thread"
            aria-expanded={threadChevron.expanded ?? false}
            onClick={stopAnd(() => threadChevron.onToggle?.())}
            className="thread-chevron-btn"
          >
            <ChevronDown
              size={12}
              strokeWidth={2}
              className={cn(
                'transition-transform duration-base ease-out',
                threadChevron.expanded ? 'rotate-0' : '-rotate-90'
              )}
            />
          </button>
        )}
        {/* round 7: child 行不再画竖向 tether 线 — 线程归属已由选中态的
            左侧通高 accent 条 + child 行 inset tint 表达, 不连续的竖线
            反而添乱 (用户定稿删除)。 */}
      </span>
      {/* Batch checkbox — visible when body[data-batch-mode='true']. */}
      <span
        className={cbClass}
        role="checkbox"
        aria-checked={batchIsSelected}
        aria-hidden={batchMode === 'off'}
      />
      <span
        className={cn('avatar', `avatar-${slot}`)}
        aria-hidden
        // Sprint 14 round 10 — thread children keep the avatar slot to
        // preserve the 32px+1fr grid (so sender/subject columns align
        // across head and children), but render it invisible.  Visual
        // result: a tidy 32px indent that reads as "folded under".
        style={noAvatar ? { visibility: 'hidden' } : undefined}
      >
        {noAvatar ? '' : initials}
      </span>

      <div className="row-content">
        <div className="row-top">
          <span className="sender-line">
            <span className="sender-name">
              {senderName || senderEmail || t('emailRow.unknownSender')}
            </span>
            {senderEmail && senderName && <span className="recipient-hint">, {senderEmail}</span>}
            {email.lang === 'en' && (
              <>
                {' '}
                <span className="lang-pip" aria-label="English">
                  EN
                </span>
              </>
            )}
          </span>
          <span className="row-time">{shortTime(email.date_received)}</span>
        </div>

        <div className="subject-row">
          <span className="subject-text">{email.subject || t('emailRow.noSubject')}</span>
          <span className="row-actions">
            <button
              type="button"
              className="ricon ricon-flag"
              data-flag-state={flagState}
              aria-label={t('emailRow.toggleFlag')}
              onClick={stopAnd(() => void handleFlagClick())}
            >
              {flagSvgEl}
            </button>
            <button
              type="button"
              className="ricon ricon-pin"
              aria-pressed={pinned}
              aria-label={t('emailRow.togglePin')}
              onClick={stopAnd(() => {
                // 虚拟头: 已有成员置顶 → 级联取消整条线程 (服务端按 thread_id 展开
                // 权威成员集, 前端同帧翻掉已知成员); 一个都没置顶 → 只置顶最新一封.
                // 子行 / 单封 / 发件箱 sent-anchor 行走原来的单封 toggle.
                void togglePin(
                  email.internal_id,
                  threadHead && pinned
                    ? { memberIds: threadHead.memberIds, cascadeThread: true }
                    : undefined
                )
              })}
            >
              {pinSvg}
            </button>
            {email.attach_count > 0 && (
              <span
                className="ricon ricon-attach"
                aria-label={t('emailRow.attachmentCount', { count: email.attach_count })}
              >
                {attachSvg}
              </span>
            )}
            {important && (
              <span className="ricon ricon-important" aria-label={t('emailRow.important')}>
                {importantSvg}
              </span>
            )}
          </span>
        </div>

        {snippet && !compact && <div className="body-preview">{snippet}</div>}

        {aiStripVisible && !compact && (
          <div className="ai-strip">
            {email.ai_priority && (
              <>
                <span className="pdot" aria-hidden />
                <span className="pname">{PRIORITY_UPPER[email.ai_priority]}</span>
              </>
            )}
            {actionLabel && (
              <>
                {email.ai_priority && <span className="sep">·</span>}
                <span className="ai-reply ai-bit" title={email.ai_action ?? undefined}>
                  {actionLabel}
                </span>
              </>
            )}
            {failed && (
              <>
                {(email.ai_priority || actionLabel) && <span className="sep">·</span>}
                <span className="ai-failed ai-bit">{t('emailRow.syncFailed')}</span>
              </>
            )}
            {isNew && (
              <>
                {(email.ai_priority || actionLabel || failed) && <span className="sep">·</span>}
                <span className="ai-bit" style={{ color: 'rgb(var(--c-accent))' }}>
                  {t('emailRow.new')}
                </span>
              </>
            )}
            {email.attach_count > 0 && (
              <span className="ml-auto inline-flex items-center gap-1 text-ink-fg-3">
                <Paperclip size={10} strokeWidth={2} />
                <span className="tabular-nums">{email.attach_count}</span>
              </span>
            )}
          </div>
        )}
      </div>
    </article>
  )
}

// Sprint 16 perf — 列表 ~1000 行时 5s SSE invalidate 后 React Query 全列 fresh
// data 引用变, 不 memo 会触发全列 render. 自定义 equality 只比较 EmailRow 真正
// 用到的 email 字段 + 父级稳定 props; onSelect 故意不比较引用 — VirtualRow 每帧
// 重建 handleSelect 闭包 (:176-182), 但其行为只依赖 email.internal_id (已在下方
// EMAIL_ROW_EMAIL_KEYS 逐字段比较中覆盖), internal_id 不变时新旧闭包行为等价,
// 跳过比较不影响正确性 (与下方 threadChevronEqual 跳过 onToggle 同理).
const EMAIL_ROW_EMAIL_KEYS = [
  'internal_id',
  'is_read',
  'is_flagged',
  'processing_status',
  'sync_status',
  'snippet',
  'ai_priority',
  'ai_action',
  'is_important',
  'date_received',
  'attach_count',
  'subject',
  'sender',
  'sender_name',
  'lang'
] as const

function threadChevronEqual(
  a: ThreadChevronProps | undefined,
  b: ThreadChevronProps | undefined
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  // 故意不比较 onToggle 引用 — 父组件 (VirtualRow) 每帧重建闭包, 但 toggle
  // 行为只依赖 threadId, memo 效用不该被新引用打穿. isHead/isChild/expanded
  // 一致即视为同一条 chevron 视觉状态.
  return a.isHead === b.isHead && a.isChild === b.isChild && a.expanded === b.expanded
}

/** 虚拟头聚合的 memo 判据. flattenGroups 每次都重建这个对象 (memberIds 是新数组),
 *  所以必须逐字段比 —— 否则 memo 被引用变化打穿, 长列表每次 poll 全列重渲. */
function threadHeadEqual(a: ThreadHeadProps | undefined, b: ThreadHeadProps | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.aggFlagged !== b.aggFlagged) return false
  if (a.memberIds.length !== b.memberIds.length) return false
  for (let i = 0; i < a.memberIds.length; i++) {
    if (a.memberIds[i] !== b.memberIds[i]) return false
  }
  return true
}

function emailRowPropsEqual(prev: Props, next: Props): boolean {
  if (prev.selected !== next.selected) return false
  if (prev.isNew !== next.isNew) return false
  if (prev.noAvatar !== next.noAvatar) return false
  if (prev.compact !== next.compact) return false
  if (!threadChevronEqual(prev.threadChevron, next.threadChevron)) return false
  if (!threadHeadEqual(prev.threadHead, next.threadHead)) return false
  const a = prev.email
  const b = next.email
  if (a === b) return true
  for (const k of EMAIL_ROW_EMAIL_KEYS) {
    if (a[k] !== b[k]) return false
  }
  return true
}

export const EmailRow = memo(EmailRowInner, emailRowPropsEqual)
