// S2 W4 — SkillInstallCard (skill_install, edit tier + capability_change).
//
// Stage ONE of the two-step install (ADR-002 §4): the user approves "go download / import this
// package into QUARANTINE". Nothing is installed by this step — the card says so explicitly, and
// the real "install these exact files" decision happens on the SkillInstallConfirmCard (which
// renders server-verified quarantine facts). The source (url / local path) is user-editable at
// approval time (editableFields), so what is shown here is the exact source that will be fetched.

import { PackageSearch } from 'lucide-react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import { buildToolA2UIPayload, type SkillInstallCardProps } from '../a2ui'
import { ApprovalActions, CardFrame, TerminalBanner, deriveCardPhase } from '../_cardShell'

function propsOf(toolName: string, args: unknown, result: unknown): SkillInstallCardProps {
  const payload = buildToolA2UIPayload(toolName, { args, result })
  return (payload?.props ?? {}) as unknown as SkillInstallCardProps
}

export function SkillInstallCard(props: ToolCallMessagePartProps): React.JSX.Element {
  const { toolName, args, result, respondToApproval } = props
  const phase = deriveCardPhase(props)
  const data = propsOf(toolName, args, result)
  const source = data.sourceUrl ?? data.localPath ?? '(未指定来源)'

  return (
    <CardFrame icon={<PackageSearch size={13} strokeWidth={2} />} title="下载 Skill 包（第一步）" phase={phase}>
      {phase === 'pending' ? (
        <>
          <div className="text-aux text-ink-fg-2">
            {data.sourceUrl ? '将从以下地址下载 skill 包：' : '将导入以下本地 skill 包：'}
          </div>
          <div className="mt-1 break-all font-mono text-meta text-ink-fg">{source}</div>
          <div className="mt-2 rounded-md border border-ink-border-soft bg-ink-2/60 px-2.5 py-2 text-aux text-ink-fg-3">
            本步只把包下载到隔离区做校验（hash / 清单 / 声明的密钥），<span className="text-ink-fg-2">不会安装</span>。
            校验结果会在下一步的确认卡上展示，由你再次确认后才真正安装。
          </div>
          <ApprovalActions
            onApprove={() => respondToApproval({ approved: true })}
            onReject={() => respondToApproval({ approved: false })}
            approveLabel="允许下载"
          />
        </>
      ) : phase === 'done' ? (
        <>
          <div className="break-all font-mono text-meta text-ink-fg">{source}</div>
          <div className="mt-0.5 text-aux text-ink-fg-2">
            {data.quarantineId
              ? `已入隔离区 ${data.quarantineId}${typeof data.fileCount === 'number' ? `（${data.fileCount} 个文件）` : ''}，等待第二步确认安装。`
              : '已完成下载校验，等待第二步确认安装。'}
          </div>
        </>
      ) : phase === 'error' ? (
        <div className="text-aux text-fail">下载/校验失败（来源不可达、包非法或超限），未产生任何安装。</div>
      ) : (
        <>
          <div className="break-all font-mono text-meta text-ink-fg">{source}</div>
          <TerminalBanner phase={phase} />
        </>
      )}
    </CardFrame>
  )
}
