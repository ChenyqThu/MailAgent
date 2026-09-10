import { useTranslation } from 'react-i18next'
import { Loader2, Shield, Sparkles, X } from 'lucide-react'

import { useEnterAnimation } from '@shared/hooks/useEnterAnimation'
import { toastSuccess } from '@shared/state/toast'

import { MatterModelDefaultsPanel } from './MatterModelDefaultsPanel'
import { MatterPromptAssembly } from './MatterPromptAssembly'
import { MatterTaskContractField } from './MatterTaskContractField'
import { MatterToolFacePanel } from './MatterToolFacePanel'
import { useMatterTaskContract } from './useMatterGlobalAgentDoc'

/**
 * 全局 Matter Agent 配置（P6-B D3/D17；0812 dogfood Lane C 扩成三块）。
 *
 * owner 原话：「该显示的默认 system prompt（不可改部分和可改部分）都没显示出来，工具那块
 * 也是」。所以本弹窗现在自上而下是三块：
 *   1. `MatterPromptAssembly` —— 每轮 prompt 由哪几段拼成、你改的是哪一段（只读）；
 *   2. 任务契约编辑框 —— **唯一可改的那一段**（库里空 = 跟随代码默认，见下）；
 *   3. `MatterToolFacePanel` —— 工具面逐项列出 + 唯一可改的网页三档。
 *
 * 同一组组件也铺在团队页「事项跟进 → 设置」里（`MatterFollowupSettings`），两处读写同一份数据。
 *
 * 设计稿画的「8 个可用工具勾选」仍**不做**：那 30 件工具是服务端按 CLASS 强制推导的
 * （matter_followup 矩阵行 + wrap 腰带），勾选框勾不掉也勾不上 —— 画出来就是假开关。
 * 改为「列出来 + 标明哪些固定」。真正可配的只有网页那一档（owner_settings
 * `matter_run_web_face`，服务端确实读它），它就做成真开关。
 *
 * 「恢复默认」= 把内容清空（后端据此回落代码里的任务契约），不是把当前默认文本写进库 ——
 * 这样以后默认文案升级，没自定义过的用户能跟着走。
 */
export function MatterGlobalAgentModal({ onClose }: { onClose(): void }): React.ReactElement {
  const { t } = useTranslation()
  // G-32 —— 遮罩 fadeIn + 卡片 popIn；只做进场（调用方硬挂载，见 useEnterAnimation 头注）。
  const animScopeRef = useEnterAnimation<HTMLDivElement>({
    card: '[data-anim-card]',
    backdrop: true
  })
  const contract = useMatterTaskContract(() => {
    toastSuccess(t('matters.globalAgent.saved'))
    onClose()
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

          <div className="mt-4">
            <MatterTaskContractField contract={contract} />
          </div>

          {/* 0813 轮 3 B10：模型 / 思考强度 / 备用模型的**全局默认**。事项级的同三项是
              「覆盖」，这里是它们跟随的那一层（解析链 = 事项级覆盖 → 绑定 Agent →
              这里 → 系统全局默认，权威在 Python `run_spec.py`）。 */}
          <MatterModelDefaultsPanel />

          {/* 0812 dogfood：工具面从一段散文换成**逐项列出**的清单（含唯一可改的网页三档）。
              清单本身在零依赖叶子 `@shared/lib/matterToolFace`，与 gateway 真实 ToolSet
              有双向闸；固定项仍不画 disabled 勾选框（那是永远不生效的假开关）。 */}
          <MatterToolFacePanel />
        </div>

        {/* 设计 `matter-agent.jsx:620-625` 的页脚：shield + 「改动的影响范围」+ 取消/保存。 */}
        <footer className="flex items-center gap-2.5 border-t border-ink-border px-5 py-3">
          <Shield size={12} className="shrink-0 text-ink-fg-3" />
          <span className="min-w-0 flex-1 text-meta leading-5 text-ink-fg-3">
            {t('matters.globalAgent.footerNote')}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-[var(--r-ctl)] px-3 py-1.5 text-body text-ink-fg-1 hover:bg-ink-3"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              disabled={contract.isSaving || !contract.canSave}
              onClick={contract.save}
              className="inline-flex items-center gap-1.5 rounded-[var(--r-ctl)] bg-coral/100 px-3 py-1.5 text-body font-medium text-accent-fg disabled:opacity-60"
            >
              {contract.isSaving ? <Loader2 size={13} className="animate-spin" /> : null}
              {t('common.save')}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
