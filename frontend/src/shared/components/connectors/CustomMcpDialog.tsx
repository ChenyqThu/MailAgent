// Phase 5 (WP-5B.4) — Custom HTTP (Streamable / SSE) & local lazy stdio MCP connector dialog.
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus, Trash2 } from 'lucide-react'

import { useMailApi } from '@shared/hooks/useMailApi'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { toastError, toastSuccess } from '@shared/state/toast'
import type {
  ConnectorSummary,
  ConnectorTransport,
  CustomConnectorCreateInput,
  CustomConnectorUpdateInput
} from '@shared/api/types'
import { Button } from '@shared/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@shared/components/ui/dialog'

interface KvRow {
  id: number
  key: string
  value: string
}

function slugifyConnectorId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

function splitArgs(raw: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]
    if (quote) {
      if (ch === quote) {
        quote = null
      } else {
        cur += ch
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (/\s/.test(ch)) {
      if (cur.length > 0) {
        out.push(cur)
        cur = ''
      }
    } else {
      cur += ch
    }
  }
  if (cur.length > 0) out.push(cur)
  return out
}

export function CustomMcpDialog({
  open,
  onOpenChange,
  initialConnector,
  onSaved
}: {
  open: boolean
  onOpenChange(open: boolean): void
  initialConnector?: ConnectorSummary | null
  onSaved?(connectorId: string): void
}): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const qc = useQueryClient()
  const editing = initialConnector != null
  const nextRowIdRef = React.useRef(1)
  const makeKv = (key = '', value = ''): KvRow => ({
    id: nextRowIdRef.current++,
    key,
    value
  })

  const [connectorId, setConnectorId] = React.useState('')
  const [idTouched, setIdTouched] = React.useState(false)
  const [displayName, setDisplayName] = React.useState('')
  const [transport, setTransport] = React.useState<ConnectorTransport>('streamable_http')
  const [serverUrl, setServerUrl] = React.useState('')
  const [headerRows, setHeaderRows] = React.useState<KvRow[]>([])
  const [replaceHeaders, setReplaceHeaders] = React.useState(false)
  const [command, setCommand] = React.useState('')
  const [argsText, setArgsText] = React.useState('')
  const [cwd, setCwd] = React.useState('')
  const [envRows, setEnvRows] = React.useState<KvRow[]>([])
  const [replaceEnv, setReplaceEnv] = React.useState(false)
  const [autoSync, setAutoSync] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [err, setErr] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setErr(null)
    if (initialConnector) {
      setConnectorId(initialConnector.connector_id)
      setIdTouched(true)
      setDisplayName(initialConnector.display_name)
      setTransport(
        initialConnector.transport === 'stdio'
          ? 'stdio'
          : initialConnector.transport === 'sse'
            ? 'sse'
            : 'streamable_http'
      )
      setServerUrl(initialConnector.server_url || '')
      setHeaderRows([])
      setReplaceHeaders(false)
      setCommand(initialConnector.stdio_command?.command ?? '')
      setArgsText((initialConnector.stdio_command?.args ?? []).join(' '))
      setCwd(initialConnector.stdio_command?.cwd ?? '')
      setEnvRows([])
      setReplaceEnv(false)
      setAutoSync(false)
    } else {
      setConnectorId('')
      setIdTouched(false)
      setDisplayName('')
      setTransport('streamable_http')
      setServerUrl('')
      setHeaderRows([])
      setReplaceHeaders(true)
      setCommand('')
      setArgsText('')
      setCwd('')
      setEnvRows([])
      setReplaceEnv(true)
      setAutoSync(true)
    }
  }, [open, initialConnector])

  const kvToRecord = (rows: KvRow[]): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const r of rows) {
      const k = r.key.trim()
      if (k) out[k] = r.value
    }
    return out
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setErr(null)
    const cid = connectorId.trim()
    const name = displayName.trim()
    if (!name) {
      setErr(t('settings.connectors.custom.nameRequired'))
      return
    }
    if (!editing && !/^[a-z0-9][a-z0-9_-]{1,47}$/.test(cid)) {
      setErr(t('settings.connectors.custom.idInvalid'))
      return
    }
    const isRemoteHttp = transport === 'streamable_http' || transport === 'sse'
    if (isRemoteHttp && !serverUrl.trim()) {
      setErr(t('settings.connectors.custom.urlRequired'))
      return
    }
    if (transport === 'stdio' && !command.trim()) {
      setErr(t('settings.connectors.custom.commandRequired'))
      return
    }
    if (!api.connector.createCustom || !api.connector.updateCustom) return

    setSaving(true)
    try {
      let savedId = cid
      if (editing) {
        const patch: CustomConnectorUpdateInput = {
          display_name: name,
          transport,
          ...(isRemoteHttp
            ? {
                server_url: serverUrl.trim(),
                ...(replaceHeaders ? { headers: kvToRecord(headerRows) } : {})
              }
            : {
                command: command.trim(),
                args: splitArgs(argsText),
                cwd: cwd.trim() || null,
                ...(replaceEnv ? { env: kvToRecord(envRows) } : {})
              })
        }
        const res = await api.connector.updateCustom(initialConnector.connector_id, patch)
        savedId = res.connector_id
      } else {
        const input: CustomConnectorCreateInput = {
          connector_id: cid,
          display_name: name,
          transport,
          ...(isRemoteHttp
            ? {
                server_url: serverUrl.trim(),
                headers: kvToRecord(headerRows)
              }
            : {
                command: command.trim(),
                args: splitArgs(argsText),
                cwd: cwd.trim() || null,
                env: kvToRecord(envRows)
              })
        }
        const res = await api.connector.createCustom(input)
        savedId = res.connector_id
      }

      await qc.invalidateQueries({ queryKey: qk.connectors() })
      if (autoSync) {
        try {
          await api.connector.sync(savedId)
          await qc.invalidateQueries({ queryKey: qk.connectors() })
          await qc.invalidateQueries({ queryKey: qk.connectorTools(savedId) })
        } catch (syncErr) {
          toastError(t('settings.connectors.custom.syncWarning'), errorMessage(syncErr))
        }
      }
      toastSuccess(
        editing
          ? t('settings.connectors.custom.updated', { name })
          : t('settings.connectors.custom.created', { name })
      )
      onOpenChange(false)
      onSaved?.(savedId)
    } catch (submitErr) {
      setErr(errorMessage(submitErr))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto scrollbar-thin">
        <DialogHeader>
          <DialogTitle>
            {editing
              ? t('settings.connectors.custom.editTitle', { name: initialConnector.display_name })
              : t('settings.connectors.custom.createTitle')}
          </DialogTitle>
          <DialogDescription>{t('settings.connectors.custom.desc')}</DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3">
          <div>
            <label className="mb-1 block text-aux font-medium text-ink-fg-1">
              {t('settings.connectors.custom.displayName')}
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => {
                const v = e.target.value
                setDisplayName(v)
                if (!editing && !idTouched) {
                  setConnectorId(slugifyConnectorId(v))
                }
              }}
              placeholder={t('settings.connectors.custom.displayNamePlaceholder')}
              className="w-full rounded-[var(--r-ctl)] border border-ink-border bg-ink-1 px-3 py-1.5 text-body text-ink-fg outline-none focus:border-coral"
            />
          </div>

          {!editing && (
            <div>
              <label className="mb-1 block text-aux font-medium text-ink-fg-1">
                {t('settings.connectors.custom.connectorId')}
              </label>
              <input
                type="text"
                value={connectorId}
                onChange={(e) => {
                  setIdTouched(true)
                  setConnectorId(e.target.value)
                }}
                placeholder="my-mcp-server"
                className="w-full rounded-[var(--r-ctl)] border border-ink-border bg-ink-1 px-3 py-1.5 font-mono text-aux text-ink-fg outline-none focus:border-coral"
              />
            </div>
          )}

          <div>
            <div className="mb-1 text-aux font-medium text-ink-fg-1">
              {t('settings.connectors.custom.transportLabel')}
            </div>
            <div className="grid grid-cols-3 gap-1 rounded-[var(--r-ctl)] bg-ink-1/70 p-1">
              {(['streamable_http', 'sse', 'stdio'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setTransport(mode)}
                  className={cn(
                    'rounded-md border px-2.5 py-1.5 text-aux font-medium transition-colors duration-fast',
                    transport === mode
                      ? 'border-coral/50 bg-coral/12 text-coral'
                      : 'border-transparent text-ink-fg-2 hover:text-ink-fg'
                  )}
                >
                  {mode === 'streamable_http'
                    ? t('settings.connectors.custom.transportHttp')
                    : mode === 'sse'
                      ? t('settings.connectors.custom.transportSse')
                      : t('settings.connectors.custom.transportStdio')}
                </button>
              ))}
            </div>
          </div>

          {transport !== 'stdio' ? (
            <>
              <div>
                <label className="mb-1 block text-aux font-medium text-ink-fg-1">
                  {t('settings.connectors.custom.serverUrl')}
                </label>
                <input
                  type="url"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  placeholder={
                    transport === 'sse'
                      ? 'https://mcp.example.com/sse'
                      : 'https://mcp.example.com/mcp'
                  }
                  className="w-full rounded-[var(--r-ctl)] border border-ink-border bg-ink-1 px-3 py-1.5 font-mono text-aux text-ink-fg outline-none focus:border-coral"
                />
                <p className="mt-1 text-aux text-ink-fg-3">
                  {t('settings.connectors.custom.urlHint')}
                </p>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-aux font-medium text-ink-fg-1">
                    {t('settings.connectors.custom.headersLabel')}
                  </span>
                  {editing && !replaceHeaders ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setReplaceHeaders(true)}
                    >
                      {t('settings.connectors.custom.replaceSecrets')}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setHeaderRows((cur) => [...cur, makeKv()])}
                    >
                      <Plus className="size-3.5" aria-hidden="true" />
                      {t('settings.connectors.custom.addPair')}
                    </Button>
                  )}
                </div>
                {editing && !replaceHeaders ? (
                  <p className="text-aux text-ink-fg-3">
                    {(initialConnector?.custom_header_names?.length ?? 0) > 0
                      ? t('settings.connectors.custom.existingKeys', {
                          keys: initialConnector?.custom_header_names?.join(', ')
                        })
                      : t('settings.connectors.custom.noHeaders')}
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {headerRows.map((row) => (
                      <div key={row.id} className="flex items-center gap-1.5">
                        <input
                          type="text"
                          value={row.key}
                          onChange={(e) =>
                            setHeaderRows((cur) =>
                              cur.map((r) => (r.id === row.id ? { ...r, key: e.target.value } : r))
                            )
                          }
                          placeholder="Authorization"
                          className="w-40 rounded-[var(--r-ctl)] border border-ink-border bg-ink-1 px-2.5 py-1 font-mono text-meta text-ink-fg outline-none focus:border-coral"
                        />
                        <input
                          type="password"
                          value={row.value}
                          onChange={(e) =>
                            setHeaderRows((cur) =>
                              cur.map((r) =>
                                r.id === row.id ? { ...r, value: e.target.value } : r
                              )
                            )
                          }
                          placeholder="Bearer ..."
                          className="min-w-0 flex-1 rounded-[var(--r-ctl)] border border-ink-border bg-ink-1 px-2.5 py-1 font-mono text-meta text-ink-fg outline-none focus:border-coral"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            setHeaderRows((cur) => cur.filter((r) => r.id !== row.id))
                          }
                          className="p-1 text-ink-fg-3 hover:text-fail"
                          aria-label={t('settings.connectors.custom.removePair')}
                        >
                          <Trash2 className="size-3.5" aria-hidden="true" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="mb-1 block text-aux font-medium text-ink-fg-1">
                  {t('settings.connectors.custom.command')}
                </label>
                <input
                  type="text"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="npx"
                  className="w-full rounded-[var(--r-ctl)] border border-ink-border bg-ink-1 px-3 py-1.5 font-mono text-aux text-ink-fg outline-none focus:border-coral"
                />
              </div>

              <div>
                <label className="mb-1 block text-aux font-medium text-ink-fg-1">
                  {t('settings.connectors.custom.args')}
                </label>
                <input
                  type="text"
                  value={argsText}
                  onChange={(e) => setArgsText(e.target.value)}
                  placeholder="-y @modelcontextprotocol/server-filesystem /path"
                  className="w-full rounded-[var(--r-ctl)] border border-ink-border bg-ink-1 px-3 py-1.5 font-mono text-aux text-ink-fg outline-none focus:border-coral"
                />
              </div>

              <div>
                <label className="mb-1 block text-aux font-medium text-ink-fg-1">
                  {t('settings.connectors.custom.cwd')}
                </label>
                <input
                  type="text"
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                  placeholder="/Users/..."
                  className="w-full rounded-[var(--r-ctl)] border border-ink-border bg-ink-1 px-3 py-1.5 font-mono text-aux text-ink-fg outline-none focus:border-coral"
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-aux font-medium text-ink-fg-1">
                    {t('settings.connectors.custom.envLabel')}
                  </span>
                  {editing && !replaceEnv ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setReplaceEnv(true)}
                    >
                      {t('settings.connectors.custom.replaceSecrets')}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setEnvRows((cur) => [...cur, makeKv()])}
                    >
                      <Plus className="size-3.5" aria-hidden="true" />
                      {t('settings.connectors.custom.addPair')}
                    </Button>
                  )}
                </div>
                {editing && !replaceEnv ? (
                  <p className="text-aux text-ink-fg-3">
                    {(initialConnector?.stdio_env_keys?.length ?? 0) > 0
                      ? t('settings.connectors.custom.existingKeys', {
                          keys: initialConnector?.stdio_env_keys?.join(', ')
                        })
                      : t('settings.connectors.custom.noEnv')}
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {envRows.map((row) => (
                      <div key={row.id} className="flex items-center gap-1.5">
                        <input
                          type="text"
                          value={row.key}
                          onChange={(e) =>
                            setEnvRows((cur) =>
                              cur.map((r) => (r.id === row.id ? { ...r, key: e.target.value } : r))
                            )
                          }
                          placeholder="API_TOKEN"
                          className="w-40 rounded-[var(--r-ctl)] border border-ink-border bg-ink-1 px-2.5 py-1 font-mono text-meta text-ink-fg outline-none focus:border-coral"
                        />
                        <input
                          type="password"
                          value={row.value}
                          onChange={(e) =>
                            setEnvRows((cur) =>
                              cur.map((r) =>
                                r.id === row.id ? { ...r, value: e.target.value } : r
                              )
                            )
                          }
                          placeholder="secret"
                          className="min-w-0 flex-1 rounded-[var(--r-ctl)] border border-ink-border bg-ink-1 px-2.5 py-1 font-mono text-meta text-ink-fg outline-none focus:border-coral"
                        />
                        <button
                          type="button"
                          onClick={() => setEnvRows((cur) => cur.filter((r) => r.id !== row.id))}
                          className="p-1 text-ink-fg-3 hover:text-fail"
                          aria-label={t('settings.connectors.custom.removePair')}
                        >
                          <Trash2 className="size-3.5" aria-hidden="true" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          <label className="flex items-center gap-2 pt-1 text-aux text-ink-fg-2">
            <input
              type="checkbox"
              checked={autoSync}
              onChange={(e) => setAutoSync(e.target.checked)}
            />
            <span>{t('settings.connectors.custom.autoSync')}</span>
          </label>

          {err && (
            <div className="rounded-md border border-fail/40 bg-fail/10 px-3 py-2 text-aux text-fail">
              {err}
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              {t('settings.connectors.cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
              {saving
                ? t('settings.connectors.custom.saving')
                : editing
                  ? t('settings.connectors.custom.saveEdit')
                  : t('settings.connectors.custom.createAction')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
