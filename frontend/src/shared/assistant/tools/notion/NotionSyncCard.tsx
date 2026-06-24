// chat-panel P4 Phase 04a — NotionSyncCard (email_resync, preview tier).
//
// The rich card for re-pushing an email to Notion from the SQLite SSoT. preview tier =
// approve / reject only (no editable fields). While pending it shows the target email + a
// short explanation; once it runs it shows the old → new Notion page id and the action taken
// (created / updated). Renders from the SHARED a2ui mapper so card + audit can't diverge.

import { RefreshCw } from 'lucide-react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import { buildToolA2UIPayload, type NotionSyncCardProps } from '../a2ui'
import { ApprovalActions, CardFrame, TerminalBanner, deriveCardPhase } from '../_cardShell'

function propsOf(args: unknown, result: unknown): NotionSyncCardProps {
  const payload = buildToolA2UIPayload('email_resync', { args, result })
  return (payload?.props ?? { internalId: -1 }) as unknown as NotionSyncCardProps
}

export function NotionSyncCard(props: ToolCallMessagePartProps): React.JSX.Element {
  const { args, result, respondToApproval } = props
  const phase = deriveCardPhase(props)
  const data = propsOf(args, result)

  return (
    <CardFrame icon={<RefreshCw size={13} strokeWidth={2} />} title="同步到 Notion" phase={phase}>
      {phase === 'pending' ? (
        <>
          <div className="text-aux text-ink-fg">{`重新把邮件 #${data.internalId} 推送到 Notion`}</div>
          <div className="mt-1 text-meta text-ink-fg-2">
            从本地 SQLite SSoT 重建该邮件的 Notion 页面（幂等，可安全重复）。
          </div>
          <ApprovalActions
            onApprove={() => respondToApproval({ approved: true })}
            onReject={() => respondToApproval({ approved: false })}
            approveLabel="重新同步"
          />
        </>
      ) : phase === 'done' ? (
        <div className="space-y-1">
          <div className="text-aux text-ink-fg">
            {data.action === 'recreated'
              ? '已重建 Notion 页面。'
              : data.action === 'updated'
                ? '已更新 Notion 页面。'
                : 'Notion 页面已同步。'}
          </div>
          <PageMapping oldId={data.oldPageId} newId={data.newPageId} />
        </div>
      ) : phase === 'error' ? (
        <div className="text-aux text-fail">同步失败，请重试或让助手重新发起。</div>
      ) : (
        <>
          <div className="text-aux text-ink-fg">{`邮件 #${data.internalId}`}</div>
          <TerminalBanner phase={phase} />
        </>
      )}
    </CardFrame>
  )
}

function PageMapping({
  oldId,
  newId
}: {
  oldId?: string | null
  newId?: string | null
}): React.JSX.Element | null {
  if (!oldId && !newId) return null
  return (
    <div className="text-meta font-mono text-ink-fg-2">
      {oldId ? `旧页面 ${oldId.slice(0, 8)}…` : '（无旧页面）'}
      {' → '}
      {newId ? `新页面 ${newId.slice(0, 8)}…` : '（无）'}
    </div>
  )
}
