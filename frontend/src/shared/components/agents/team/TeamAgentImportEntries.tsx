// task 08-31 P4a 收尾 — 团队页恢复 Agent Plugin 的「导入」与「用模板创建：会前准备」入口。
// P4a 把卡片网格换成团队页时只补了导出（CustomAgentSettings 危险区的「导出」），这两个
// 入口随旧 AgentsTab 一起丢了。
//
// 链路与旧 AgentsTab 一致：POST /report-agents/import，body 两形态
//   • { payload: <导出的 JSON> } —— 与设置页「导出」的 agent-*.json 互为逆操作
//   • { template: 'meeting_prep' } —— 后端 agent_templates 里的模板
// （不是 SkillDraftsSection 那条 zip → importAgentPlugin 的技能包链，两者不同。）
// 落地恒 enabled=false 由后端保证（Agent Plugins 1.0 契约），前端不额外置位。
//
// 🔴 挂在清单列而不是新建表单里：导入成功要跳去新成员的设置档，新建表单会随之卸载，
//    「未满足依赖」提示挂在会被卸载的节点上等于没有（旧实现里网格是常驻的，抽屉才是浮层）。

import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import type { ReportAgentConfig } from '@shared/api/types'
import { resolveApiBaseUrl } from '@shared/hooks/useLlmModels'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { toastError } from '@shared/state/toast'

import { useAgentPluginsEnabled, useCalendarTriggerEnabled } from '../hooks'

interface ImportEnvelope {
  data?: {
    agent?: ReportAgentConfig
    unmet_dependencies?: Array<{ type: string; ref: string }>
  }
  error?: { message?: string }
}

export function TeamAgentImportEntries({
  /** 导入落地后的流转：选中新成员并落设置档（同新建）。 */
  onImported
}: {
  onImported: (agentId: string) => void
}): React.ReactElement | null {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const agentPluginsEnabled = useAgentPluginsEnabled()
  const calendarTriggerEnabled = useCalendarTriggerEnabled()
  const fileRef = useRef<HTMLInputElement>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function importAgent(body: Record<string, unknown>): Promise<void> {
    try {
      const response = await fetch(`${resolveApiBaseUrl()}/report-agents/import`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      const envelope = (await response.json()) as ImportEnvelope
      if (!response.ok || !envelope.data?.agent)
        throw new Error(envelope.error?.message ?? response.statusText)
      await queryClient.invalidateQueries({ queryKey: qk.report.config() })
      const unmet = envelope.data.unmet_dependencies ?? []
      setNotice(
        unmet.length
          ? t('agents.custom.unmetDependencies', {
              items: unmet.map((item) => `${item.type}: ${item.ref}`).join(', ')
            })
          : null
      )
      onImported(envelope.data.agent.id)
    } catch (error) {
      toastError(t('agents.custom.import'), errorMessage(error))
    }
  }

  async function importAgentFile(file: File): Promise<void> {
    try {
      await importAgent({ payload: JSON.parse(await file.text()) as unknown })
    } catch (error) {
      toastError(t('agents.custom.import'), errorMessage(error))
    } finally {
      // 选同一个文件两次也要触发 change。
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  if (!agentPluginsEnabled) return null

  return (
    <div className="flex flex-col gap-1 px-2.5 pt-2" data-team-import>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void importAgentFile(file)
        }}
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          data-team-import-file
          className="text-meta text-ink-fg-2 transition-colors duration-fast hover:text-ink-fg"
          onClick={() => fileRef.current?.click()}
        >
          {t('agents.custom.import')}
        </button>
        <button
          type="button"
          data-team-import-template
          className="text-meta text-ink-fg-2 transition-colors duration-fast hover:text-ink-fg"
          onClick={() => void importAgent({ template: 'meeting_prep' })}
        >
          {t('agents.custom.meetingPrepTemplate')}
        </button>
      </div>
      {!calendarTriggerEnabled && (
        <span className="text-micro text-warn" data-team-import-calendar-warn>
          {t('agents.custom.calendarRequired')}
        </span>
      )}
      {notice !== null && (
        <span className="text-micro leading-relaxed text-warn" data-team-import-notice>
          {notice}
        </span>
      )}
    </div>
  )
}
