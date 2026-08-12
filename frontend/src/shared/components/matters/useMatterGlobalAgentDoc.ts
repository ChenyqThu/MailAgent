import { useQuery, type UseQueryResult } from '@tanstack/react-query'

import { resolveApiBaseUrl } from '@shared/lib/apiBaseUrl'

/**
 * 全局 Matter Agent 任务契约（`agent_config.db` 的 `matter_agent` 文档）的读单源。
 *
 * 🔴 「库里空 = 跟随代码默认」是既定的**存储**语义（这样以后默认文案升级，没自定义过的
 * 用户能跟着走），所以**当前生效的值 = `content || defaultContent`** —— 界面必须显示这个
 * 表达式的结果，而不是把空的 `content` 原样摆出来。0812 dogfood 里 owner 打开配置面看到
 * 空 textarea，读成「预设完全没做」，正是这个缺口。
 *
 * 两处消费（全局配置模态的编辑框、事项级「专属指令」旁的只读披露区）共用这一个 query，
 * 不各写一份 fetch —— 两份 fetch 会各自缓存，同一份文档在两个面上显示成两个值。
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
