import { useTranslation } from 'react-i18next'
import { Loader2, RotateCcw } from 'lucide-react'

import type { MatterTaskContract } from './useMatterGlobalAgentDoc'

/**
 * 任务契约编辑框 —— 每轮 prompt 里**唯一可改**的那一段（库里空 = 跟随代码默认）。
 * 全局配置模态与团队页「事项跟进 → 设置」共用；草稿与保存在 `useMatterTaskContract`。
 */
export function MatterTaskContractField({
  contract
}: {
  contract: MatterTaskContract
}): React.ReactElement {
  const { t } = useTranslation()
  const { doc, draft, setDraft, defaultContent, isDefault } = contract

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <label className="text-meta font-medium text-ink-fg-1" htmlFor="matter-global-prompt">
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
            {t(isDefault ? 'matters.globalAgent.usingDefault' : 'matters.globalAgent.customized')}
          </span>
        ) : null}
      </div>
      {doc.isError ? (
        /* 🔴 失败必须说出来，且保存键不能继续可点（见 MatterTaskContract.canSave）。 */
        <p className="mt-2 text-meta leading-5 text-warn">{t('matters.globalAgent.loadFailed')}</p>
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
      <div className="mt-2 flex items-start justify-between gap-3">
        <p className="min-w-0 text-meta leading-5 text-ink-fg-2">
          {t('matters.globalAgent.promptHint')}
        </p>
        {/* 设计 `matter-agent.jsx:563-565` —— 「恢复默认」贴着它作用的那个框（原来在页脚
            最左边，与「取消/保存」并排，读起来像第三个提交动作）。 */}
        <button
          type="button"
          onClick={() => setDraft(defaultContent)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-[var(--r-ctl)] px-2 py-1 text-meta text-ink-fg-2 hover:bg-ink-3 hover:text-ink-fg"
        >
          <RotateCcw size={12} />
          {t('matters.globalAgent.restoreDefault')}
        </button>
      </div>
    </div>
  )
}
