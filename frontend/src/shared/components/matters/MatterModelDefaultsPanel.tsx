import { useTranslation } from 'react-i18next'
import { Cpu, Loader2 } from 'lucide-react'

import { errorMessage } from '@shared/lib/ipcErrors'
import { toastError } from '@shared/state/toast'

import { MatterModelFields } from './MatterModelFields'
import { matterModelDraftFrom, useMatterModelFields } from './matterModelDraft'
import { useMatterAgentDefaults } from './useMatterAgentDefaults'

/**
 * 全局跟进 Agent 的**模型默认**（0813 dogfood 轮 3 · B10）。
 *
 * owner 原话：「跟进规则的**全局** matter agent 配置，仍然没有模型配置啊，看设计，override
 * 倒是有了」。上一批只给了事项级覆盖，而全局这一层对模型没有任何意见 —— 于是所有没单独配过
 * 的事项只能跟绑定 Agent 或系统全局默认走，「全局跟进 Agent 用哪个模型」根本没有落点。
 *
 * 🔴 **改一下存一次**（不进页脚那颗「保存」）：页脚的保存写的是任务契约文档（另一个后端
 * 端点），把两条写路径塞进一颗按钮就得处理「一半成功」。同一个弹窗里的网页三档已经是这个
 * 交互，这里沿用 —— 好处是「显示的档 == 存进去的档」在结构上永真：草稿直接由服务端事实派生，
 * 保存失败自动退回（`useMatterAgentDefaults` 的回滚）。
 *
 * 🔴 与设计稿的差异（设计 `matter-agent.jsx:578-591` 只画了「默认模型 + 备用模型」）：
 *   · 多一项**思考强度** —— 事项级已有这一项（轮 3 #10），全局缺席会让「全局设一次」变成
 *     「每个事项各设一遍」；
 *   · 设计的「切换条件」（超时/限流/报错三个药丸）**不做** —— 真实重试判据是「这次尝试
 *     什么都没产出」，由 gateway 判定，没有可配的位；画出来就是假开关。
 */
export function MatterModelDefaultsPanel(): React.ReactElement {
  const { t } = useTranslation()
  const store = useMatterAgentDefaults({
    onSaveError: (error) =>
      toastError(t('matters.globalAgent.modelDefaults.saveFailed'), errorMessage(error))
  })
  // 🔴 草稿**不留本地 state**：直接由服务端事实派生。改一下存一次的面上，任何本地缓存都会
  // 制造「界面显示 X、库里是 Y」的窗口，而这正是本批要收的病根。
  const draft = matterModelDraftFrom(store.defaults)
  const { blockFor } = useMatterModelFields(draft)

  return (
    <div className="mt-4 rounded-[var(--r-ctl)] border border-ink-border bg-ink-2/50 p-3">
      <p className="flex items-center gap-1.5 text-meta font-medium text-ink-fg-1">
        <Cpu size={13} className="text-ai" />
        {t('matters.globalAgent.modelDefaults.title')}
        {store.isSaving ? <Loader2 size={11} className="animate-spin text-ink-fg-3" /> : null}
      </p>
      <p className="mt-1.5 text-meta leading-relaxed text-ink-fg-2">
        {t('matters.globalAgent.modelDefaults.intro')}
      </p>
      {/* 🔴 读失败必须说出来：静默显示成「没配过」会诱使 owner 在一份看不见的旧配置上重配。 */}
      {store.isError ? (
        <p className="mt-2 text-meta leading-5 text-warn">
          {t('matters.globalAgent.modelDefaults.loadFailed')}
        </p>
      ) : null}
      {/* 🔴 还没读回来时**不渲染这三个 select**（同弹窗里任务契约 textarea 的处置）：未加载
          的草稿三档都是「不设默认」，与真的没配过长得一模一样 —— 摆出来就是在数据回来之前
          先下一个确定的否定判断，而它有一半时间是错的。 */}
      {store.defaults === undefined && !store.isError ? (
        <p className="mt-2 flex items-center gap-1.5 text-meta text-ink-fg-3">
          <Loader2 size={11} className="animate-spin" />
          {t('common.loading')}
        </p>
      ) : (
        <MatterModelFields
          idPrefix="matter-global-agent"
          draft={draft}
          onDraftChange={(next) => store.save(blockFor(next))}
          followKeys={{
            model: 'matters.globalAgent.modelDefaults.modelFollow',
            effort: 'matters.globalAgent.modelDefaults.effortFollow',
            fallback: 'matters.globalAgent.modelDefaults.fallbackFollow'
          }}
          fallbackHintKey="matters.globalAgent.modelDefaults.fallbackHint"
          effortFollowHintKey="matters.globalAgent.modelDefaults.effortScopeHint"
          /* 正在存 → 不许接着改：此刻显示的是乐观值，在它上面改会把一个没落库的中间态
             当基线发出去。读失败时同样锁住（草稿是空的，存下去等于清空别人的配置）。 */
          disabled={store.isSaving || store.isError}
        />
      )}
    </div>
  )
}
