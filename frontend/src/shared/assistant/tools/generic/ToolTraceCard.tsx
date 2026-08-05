// chat-panel P4 Phase 01 — generic tool-call trace card.
//
// The `tools.Fallback` slot for MessagePrimitive.Parts: every tool-call part with no rich
// by_name card renders through this one (registry miss never blocks). It is mounted on all three
// chat surfaces — email panel (components/message.tsx), agent panel / Cmd+O
// (components/agents/AgentMessage.tsx) and the read-only history transcript
// (ReadOnlyTranscript.tsx) — so every state below must also be correct for a REPLAYED part that
// only ever had a result.
//
// 阶段 0.5-① 「工具执行过程可见」 — the card is now the four-段 surface:
//   ① 流式参数  the disclosure opens WHILE the call runs and re-renders as `args` fills in
//              (it used to be `hidden` + the toggle disabled until the tool finished);
//   ② 加载占位  an `animate-pulse` skeleton stands in for arguments that have not arrived;
//   ③ 标题行    kind icon + human-readable localized title + arg preview + LIVE elapsed + status;
//   ④ 最终结果  the request / result JSON, plus a row-level ok / error / denied distinction.
// W2（B 波）三处视觉收束：arg 预览升成 code chip；右端独立 chevron 退役 —— 展开性提示改由 kind 图标
// chip 原地 cross-fade 成 chevron（`.icon-swap` 原语）；展开区两张圆角卡改成一条 border-l 串起的详情行。
// beui `tool-result` 收编（2026-08）—— 只补**收尾编排**，上面四段一段没动：
//   R1 完成即自动折叠（running↔settled 的转变驱动，走 `CollapsibleRegion`）；
//   R2 running 时输出区自动跟随滚到底；
//   R3 状态槽位 roll 切换（`RollSwap`，无 blur）；
//   R4 输出区高度上限 + `role="log"` / `aria-live="polite"` 视口；
//   R5 `cancelled` 从 `denied` 里分出来（没人决定 ≠ 有人拒绝）。
// 上游有而我们**不要**的：语法高亮输出、复制/重跑操作条（复制在消息级已有）、可见状态文案。
// 我们有而上游没有的（一条都不许在收编里掉）：实时计时、本地化标题、参数预览 chip、四段式流式参数。
// State comes from ONE judge (`runtime/toolPhase.ts`), elapsed from the renderer clock
// (`useToolElapsed` — the runtime's `part.timing` is never populated by our gateway).
// MailAgent tokens only (ink-* surfaces, --c-accent accent), so it reskins across the theme
// three-state + 6 accents with zero edits.

import { useId, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Ban,
  Check,
  CheckSquare,
  ChevronRight,
  CircleSlash,
  FileText,
  Flag,
  Link2,
  Loader2,
  Search,
  Terminal,
  X
} from 'lucide-react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import { cn } from '@shared/lib/cn'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'
import { CollapsibleRegion } from '@shared/components/ui/collapsible'
import {
  classifyTool,
  prettyJson,
  toolTitleKey,
  type ToolKind
} from '@shared/components/chat/tool_steps'
import {
  deriveToolPhase,
  isToolCancelled,
  isToolDenied,
  isToolPhaseSettled
} from '@shared/assistant/runtime/toolPhase'
import { RollSwap } from './RollSwap'
import { formatToolDuration, useToolElapsed } from './useToolElapsed'

/** ToolKind → lucide icon (fixed set, not a render-time factory — matches the
 *  legacy toolKindIconEl constraint that avoids react-hooks/static-components). */
function toolKindIconEl(kind: ToolKind, size = 13): React.ReactElement {
  switch (kind) {
    case 'read':
      return <FileText size={size} strokeWidth={2} />
    case 'task':
      return <CheckSquare size={size} strokeWidth={2} />
    case 'write':
      return <Flag size={size} strokeWidth={2} />
    case 'cmd':
      return <Terminal size={size} strokeWidth={2} />
    case 'link':
      return <Link2 size={size} strokeWidth={2} />
    case 'search':
    default:
      return <Search size={size} strokeWidth={2} />
  }
}

const TOOL_KIND_COLOR: Record<ToolKind, string> = {
  search: 'text-ink-fg-1',
  read: 'text-info',
  task: 'text-coral',
  write: 'text-coral',
  cmd: 'text-ai',
  link: 'text-ok'
}

/** G6 — the row-level outcome. `denied` (the user refused the call) is deliberately separate from
 *  `error` (the tool ran and failed): they look the same in the raw part (both carry isError +
 *  an `{error}` result) but mean opposite things to the reader.
 *  R5（beui tool-result 收编）— `cancelled` splits off the *other* half of what `denied` used to
 *  cover: `approved === false` is an active refusal, an `approval.resolution` of cancelled/expired
 *  means NOBODY decided. Calling the second one「已拒绝」names a person who never acted. The repo
 *  already draws this line one layer over (`_cardShell.lib.ts` → `rejected` vs `expired`); this row
 *  was the outlier that flattened them. Judge: `runtime/toolPhase.ts::isToolCancelled`. */
type RowTone = 'live' | 'ok' | 'error' | 'denied' | 'cancelled'

const TONE_CHIP: Record<RowTone, string> = {
  live: 'bg-ink-1',
  ok: 'bg-ink-1',
  error: 'bg-fail/10 text-fail',
  denied: 'bg-ink-3 text-ink-fg-3',
  cancelled: 'bg-ink-3 text-ink-fg-3'
}

const TONE_STATUS_KEY: Record<RowTone, string> = {
  live: 'chat.toolStep.statusRunning',
  ok: 'chat.toolStep.statusOk',
  error: 'chat.toolStep.statusError',
  denied: 'chat.toolStep.statusDenied',
  // 🔴 tone 叫 `cancelled`（对齐 beui 的状态名 + `isToolCancelled` 判据），**文案**却复用本仓
  // 既有的「已过期 / Expired」—— 因为 `_cardShell` 的 `expired` 相位判据是**同一个** wire 条件
  // （`approval.resolution ∈ {cancelled, expired}`），同一件事在两个面必须读作同一个词。
  // 0805 收尾③ 起两个面已完全对齐：审批卡的 `approvalShell.phase.rejected` 也叫「已拒绝 /
  // Denied」（与本表的 `denied` 同词），「取消 / Cancelled」这个词被彻底让给上游 `resolution`
  // 那个「没人决定」的终态，不再一词两义。
  cancelled: 'chat.toolStep.statusExpired'
}

/** Tones whose row reads as "nothing happened here" — muted title, muted chip. */
const TONE_MUTED: ReadonlySet<RowTone> = new Set<RowTone>(['denied', 'cancelled'])

function statusIconEl(tone: RowTone): React.ReactElement {
  switch (tone) {
    case 'live':
      return <Loader2 size={13} strokeWidth={2} className="animate-spin text-coral" />
    case 'error':
      return <X size={13} strokeWidth={2.5} className="text-fail" />
    case 'denied':
      // Ban (⃠ prohibited) stays with the ACTIVE refusal…
      return <Ban size={13} strokeWidth={2} className="text-ink-fg-3" />
    case 'cancelled':
      // …and the void glyph takes the no-decision case. beUI uses Ban for its `cancelled` only
      // because it has no `denied` state to distinguish it from; we have both.
      return <CircleSlash size={13} strokeWidth={2} className="text-ink-fg-3" />
    case 'ok':
    default:
      return <Check size={13} strokeWidth={2.5} className="text-ok" />
  }
}

/** R4 — output viewport cap, in px (beUI's `maxHeight` default). Before this the disclosure grew
 *  without bound for a fat arg blob; the result `<pre>` had its own `max-h-48`, which this replaces
 *  (one scroller for the whole detail area, not a scroller nested in a scroller). */
const OUTPUT_MAX_HEIGHT = 220

/** R2 — "already at the bottom" tolerance, in px. Sub-pixel scroll positions (zoom / fractional
 *  line boxes) mean `scrollTop + clientHeight` rarely equals `scrollHeight` exactly; ~1.5 lines of
 *  the micro mono text is a forgiving-but-not-sloppy threshold. */
const STICK_TO_BOTTOM_EPSILON = 24

/** Representative inline preview of the first non-empty string / number arg. Reads `args` (the
 *  partial-parsed object) first so it grows field by field while the model streams. */
function argPreview(args: unknown, argsText: string): string {
  const obj = asPlainObject(args) ?? safeParseObject(argsText)
  if (!obj) return ''
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && v.trim()) return v.length > 48 ? `${v.slice(0, 48)}…` : v
  }
  for (const v of Object.values(obj)) {
    if (typeof v === 'number') return String(v)
  }
  return ''
}

function asPlainObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function safeParseObject(text: string): Record<string, unknown> | null {
  try {
    return asPlainObject(JSON.parse(text) as unknown)
  } catch {
    return null
  }
}

export function ToolTraceCard({
  toolName,
  args,
  argsText,
  result,
  status,
  isError,
  approval
}: ToolCallMessagePartProps): React.JSX.Element {
  const { t } = useTranslation()
  const reduce = useReducedMotion()
  const contentId = useId()
  const viewportRef = useRef<HTMLDivElement>(null)
  // R2 —「跟不跟随」的意图位。ref 而非 state：它只被 effect 读，翻它不需要重渲染。
  const stickToBottomRef = useRef(true)
  const [open, setOpen] = useState(false)
  // W2-② 图标位变形 —— 展开性提示不再占右端一个独立槽位，而是在 kind 图标 chip 原地 cross-fade 成
  // chevron。hover 用 React state（不是 group-hover 类）是因为 `.icon-swap-item[data-active]` 的
  // 属性选择器与 `.group:hover .group-hover\:*` 同特异度，谁赢只取决于生成顺序 —— 用 state 驱动
  // data-active 才是确定的。
  const [hovered, setHovered] = useState(false)

  const part = { argsText, result, isError, approval, status }
  const phase = deriveToolPhase(part)
  const settled = isToolPhaseSettled(phase)
  const elapsed = useToolElapsed(!settled)

  // R1 —「完成即自动折叠」(beui `collapseOnComplete`). Adjust-on-prop-change (react.dev), the same
  // shape `ToolGroupCard` uses one level up: running → settled 收起, settled → running 再展开.
  // 🔴 It is a TRANSITION, not `open = !settled`: 首挂载不动 open —— 一张挂载即 running 的卡仍从
  // 折叠态起（既有行为），否则每轮对话都会炸开一堆 JSON。
  const [prevSettled, setPrevSettled] = useState(settled)
  if (prevSettled !== settled) {
    setPrevSettled(settled)
    setOpen(!settled)
  }

  const tone: RowTone = !settled
    ? 'live'
    : isToolCancelled(part)
      ? 'cancelled'
      : isToolDenied(part)
        ? 'denied'
        : phase === 'error'
          ? 'error'
          : 'ok'
  const kind = classifyTool(toolName)
  const titleKey = toolTitleKey(toolName)
  const title = titleKey === null ? toolName : t(titleKey)
  const text = argsText ?? ''
  const preview = argPreview(args, text)
  const argsObject = asPlainObject(args)
  const hasArgs = argsObject !== null && Object.keys(argsObject).length > 0
  const hasResult = result !== undefined && result !== null
  // 静息 = kind 图标；hover 或已展开 = chevron（展开再转 90°）。原右端独立 chevron 的显隐条件
  // （hover 才现 / 展开恒显）逐条搬到这里，可展开性本身不变（无参数照样能开）。
  const showChevron = hovered || open

  // 每次 running↔settled 翻转都把跟随意图复位：上一轮「我要往上翻看历史」的手势不该粘到下一轮。
  // 🔴 必须是 effect，不能塞进上面那个 render 期的转变块 —— render 里写 ref 会被
  // `react-hooks/refs` 拦下（且确实不安全：那一段在 StrictMode 下会重跑）。声明顺序在跟随
  // effect **之前**，layout effect 按声明序执行，所以翻转那一帧复位先落、跟随立刻恢复。
  useLayoutEffect(() => {
    stickToBottomRef.current = true
  }, [settled])

  // R2 — running 时输出区跟着长出来的内容滚到底（beui 同款）。
  // 🔴 **无依赖数组是有意的**（逐条抄自上游）：要跟随的是「内容变了」，而 args 的每一次 delta 都
  // 只是 props 变化，写任何依赖列表都会漏掉一类增长。每帧最多排一个 rAF、settle/折叠即不再排，
  // 代价可忽略。rAF 是为了让浏览器先完成本次 commit 的布局，再读 scrollHeight（同帧直接读会拿到
  // 旧高度，永远差一屏）。reduce 下 behavior 取 'auto'（瞬移）——「减弱动态效果」也包含平滑滚动。
  //
  // 🔴 `stickToBottomRef` 不是可选的加分项，是这条「无依赖数组」的必要配套：running 期间
  // `useToolElapsed` 每 200ms 就 setState 一次（reduce 下才不 tick），于是**每 200ms 重跑一次
  // 本 effect**。没有这个闸时，用户手动往上滚看已流过的参数，会在 200ms 内被拽回底部 —— 实测
  // 500ms 内被强制 scrollTo 两次，等于这个视口在 running 期间根本不能读。而这张卡 running 期
  // 展开**只可能**来自用户手点（R1 从不自动展开挂载即 running 的卡），所以被拽回的恰恰是刚刚
  // 明确表达了「我要看」的那个人。
  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || !open || settled || !stickToBottomRef.current) return
    const frame = requestAnimationFrame(() => {
      if (typeof viewport.scrollTo === 'function') {
        viewport.scrollTo({ top: viewport.scrollHeight, behavior: reduce ? 'auto' : 'smooth' })
      } else {
        viewport.scrollTop = viewport.scrollHeight
      }
    })
    return () => cancelAnimationFrame(frame)
  })

  /** 回到底部即恢复跟随。🔴 这个 handler **只把闸拨到 true，永远不拨 false** —— 上面的
   *  `behavior:'smooth'` 会在动画途中连发 scroll 事件，那时离底还很远；若在这里按几何判 false，
   *  我们自己的跟随动画第一帧就会把跟随关掉。「不跟了」只能由下面的真实用户手势来判。 */
  const handleViewportScroll = (e: React.UIEvent<HTMLDivElement>): void => {
    const el = e.currentTarget
    if (el.scrollHeight - el.clientHeight - el.scrollTop <= STICK_TO_BOTTOM_EPSILON) {
      stickToBottomRef.current = true
    }
  }

  /** 用户手势 = 唯一能中断跟随的信号。wheel 看 `deltaY < 0`（向上）而不是看几何：wheel 触发时
   *  scrollTop 还没更新，读几何会慢一拍。程序化滚动不会产生 wheel/touchmove，所以不会误伤。 */
  const handleViewportWheel = (e: React.WheelEvent<HTMLDivElement>): void => {
    if (e.deltaY < 0) stickToBottomRef.current = false
  }
  const handleViewportTouchMove = (): void => {
    stickToBottomRef.current = false
  }

  return (
    <div className="my-1.5 min-w-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className="group flex w-full items-center gap-2.5 py-1 text-left"
        aria-expanded={open}
        aria-controls={contentId}
      >
        <span
          className={cn(
            'grid h-5 w-5 shrink-0 place-items-center rounded-md',
            TONE_CHIP[tone],
            tone === 'live' || tone === 'ok' ? TOOL_KIND_COLOR[kind] : undefined
          )}
        >
          {/* 同 slot 双图标 cross-fade 走 index.css 的 `.icon-swap` 原语（120ms fast + standard 曲线、
              零 filter，与 copy→check / Eye↔EyeOff 同一份）。🔴 TONE_CHIP 的底色留在外层 chip 上 ——
              变形只换 glyph，live/ok/error/denied/cancelled 五态语义不受影响。 */}
          <span className="icon-swap">
            <span className="icon-swap-item" data-active={showChevron ? 'false' : 'true'}>
              {toolKindIconEl(kind)}
            </span>
            <span className="icon-swap-item" data-active={showChevron ? 'true' : 'false'}>
              <ChevronRight
                size={13}
                strokeWidth={2}
                className={cn('transition-transform duration-fast', open && 'rotate-90')}
              />
            </span>
          </span>
        </span>
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-aux',
            TONE_MUTED.has(tone) ? 'text-ink-fg-3' : 'text-ink-fg'
          )}
        >
          {title}
          {preview ? (
            // W2-① arg code chip —— 参数预览从裸 mono 文本升成有底的 code chip（hover 随行加深），
            // 与骨架分支互斥（骨架恒是「参数还没到」的占位，不是 chip）。
            <span
              className="ml-1.5 rounded bg-ink-3 px-1 py-0.5 font-mono text-meta text-ink-fg-2 transition-colors duration-fast group-hover:bg-ink-4 group-hover:text-ink-fg-1"
              title={preview}
            >
              {preview}
            </span>
          ) : phase === 'streaming-args' ? (
            // ② 加载占位 — the arguments are still arriving. Block-level `animate-pulse` skeleton
            // (motion-gsap.md §9 loading 三词汇), NOT a second spinner / shimmer on this row.
            <span
              className="ml-1.5 inline-block h-2.5 w-20 animate-pulse rounded bg-ink-3 align-middle motion-reduce:animate-none"
              aria-label={t('chat.toolStep.argsStreaming')}
            />
          ) : null}
        </span>
        {elapsed !== null && (
          <span
            className="shrink-0 font-mono text-meta tabular-nums text-ink-fg-3"
            title={t('chat.toolStep.duration')}
          >
            {formatToolDuration(elapsed)}
          </span>
        )}
        <span
          className="grid w-3.5 shrink-0 place-items-center"
          role="img"
          aria-label={t(TONE_STATUS_KEY[tone])}
        >
          {/* R3 — 状态换挡是这张卡上**唯一**真会变的槽位（live → ok/error/denied/cancelled），此前
              是硬替换。roll 走收编的 `RollSwap`（旧的向上滚出、新的从下滚入，无 blur —— 见该文件
              头注释里的零 filter 红线）。
              🔴 aria-label 留在**外层**这个不参与动画的 span 上：AT 拿到的是即时真值，退场层不带
              名字，不会出现「运行中 + 已完成」两个 role=img 同时被读出来。
              🔴 标题**有意不 roll**：title 由固定的 toolName 派生，一个 part 的生命周期内不可能
              变（语言切换除外），按 motion-gsap §0「答不上它解决了哪个生硬瞬切 → 不做」，给它套一层
              inline-grid + overflow-hidden 只会白白改掉这行的基线与截断行为。 */}
          <RollSwap value={tone}>{statusIconEl(tone)}</RollSwap>
        </span>
      </button>

      {/* ①/④ Progressive disclosure — request args + result JSON. Open WHILE running too, so the
          arguments can be watched as they stream in.
          W2-③ 结构：两张独立圆角卡 → 一条自图标 chip 中心（ml-2.5 = 20px chip 的半宽）垂下的
          border-l 串起的详情行。小标题保留 i18n（视觉降为行级小节，不再是卡片抬头）。
          R1 —— 折叠从 `display: block/hidden` 硬切换成全仓统一的 `CollapsibleRegion`
          （grid-rows 0fr↔1fr 纯 CSS 高度过渡 + opacity，duration-base + standard，
          `motion-reduce:transition-none` 自带）。与 `ToolGroupCard` / `ReasoningText` 同源，
          DESIGN §4.1「能 grid-rows 解决不上 GSAP」；顺带白得 `inert`（折叠态子树退出 tab 序，
          原来的 `aria-hidden` 只管 AT、管不了焦点）。padding 走 bodyClassName 落到最内层 ——
          挂在被 0fr 收缩的那层会留残高（collapsible.tsx 里有实测记录）。 */}
      <CollapsibleRegion
        expanded={open}
        id={contentId}
        className="ml-2.5"
        bodyClassName="border-l border-ink-border-soft pl-3.5"
      >
        {/* R4 —— 输出视口：高度上限 + `role="log"` / `aria-live="polite"`。
            上限盖住**整个**详情区（请求 + 结果）而不只是结果：在这张卡上，running 期真正在长的是
            流入的参数，而它此前完全没有上限（一坨大 args 能把整条消息顶开）。结果 `<pre>` 原有的
            `max-h-48` 一并撤掉 —— 两层滚动条套在一起时外层永远滚不到底，R2 的跟随也就成了摆设。
            折叠态整块 `inert`（见上），所以 aria-live 不会在关着的时候朝 AT 播报。 */}
        <div
          ref={viewportRef}
          role="log"
          aria-live="polite"
          onScroll={handleViewportScroll}
          onWheel={handleViewportWheel}
          onTouchMove={handleViewportTouchMove}
          className="scrollbar-thin overflow-y-auto"
          style={{ maxHeight: OUTPUT_MAX_HEIGHT }}
        >
          <div className="mb-1 text-meta font-medium text-ink-fg-1">
            {t('chat.toolStep.request')}
          </div>
          {hasArgs ? (
            // R6 — `args` is the partial-JSON PARSE of the stream, so it is always well-formed;
            // `argsText` is a truncated prefix mid-stream and only serves as a fallback.
            <pre className="scrollbar-thin overflow-x-auto whitespace-pre-wrap break-words text-micro font-mono leading-relaxed text-ink-fg-1">
              {prettyJson(argsObject)}
            </pre>
          ) : phase === 'streaming-args' ? (
            <div
              className="animate-pulse space-y-1.5 motion-reduce:animate-none"
              aria-label={t('chat.toolStep.argsStreaming')}
            >
              <div className="h-2.5 w-2/3 rounded bg-ink-3" />
              <div className="h-2.5 w-1/3 rounded bg-ink-3" />
            </div>
          ) : (
            <pre className="scrollbar-thin overflow-x-auto whitespace-pre-wrap break-words text-micro font-mono leading-relaxed text-ink-fg-1">
              {text.trim() ? prettyJson(text) : prettyJson(args)}
            </pre>
          )}
          {hasResult && (
            <>
              <div className="mb-1 mt-2 text-meta font-medium text-ink-fg-1">
                {t('chat.toolStep.result')}
              </div>
              <pre className="scrollbar-thin overflow-x-auto whitespace-pre-wrap break-words text-micro font-mono leading-relaxed text-ink-fg-1">
                {prettyJson(result)}
              </pre>
            </>
          )}
        </div>
      </CollapsibleRegion>
    </div>
  )
}
