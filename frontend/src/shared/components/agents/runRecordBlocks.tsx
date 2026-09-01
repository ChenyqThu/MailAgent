// task 08-27 P4a（lane team-shell）— 执行记录 transcript 的两块共享积木：
//
//   • AgentRunTriggerBubble — 前端合成的「⚡自动触发」紫色气泡（transcript 第一条）。
//     🔴 数据来自 run 行的 triggerKind/triggerFiredAtIso，**不是**会话首条 user 消息
//     （那是 4-7KB 任务契约 prompt，r8 §A.2；直接渲染 = 点开一次执行先看 7KB 系统指令）。
//   • RunRawPromptBlock — 被摘掉的原始 prompt 收进折叠块（默认收起）+ 复制。
//
// AgentRecordConversation（/sessions 打开 run 会话）与团队页执行详情共用这两块，但挂法不同：
// 前者仍把折叠块挂在流末尾；后者（08-31 dogfood：末尾块 owner 找不到）把它 `bare` 嵌进触发
// 气泡内部，靠 AgentRunTriggerBubble 的 `prompt` 参数传进去。

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronRight, Copy, Zap } from 'lucide-react'

import { cn } from '@shared/lib/cn'

import { triggerLabelKey } from './team/runTranscript'

function fmtFiredAt(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}

/** 紫色触发气泡（消息流最前，宽度约束与 AgentMessage 的 thread-max-width 壳一致）。
 *  detail 是触发条件的一句话补充（如 email_filter 的命中摘要），没有就只显示种类。
 *  prompt 在场时气泡内直接挂「展开查看完整触发指令」（08-31 dogfood：原来它是流末尾的
 *  独立折叠块，owner 找不到 —— 触发指令属于触发这件事，收在触发气泡里）。 */
export function AgentRunTriggerBubble({
  triggerKind,
  firedAtIso,
  detail,
  prompt
}: {
  triggerKind: string | null | undefined
  firedAtIso: string | null | undefined
  detail?: string | null
  prompt?: string | null
}): React.ReactElement {
  const { t } = useTranslation()
  const firedAt = fmtFiredAt(firedAtIso)
  return (
    <div className="mx-auto mb-5 w-full max-w-[var(--thread-max-width)]" data-run-trigger-bubble>
      <div className="rounded-2xl rounded-tl-md border border-ai/30 bg-ai/10 px-3.5 py-2.5">
        <div className="flex items-center gap-1.5 text-meta font-medium text-ai">
          <Zap size={12} strokeWidth={2} />
          <span>{t('team.record.trigger.badge')}</span>
          {firedAt && (
            <>
              <span aria-hidden>·</span>
              <span className="font-mono">{firedAt}</span>
            </>
          )}
        </div>
        <div className="mt-1 text-body leading-relaxed text-ink-fg">
          {t(triggerLabelKey(triggerKind))}
          {detail ? ` · ${detail}` : ''}
        </div>
        {prompt != null && prompt !== '' && <RunRawPromptBlock prompt={prompt} bare />}
      </div>
    </div>
  )
}

/** 任务契约 prompt 原文的折叠块（默认收起）+ 复制。不占主位 —— 要看原文的时候能看，
 *  但它不该是第一眼的东西（design §8.1）。
 *
 *  两种外壳，一套实现：
 *   • 默认 —— 独立卡片，自带 thread-max-width 居中壳（/sessions 的执行记录视图挂在流末尾）。
 *   • `bare` —— 去掉卡片与居中壳，嵌进触发气泡内部（团队页执行详情，08-31 dogfood）。 */
export function RunRawPromptBlock({
  prompt,
  bare = false
}: {
  prompt: string
  bare?: boolean
}): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    // fire-and-forget：剪贴板失败（权限/环境）不值得打断阅读，按钮态不翻即无声。
    void navigator.clipboard?.writeText(prompt).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }
  const body = (
    <div
      data-run-raw-prompt
      className={cn(
        bare
          ? 'mt-1.5 border-t border-ai/25'
          : 'rounded-lg border border-[var(--hairline)] bg-ink-2/60'
      )}
    >
      <div className={cn('flex items-center gap-1', !bare && 'pr-1.5')}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 text-left text-meta transition-colors duration-fast hover:text-ink-fg',
            bare ? 'py-1.5 text-ai' : 'px-3 py-2 text-ink-fg-2'
          )}
        >
          <ChevronRight
            size={13}
            strokeWidth={2}
            className={cn('shrink-0 transition-transform duration-fast', open && 'rotate-90')}
          />
          <span className="truncate">{t('team.record.rawPrompt.title')}</span>
        </button>
        <button
          type="button"
          onClick={copy}
          aria-label={t('team.record.rawPrompt.copy')}
          title={t('team.record.rawPrompt.copy')}
          className="grid size-7 shrink-0 place-items-center rounded-md text-ink-fg-3 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
        >
          {copied ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={2} />}
        </button>
      </div>
      {open && (
        <pre
          className={cn(
            'scrollbar-thin max-h-72 overflow-y-auto whitespace-pre-wrap border-t font-mono text-micro leading-relaxed text-ink-fg-2 [overflow-wrap:anywhere]',
            bare ? 'border-ai/25 py-2' : 'border-[var(--hairline)] px-3 py-2.5'
          )}
        >
          {prompt}
        </pre>
      )}
    </div>
  )
  if (bare) return body
  return <div className="mx-auto mb-4 w-full max-w-[var(--thread-max-width)]">{body}</div>
}
