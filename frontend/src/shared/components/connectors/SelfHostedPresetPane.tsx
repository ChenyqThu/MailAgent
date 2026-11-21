import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'

import { useMailApi } from '@shared/hooks/useMailApi'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { toastError, toastSuccess } from '@shared/state/toast'
import type { SelfHostedPresetEntry } from '@shared/api/types'
import { Button } from '@shared/components/ui/button'
import { Input } from '@shared/components/ui/input'

import { CatalogLogo } from './CatalogDetailPane'
import { PILL_BASE, isWebBuild } from './consoleShared'

export function SelfHostedPresetPane({
  preset,
  onConnected
}: {
  preset: SelfHostedPresetEntry
  onConnected(connectorId: string): void
}): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const qc = useQueryClient()
  const isWeb = isWebBuild()

  const [serverUrl, setServerUrl] = React.useState(preset.default_server_url)
  const [token, setToken] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [err, setErr] = React.useState<string | null>(null)

  async function handleConnect(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setErr(null)
    const cleanedUrl = serverUrl.trim()
    if (!cleanedUrl) {
      setErr(t('settings.connectors.custom.urlRequired'))
      return
    }
    if (!api.connector.createCustom) return

    const trimmedToken = token.trim()
    const headers: Record<string, string> = trimmedToken
      ? { [preset.auth_header]: `${preset.auth_prefix}${trimmedToken}` }
      : {}

    setSaving(true)
    try {
      await api.connector.createCustom({
        connector_id: preset.connector_id,
        display_name: preset.display_name,
        transport: preset.transport,
        server_url: cleanedUrl,
        headers
      })
      setToken('')
      await qc.invalidateQueries({ queryKey: qk.connectors() })
      await qc.invalidateQueries({ queryKey: qk.connectorCatalog() })
      try {
        await api.connector.sync(preset.connector_id)
        await qc.invalidateQueries({ queryKey: qk.connectors() })
        await qc.invalidateQueries({ queryKey: qk.connectorTools(preset.connector_id) })
      } catch (syncErr) {
        toastError(t('settings.connectors.custom.syncWarning'), errorMessage(syncErr))
      }
      toastSuccess(t('settings.connectors.custom.created', { name: preset.display_name }))
      onConnected(preset.connector_id)
    } catch (submitErr) {
      setErr(errorMessage(submitErr))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div className="flex items-start gap-3">
        <CatalogLogo entry={preset} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lead font-medium text-ink-fg">{preset.display_name}</h2>
            <span className={cn(PILL_BASE, 'bg-ink-4 text-aux text-ink-fg-2')}>
              {t('settings.connectors.selfHosted.badge')}
            </span>
          </div>
          <p className="mt-1 text-aux leading-relaxed text-ink-fg-2">
            {t(preset.description_key)}
          </p>
        </div>
      </div>

      <form
        onSubmit={(e) => void handleConnect(e)}
        className="mt-4 space-y-3 rounded-[var(--r-card)] border border-ink-border bg-ink-2 p-4"
      >
        <div>
          <label
            htmlFor="preset-server-url"
            className="mb-1 block text-aux font-medium text-ink-fg-1"
          >
            {t('settings.connectors.selfHosted.serverUrlLabel')}
          </label>
          <Input
            id="preset-server-url"
            type="url"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder={preset.url_placeholder}
            disabled={isWeb || saving}
            className="font-mono text-aux"
          />
          <p className="mt-1 text-aux text-ink-fg-3">
            {t('settings.connectors.selfHosted.serverUrlHint')}
          </p>
        </div>

        <div>
          <label
            htmlFor="preset-access-token"
            className="mb-1 block text-aux font-medium text-ink-fg-1"
          >
            {t('settings.connectors.selfHosted.tokenLabel')}
          </label>
          <Input
            id="preset-access-token"
            type="password"
            value={token}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setToken(e.target.value)}
            placeholder={t('settings.connectors.selfHosted.tokenPlaceholder')}
            disabled={isWeb || saving}
            className="font-mono text-aux"
          />
          <p className="mt-1 text-aux text-ink-fg-3">
            {t('settings.connectors.selfHosted.tokenHint')}
          </p>
        </div>

        {isWeb ? (
          <p className="text-aux text-ink-fg-3">
            {t('settings.connectors.selfHosted.webDisabled')}
          </p>
        ) : null}

        {err ? <p className="text-aux text-fail">{err}</p> : null}

        <div className="flex items-center gap-2 pt-1">
          <Button type="submit" size="sm" disabled={isWeb || saving || !api.connector.createCustom}>
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t('settings.connectors.selfHosted.connectAndSync')}
          </Button>
        </div>
      </form>
    </div>
  )
}
