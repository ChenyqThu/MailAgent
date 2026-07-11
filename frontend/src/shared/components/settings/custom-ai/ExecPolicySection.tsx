// S2 W1 — 自动化策略 (exec whitelist rules) subsection

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Loader2, X } from 'lucide-react'

import { useMailApi } from '@shared/hooks/useMailApi'
import { toastError, toastSuccess } from '@shared/state/toast'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { Switch } from '@shared/components/ui/switch'
import { Button } from '@shared/components/ui/button'

import { Section } from '../parts/Section'
import { fetchExecPolicyEnabled } from './shared'

/** Human-readable one-line summary of a structured matcher (read-only display; the model can't
 *  create rules, and narrowing = delete + recreate — so no editable form here). */
function formatMatcher(capability: string, matcher: Record<string, unknown>, t: TFunction): string {
  if (capability === 'exec') {
    const argv0 = typeof matcher.argv0_realpath === 'string' ? matcher.argv0_realpath : '?'
    const tmpl = Array.isArray(matcher.argv_template) ? matcher.argv_template : []
    const args = tmpl
      .map((it) => {
        const o = it as { pin?: unknown; any?: unknown }
        return o?.any === true
          ? t('settings.execPolicy.matcher.any')
          : typeof o?.pin === 'string'
            ? o.pin
            : '?'
      })
      .join(' ')
    const cwd =
      typeof matcher.cwd_scope === 'string'
        ? t('settings.execPolicy.matcher.dir', { scope: matcher.cwd_scope })
        : ''
    return `${argv0}${args ? ' ' + args : ''}${cwd}`
  }
  if (capability === 'file_read' || capability === 'file_write') {
    return typeof matcher.realpath_prefix === 'string' ? matcher.realpath_prefix : '?'
  }
  if (capability === 'web') {
    return typeof matcher.origin === 'string' ? matcher.origin : '?'
  }
  return JSON.stringify(matcher)
}

const CAPABILITY_LABEL_KEYS: Record<string, string> = {
  exec: 'settings.execPolicy.capability.exec',
  file_read: 'settings.execPolicy.capability.file_read',
  file_write: 'settings.execPolicy.capability.file_write',
  web: 'settings.execPolicy.capability.web'
}

/** The 自动化策略 management page: list / enable-disable / delete the exec whitelist rules the owner
 *  created via the approval card's "总是允许". Self-gates on execPolicyEnabled (default OFF → null). */
export function ExecPolicySection(): React.ReactElement | null {
  const { t } = useTranslation()
  const api = useMailApi()
  const qc = useQueryClient()

  const { data: enabled } = useQuery<boolean>({
    queryKey: qk.chat.config('execPolicyEnabled'),
    queryFn: fetchExecPolicyEnabled,
    staleTime: 30_000,
    retry: false
  })

  const { data: rules, isError } = useQuery<import('@shared/api/types').ExecPolicyRule[]>({
    queryKey: qk.execPolicy.rules(),
    queryFn: () => api.chat.listPolicyRules(),
    enabled: enabled === true,
    staleTime: 10_000
  })

  // flag-off (false / undefined) → byte-level no-render (DOM has no section).
  if (!enabled) return null

  const refetch = (): void => {
    void qc.invalidateQueries({ queryKey: qk.execPolicy.rules() })
  }

  const onToggle = async (id: number, next: boolean): Promise<void> => {
    try {
      await api.chat.setPolicyRuleEnabled(id, next)
      refetch()
    } catch (err) {
      toastError(t('settings.execPolicy.title'), errorMessage(err))
    }
  }
  const onDelete = async (id: number): Promise<void> => {
    try {
      await api.chat.deletePolicyRule(id)
      toastSuccess(t('settings.execPolicy.deleted'))
      refetch()
    } catch (err) {
      toastError(t('settings.execPolicy.title'), errorMessage(err))
    }
  }

  const content: React.ReactNode = (() => {
    if (isError) {
      return (
        <div className="px-4 py-3.5 text-aux text-ink-fg-3">
          {t('settings.execPolicy.loadError')}
        </div>
      )
    }
    if (!rules) {
      return (
        <div className="flex items-center gap-2 px-4 py-3.5 text-aux text-ink-fg-2">
          <Loader2 className="size-3.5 animate-spin shrink-0" />
          {t('settings.execPolicy.loading')}
        </div>
      )
    }
    if (rules.length === 0) {
      return (
        <div className="px-4 py-3.5 text-aux text-ink-fg-3">{t('settings.execPolicy.empty')}</div>
      )
    }
    return (
      <div className="divide-y divide-ink-border-soft">
        {rules.map((rule) => (
          <div key={rule.id} className="flex items-start gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="rounded bg-ink-3 px-1.5 py-0.5 text-aux text-ink-fg-2">
                  {rule.capability in CAPABILITY_LABEL_KEYS
                    ? t(CAPABILITY_LABEL_KEYS[rule.capability])
                    : rule.capability}
                </span>
                {rule.dangerous && (
                  <span className="inline-flex items-center gap-1 rounded bg-fail/15 px-1.5 py-0.5 text-aux font-medium text-fail">
                    <AlertTriangle size={12} strokeWidth={2.5} />
                    {t('settings.execPolicy.dangerous')}
                  </span>
                )}
              </div>
              <div className="mt-1 break-all font-mono text-meta text-ink-fg">
                {formatMatcher(rule.capability, rule.matcher, t)}
              </div>
              <div className="mt-0.5 text-aux text-ink-fg-3">
                {t('settings.execPolicy.hitCount', { count: rule.useCount })}
                {rule.lastUsedAt
                  ? t('settings.execPolicy.lastUsed', { time: rule.lastUsedAt })
                  : ''}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Switch
                checked={rule.enabled}
                onCheckedChange={(v: boolean) => void onToggle(rule.id, v)}
                aria-label={t('settings.execPolicy.toggleAria')}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void onDelete(rule.id)}
                aria-label={t('settings.execPolicy.deleteAria')}
              >
                <X size={13} strokeWidth={2.5} />
              </Button>
            </div>
          </div>
        ))}
      </div>
    )
  })()

  return (
    <Section title={t('settings.execPolicy.title')} helper={t('settings.execPolicy.helper')}>
      {content}
    </Section>
  )
}
