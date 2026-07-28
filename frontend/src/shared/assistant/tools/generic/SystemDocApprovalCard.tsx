// M4b — SystemDocApprovalCard (update_system_md).
//
// Approve/reject card for the agent proposing an edit to one of its own Standing Context documents
// (soul / agent / rules / user). Uses the same CardFrame + ApprovalActions pattern (from _cardShell)
// so the edit gets a proper in-conversation approve/reject affordance instead of
// the generic ToolTraceCard. soul/rules (identity + hard constraints) get the high-risk red
// treatment + the safety-floor note; jailbreak / override phrasing in `rules` is rejected
// server-side (validate_rules_content) → the card then shows the error phase. The FULL new content
// rides the editable approval input; the card shows a bounded preview.

import { CheckCircle2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import { buildToolA2UIPayload, type SystemDocApprovalCardProps } from '../a2ui'
import {
  ApprovalActions,
  ApprovalIcon,
  CardFrame,
  TerminalBanner,
  deriveCardPhase
} from '../_cardShell'

// doc name → i18n key suffix (labels live under chat.systemDocApprovalCard.doc.<key>).
//
// 🔴 The key set is pinned to `updateSystemMdSchema.doc_name` (ai-gateway/tools/schemas.ts) —
// this card renders for update_system_md ONLY (a2ui.ts componentForTool), so those four
// values are exactly what docName can be. `memory` is deliberately absent: memory.md is NOT
// an update_system_md target (identity boundary, tools/profile.ts:18 — it is written by
// agent_memory_update / auto-capture instead), so a memory label here would be dead code that
// misrepresents the tool surface. Settings' StandingDocsSection lists 5 docs because it is the
// *editor* for all of them; the two key sets differ on purpose. Adding a doc to the zod enum
// must add it here too (plus the zh/en strings) — SystemDocApprovalCard.test.tsx renders every
// enum value and fails if any of them falls back to the raw doc name.
const DOC_LABEL_KEYS: Record<string, string> = {
  soul: 'soul',
  agent: 'agent',
  rules: 'rules',
  user: 'user'
}

function propsOf(toolName: string, args: unknown, result: unknown): SystemDocApprovalCardProps {
  const payload = buildToolA2UIPayload(toolName, { args, result })
  return (payload?.props ?? {
    docName: '',
    highRisk: false,
    contentPreview: '',
    contentLength: 0
  }) as unknown as SystemDocApprovalCardProps
}

export function SystemDocApprovalCard(props: ToolCallMessagePartProps): React.JSX.Element {
  const { toolName, args, result, respondToApproval } = props
  const { t } = useTranslation()
  const phase = deriveCardPhase(props)
  const data = propsOf(toolName, args, result)
  const label = DOC_LABEL_KEYS[data.docName]
    ? t(`chat.systemDocApprovalCard.doc.${DOC_LABEL_KEYS[data.docName]}`)
    : data.docName
  const title = data.highRisk
    ? t('chat.systemDocApprovalCard.titleHighRisk')
    : t('chat.systemDocApprovalCard.title')

  return (
    <CardFrame icon={<ApprovalIcon />} title={title} phase={phase}>
      {phase === 'pending' ? (
        <>
          <div className="text-aux text-ink-fg">
            {t('chat.systemDocApprovalCard.lead', { label })}
          </div>
          {data.highRisk && (
            <div className="mt-1 rounded-md border border-fail/30 bg-fail/10 px-2.5 py-1.5 text-meta text-fail">
              {t('chat.systemDocApprovalCard.highRiskWarn')}
            </div>
          )}
          {data.contentPreview && (
            <div className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-aux text-ink-fg-2">
              {data.contentPreview}
            </div>
          )}
          <div className="mt-0.5 text-meta text-ink-fg-2">
            {t('chat.systemDocApprovalCard.lengthNote', { count: data.contentLength })}
          </div>
          <ApprovalActions
            onApprove={() => respondToApproval({ approved: true })}
            onReject={() => respondToApproval({ approved: false })}
          />
        </>
      ) : phase === 'done' ? (
        <div className="flex items-center gap-1.5 text-aux text-ink-fg">
          <CheckCircle2 size={13} strokeWidth={2} className="shrink-0 text-ok" />
          <span>{t('chat.systemDocApprovalCard.done', { label })}</span>
        </div>
      ) : phase === 'error' ? (
        <div className="text-aux text-fail">{t('chat.systemDocApprovalCard.error')}</div>
      ) : (
        <>
          <div className="text-aux text-ink-fg">
            {t('chat.systemDocApprovalCard.summary', { label })}
          </div>
          <TerminalBanner phase={phase} />
        </>
      )}
    </CardFrame>
  )
}
