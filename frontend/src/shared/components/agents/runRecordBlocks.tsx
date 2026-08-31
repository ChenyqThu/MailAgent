// task 08-27 P4a（lane team-shell）— 执行记录 transcript 的两块共享积木：
//
//   • AgentRunTriggerBubble — 前端合成的「⚡自动触发」紫色气泡（transcript 第一条）。
//     🔴 数据来自 run 行的 triggerKind/triggerFiredAtIso，**不是**会话首条 user 消息
//     （那是 4-7KB 任务契约 prompt，r8 §A.2；直接渲染 = 点开一次执行先看 7KB 系统指令）。
//   • RunRawPromptBlock — 被摘掉的原始 prompt 收进末尾折叠块（默认收起）+ 复制。
//
// AgentRecordConversation（/sessions 打开 run 会话）与团队页执行详情共用这两块。

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
 *  detail 是触发条件的一句话补充（如 email_filter 的命中摘要），没有就只显示种类。 */
export function AgentRunTriggerBubble({
  triggerKind,
  firedAtIso,
  detail
}: {
  triggerKind: string | null | undefined
  firedAtIso: string | null | undefined
  detail?: string | null
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
      </div>
    </div>
  )
}

/** 末尾折叠块：被摘掉的任务契约 prompt 原文（默认收起）+ 复制。不占主位 —— 要看原文的
 *  时候能看，但它不该是第一眼的东西（design §8.1）。 */
export function RunRawPromptBlock({ prompt }: { prompt: string }): React.ReactElement {
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
  return (
    <div className="mx-auto mb-4 w-full max-w-[var(--thread-max-width)]" data-run-raw-prompt>
      <div className="rounded-lg border border-[var(--hairline)] bg-ink-2/60">
        <div className="flex items-center gap-1 pr-1.5">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="flex min-w-0 flex-1 items-center gap-1.5 px-3 py-2 text-left text-meta text-ink-fg-2 transition-colors duration-fast hover:text-ink-fg"
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
          <pre className="scrollbar-thin max-h-72 overflow-y-auto whitespace-pre-wrap border-t border-[var(--hairline)] px-3 py-2.5 font-mono text-micro leading-relaxed text-ink-fg-2 [overflow-wrap:anywhere]">
            {prompt}
          </pre>
        )}
      </div>
    </div>
  )
}
