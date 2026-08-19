// 治理台抽屉的「它能做什么」tab（WP7；原型 `cagent.jsx` :91-117）：
//   ① 注入的工具逐件列出（名字 + 权限档 + 一句说明）；
//   ② 治理 agent 的系统提示词 —— **可编辑**。
//
// 🔴 清单不在本文件里硬编码，来自零依赖叶子 `@shared/lib/contactToolFace`，与 gateway
// 真实装配出来的 ToolSet 由 `tests/ai-gateway/contact_tool_face_leaf.test.ts` 三向钉死
// （幽灵条目 / 藏起来的能力 / 治理场地拿不到的那三件写工具，都会红）。
//
// 🔴 原型这块是只读 `<pre>` + 标题写着「可在 Agents 页编辑」。改成抽屉内可编辑是
// owner 拍板（PRD §4.8「治理台抽屉内可编辑」）：Agents 页没有、也不打算加治理卡，
// 留着那句话就是指向一个不存在的地方。

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText, Loader2, RotateCcw, SlidersHorizontal } from 'lucide-react'

import {
  CONTACT_TOOL_FACE_GROUPS,
  type ContactToolGroup
} from '@shared/lib/contactToolFace'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { toastError, toastSuccess } from '@shared/state/toast'

import { useContactAgentPrompt, useSaveContactAgentPrompt } from './hooks'
import { ContactPip, SecHead } from './parts'

const PERMISSION_TONE: Record<ContactToolGroup['permission'], 'neutral' | 'info' | 'warn'> = {
  read: 'neutral',
  propose: 'info',
  write: 'warn'
}

function ToolRow({
  name,
  permission
}: {
  name: string
  permission: ContactToolGroup['permission']
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div className="flex items-baseline gap-2 rounded-[var(--r-ctl)] bg-ink-fg/[0.025] px-[9px] py-1.5">
      <code className="shrink-0 font-mono text-micro text-ink-fg">{name}</code>
      <ContactPip tone={PERMISSION_TONE[permission]}>
        {t(`contacts.agent.perm.${permission}`)}
      </ContactPip>
      <span className="min-w-0 flex-1 text-micro leading-[1.5] text-ink-fg-2 [text-wrap:pretty]">
        {t(`contacts.agent.desc.${name}`)}
      </span>
    </div>
  )
}

/** 系统提示词编辑区。生效值 = `content || defaultContent`（库里空 = 跟随代码默认，
 *  空框会被读成「预设完全没做」——matters 0812 dogfood 实测过的那个缺口）。
 *  🔴 读失败时保存钮禁用：那时 draft 是一份空草稿，点保存会把它当「新内容」覆盖掉
 *  owner 可能已有的自定义文本，是数据损坏路径。 */
function ContactAgentPromptEditor(): React.ReactElement {
  const { t } = useTranslation()
  const doc = useContactAgentPrompt(true)
  const save = useSaveContactAgentPrompt()
  const [draft, setDraft] = useState('')
  const [loaded, setLoaded] = useState(false)

  const defaultContent = doc.data?.defaultContent ?? ''
  useEffect(() => {
    if (doc.data !== undefined && !loaded) {
      setDraft(doc.data.content || doc.data.defaultContent)
      setLoaded(true)
    }
  }, [doc.data, loaded])

  const isDefault = draft.trim() === defaultContent.trim()

  return (
    <div>
      <SecHead
        icon={<FileText size={13} aria-hidden className="shrink-0 text-ink-fg-2" />}
        title={t('contacts.agent.prompt.title')}
      />
      {/* 🔴 先说清「你改的是哪一段」：下面那个框只是每轮任务提示词的第一段。 */}
      <p className="text-micro leading-[1.6] text-ink-fg-3">{t('contacts.agent.prompt.hint')}</p>

      <div className="mt-2 flex items-center justify-between gap-2">
        <label className="text-meta font-medium text-ink-fg-1" htmlFor="contact-agent-prompt">
          {t('contacts.agent.prompt.label')}
        </label>
        {!doc.isPending && defaultContent !== '' ? (
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-micro',
              isDefault ? 'bg-ok/[0.12] text-ok' : 'bg-ai/[0.12] text-ai'
            )}
          >
            {t(
              isDefault ? 'contacts.agent.prompt.usingDefault' : 'contacts.agent.prompt.customized'
            )}
          </span>
        ) : null}
      </div>

      {doc.isError ? (
        <p className="mt-1.5 text-meta leading-[1.6] text-warn">
          {t('contacts.agent.prompt.loadFailed')}
        </p>
      ) : null}

      <textarea
        id="contact-agent-prompt"
        value={draft}
        disabled={doc.isPending || doc.isError}
        onChange={(event) => setDraft(event.target.value)}
        rows={10}
        placeholder={t('contacts.agent.prompt.placeholder')}
        className="mt-1.5 w-full resize-y rounded-[var(--r-ctl)] border border-ink-border bg-ink-0/40 p-2.5 font-mono text-micro leading-[1.7] text-ink-fg-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/70 disabled:opacity-60"
      />

      <div className="mt-1.5 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setDraft(defaultContent)}
          disabled={doc.isPending || doc.isError}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-[var(--r-ctl)] px-2 py-1 text-meta text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg disabled:pointer-events-none disabled:opacity-50"
        >
          <RotateCcw size={12} aria-hidden />
          {t('contacts.agent.prompt.restoreDefault')}
        </button>
        <span aria-hidden className="flex-1" />
        <button
          type="button"
          disabled={doc.isPending || doc.isError || save.isPending}
          onClick={() =>
            // 「恢复默认」= 存空内容（服务端据此回落代码默认），不是把当前默认文本写进库
            // —— 这样以后默认文案升级，没自定义过的用户能跟着走。
            save.mutate(isDefault ? '' : draft, {
              onSuccess: () => toastSuccess(t('contacts.toast.promptSaved')),
              onError: (error) =>
                toastError(t('contacts.toast.promptSaveFailed'), errorMessage(error))
            })
          }
          className="inline-flex shrink-0 items-center gap-1.5 rounded-[var(--r-ctl)] border border-coral/30 bg-coral/10 px-2.5 py-1 text-meta font-medium text-coral transition-colors duration-fast ease-standard hover:bg-coral/[0.17] disabled:pointer-events-none disabled:opacity-50"
        >
          {save.isPending ? <Loader2 size={12} aria-hidden className="animate-spin" /> : null}
          {t(save.isPending ? 'contacts.agent.prompt.saving' : 'contacts.agent.prompt.save')}
        </button>
      </div>
    </div>
  )
}

export function ContactAgentToolFace(): React.ReactElement {
  const { t } = useTranslation()
  const toolCount = CONTACT_TOOL_FACE_GROUPS.reduce((n, group) => n + group.tools.length, 0)

  return (
    <div className="flex flex-col gap-4">
      <div>
        <SecHead
          icon={<SlidersHorizontal size={13} aria-hidden className="shrink-0 text-ink-fg-2" />}
          title={t('contacts.agent.tools.title')}
          count={toolCount}
        />
        <div className="flex flex-col gap-1">
          {CONTACT_TOOL_FACE_GROUPS.map((group) =>
            group.tools.map((name) => (
              <ToolRow key={name} name={name} permission={group.permission} />
            ))
          )}
        </div>
        <p className="mt-[7px] text-micro leading-[1.6] text-ink-fg-3">
          {t('contacts.agent.tools.footnote')}
        </p>
        {/* 🔴 副标写着「它读、它提议，你确认」，同屏却列着三件写工具 —— 不说清场地就是撒谎。
            policy.ts 的 `contact_governance` 行 deny 掉整个 domain_write 类。 */}
        <p className="mt-1 text-micro leading-[1.6] text-ink-fg-3">
          {t('contacts.agent.tools.governanceOff')}
        </p>
      </div>
      <ContactAgentPromptEditor />
    </div>
  )
}
