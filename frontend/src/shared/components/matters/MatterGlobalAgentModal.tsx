import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2, RotateCcw, Sparkles, X } from 'lucide-react'

import { useEnterAnimation } from '@shared/hooks/useEnterAnimation'
import { resolveApiBaseUrl } from '@shared/lib/apiBaseUrl'
import { errorMessage } from '@shared/lib/ipcErrors'
import { toastError, toastSuccess } from '@shared/state/toast'

import { MatterPromptAssembly } from './MatterPromptAssembly'
import { MatterToolFacePanel } from './MatterToolFacePanel'
import { MATTER_GLOBAL_AGENT_DOC_KEY, useMatterGlobalAgentDoc } from './useMatterGlobalAgentDoc'

/**
 * 全局 Matter Agent 配置（P6-B D3/D17；0812 dogfood Lane C 扩成三块）。
 *
 * owner 原话：「该显示的默认 system prompt（不可改部分和可改部分）都没显示出来，工具那块
 * 也是」。所以本弹窗现在自上而下是三块：
 *   1. `MatterPromptAssembly` —— 每轮 prompt 由哪几段拼成、你改的是哪一段（只读）；
 *   2. 任务契约编辑框 —— **唯一可改的那一段**（库里空 = 跟随代码默认，见下）；
 *   3. `MatterToolFacePanel` —— 工具面逐项列出 + 唯一可改的网页三档。
 *
 * 设计稿画的「8 个可用工具勾选」仍**不做**：那 30 件工具是服务端按 CLASS 强制推导的
 * （matter_followup 矩阵行 + wrap 腰带），勾选框勾不掉也勾不上 —— 画出来就是假开关。
 * 改为「列出来 + 标明哪些固定」。真正可配的只有网页那一档（owner_settings
 * `matter_run_web_face`，服务端确实读它），它就做成真开关。
 *
 * 「恢复默认」= 把内容清空（后端据此回落代码里的任务契约），不是把当前默认文本写进库 ——
 * 这样以后默认文案升级，没自定义过的用户能跟着走。
 */

const DOC_NAME = 'matter_agent'

export function MatterGlobalAgentModal({ onClose }: { onClose(): void }): React.ReactElement {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState('')
  const [loaded, setLoaded] = useState(false)
  // G-32 —— 遮罩 fadeIn + 卡片 popIn；只做进场（调用方硬挂载，见 useEnterAnimation 头注）。
  const animScopeRef = useEnterAnimation<HTMLDivElement>({
    card: '[data-anim-card]',
    backdrop: true
  })

  const doc = useMatterGlobalAgentDoc()

  const defaultContent = doc.data?.defaultContent ?? ''

  useEffect(() => {
    if (doc.data !== undefined && !loaded) {
      // 🔴 库里空 = 跟随代码默认。空框会被读成"没有预设"（0812 dogfood 实测），所以未自定义
      // 时把**当前生效的默认全文**填进来：看得见、可直接改。存储语义不变，见下方 save。
      setDraft(doc.data.content || doc.data.defaultContent)
      setLoaded(true)
    }
  }, [doc.data, loaded])

  const isDefault = draft.trim() === defaultContent.trim()

  const save = useMutation({
    mutationFn: async (content: string): Promise<void> => {
      const response = await fetch(`${resolveApiBaseUrl()}/agent/profile/docs/${DOC_NAME}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MATTER_GLOBAL_AGENT_DOC_KEY })
      toastSuccess(t('matters.globalAgent.saved'))
      onClose()
    },
    onError: (error) => toastError(t('matters.globalAgent.saveFailed'), errorMessage(error))
  })

  return (
    <div
      ref={animScopeRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-0/60 p-6"
    >
      <div
        data-anim-card
        className="flex max-h-full w-full max-w-[620px] flex-col overflow-hidden rounded-[var(--r-card)] border border-ink-border bg-ink-1 shadow-raised"
      >
        <header className="flex items-start justify-between gap-3 border-b border-ink-border px-5 py-4">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-lead font-semibold">
              <Sparkles size={15} className="text-ai" />
              {t('matters.globalAgent.title')}
            </h2>
            <p className="mt-1 text-meta text-ink-fg-2">{t('matters.globalAgent.subtitle')}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="rounded-[var(--r-ctl)] p-1 text-ink-fg-2 hover:bg-ink-3 hover:text-ink-fg"
          >
            <X size={15} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {/* 🔴 先说清「你改的是哪一段」：下面那个框只是每轮 prompt 的第一段。 */}
          <MatterPromptAssembly />

          <div className="mt-4 flex items-center justify-between gap-2">
            <label className="text-meta font-medium text-ink-fg-2" htmlFor="matter-global-prompt">
              {t('matters.globalAgent.promptLabel')}
            </label>
            {!doc.isLoading && defaultContent ? (
              <span
                className={
                  isDefault
                    ? 'rounded-full bg-ok/[0.12] px-2 py-0.5 text-meta text-ok'
                    : 'rounded-full bg-ai/[0.12] px-2 py-0.5 text-meta text-ai'
                }
              >
                {t(
                  isDefault ? 'matters.globalAgent.usingDefault' : 'matters.globalAgent.customized'
                )}
              </span>
            ) : null}
          </div>
          {doc.isError ? (
            /* 🔴 失败必须说出来，且不能让保存键继续可点——读失败时 draft 是一份空草稿，
               点保存会把它当"新内容"覆盖用户可能已有的自定义文本，是数据损坏路径。 */
            <p className="mt-2 text-meta leading-5 text-warn">
              {t('matters.globalAgent.loadFailed')}
            </p>
          ) : null}
          {doc.isLoading ? (
            <div className="mt-2 flex items-center gap-2 text-meta text-ink-fg-2">
              <Loader2 size={13} className="animate-spin" />
              {t('common.loading')}
            </div>
          ) : (
            <textarea
              id="matter-global-prompt"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={14}
              placeholder={t('matters.globalAgent.promptPlaceholder')}
              className="mt-2 w-full resize-y rounded-[var(--r-ctl)] border border-ink-border bg-ink-0/40 p-3 font-mono text-meta leading-relaxed text-ink-fg-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70"
            />
          )}
          <p className="mt-2 text-meta text-ink-fg-2">{t('matters.globalAgent.promptHint')}</p>

          {/* 0812 dogfood：工具面从一段散文换成**逐项列出**的清单（含唯一可改的网页三档）。
              清单本身在零依赖叶子 `@shared/lib/matterToolFace`，与 gateway 真实 ToolSet
              有双向闸；固定项仍不画 disabled 勾选框（那是永远不生效的假开关）。 */}
          <MatterToolFacePanel />
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-ink-border px-5 py-3">
          <button
            type="button"
            onClick={() => setDraft(defaultContent)}
            className="inline-flex items-center gap-1.5 text-meta text-ink-fg-2 hover:text-ink-fg"
          >
            <RotateCcw size={13} />
            {t('matters.globalAgent.restoreDefault')}
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-[var(--r-ctl)] px-3 py-1.5 text-body text-ink-fg-1 hover:bg-ink-3"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              disabled={save.isPending || doc.isLoading || doc.isError}
              /* 与默认逐字相同 ⇒ 存空串回到"跟随默认"，而不是把这份快照冻进库里
                 （否则以后默认文案升级，这个用户永远停在今天这版）。 */
              onClick={() => save.mutate(isDefault ? '' : draft)}
              className="inline-flex items-center gap-1.5 rounded-[var(--r-ctl)] bg-coral/100 px-3 py-1.5 text-body font-medium text-accent-fg disabled:opacity-60"
            >
              {save.isPending ? <Loader2 size={13} className="animate-spin" /> : null}
              {t('common.save')}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
