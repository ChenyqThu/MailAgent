// MCP key reveal, one-click client installer, and rotate/revoke confirmation modals.

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, Copy, Loader2 } from 'lucide-react'

import type {
  McpApiKey,
  McpClientMode,
  McpClientTarget,
  McpKeyWithPlaintext,
  McpWriteClientConfigResult
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
import { Input } from '@shared/components/ui/input'
import { useMailApi } from '@shared/hooks/useMailApi'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { toastError, toastSuccess } from '@shared/state/toast'

import {
  buildHttpClientConfigText,
  buildNotionConfigText,
  buildSseClientConfigText,
  useCopy,
  type KeyAction
} from './mcpServiceUtils'

export function KeyRevealedDialog({
  revealed,
  localUrl,
  sseUrl,
  publicUrl,
  publicUrlUnverified,
  onNeedPublicUrl,
  onOpenClientInstaller,
  onClose
}: {
  revealed: McpKeyWithPlaintext | null
  localUrl: string
  sseUrl: string
  publicUrl: string
  /** 已填公网地址、但最近一次检测结果不是 reachable。 */
  publicUrlUnverified: boolean
  /** 没填公网地址时点「复制 Notion 配置」：展开页面上的公网地址引导。 */
  onNeedPublicUrl: () => void
  onOpenClientInstaller: (plaintext: string) => void
  onClose: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const { copied, copy } = useCopy()
  const isWeb =
    (import.meta as unknown as { env?: { VITE_BUILD_TARGET?: string } }).env?.VITE_BUILD_TARGET ===
    'web'
  // 记「哪一把明文」触发过提示，换一把（新建 / 轮换）自然复位，不需要 effect。
  const [needPublicFor, setNeedPublicFor] = React.useState<string | null>(null)

  const plaintext = revealed?.plaintext ?? ''

  function handleCopyNotion(): void {
    // Notion 只能连公网 HTTPS：没有公网地址时不拿本机地址兜底（复制了也用不了）。
    if (!publicUrl) {
      setNeedPublicFor(plaintext)
      onNeedPublicUrl()
      return
    }
    copy(buildNotionConfigText(publicUrl, plaintext), 'notion')
  }

  return (
    <Dialog
      open={revealed != null}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('settings.mcp.revealed.title')}</DialogTitle>
          <DialogDescription>
            {t('settings.mcp.revealed.desc', { label: revealed?.key.label ?? '' })}
          </DialogDescription>
        </DialogHeader>

        {revealed ? (
          <div className="flex flex-col gap-3">
            <div className="rounded-md border border-ink-border-soft input-surface px-3 py-2 text-aux font-mono text-ink-fg break-all select-all">
              {plaintext}
            </div>
            <div className="text-aux text-warn">{t('settings.mcp.revealed.warning')}</div>
            {!publicUrl && needPublicFor === plaintext ? (
              <div role="alert" className="text-aux text-fail">
                {t('settings.mcp.revealed.notionNeedsPublicUrl')}
              </div>
            ) : null}
            {publicUrl && publicUrlUnverified ? (
              <div className="text-aux text-warn">
                {t('settings.mcp.revealed.publicUrlUnverified')}
              </div>
            ) : null}
          </div>
        ) : null}

        <DialogFooter className="flex-wrap">
          <Button variant="outline" size="sm" onClick={() => copy(plaintext, 'key')}>
            {copied === 'key' ? <CheckCircle2 className="text-ok" /> : <Copy />}
            {t('settings.mcp.revealed.copyKey')}
          </Button>
          <Button variant="outline" size="sm" onClick={handleCopyNotion}>
            {copied === 'notion' ? <CheckCircle2 className="text-ok" /> : <Copy />}
            {t('settings.mcp.revealed.copyNotion')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => copy(buildHttpClientConfigText(localUrl, plaintext), 'http')}
          >
            {copied === 'http' ? <CheckCircle2 className="text-ok" /> : <Copy />}
            {t('settings.mcp.revealed.copyHttp')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => copy(buildSseClientConfigText(sseUrl, plaintext), 'sse')}
          >
            {copied === 'sse' ? <CheckCircle2 className="text-ok" /> : <Copy />}
            {t('settings.mcp.revealed.copySse')}
          </Button>
          {!isWeb && api.mcpService.writeClientConfig != null ? (
            <Button variant="outline" size="sm" onClick={() => onOpenClientInstaller(plaintext)}>
              {t('settings.mcp.clientConfig.openButton')}
            </Button>
          ) : null}
          <Button size="sm" onClick={onClose}>
            {t('settings.mcp.revealed.done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ClientConfigDialog({
  open,
  initialApiKey,
  onClose
}: {
  open: boolean
  initialApiKey?: string
  onClose: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const [target, setTarget] = React.useState<McpClientTarget>('claude_code')
  const [mode, setMode] = React.useState<McpClientMode>('streamable_http')
  const [apiKey, setApiKey] = React.useState(initialApiKey ?? '')
  const [preview, setPreview] = React.useState<McpWriteClientConfigResult | null>(null)
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    setApiKey(initialApiKey ?? '')
    setPreview(null)
  }, [open, initialApiKey])

  async function runConfigAction(dryRun: boolean): Promise<void> {
    if (!api.mcpService.writeClientConfig) return
    setBusy(true)
    try {
      const res = await api.mcpService.writeClientConfig({
        target,
        mode,
        ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
        dry_run: dryRun
      })
      setPreview(res)
      if (!dryRun && res.wrote) {
        toastSuccess(t('settings.mcp.clientConfig.wroteSuccess', { path: res.path }))
      }
    } catch (err) {
      toastError(t('settings.mcp.clientConfig.failed'), errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto scrollbar-thin">
        <DialogHeader>
          <DialogTitle>{t('settings.mcp.clientConfig.dialogTitle')}</DialogTitle>
          <DialogDescription>{t('settings.mcp.clientConfig.dialogDesc')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <label htmlFor="mcp-client-target" className="mb-1 block text-aux text-ink-fg">
              {t('settings.mcp.clientConfig.targetLabel')}
            </label>
            <select
              id="mcp-client-target"
              value={target}
              onChange={(e) => {
                setTarget(e.target.value as McpClientTarget)
                setPreview(null)
              }}
              className="h-9 w-full rounded-[var(--r-ctl)] border border-ink-border bg-ink-1 px-2.5 text-aux text-ink-fg outline-none focus:border-coral"
            >
              <option value="claude_desktop">Claude Desktop</option>
              <option value="claude_code">Claude Code</option>
              <option value="cursor">Cursor</option>
              <option value="antigravity">Antigravity</option>
            </select>
          </div>

          <div>
            <div className="mb-1 text-aux text-ink-fg">
              {t('settings.mcp.clientConfig.modeLabel')}
            </div>
            <div className="grid grid-cols-3 gap-1 rounded-[var(--r-ctl)] bg-ink-1/70 p-1">
              {(['streamable_http', 'sse', 'stdio'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    setMode(m)
                    setPreview(null)
                  }}
                  className={cn(
                    'rounded-md border px-2.5 py-1 text-aux font-medium transition-colors duration-fast',
                    mode === m
                      ? 'border-coral/50 bg-coral/12 text-coral'
                      : 'border-transparent text-ink-fg-2 hover:text-ink-fg'
                  )}
                >
                  {m === 'streamable_http'
                    ? t('settings.mcp.clientConfig.modeHttp')
                    : m === 'sse'
                      ? t('settings.mcp.clientConfig.modeSse')
                      : t('settings.mcp.clientConfig.modeStdio')}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="mcp-client-key" className="mb-1 block text-aux text-ink-fg">
              {t('settings.mcp.clientConfig.apiKeyLabel')}
            </label>
            <Input
              id="mcp-client-key"
              type="password"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value)
                setPreview(null)
              }}
              placeholder="mak_..."
            />
            <p className="mt-1 text-aux text-ink-fg-3">
              {t('settings.mcp.clientConfig.apiKeyHint')}
            </p>
          </div>

          {preview ? (
            <div className="space-y-1.5 rounded-md border border-ink-border-soft bg-ink-1/60 p-2.5">
              <div className="break-all font-mono text-meta text-ink-fg-2">{preview.path}</div>
              {preview.backup_path ? (
                <div className="text-aux text-ok">
                  {t('settings.mcp.clientConfig.backupCreated', { path: preview.backup_path })}
                </div>
              ) : null}
              <pre className="max-h-44 overflow-auto rounded bg-ink-1 p-2 font-mono text-meta text-ink-fg">
                {preview.preview}
              </pre>
            </div>
          ) : null}
        </div>

        <DialogFooter className="flex-wrap">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            {t('settings.mcp.cancel')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void runConfigAction(true)}
          >
            {t('settings.mcp.clientConfig.previewButton')}
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void runConfigAction(false)}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t('settings.mcp.clientConfig.writeButton')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// 轮换和撤销都会让已配置的客户端立即失效，所以两者都先确认。
export function ConfirmKeyActionDialog({
  target,
  busy,
  onCancel,
  onConfirm
}: {
  target: { key: McpApiKey; action: KeyAction } | null
  busy: boolean
  onCancel: () => void
  onConfirm: (target: { key: McpApiKey; action: KeyAction }) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const action = target?.action ?? 'revoke'
  return (
    <Dialog
      open={target != null}
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t(`settings.mcp.${action}.title`, { label: target?.key.label ?? '' })}
          </DialogTitle>
          <DialogDescription>{t(`settings.mcp.${action}.desc`)}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" onClick={onCancel}>
            {t('settings.mcp.cancel')}
          </Button>
          <Button
            variant={action === 'revoke' ? 'destructive' : 'default'}
            disabled={busy || target == null}
            onClick={() => {
              if (target) onConfirm(target)
            }}
          >
            {t(`settings.mcp.${action}.confirm`)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
