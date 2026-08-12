import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2, RotateCcw, Shield, Sparkles, X } from 'lucide-react'

import { errorMessage } from '@shared/lib/ipcErrors'
import { toastError, toastSuccess } from '@shared/state/toast'

/**
 * 全局 Matter Agent 配置（P6-B D3/D17）—— **只做 prompt**。
 *
 * 设计稿还画了「8 个可用工具勾选」与「授权级别三档」，两者都**刻意不做**：在本仓架构里
 * 它们是服务端强制的（固定工具 allowlist、不下发任何 grant 键、policy 只放行读 + artifact），
 * 做成 UI 开关后用户勾上「对外发送邮件」也不会生效 —— 那就是又造一个说谎的界面。
 * 所以这里改为**如实陈述**这两条由系统固定。
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

  const doc = useQuery({
    queryKey: ['matters', 'global-agent-doc'],
    queryFn: async (): Promise<{ content: string; defaultContent: string }> => {
      const response = await fetch(`/api/agent/profile/docs/${DOC_NAME}`, {
        credentials: 'include'
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = (await response.json()) as {
        data?: { content?: string; defaultContent?: string }
      }
      return {
        content: payload.data?.content ?? '',
        defaultContent: payload.data?.defaultContent ?? ''
      }
    },
    staleTime: 30_000
  })

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
      const response = await fetch(`/api/agent/profile/docs/${DOC_NAME}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['matters', 'global-agent-doc'] })
      toastSuccess(t('matters.globalAgent.saved'))
      onClose()
    },
    onError: (error) => toastError(t('matters.globalAgent.saveFailed'), errorMessage(error))
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-0/60 p-6">
      <div className="flex max-h-full w-full max-w-[620px] flex-col overflow-hidden rounded-[var(--r-card)] border border-ink-border bg-ink-1 shadow-raised">
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
          <div className="flex items-center justify-between gap-2">
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

          {/* D3 末条：工具面与授权级别由系统固定、事项级不能提权 —— 如实陈述，
              而不是画一排永远不生效的 disabled 勾选框。 */}
          <div className="mt-4 rounded-[var(--r-ctl)] border border-ink-border bg-ink-2/50 p-3">
            <p className="flex items-center gap-1.5 text-meta font-medium text-ink-fg-1">
              <Shield size={13} className="text-ok" />
              {t('matters.globalAgent.fixedTitle')}
            </p>
            <p className="mt-1.5 text-meta leading-relaxed text-ink-fg-2">
              {t('matters.globalAgent.fixedBody')}
            </p>
          </div>
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
              disabled={save.isPending || doc.isLoading}
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
