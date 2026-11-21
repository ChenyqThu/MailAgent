import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import { AlertTriangle, Code2, Eye } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { artifactWorkspaceId } from '../../inspector/deriveSessionWorkspace'
import { useSessionInspector } from '../../inspector/inspectorContext'
import { ApprovalActions, CardDetails, CardFrame, TerminalBanner } from '../_cardShell'
import { deriveCardPhase, toolErrorDetail } from '../_cardShell.lib'
import { readArtifactWriteInput, readArtifactWriteOutput } from './artifactWriteCard.lib'

export function ArtifactWriteCard(props: ToolCallMessagePartProps): React.JSX.Element {
  const { toolCallId, args, argsText, result, respondToApproval } = props
  const { t } = useTranslation()
  const inspector = useSessionInspector()
  const phase = deriveCardPhase(props)
  const input = readArtifactWriteInput(args, argsText)
  const output = phase === 'done' ? readArtifactWriteOutput(result) : null
  const lintFailed = phase === 'done' && output?.ok === false
  const framePhase = lintFailed ? 'error' : phase

  const displayTitle = output?.title ?? input.title ?? t('chat.artifactWriteCard.title')
  const displayType = output?.artifactType ?? input.artifactType
  const displaySlug = output?.slug ?? input.slug
  const displayPath = output?.path
  const displayVersion = output?.version
  const errorDetail = phase === 'error' ? toolErrorDetail(result) : null

  const onApprove = (): Promise<void> => respondToApproval({ approved: true })
  const onReject = (reason?: string): Promise<void> =>
    respondToApproval({ approved: false, reason })

  const handleOpenPreview = (): void => {
    if (!inspector) return
    inspector.openArtifactPreview(artifactWorkspaceId(displaySlug, toolCallId))
  }

  return (
    <CardFrame
      icon={<Code2 size={13} strokeWidth={2} />}
      title={displayTitle}
      phase={framePhase}
    >
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          {displayType ? (
            <span className="rounded bg-ink-3 px-2 py-0.5 text-aux text-ink-fg-1">
              {t(`chat.inspector.artifactTypes.${displayType}`)}
            </span>
          ) : null}
          {displayVersion !== null && displayVersion !== undefined ? (
            <span className="rounded bg-ink-3 px-1.5 py-0.5 font-mono text-meta tabular-nums text-ink-fg-2">
              v{displayVersion}
            </span>
          ) : null}
          {displaySlug ? (
            <span className="truncate font-mono text-meta text-ink-fg-3">{displaySlug}</span>
          ) : null}
        </div>

        {displayPath ? (
          <div className="flex min-w-0 items-baseline gap-1.5">
            <span className="shrink-0 text-aux text-ink-fg-3">
              {t('chat.artifactWriteCard.pathLabel')}
            </span>
            <span className="min-w-0 break-all font-mono text-meta text-ink-fg-2">
              {displayPath}
            </span>
          </div>
        ) : null}

        {input.changeNote ? (
          <div className="text-aux text-ink-fg-2">{input.changeNote}</div>
        ) : null}

        {lintFailed && output && output.issues.length > 0 ? (
          <div className="mt-1 rounded-md border border-fail/30 bg-fail/10 px-2.5 py-2">
            <div className="flex items-center gap-1.5 text-aux font-medium text-fail">
              <AlertTriangle size={13} strokeWidth={2} />
              <span>{t('chat.artifactWriteCard.lintTitle')}</span>
            </div>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-aux text-ink-fg-1">
              {output.issues.map((issue, idx) => (
                <li key={idx}>{issue}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {!lintFailed && output && output.warnings.length > 0 ? (
          <div className="mt-1 rounded-md border border-warn/30 bg-warn/10 px-2.5 py-2">
            <div className="text-aux font-medium text-warn">
              {t('chat.artifactWriteCard.warningsTitle')}
            </div>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-aux text-ink-fg-2">
              {output.warnings.map((warn, idx) => (
                <li key={idx}>{warn}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {phase === 'error' && errorDetail ? (
          <div className="text-aux text-fail">{errorDetail}</div>
        ) : null}

        {phase === 'pending' && input.html ? (
          <CardDetails label={t('chat.artifactWriteCard.htmlSourceLabel')}>
            <pre className="scrollbar-thin mt-1 max-h-60 overflow-auto rounded-md border border-ink-border-soft bg-ink-2 px-2.5 py-2 font-mono text-meta text-ink-fg">
              {input.html}
            </pre>
          </CardDetails>
        ) : null}

        {phase === 'done' && !lintFailed && inspector !== null ? (
          <div className="pt-1">
            <button
              type="button"
              onClick={handleOpenPreview}
              aria-label={t('chat.artifactWriteCard.openPreview')}
              className="inline-flex items-center gap-1.5 rounded-md border border-ink-border-soft bg-ink-2 px-2.5 py-1 text-aux font-medium text-ink-fg transition-colors duration-fast hover:bg-ink-3"
            >
              <Eye size={13} strokeWidth={2} className="text-coral" />
              <span>{t('chat.artifactWriteCard.preview')}</span>
            </button>
          </div>
        ) : null}

        <ApprovalActions onApprove={onApprove} onReject={onReject} rejectReason />
        {phase === 'rejected' || phase === 'expired' ? <TerminalBanner phase={phase} /> : null}
      </div>
    </CardFrame>
  )
}
