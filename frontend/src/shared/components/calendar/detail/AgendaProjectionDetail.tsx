// task 08-27 P4d —— 投影条目（matter / agent）的详情形态分流。
//
// mail 形态留在 EventDetailDrawer 里（它带着 RSVP / 删除撤销 / 关联邮件那一串 mutation，
// 拆出来会让 Layout 单挂的那份 hook 状态跟着组件卸载）。这里只接投影两源。

import type { AgendaEntry } from '@shared/api/types'

import { AgentEntryDetail } from './AgentEntryDetail'
import { MatterEntryDetail } from './MatterEntryDetail'

export function AgendaProjectionDetail({
  entry,
  onClose
}: {
  entry: AgendaEntry
  onClose: () => void
}): React.ReactElement {
  return entry.source === 'agent' ? (
    <AgentEntryDetail entry={entry} onClose={onClose} />
  ) : (
    <MatterEntryDetail entry={entry} onClose={onClose} />
  )
}
