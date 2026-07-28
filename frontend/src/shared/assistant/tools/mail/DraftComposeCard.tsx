// prd 07-27 — DraftComposeCard (email_draft_compose / email_draft_update, edit tier).
//
// The rich approval card for the two draft writes that email_draft_reply's card cannot express:
// a new/forward draft needs a SUBJECT (a reply derives it) and an update needs to show what the
// change replaces. Both share one card because both review the same surface (subject + recipients
// + body, all editable before approval); `kind` picks the wording and the extra rows.
//
//   - compose: the proposed subject / to / cc / bcc / body, plus the forward source + whether the
//     original will be quoted.
//   - update: the SAME editable fields, prefilled from the model's patch where it proposed one and
//     from the draft's CURRENT values otherwise, with a before→after diff for whatever changes.
//     🔴 "before" is fetched LIVE from serve-api (GET /api/email/{id}) — never projected from the
//     model's args (CalendarApprovalCard / CustomAgentApprovalCard precedent), so a model lying
//     about the draft's current contents cannot change what the user reviews.
//
// On approve, only the fields the user actually changed are POSTed to the gateway resolve
// side-channel (postApprovalEdit) before the native approval, so an untouched field keeps its
// tool-side semantic (compose: the model's value; update: "backfill from the existing draft").
// Facts unavailable (draft gone / fetch error) → a warning line + the raw proposal; approve stays
// possible and the Python write authority re-validates.

import { useEffect, useState } from 'react'
import { FilePlus2, FilePenLine } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import { buildToolA2UIPayload, type DraftComposeCardProps } from '../a2ui'
import {
  ApprovalActions,
  CardFrame,
  TerminalBanner,
  deriveCardPhase,
  postApprovalEdit,
  toolErrorDetail
} from '../_cardShell'

// Resolve serve-api base URL for the "before" fetch (mirrors CalendarApprovalCard — intentionally
// duplicated rather than coupling a shared tool card to the settings module).
function resolveApiBaseUrl(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  if (env?.VITE_BUILD_TARGET === 'web') {
    return env.VITE_API_BASE_URL ?? '/api'
  }
  let port = 8200
  try {
    const raw = new URLSearchParams(window.location.search).get('apiPort')
    const n = raw != null ? Number.parseInt(raw, 10) : NaN
    if (Number.isFinite(n) && n > 0) port = n
  } catch {
    /* non-renderer test environment */
  }
  return `http://127.0.0.1:${port}/api`
}

/** The server-fact subset the update card renders (GET /api/email/{id} record). */
interface DraftFacts {
  subject: string
  to: string
  cc: string
  mailbox: string
}

async function fetchDraftFacts(internalId: number): Promise<DraftFacts | null> {
  const resp = await fetch(`${resolveApiBaseUrl()}/email/${internalId}`, {
    credentials: 'include'
  })
  if (resp.status === 404) return null
  if (!resp.ok) throw new Error(`E_HTTP_${resp.status}`)
  const body = (await resp.json()) as { status?: string; data?: Record<string, unknown> }
  if (body.status !== 'success' || !body.data) throw new Error('E_BAD_ENVELOPE')
  const d = body.data
  const s = (v: unknown): string => (typeof v === 'string' ? v : '')
  return { subject: s(d.subject), to: s(d.to_addr), cc: s(d.cc_addr), mailbox: s(d.mailbox) }
}

function propsOf(toolName: string, args: unknown, result: unknown): DraftComposeCardProps {
  const payload = buildToolA2UIPayload(toolName, { args, result })
  return (payload?.props ?? {
    kind: 'compose',
    to: [],
    cc: [],
    bcc: []
  }) as unknown as DraftComposeCardProps
}

/** Parse a recipients text field (comma / semicolon / newline separated) into a clean list. */
function parseRecipients(text: string): string[] {
  return text
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-baseline gap-2 text-aux">
      <span className="shrink-0 text-ink-fg-2">{label}</span>
      <span className="min-w-0 break-all text-ink-fg">{value}</span>
    </div>
  )
}

/** One editable field (single-line). */
function Field({
  label,
  value,
  placeholder,
  onChange
}: {
  label: string
  value: string
  placeholder?: string
  onChange: (v: string) => void
}): React.JSX.Element {
  return (
    <div>
      <div className="mb-0.5 text-meta font-medium text-ink-fg-2">{label}</div>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-ink-border-soft bg-ink-2 px-2.5 py-1.5 text-aux text-ink-fg outline-none placeholder:text-ink-fg-3 focus:border-coral/50"
        aria-label={label}
      />
    </div>
  )
}

export function DraftComposeCard(props: ToolCallMessagePartProps): React.JSX.Element {
  const { toolName, args, result, toolCallId, respondToApproval } = props
  const { t } = useTranslation()
  const phase = deriveCardPhase(props)
  const data = propsOf(toolName, args, result)
  const isUpdate = data.kind === 'update'
  const errorDetail = phase === 'error' ? toolErrorDetail(result) : null

  const [facts, setFacts] = useState<DraftFacts | null>(null)
  const [factsState, setFactsState] = useState<'idle' | 'loading' | 'ok' | 'missing' | 'error'>(
    isUpdate ? 'loading' : 'idle'
  )

  useEffect(() => {
    if (!isUpdate || phase !== 'pending' || data.internalId == null) return
    let cancelled = false
    fetchDraftFacts(data.internalId)
      .then((row) => {
        if (cancelled) return
        setFacts(row)
        setFactsState(row ? 'ok' : 'missing')
      })
      .catch(() => {
        if (!cancelled) setFactsState('error')
      })
    return () => {
      cancelled = true
    }
  }, [isUpdate, phase, data.internalId])

  // The baseline each field is prefilled from: the model's proposal where it made one, else (for
  // an update) the draft's live current value. Approve POSTs only the fields whose text differs
  // from this baseline, so an untouched field keeps its tool-side meaning ("keep the current
  // value") instead of being re-sent as an explicit override.
  const baseSubject = data.subject ?? (isUpdate ? (facts?.subject ?? '') : '')
  const baseTo = data.to.length > 0 ? data.to.join(', ') : isUpdate ? (facts?.to ?? '') : ''
  const baseCc = data.cc.length > 0 ? data.cc.join(', ') : isUpdate ? (facts?.cc ?? '') : ''
  const baseBcc = data.bcc.join(', ')
  const baseBody = data.bodyMarkdown ?? ''

  const [subject, setSubject] = useState(baseSubject)
  const [toText, setToText] = useState(baseTo)
  const [ccText, setCcText] = useState(baseCc)
  const [bccText, setBccText] = useState(baseBcc)
  const [body, setBody] = useState(baseBody)
  const [edited, setEdited] = useState(false)
  // The proposal streams in (input-streaming → input-available) and the update facts land async,
  // so keep the fields synced to the latest baseline until the user types (DraftReplyCard 先例:
  // a plain useState latches the empty first render and never catches up).
  const baselineKey = JSON.stringify([baseSubject, baseTo, baseCc, baseBcc, baseBody])
  const [prevBaselineKey, setPrevBaselineKey] = useState(baselineKey)
  if (!edited && prevBaselineKey !== baselineKey) {
    setPrevBaselineKey(baselineKey)
    setSubject(baseSubject)
    setToText(baseTo)
    setCcText(baseCc)
    setBccText(baseBcc)
    setBody(baseBody)
  }

  const onApprove = async (): Promise<void> => {
    const editedInput: Record<string, unknown> = {}
    if (subject !== baseSubject) editedInput.subject = subject
    if (body !== baseBody) editedInput.body_markdown = body
    if (toText !== baseTo) editedInput.to = parseRecipients(toText)
    if (ccText !== baseCc) editedInput.cc = parseRecipients(ccText)
    if (bccText !== baseBcc) editedInput.bcc = parseRecipients(bccText)
    if (Object.keys(editedInput).length > 0) {
      await postApprovalEdit(toolCallId, editedInput)
    }
    respondToApproval({ approved: true })
  }
  const onReject = (): void => respondToApproval({ approved: false })

  const title = t(
    isUpdate
      ? 'chat.draftComposeCard.update.title'
      : data.mode === 'forward'
        ? 'chat.draftComposeCard.forward.title'
        : 'chat.draftComposeCard.new.title'
  )
  const icon = isUpdate ? (
    <FilePenLine size={13} strokeWidth={2} />
  ) : (
    <FilePlus2 size={13} strokeWidth={2} />
  )

  // before→after: only the fields that actually change, and only when the live facts are known.
  const diffRows: Array<{ label: string; before: string; after: string }> = []
  if (isUpdate && facts) {
    if (subject !== facts.subject) {
      diffRows.push({
        label: t('chat.draftComposeCard.subject'),
        before: facts.subject,
        after: subject
      })
    }
    if (toText !== facts.to) {
      diffRows.push({ label: t('chat.draftComposeCard.to'), before: facts.to, after: toText })
    }
    if (ccText !== facts.cc) {
      diffRows.push({ label: t('chat.draftComposeCard.cc'), before: facts.cc, after: ccText })
    }
  }

  const summary = (
    <div className="space-y-1">
      {isUpdate ? (
        <Row
          label={t('chat.draftComposeCard.draft')}
          value={facts?.subject || `#${String(data.internalId ?? '?')}`}
        />
      ) : (
        <>
          {data.subject != null && data.subject.length > 0 && (
            <Row label={t('chat.draftComposeCard.subject')} value={data.subject} />
          )}
          {data.mode === 'forward' && data.internalId != null && (
            <Row
              label={t('chat.draftComposeCard.forwardOf')}
              value={t(
                data.quoteOriginal === false
                  ? 'chat.draftComposeCard.forwardSourceNoQuote'
                  : 'chat.draftComposeCard.forwardSource',
                { id: data.internalId }
              )}
            />
          )}
        </>
      )}
      {data.to.length > 0 && (
        <Row label={t('chat.draftComposeCard.to')} value={data.to.join('，')} />
      )}
      {data.cc.length > 0 && (
        <Row label={t('chat.draftComposeCard.cc')} value={data.cc.join('，')} />
      )}
      {data.bcc.length > 0 && (
        <Row label={t('chat.draftComposeCard.bcc')} value={data.bcc.join('，')} />
      )}
    </div>
  )

  return (
    <CardFrame icon={icon} title={title} phase={phase}>
      {phase === 'pending' ? (
        <div className="space-y-2">
          <div className="text-meta text-ink-fg-2">
            {t(
              isUpdate
                ? 'chat.draftComposeCard.update.hint'
                : data.mode === 'forward'
                  ? 'chat.draftComposeCard.forward.hint'
                  : 'chat.draftComposeCard.new.hint'
            )}
          </div>
          {isUpdate && (factsState === 'missing' || factsState === 'error') && (
            <div className="rounded-md border border-warn/30 bg-warn/10 px-2.5 py-1.5 text-meta text-warn">
              {t(
                factsState === 'missing'
                  ? 'chat.draftComposeCard.factsMissing'
                  : 'chat.draftComposeCard.factsError'
              )}
            </div>
          )}
          <Field
            label={t('chat.draftComposeCard.subject')}
            value={subject}
            placeholder={t(
              isUpdate
                ? 'chat.draftComposeCard.subjectKeepPlaceholder'
                : 'chat.draftComposeCard.subjectPlaceholder'
            )}
            onChange={(v) => {
              setEdited(true)
              setSubject(v)
            }}
          />
          <Field
            label={t('chat.draftComposeCard.to')}
            value={toText}
            onChange={(v) => {
              setEdited(true)
              setToText(v)
            }}
          />
          <Field
            label={t('chat.draftComposeCard.cc')}
            value={ccText}
            onChange={(v) => {
              setEdited(true)
              setCcText(v)
            }}
          />
          {(data.bcc.length > 0 || bccText.length > 0) && (
            <Field
              label={t('chat.draftComposeCard.bcc')}
              value={bccText}
              onChange={(v) => {
                setEdited(true)
                setBccText(v)
              }}
            />
          )}
          <textarea
            value={body}
            onChange={(e) => {
              setEdited(true)
              setBody(e.target.value)
            }}
            rows={6}
            placeholder={isUpdate ? t('chat.draftComposeCard.bodyKeepPlaceholder') : undefined}
            className="scrollbar-thin w-full resize-y rounded-lg border border-ink-border-soft bg-ink-2 px-2.5 py-2 text-aux leading-relaxed text-ink-fg outline-none focus:border-coral/50"
            aria-label={t('chat.draftComposeCard.bodyLabel')}
          />
          {diffRows.length > 0 && (
            <div className="space-y-1 rounded-md border border-ink-border-soft bg-ink-2 px-2.5 py-1.5">
              <div className="text-meta font-medium text-ink-fg-2">
                {t('chat.draftComposeCard.changes')}
              </div>
              {diffRows.map((r) => (
                <div key={r.label} className="text-meta text-ink-fg-1">
                  <span className="text-ink-fg-2">{r.label}</span>
                  {` ${r.before || t('chat.draftComposeCard.empty')} → `}
                  <span className="font-medium text-ink-fg">
                    {r.after || t('chat.draftComposeCard.empty')}
                  </span>
                </div>
              ))}
            </div>
          )}
          <ApprovalActions
            onApprove={onApprove}
            onReject={onReject}
            approveLabel={t(
              isUpdate
                ? 'chat.draftComposeCard.update.approve'
                : 'chat.draftComposeCard.new.approve'
            )}
          />
        </div>
      ) : phase === 'done' ? (
        <div className="space-y-1.5">
          <div className="text-aux text-ink-fg">
            {t(isUpdate ? 'chat.draftComposeCard.update.done' : 'chat.draftComposeCard.new.done')}
            {data.userEdited ? t('chat.draftComposeCard.withYourEdits') : ''}
          </div>
          {summary}
          <div className="text-meta text-ink-fg-2">
            {data.draftsFolder
              ? t('chat.draftComposeCard.folder', { folder: data.draftsFolder })
              : t('chat.draftComposeCard.savedToDrafts')}
          </div>
          {isUpdate && data.oldDraftDeleted === false && (
            <div className="rounded-md border border-warn/30 bg-warn/10 px-2.5 py-1.5 text-meta text-warn">
              {t('chat.draftComposeCard.oldDraftKept')}
            </div>
          )}
          {data.bodyMarkdown != null && data.bodyMarkdown.length > 0 && (
            <pre className="scrollbar-thin mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-ink-border-soft bg-ink-2 px-2.5 py-2 text-meta leading-relaxed text-ink-fg-1">
              {data.bodyMarkdown}
            </pre>
          )}
        </div>
      ) : phase === 'error' ? (
        // issue #70 — the generic sentence alone left the user (and anyone reading the thread
        // later) with no idea WHY; the part already carries the reason, so show it.
        <div className="space-y-1">
          <div className="text-aux text-fail">{t('chat.draftComposeCard.error')}</div>
          {errorDetail != null && (
            <div className="break-words font-mono text-meta text-ink-fg-2">{errorDetail}</div>
          )}
        </div>
      ) : (
        <>
          {summary}
          <TerminalBanner phase={phase} />
        </>
      )}
    </CardFrame>
  )
}
