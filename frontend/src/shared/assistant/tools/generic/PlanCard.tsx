import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import { Ban, CheckCircle2, Circle, CircleDashed, OctagonX } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { PlanStepStatus, PlanUpdateValue } from '../../plan'

const STATUS_STYLES: Record<PlanStepStatus, string> = {
  pending: 'border-ink-border-soft bg-ink-2 text-ink-fg-3',
  in_progress: 'border-accent/30 bg-accent/10 text-accent',
  done: 'border-success/30 bg-success/10 text-success',
  blocked: 'border-danger/30 bg-danger/10 text-danger',
  unavailable: 'border-warn/30 bg-warn/10 text-warn'
}

const STATUSES = new Set<PlanStepStatus>([
  'pending',
  'in_progress',
  'done',
  'blocked',
  'unavailable'
])

function iconFor(status: PlanStepStatus): React.ReactNode {
  if (status === 'done') return <CheckCircle2 size={14} />
  if (status === 'in_progress') return <CircleDashed size={14} />
  if (status === 'blocked') return <OctagonX size={14} />
  if (status === 'unavailable') return <Ban size={14} />
  return <Circle size={14} />
}

function asPlan(value: unknown): PlanUpdateValue | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.goal !== 'string' || !Array.isArray(record.steps)) return null
  const steps: PlanUpdateValue['steps'] = []
  for (const candidate of record.steps) {
    if (candidate == null || typeof candidate !== 'object' || Array.isArray(candidate)) return null
    const step = candidate as Record<string, unknown>
    if (
      typeof step.id !== 'string' ||
      typeof step.title !== 'string' ||
      typeof step.status !== 'string' ||
      !STATUSES.has(step.status as PlanStepStatus)
    ) {
      return null
    }
    steps.push({
      id: step.id,
      title: step.title,
      status: step.status as PlanStepStatus,
      ...(typeof step.note === 'string' && step.note ? { note: step.note } : {})
    })
  }
  return { goal: record.goal, steps }
}

/** Read-only plan artifact. Updates happen only through later plan_update tool parts. */
export function PlanCard({ args, result }: ToolCallMessagePartProps): React.JSX.Element {
  const { t } = useTranslation()
  const plan = asPlan(result) ?? asPlan(args)

  if (plan === null) {
    return (
      <section className="my-1.5 rounded-lg border border-ink-border-soft bg-ink-2 px-3 py-2.5">
        <p className="text-aux font-medium text-ink-fg">{t('chat.planCard.title')}</p>
        <p className="mt-1 text-meta text-ink-fg-3">{t('chat.planCard.invalid')}</p>
      </section>
    )
  }

  return (
    <section
      className="my-1.5 rounded-lg border border-ink-border-soft bg-ink-2 px-3 py-2.5"
      aria-label={t('chat.planCard.title')}
    >
      <p className="text-micro font-medium uppercase tracking-wide text-ink-fg-3">
        {t('chat.planCard.title')}
      </p>
      <h4 className="mt-1 text-sm font-semibold text-ink-fg">{plan.goal}</h4>
      <ol className="mt-2.5 space-y-2">
        {plan.steps.map((step) => (
          <li key={step.id} className="flex min-w-0 items-start gap-2">
            <span
              className={`mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-micro ${STATUS_STYLES[step.status]}`}
              aria-label={t(`chat.planCard.status.${step.status}`)}
            >
              {iconFor(step.status)}
              {t(`chat.planCard.status.${step.status}`)}
            </span>
            <div className="min-w-0">
              <p className="text-aux font-medium text-ink-fg">{step.title}</p>
              {step.note ? <p className="mt-0.5 text-meta text-ink-fg-3">{step.note}</p> : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}
