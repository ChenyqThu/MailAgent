// Sprint 18 §PR D — dual-write secret field (keytar + .env).
//
// Used ONLY for the two secrets that Electron-main itself consumes:
//   LLM_API_KEY        — translation + Custom-API chat backend (main proc)
//   MAILAGENT_CLI_API_KEY — CLI write-command auth header (cli_runner)
//
// Other secrets (NOTION_TOKEN / FEISHU_APP_SECRET / ALERT_*_SECRET /
// STATS_REPORT_TOKEN / DASHBOARD_PASSWORD) are consumed ONLY by Python and
// belong to the regular <EnvField control="password" /> path — single-write
// to .env.
//
// Dual-write flow:
//   1. await mailApi.settings.setSecret(slot, value)    → keytar
//   2. await mailApi.env.set({ [envKey]: value })       → .env
// If step 2 fails we DON'T roll back step 1 — keytar holding the new key
// while .env stays on the old one is a recoverable inconsistency the user
// can detect via the saved/unsaved toast and a re-attempt. Rolling back a
// keytar write is itself another keychain prompt; cumulatively worse UX.

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Eye, EyeOff, Loader2 } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { useMailApi } from '@shared/hooks/useMailApi'
import { Input } from '@shared/components/ui/input'
import { toastError, toastSuccess } from '@shared/state/toast'
import { applyEnvPatch, useEnvStore } from '@shared/state/env'
import { useRestartStore } from '@shared/state/restart'
import type { SecretSlot } from '@shared/api/types'

import { Row } from './Row'

/** Coerce a ReactNode label into a string for toast titles (kept duplicate of
 *  EnvField.labelString to avoid a cross-file circular import while the
 *  parts/ directory stays a flat sibling layout). */
function labelString(node: React.ReactNode, fallback: string): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  return fallback
}

interface EnvSecretFieldProps {
  envKey: 'LLM_API_KEY' | 'LLM_TRANSLATE_API_KEY' | 'MAILAGENT_CLI_API_KEY'
  keytarSlot: SecretSlot
  label: React.ReactNode
  helper?: React.ReactNode
  placeholder?: string
  /** Optional toast title override (defaults to label). */
  savedToastTitle?: React.ReactNode
  disabled?: boolean
  className?: string
}

export function EnvSecretField({
  envKey,
  keytarSlot,
  label,
  helper,
  placeholder,
  savedToastTitle,
  disabled = false,
  className
}: EnvSecretFieldProps): React.ReactElement {
  const { t } = useTranslation()
  const storeState = useEnvStore((s) => s.state)
  const markRestartRequired = useRestartStore((s) => s.markRestartRequired)
  const api = useMailApi()

  const storedMarker =
    storeState.status === 'ready' ? (storeState.snapshot.values[envKey] ?? '') : ''
  const hasStored = storedMarker.length > 0

  const [local, setLocal] = React.useState('')
  const [revealed, setRevealed] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)

  async function handleBlur(next: string): Promise<void> {
    if (next.length === 0) return // empty blur = no save (user must clear via explicit action)
    setSubmitting(true)
    try {
      // Step 1: keytar write (main-process consumer). Throws on keychain
      // prompt cancellation — surface immediately.
      await api.settings.setSecret(keytarSlot, next)
      // Step 2: .env mirror (Python consumer). If this fails we keep keytar
      // already-written and surface a partial-save toast.
      const result = await applyEnvPatch({ [envKey]: next })
      if (result.ok) {
        if (result.changedKeys.length > 0) markRestartRequired(result.changedKeys)
        toastSuccess(
          labelString(savedToastTitle ?? label, envKey),
          t('settings.envField.secretSaved')
        )
      } else {
        toastError(
          labelString(label, envKey),
          `keytar OK, but .env write failed: ${result.error.code} — ${result.error.message}`
        )
      }
    } catch (err) {
      toastError(labelString(label, envKey), errorMessage(err))
    } finally {
      // Clear plaintext from local state the moment we've handed it off.
      setLocal('')
      setRevealed(false)
      setSubmitting(false)
    }
  }

  if (storeState.status !== 'ready') {
    return (
      <Row label={label} helper={helper} className={className}>
        <Loader2 className="size-4 animate-spin text-ink-fg-3" aria-label="loading" />
      </Row>
    )
  }

  return (
    <Row label={label} helper={helper} className={className}>
      <div className="relative w-[260px]">
        <Input
          type={revealed ? 'text' : 'password'}
          value={local}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={(e) => handleBlur(e.target.value)}
          placeholder={
            hasStored
              ? t('settings.envField.secretSet')
              : (placeholder ?? t('settings.envField.secretUnset'))
          }
          disabled={disabled || submitting}
          className="pr-9"
          aria-label={typeof label === 'string' ? label : envKey}
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setRevealed((v) => !v)}
          disabled={local.length === 0}
          aria-label={revealed ? t('settings.envField.hide') : t('settings.envField.reveal')}
          className={cn(
            'absolute right-1 top-1/2 -translate-y-1/2 inline-flex h-7 w-7 items-center justify-center rounded-md',
            'text-ink-fg-2 hover:bg-ink-3 hover:text-ink-fg',
            'transition-colors duration-fast ease-standard',
            'disabled:opacity-40 disabled:pointer-events-none'
          )}
        >
          <span className="icon-swap">
            <span className="icon-swap-item" data-active={revealed ? 'true' : 'false'}>
              <EyeOff className="size-4" />
            </span>
            <span className="icon-swap-item" data-active={revealed ? 'false' : 'true'}>
              <Eye className="size-4" />
            </span>
          </span>
        </button>
      </div>
    </Row>
  )
}
