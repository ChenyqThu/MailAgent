// S2 W4 — SkillInstallCard (skill_install, edit tier + capability_change).
//
// Stage ONE of the two-step install (ADR-002 §4): the user approves "go download / import this
// package into QUARANTINE". Nothing is installed by this step — the card says so explicitly, and
// the real "install these exact files" decision happens on the SkillInstallConfirmCard (which
// renders server-verified quarantine facts). The source (url / local path) is user-editable at
// approval time (editableFields), so what is shown here is the exact source that will be fetched.

import { PackageSearch } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import { buildToolA2UIPayload, type SkillInstallCardProps } from '../a2ui'
import { ApprovalActions, CardFrame, TerminalBanner } from '../_cardShell'
import { deriveCardPhase } from '../_cardShell.lib'

function propsOf(toolName: string, args: unknown, result: unknown): SkillInstallCardProps {
  const payload = buildToolA2UIPayload(toolName, { args, result })
  return (payload?.props ?? {}) as unknown as SkillInstallCardProps
}

export function SkillInstallCard(props: ToolCallMessagePartProps): React.JSX.Element {
  const { toolName, args, result, respondToApproval } = props
  const { t } = useTranslation()
  const phase = deriveCardPhase(props)
  const data = propsOf(toolName, args, result)
  const source = data.sourceUrl ?? data.localPath ?? t('chat.skillInstallCard.unspecifiedSource')

  return (
    <CardFrame
      icon={<PackageSearch size={13} strokeWidth={2} />}
      title={t('chat.skillInstallCard.title')}
      phase={phase}
    >
      {phase === 'pending' ? (
        <>
          <div className="text-aux text-ink-fg-2">
            {data.sourceUrl
              ? t('chat.skillInstallCard.fromUrl')
              : t('chat.skillInstallCard.fromLocal')}
          </div>
          <div className="mt-1 break-all font-mono text-meta text-ink-fg">{source}</div>
          <div className="mt-2 rounded-md border border-ink-border-soft bg-ink-2/60 px-2.5 py-2 text-aux text-ink-fg-3">
            {t('chat.skillInstallCard.quarantineNote1')}
            <span className="text-ink-fg-2">
              {t('chat.skillInstallCard.quarantineNoteEmphasis')}
            </span>
            {t('chat.skillInstallCard.quarantineNote2')}
          </div>
          <ApprovalActions
            onApprove={() => respondToApproval({ approved: true })}
            onReject={() => respondToApproval({ approved: false })}
            approveLabel={t('chat.skillInstallCard.approve')}
          />
        </>
      ) : phase === 'done' ? (
        <>
          <div className="break-all font-mono text-meta text-ink-fg">{source}</div>
          <div className="mt-0.5 text-aux text-ink-fg-2">
            {data.quarantineId
              ? typeof data.fileCount === 'number'
                ? t('chat.skillInstallCard.quarantinedWithFiles', {
                    id: data.quarantineId,
                    count: data.fileCount
                  })
                : t('chat.skillInstallCard.quarantined', { id: data.quarantineId })
              : t('chat.skillInstallCard.verified')}
          </div>
        </>
      ) : phase === 'error' ? (
        <div className="text-aux text-fail">{t('chat.skillInstallCard.error')}</div>
      ) : (
        <>
          <div className="break-all font-mono text-meta text-ink-fg">{source}</div>
          <TerminalBanner phase={phase} />
        </>
      )}
    </CardFrame>
  )
}
