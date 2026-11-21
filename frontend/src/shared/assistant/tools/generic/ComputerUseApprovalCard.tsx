// Wave 4 (Computer Use MCP Epic §5.4) — ComputerUseApprovalCard (`computer_use_run`).
//
// 任务级 HITL 审批卡：展示操作目标（goal）、目标面（auto/browser/desktop）、限定应用/域名范围
// （allowed_apps / allowed_domains）、提交前停靠开关（stop_before_submit），以及「画面像素不经
// 文本脱敏中间件自动遮罩」的诚实隐私提醒。暂停态走 assistant-ui 原生 `respondToApproval`（通
// 道 A），绝不落入无按钮 ToolTraceCard 死锁。

import { useState } from 'react'
import { Monitor, ShieldAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import { buildToolA2UIPayload, type ComputerUseApprovalCardProps } from '../a2ui'
import {
  ApprovalActions,
  CardDetails,
  CardFrame,
  CardParams,
  TerminalBanner,
  type CardParam
} from '../_cardShell'
import { deriveCardPhase } from '../_cardShell.lib'
import { resolveAiGatewayBaseUrl } from '../../runtime/flags'

async function postRememberComputerUsePolicy(toolCallId: string): Promise<void> {
  const base = resolveAiGatewayBaseUrl()
  if (base == null) throw new Error('E_NO_GATEWAY')
  const res = await fetch(`${base}/api/ai/policy/remember`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ toolCallId })
  })
  if (!res.ok) {
    let code = `E_HTTP_${res.status}`
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error) code = body.error
    } catch {
      /* non-JSON error body */
    }
    throw new Error(code)
  }
}

function resolveEffectiveArgs(args: unknown, argsText: string | undefined): unknown {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    if (Object.keys(args as Record<string, unknown>).length > 0) return args
  }
  if (argsText) {
    try {
      const parsed = JSON.parse(argsText) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      /* 流式尚未闭合时退回空对象 */
    }
  }
  return args ?? {}
}

function propsOf(
  args: unknown,
  argsText: string | undefined,
  result: unknown
): ComputerUseApprovalCardProps {
  const effectiveArgs = resolveEffectiveArgs(args, argsText)
  const payload = buildToolA2UIPayload('computer_use_run', {
    args: effectiveArgs,
    result
  })
  return (payload?.props ?? {
    goal: '',
    targetHint: 'auto',
    allowedApps: [],
    allowedDomains: [],
    stopBeforeSubmit: true
  }) as unknown as ComputerUseApprovalCardProps
}

const KNOWN_RESULT_STATUSES = new Set([
  'awaiting_confirmation',
  'scope_violation',
  'completed'
])

export function ComputerUseApprovalCard(props: ToolCallMessagePartProps): React.JSX.Element {
  const { args, argsText, result, toolCallId, respondToApproval } = props
  const { t } = useTranslation()
  const phase = deriveCardPhase(props)
  const data = propsOf(args, argsText, result)
  const [alwaysAllow, setAlwaysAllow] = useState(false)
  const canRemember =
    data.stopBeforeSubmit && (data.allowedApps.length > 0 || data.allowedDomains.length > 0)

  const onApprove = async (): Promise<void> => {
    if (canRemember && alwaysAllow && toolCallId) {
      try {
        await postRememberComputerUsePolicy(toolCallId)
      } catch {
        /* best-effort whitelist rule persistence */
      }
    }
    await respondToApproval({ approved: true })
  }
  const onReject = (reason?: string): Promise<void> =>
    respondToApproval({ approved: false, reason })

  const reviewItems: CardParam[] = [
    {
      id: 'goal',
      label: t('chat.computerUseCard.goal'),
      value: data.goal.trim().length > 0 ? data.goal : t('chat.computerUseCard.emptyGoal'),
      accent: true
    },
    {
      id: 'target',
      label: t('chat.computerUseCard.target'),
      value: t(`chat.computerUseCard.targetValue.${data.targetHint}`)
    }
  ]

  if (data.allowedApps.length > 0) {
    reviewItems.push({
      id: 'allowedApps',
      label: t('chat.computerUseCard.allowedApps'),
      value: data.allowedApps.join(', ')
    })
  }
  if (data.allowedDomains.length > 0) {
    reviewItems.push({
      id: 'allowedDomains',
      label: t('chat.computerUseCard.allowedDomains'),
      value: data.allowedDomains.join(', ')
    })
  }
  if (data.allowedApps.length === 0 && data.allowedDomains.length === 0) {
    reviewItems.push({
      id: 'scope',
      label: t('chat.computerUseCard.allowedDomains'),
      value: (
        <span className="text-aux text-warn">{t('chat.computerUseCard.unboundedScope')}</span>
      )
    })
  }

  reviewItems.push({
    id: 'stopBeforeSubmit',
    label: t('chat.computerUseCard.stopBeforeSubmit'),
    value: data.stopBeforeSubmit ? (
      <span className="text-aux text-ok">{t('chat.computerUseCard.stopBeforeSubmitOn')}</span>
    ) : (
      <span className="text-aux font-medium text-warn">
        {t('chat.computerUseCard.stopBeforeSubmitOff')}
      </span>
    )
  })

  if (typeof data.maxSteps === 'number') {
    reviewItems.push({
      id: 'maxSteps',
      label: t('chat.computerUseCard.maxSteps'),
      value: t('chat.computerUseCard.maxStepsValue', { count: data.maxSteps })
    })
  }

  const outcomeItems: CardParam[] = []
  if (phase === 'done' && data.resultStatus) {
    const statusText = KNOWN_RESULT_STATUSES.has(data.resultStatus)
      ? t(`chat.computerUseCard.resultStatus.${data.resultStatus}`)
      : data.resultStatus
    outcomeItems.push({
      id: 'resultStatus',
      label: t('chat.computerUseCard.statusLabel'),
      value: (
        <span
          className={
            data.resultStatus === 'scope_violation'
              ? 'text-aux font-medium text-fail'
              : data.resultStatus === 'awaiting_confirmation'
                ? 'text-aux font-medium text-warn'
                : 'text-aux font-medium text-ok'
          }
        >
          {statusText}
        </span>
      )
    })
  }
  if (phase === 'done' && data.currentUrlOrApp) {
    outcomeItems.push({
      id: 'currentTarget',
      label: t('chat.computerUseCard.currentTarget'),
      value: data.currentUrlOrApp
    })
  }
  if (phase === 'done' && data.pendingAction) {
    outcomeItems.push({
      id: 'pendingAction',
      label: t('chat.computerUseCard.pendingAction'),
      value: data.pendingAction,
      accent: true
    })
  }
  if (phase === 'done' && (data.filledFields?.length ?? 0) > 0) {
    outcomeItems.push({
      id: 'filledFields',
      label: t('chat.computerUseCard.filledFields'),
      value: data.filledFields!.join(', ')
    })
  }

  return (
    <CardFrame
      icon={<Monitor size={13} strokeWidth={2} />}
      title={t('chat.computerUseCard.title')}
      phase={phase}
    >
      {phase === 'error' ? (
        <div className="text-aux text-fail">{t('chat.computerUseCard.error')}</div>
      ) : (
        <>
          {outcomeItems.length > 0 ? <CardParams items={outcomeItems} className="mb-1.5" /> : null}
          <CardDetails>
            <CardParams items={reviewItems} className="mt-1" />
          </CardDetails>
        </>
      )}
      {phase === 'pending' || phase === 'authorized' ? (
        <div className="mt-2 flex items-start gap-2 rounded-md border border-warn/30 bg-warn/[0.06] px-2.5 py-2">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="text-aux font-medium text-ink-fg">
              {t('chat.computerUseCard.pixelPrivacyTitle')}
            </div>
            <p className="mt-0.5 text-aux leading-relaxed text-ink-fg-2">
              {t('chat.computerUseCard.pixelPrivacyBody')}
            </p>
          </div>
        </div>
      ) : null}
      {phase === 'pending' && canRemember ? (
        <div className="mt-2 rounded-md border border-ink-border-soft bg-ink-2/60 px-2.5 py-2">
          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              checked={alwaysAllow}
              onChange={(e) => setAlwaysAllow(e.target.checked)}
              className="mt-0.5 size-3.5 shrink-0 accent-[rgb(var(--c-accent))]"
            />
            <span className="text-aux text-ink-fg-2">
              {t('chat.computerUseCard.alwaysAllowLabel')}
              <span className="mt-0.5 block text-ink-fg-3">
                {t('chat.computerUseCard.alwaysAllowHint')}
              </span>
            </span>
          </label>
        </div>
      ) : null}
      <ApprovalActions
        onApprove={onApprove}
        onReject={onReject}
        approveLabel={t('chat.computerUseCard.approve')}
        rejectReason
      />
      {phase === 'rejected' || phase === 'expired' ? <TerminalBanner phase={phase} /> : null}
    </CardFrame>
  )
}
