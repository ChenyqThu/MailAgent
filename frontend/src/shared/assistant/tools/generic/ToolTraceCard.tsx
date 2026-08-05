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
// State comes from ONE judge (`runtime/toolPhase.ts`), elapsed from the renderer clock
// (`useToolElapsed` — the runtime's `part.timing` is never populated by our gateway).
// MailAgent tokens only (ink-* surfaces, --c-accent accent), so it reskins across the theme
// three-state + 6 accents with zero edits.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Ban,
  Check,
  CheckSquare,
  ChevronRight,
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
import {
  classifyTool,
  prettyJson,
  toolTitleKey,
  type ToolKind
} from '@shared/components/chat/tool_steps'
import {
  deriveToolPhase,
  isToolDenied,
  isToolPhaseSettled
} from '@shared/assistant/runtime/toolPhase'
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
 *  an `{error}` result) but mean opposite things to the reader. */
type RowTone = 'live' | 'ok' | 'error' | 'denied'

const TONE_CHIP: Record<RowTone, string> = {
  live: 'bg-ink-1',
  ok: 'bg-ink-1',
  error: 'bg-fail/10 text-fail',
  denied: 'bg-ink-3 text-ink-fg-3'
}

const TONE_STATUS_KEY: Record<RowTone, string> = {
  live: 'chat.toolStep.statusRunning',
  ok: 'chat.toolStep.statusOk',
  error: 'chat.toolStep.statusError',
  denied: 'chat.toolStep.statusDenied'
}

function statusIconEl(tone: RowTone): React.ReactElement {
  switch (tone) {
    case 'live':
      return <Loader2 size={13} strokeWidth={2} className="animate-spin text-coral" />
    case 'error':
      return <X size={13} strokeWidth={2.5} className="text-fail" />
    case 'denied':
      return <Ban size={13} strokeWidth={2} className="text-ink-fg-3" />
    case 'ok':
    default:
      return <Check size={13} strokeWidth={2.5} className="text-ok" />
  }
}

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

  const tone: RowTone = !settled
    ? 'live'
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

  return (
    <div className="my-1.5 min-w-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className="group flex w-full items-center gap-2.5 py-1 text-left"
        aria-expanded={open}
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
              变形只换 glyph，live/ok/error/denied 四态语义不受影响。 */}
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
            tone === 'denied' ? 'text-ink-fg-3' : 'text-ink-fg'
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
          {statusIconEl(tone)}
        </span>
      </button>

      {/* ①/④ Progressive disclosure — request args + result JSON. Open WHILE running too, so the
          arguments can be watched as they stream in. display toggle.
          W2-③ 结构：两张独立圆角卡 → 一条自图标 chip 中心（ml-2.5 = 20px chip 的半宽）垂下的
          border-l 串起的详情行。小标题保留 i18n（视觉降为行级小节，不再是卡片抬头）。 */}
      <div
        className={cn('ml-2.5 border-l border-ink-border-soft pl-3.5', open ? 'block' : 'hidden')}
        aria-hidden={!open}
      >
        <div className="mb-1 text-meta font-medium text-ink-fg-1">{t('chat.toolStep.request')}</div>
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
            <pre className="scrollbar-thin max-h-48 overflow-auto whitespace-pre-wrap break-words text-micro font-mono leading-relaxed text-ink-fg-1">
              {prettyJson(result)}
            </pre>
          </>
        )}
      </div>
    </div>
  )
}
