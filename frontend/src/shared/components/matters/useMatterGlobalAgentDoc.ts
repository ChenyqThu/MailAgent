import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { resolveApiBaseUrl } from '@shared/lib/apiBaseUrl'
import { errorMessage } from '@shared/lib/ipcErrors'
import { toastError } from '@shared/state/toast'

/**
 * 全局 Matter Agent 任务契约（`agent_config.db` 的 `matter_agent` 文档）的读单源。
 *
 * 🔴 「库里空 = 跟随代码默认」是既定的**存储**语义（这样以后默认文案升级，没自定义过的
 * 用户能跟着走），所以**当前生效的值 = `content || defaultContent`** —— 界面必须显示这个
 * 表达式的结果，而不是把空的 `content` 原样摆出来。0812 dogfood 里 owner 打开配置面看到
 * 空 textarea，读成「预设完全没做」，正是这个缺口。
 *
 * 三处消费（全局配置模态与团队页「事项跟进 → 设置」的编辑框、事项级「专属指令」旁的只读
 * 披露区）共用这一个 query，不各写一份 fetch —— 两份 fetch 会各自缓存，同一份文档在两个面上
 * 显示成两个值。
 */
const DOC_NAME = 'matter_agent'

export const MATTER_GLOBAL_AGENT_DOC_KEY = ['matters', 'global-agent-doc'] as const

export interface MatterGlobalAgentDoc {
  content: string
  defaultContent: string
}

export function useMatterGlobalAgentDoc(): UseQueryResult<MatterGlobalAgentDoc> {
  return useQuery({
    queryKey: MATTER_GLOBAL_AGENT_DOC_KEY,
    queryFn: async (): Promise<MatterGlobalAgentDoc> => {
      const response = await fetch(`${resolveApiBaseUrl()}/agent/profile/docs/${DOC_NAME}`, {
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
}

/** 当前**生效**的任务契约全文（自定义优先，否则代码默认）。 */
export function effectiveContract(doc: MatterGlobalAgentDoc | undefined): string {
  return doc ? doc.content || doc.defaultContent : ''
}

/** 任务契约的编辑态（草稿 + 保存），全局配置模态与团队页设置档共用。 */
export interface MatterTaskContract {
  doc: UseQueryResult<MatterGlobalAgentDoc>
  draft: string
  setDraft(value: string): void
  defaultContent: string
  isDefault: boolean
  /** 🔴 加载中 / 读失败不许保存：此时草稿是空的，点保存会把它当"新内容"覆盖用户可能已有的
   *  自定义文本，是数据损坏路径。 */
  canSave: boolean
  isSaving: boolean
  isSaveError: boolean
  save(): void
}

export function useMatterTaskContract(onSaved?: () => void): MatterTaskContract {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const doc = useMatterGlobalAgentDoc()
  const [draft, setDraft] = useState('')
  const [loaded, setLoaded] = useState(false)
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

  const mutation = useMutation({
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
      onSaved?.()
    },
    onError: (error) => toastError(t('matters.globalAgent.saveFailed'), errorMessage(error))
  })

  return {
    doc,
    draft,
    setDraft,
    defaultContent,
    isDefault,
    canSave: !doc.isLoading && !doc.isError,
    isSaving: mutation.isPending,
    isSaveError: mutation.isError,
    // 与默认逐字相同 ⇒ 存空串回到"跟随默认"，而不是把这份快照冻进库里
    // （否则以后默认文案升级，这个用户永远停在今天这版）。
    save: () => mutation.mutate(isDefault ? '' : draft)
  }
}
