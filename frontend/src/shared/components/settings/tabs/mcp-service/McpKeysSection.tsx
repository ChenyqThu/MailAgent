// MCP access keys list, lifecycle actions, and scope/confirm modal orchestration.

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'

import type { McpApiKey, McpKeyWithPlaintext } from '@shared/api/types'
import { Button } from '@shared/components/ui/button'
import { useMailApi } from '@shared/hooks/useMailApi'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { toastError, toastSuccess } from '@shared/state/toast'

import { Row } from '../../parts/Row'
import { Section } from '../../parts/Section'
import { KeyScopesDialog } from './McpKeyScopesDialog'
import { ConfirmKeyActionDialog } from './McpKeyModals'
import {
  formatEpoch,
  joinLabels,
  useScopeText,
  type KeyAction,
  type ScopesDialogTarget
} from './mcpServiceUtils'

export function KeysSection({
  onRevealed
}: {
  onRevealed: (r: McpKeyWithPlaintext) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const queryClient = useQueryClient()

  const keysQuery = useQuery({
    queryKey: qk.mcpService.keys(),
    queryFn: () => api.mcpService.listKeys()
  })

  const [scopesDialog, setScopesDialog] = React.useState<{
    target: ScopesDialogTarget
    open: boolean
    // 每次打开 +1 作 React key：弹窗按打开时的密钥重新取初值，不需要 effect 同步。
    seq: number
  } | null>(null)
  const [confirmTarget, setConfirmTarget] = React.useState<{
    key: McpApiKey
    action: KeyAction
  } | null>(null)
  const [busyId, setBusyId] = React.useState<string | null>(null)

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: qk.mcpService.all() })
  }

  function openScopesDialog(target: ScopesDialogTarget): void {
    setScopesDialog((prev) => ({ target, open: true, seq: (prev?.seq ?? 0) + 1 }))
  }

  function closeScopesDialog(): void {
    setScopesDialog((prev) => (prev ? { ...prev, open: false } : prev))
  }

  async function handleRotate(key: McpApiKey): Promise<void> {
    setBusyId(key.id)
    try {
      const result = await api.mcpService.rotateKey(key.id)
      invalidate()
      setConfirmTarget(null)
      onRevealed(result)
    } catch (err) {
      toastError(t('settings.mcp.keys.rotateFailed'), errorMessage(err))
    } finally {
      setBusyId(null)
    }
  }

  async function handleRevoke(key: McpApiKey): Promise<void> {
    setBusyId(key.id)
    try {
      await api.mcpService.revokeKey(key.id)
      invalidate()
      setConfirmTarget(null)
      toastSuccess(t('settings.mcp.keys.revoked', { label: key.label }))
    } catch (err) {
      toastError(t('settings.mcp.keys.revokeFailed'), errorMessage(err))
    } finally {
      setBusyId(null)
    }
  }

  const keys = keysQuery.data ?? []

  return (
    <Section
      title={t('settings.mcp.keys.title')}
      helper={t('settings.mcp.keys.helper')}
      meta={
        <Button size="sm" variant="outline" onClick={() => openScopesDialog({ mode: 'create' })}>
          {t('settings.mcp.keys.create')}
        </Button>
      }
    >
      {keysQuery.isError ? (
        <Row
          label={t('settings.mcp.loadFailed')}
          helper={<span className="text-fail">{errorMessage(keysQuery.error)}</span>}
        >
          <Button size="sm" variant="outline" onClick={() => void keysQuery.refetch()}>
            {t('settings.mcp.retry')}
          </Button>
        </Row>
      ) : keysQuery.isPending ? (
        <Row label={t('settings.mcp.loading')}>
          <Loader2 className="size-4 animate-spin text-ink-fg-3" aria-label="loading" />
        </Row>
      ) : keys.length === 0 ? (
        <Row label={t('settings.mcp.keys.empty')} helper={t('settings.mcp.keys.emptyHint')}>
          <span />
        </Row>
      ) : (
        keys.map((key) => (
          <KeyRow
            key={key.id}
            apiKey={key}
            busy={busyId === key.id}
            onEditScopes={() => openScopesDialog({ mode: 'edit', key })}
            onRotate={() => setConfirmTarget({ key, action: 'rotate' })}
            onRevoke={() => setConfirmTarget({ key, action: 'revoke' })}
          />
        ))
      )}

      {scopesDialog ? (
        <KeyScopesDialog
          key={scopesDialog.seq}
          target={scopesDialog.target}
          open={scopesDialog.open}
          onClose={closeScopesDialog}
          onCreated={(r) => {
            invalidate()
            closeScopesDialog()
            onRevealed(r)
          }}
          onUpdated={(key) => {
            invalidate()
            closeScopesDialog()
            toastSuccess(t('settings.mcp.keys.scopesUpdated', { label: key.label }))
          }}
        />
      ) : null}
      <ConfirmKeyActionDialog
        target={confirmTarget}
        busy={confirmTarget != null && busyId === confirmTarget.key.id}
        onCancel={() => setConfirmTarget(null)}
        onConfirm={({ key, action }) =>
          void (action === 'rotate' ? handleRotate(key) : handleRevoke(key))
        }
      />
    </Section>
  )
}

function KeyRow({
  apiKey,
  busy,
  onEditScopes,
  onRotate,
  onRevoke
}: {
  apiKey: McpApiKey
  busy: boolean
  onEditScopes: () => void
  onRotate: () => void
  onRevoke: () => void
}): React.ReactElement {
  const { t, i18n } = useTranslation()
  const scopeText = useScopeText()
  const created = formatEpoch(apiKey.created_at)
  const lastUsed = formatEpoch(apiKey.last_used_at)
  const stateLabel = apiKey.revoked_at
    ? t('settings.mcp.keys.state.revoked')
    : apiKey.active
      ? null
      : t('settings.mcp.keys.state.expired')

  const base = apiKey.custom ? null : apiKey.base
  const permissions =
    base == null
      ? t('settings.mcp.presets.custom')
      : [
          t(`settings.mcp.presets.${base}.label`),
          apiKey.extra.length > 0
            ? joinLabels(i18n.language, apiKey.extra.map(scopeText.label))
            : null
        ]
          .filter((x): x is string => Boolean(x))
          .join(' · ')

  const expires = formatEpoch(apiKey.expires_at)
  const policyNotes: string[] = []
  if (expires) policyNotes.push(t('settings.mcp.keys.expiresAt', { time: expires }))
  if (apiKey.write_rpm_limit != null) {
    policyNotes.push(t('settings.mcp.keys.writeRpmBadge', { limit: apiKey.write_rpm_limit }))
  }
  if ((apiKey.disabled_tools?.length ?? 0) > 0) {
    policyNotes.push(
      t('settings.mcp.keys.disabledToolsBadge', { count: apiKey.disabled_tools?.length ?? 0 })
    )
  }

  const helper = [
    `${apiKey.key_prefix}…`,
    permissions,
    created ? t('settings.mcp.keys.createdAt', { time: created }) : null,
    lastUsed
      ? t('settings.mcp.keys.lastUsedAt', { time: lastUsed })
      : t('settings.mcp.keys.neverUsed')
  ]
    .filter((x): x is string => Boolean(x))
    .join(' · ')

  return (
    <Row
      label={
        <span className={cn(!apiKey.active && 'text-ink-fg-2')}>
          {apiKey.label}
          {stateLabel ? (
            <span className="ml-2 text-meta font-mono text-ink-fg-3">{stateLabel}</span>
          ) : null}
        </span>
      }
      helper={
        <span title={apiKey.scopes.join(', ')}>
          {helper}
          {policyNotes.length > 0 ? (
            <span className="mt-0.5 block text-aux text-ink-fg-2">{policyNotes.join(' · ')}</span>
          ) : null}
          {base == null ? (
            <span className="block mt-0.5" data-testid="mcp-key-custom-scopes">
              {t('settings.mcp.keys.customScopes', { scopes: apiKey.scopes.join(', ') })}
            </span>
          ) : null}
        </span>
      }
    >
      {apiKey.active ? (
        <div className="flex items-center gap-1.5">
          {base != null ? (
            <Button size="sm" variant="ghost" onClick={onEditScopes} disabled={busy}>
              {t('settings.mcp.keys.editScopes')}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={onRotate} disabled={busy}>
            {t('settings.mcp.keys.rotate')}
          </Button>
          <Button size="sm" variant="ghost" onClick={onRevoke} disabled={busy}>
            {t('settings.mcp.keys.revoke')}
          </Button>
        </div>
      ) : (
        <span />
      )}
    </Row>
  )
}
