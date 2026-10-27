// 设置 →「MCP 服务」：把 MailAgent 的能力经 `/mcp` 交给外部 Agent（Notion Custom Agent 等）。
//
// 四块：连接地址 / 访问密钥 / 对外工具 / 最近调用。数据全部来自 serve-api
// `/api/mcp-service/*`（mcp_service_api.ts）；公网地址存 `.env` 的
// `MAILAGENT_MCP_PUBLIC_URL`（只用于展示与生成配置，后端不据此改变行为 → 保存不标「需重启」）。
//
// serve-api 是否在跑：没有专属探针 IPC（RemoteAccessTab 也只能拿 mail-sync 近似），所以直接用
// `GET /status` 本身判定 —— 远程访问开关显式关 = 不发请求；请求以 `E_NETWORK` 失败 = 没在跑。
// 两种情况都只出一条提示和去「远程访问」的入口，其余三块的请求恒 `enabled: false`。
//
// 🔴 明文密钥只活在「密钥已生成」弹窗的组件 state 里：关闭即置 null，列表接口永不返回明文，
// 所以关掉之后没有任何路径能再取回。复制出去的三份配置都在这一刻用真实明文拼出。

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { CheckCircle2, Copy, Loader2, RefreshCw } from 'lucide-react'

import type {
  McpApiKey,
  McpAuditEntry,
  McpExposedTool,
  McpKeyPresetName,
  McpKeyWithPlaintext,
  McpProbeResult,
  McpUiKeyPreset
} from '@shared/api/types'
import { openExternal } from '@shared/components/connectors/consoleShared'
import { Button } from '@shared/components/ui/button'
import { CollapseChevron, CollapsibleRegion } from '@shared/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@shared/components/ui/dialog'
import { Input } from '@shared/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@shared/components/ui/radio-group'
import { useMailApi } from '@shared/hooks/useMailApi'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { navigateToSettingsTab } from '@shared/navigation/registry'
import { applyEnvPatch, useEnvStore } from '@shared/state/env'
import { toastError, toastSuccess } from '@shared/state/toast'

import { PageHeader } from '../parts/PageHeader'
import { Row } from '../parts/Row'
import { Section } from '../parts/Section'

const PUBLIC_URL_ENV_KEY = 'MAILAGENT_MCP_PUBLIC_URL'
const AUDIT_LIMIT = 20
const UI_PRESETS: readonly McpUiKeyPreset[] = ['readonly', 'handoff', 'drafter']

function useEnvValue(key: string): string {
  return useEnvStore((s) =>
    s.state.status === 'ready' ? (s.state.snapshot.values[key] ?? '') : ''
  )
}

/** 同 RemoteAccessTab：仅显式 'false' / '0' 算关（默认开）。 */
function isToggleOn(value: string): boolean {
  const v = value.trim().toLowerCase()
  return v !== 'false' && v !== '0'
}

function isNetworkError(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'E_NETWORK'
}

function formatEpoch(sec: number | null): string | null {
  if (sec == null) return null
  const d = new Date(sec * 1000)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString()
}

/** Notion「Custom MCP server」两个输入框照抄即可的文本。 */
function buildNotionConfigText(url: string, plaintext: string): string {
  return `URL: ${url}\nAuthorization: Bearer ${plaintext}`
}

/** Claude Code / Cursor 等通用的 HTTP MCP 客户端配置。 */
function buildHttpClientConfigText(url: string, plaintext: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        mailagent: { type: 'http', url, headers: { Authorization: `Bearer ${plaintext}` } }
      }
    },
    null,
    2
  )
}

function useCopy(): { copied: string | null; copy: (value: string, which: string) => void } {
  const [copied, setCopied] = React.useState<string | null>(null)
  const copy = React.useCallback((value: string, which: string): void => {
    void navigator.clipboard.writeText(value).then(
      () => {
        setCopied(which)
        setTimeout(() => setCopied((c) => (c === which ? null : c)), 1500)
      },
      () => {
        /* clipboard blocked — non-fatal, user can select manually */
      }
    )
  }, [])
  return { copied, copy }
}

function CopyIconButton({
  copied,
  onCopy,
  label
}: {
  copied: boolean
  onCopy: () => void
  label: string
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={label}
      className={cn(
        'shrink-0 inline-flex h-6 w-6 items-center justify-center rounded-md',
        'text-ink-fg-2 hover:bg-ink-3 hover:text-ink-fg',
        'transition-colors duration-fast ease-standard'
      )}
    >
      <span className="icon-swap">
        <span className="icon-swap-item" data-active={copied ? 'true' : 'false'}>
          <CheckCircle2 className="size-3.5 text-ok" />
        </span>
        <span className="icon-swap-item" data-active={copied ? 'false' : 'true'}>
          <Copy className="size-3.5" />
        </span>
      </span>
    </button>
  )
}

function presetLabelKey(preset: McpKeyPresetName | null): string {
  return preset ? `settings.mcp.presets.${preset}.label` : 'settings.mcp.presets.custom'
}

export function McpServiceTab(): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const navigate = useNavigate()

  const remoteEnabled = isToggleOn(useEnvValue('MAILAGENT_REMOTE_ACCESS_ENABLED'))

  const statusQuery = useQuery({
    queryKey: qk.mcpService.status(),
    queryFn: () => api.mcpService.status(),
    enabled: remoteEnabled,
    retry: false
  })
  const running = remoteEnabled && statusQuery.isSuccess
  const notRunning = !remoteEnabled || (statusQuery.isError && isNetworkError(statusQuery.error))

  return (
    <>
      <PageHeader
        eyebrow={t('settings.mcp.page.eyebrow')}
        title={t('settings.mcp.page.title')}
        description={t('settings.mcp.page.intro')}
      />

      {notRunning ? (
        <Section title={t('settings.mcp.connection.title')}>
          <Row label={t('settings.mcp.offline.label')} helper={t('settings.mcp.offline.hint')}>
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigateToSettingsTab(navigate, 'remote')}
            >
              {t('settings.mcp.offline.cta')}
            </Button>
          </Row>
        </Section>
      ) : statusQuery.isError ? (
        <Section title={t('settings.mcp.connection.title')}>
          <Row
            label={t('settings.mcp.loadFailed')}
            helper={<span className="text-fail">{errorMessage(statusQuery.error)}</span>}
          >
            <Button size="sm" variant="outline" onClick={() => void statusQuery.refetch()}>
              {t('settings.mcp.retry')}
            </Button>
          </Row>
        </Section>
      ) : !running || !statusQuery.data ? (
        <div className="flex justify-center py-10">
          <Loader2 className="size-4 animate-spin text-ink-fg-3" aria-label="loading" />
        </div>
      ) : (
        <RunningSections
          localUrl={statusQuery.data.local_url}
          statusPublicUrl={statusQuery.data.public_url ?? ''}
          activeKeyCount={statusQuery.data.active_key_count}
        />
      )}
    </>
  )
}

/** 检测结果：只记最近一次，连同被检测的那个地址（弹窗的警示只认已保存地址的结果）。 */
type ProbeState = { url: string; outcome: McpProbeResult | { error: string } }

function isReachable(probe: ProbeState | null): boolean {
  return probe != null && 'result' in probe.outcome && probe.outcome.result === 'reachable'
}

const CLOUDFLARE_TUNNEL_DOCS_URL =
  'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/'

type PublicUrlError = 'invalid' | 'notHttps' | 'loopback' | 'path'

/** 公网地址保存前的格式校验。空串合法（= 清空）。 */
function validatePublicUrl(raw: string): PublicUrlError | null {
  if (raw === '') return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'invalid'
  }
  if (url.protocol !== 'https:') return 'notHttps'
  const host = url.hostname.toLowerCase()
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '0.0.0.0' ||
    host === '[::1]' ||
    /^127(\.\d{1,3}){3}$/.test(host)
  ) {
    return 'loopback'
  }
  if (!url.pathname.endsWith('/mcp')) return 'path'
  return null
}

/** 本机地址里的端口（引导与「复制给 Agent」用真实端口，不写死 8200）。 */
function portOf(localUrl: string): string {
  try {
    const url = new URL(localUrl)
    return url.port || (url.protocol === 'https:' ? '443' : '80')
  } catch {
    return ''
  }
}

/** 已保存的合法公网地址取主机名；否则 null（调用方换成占位符）。 */
function hostOf(publicUrl: string): string | null {
  if (publicUrl === '' || validatePublicUrl(publicUrl) !== null) return null
  return new URL(publicUrl).host
}

function RunningSections({
  localUrl,
  statusPublicUrl,
  activeKeyCount
}: {
  localUrl: string
  statusPublicUrl: string
  activeKeyCount: number
}): React.ReactElement {
  const envPublicUrl = useEnvValue(PUBLIC_URL_ENV_KEY).trim()
  // env store 是保存后立即可见的那一份（乐观更新）；env 没读到时退回 status 里的值。
  const savedPublicUrl = envPublicUrl || statusPublicUrl.trim()

  const [revealed, setRevealed] = React.useState<McpKeyWithPlaintext | null>(null)
  const [probe, setProbe] = React.useState<ProbeState | null>(null)
  const [guideOpen, setGuideOpen] = React.useState(false)

  return (
    <>
      <ConnectionSection
        localUrl={localUrl}
        savedPublicUrl={savedPublicUrl}
        activeKeyCount={activeKeyCount}
        probe={probe}
        onProbe={setProbe}
        guideOpen={guideOpen}
        onGuideOpenChange={setGuideOpen}
      />
      <KeysSection onRevealed={setRevealed} />
      <ToolsSection />
      <AuditSection />
      <KeyRevealedDialog
        revealed={revealed}
        localUrl={localUrl}
        publicUrl={savedPublicUrl}
        publicUrlUnverified={
          savedPublicUrl !== '' && probe?.url === savedPublicUrl && !isReachable(probe)
        }
        onNeedPublicUrl={() => setGuideOpen(true)}
        onClose={() => setRevealed(null)}
      />
    </>
  )
}

// ── 连接地址 ────────────────────────────────────────────────────────────────

function ConnectionSection({
  localUrl,
  savedPublicUrl,
  activeKeyCount,
  probe,
  onProbe,
  guideOpen,
  onGuideOpenChange
}: {
  localUrl: string
  savedPublicUrl: string
  activeKeyCount: number
  probe: ProbeState | null
  onProbe: (p: ProbeState | null) => void
  guideOpen: boolean
  onGuideOpenChange: (open: boolean) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const queryClient = useQueryClient()
  const { copied, copy } = useCopy()

  const isWeb =
    (import.meta as unknown as { env?: { VITE_BUILD_TARGET?: string } }).env?.VITE_BUILD_TARGET ===
    'web'

  const [draft, setDraft] = React.useState(savedPublicUrl)
  const [lastSynced, setLastSynced] = React.useState(savedPublicUrl)
  if (savedPublicUrl !== lastSynced) {
    setLastSynced(savedPublicUrl)
    setDraft(savedPublicUrl)
  }
  const [saving, setSaving] = React.useState(false)
  const [probing, setProbing] = React.useState(false)
  const [urlError, setUrlError] = React.useState<PublicUrlError | null>(null)

  const trimmed = draft.trim()

  async function handleSave(): Promise<void> {
    const invalid = validatePublicUrl(trimmed)
    setUrlError(invalid)
    if (invalid) return
    setSaving(true)
    try {
      const result = await applyEnvPatch({ [PUBLIC_URL_ENV_KEY]: trimmed === '' ? null : trimmed })
      if (result.ok) {
        toastSuccess(t('settings.mcp.publicUrl.saved'))
        void queryClient.invalidateQueries({ queryKey: qk.mcpService.status() })
      } else {
        toastError(
          t('settings.mcp.publicUrl.saveFailed'),
          `${result.error.code}: ${result.error.message}`
        )
      }
    } catch (err) {
      toastError(t('settings.mcp.publicUrl.saveFailed'), errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  async function handleProbe(): Promise<void> {
    setProbing(true)
    onProbe(null)
    try {
      onProbe({ url: trimmed, outcome: await api.mcpService.probe(trimmed) })
    } catch (err) {
      onProbe({ url: trimmed, outcome: { error: errorMessage(err) } })
    } finally {
      setProbing(false)
    }
  }

  let probeLine: React.ReactNode = null
  const outcome = probe?.outcome
  if (outcome && 'error' in outcome) {
    probeLine = <span className="text-fail">{outcome.error}</span>
  } else if (outcome) {
    const { result, detail } = outcome
    const cls =
      result === 'reachable' ? 'text-ok' : result === 'access_blocked' ? 'text-warn' : 'text-fail'
    probeLine = (
      <span className={cls} data-testid="mcp-probe-result">
        {t(`settings.mcp.probe.${result}`, { detail })}
      </span>
    )
  }

  const showGuide = savedPublicUrl === '' || (probe != null && !isReachable(probe))
  const port = portOf(localUrl)
  const host = hostOf(savedPublicUrl) ?? `<${t('settings.mcp.guide.hostPlaceholder')}>`
  const guideVars = { port, host }

  return (
    <Section
      title={t('settings.mcp.connection.title')}
      helper={t('settings.mcp.connection.helper')}
    >
      <Row label={t('settings.mcp.status.label')}>
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-meta font-mono bg-ok/15 text-ok">
          <span className="w-1.5 h-1.5 rounded-full bg-ok" />
          {t('settings.mcp.status.running', { count: activeKeyCount })}
        </span>
      </Row>

      <Row label={t('settings.mcp.localUrl.label')} helper={t('settings.mcp.localUrl.hint')}>
        <div className="inline-flex items-center gap-1.5 max-w-[300px]">
          <span className="text-aux font-mono text-ink-fg-1 truncate" title={localUrl}>
            {localUrl}
          </span>
          <CopyIconButton
            copied={copied === 'local'}
            onCopy={() => copy(localUrl, 'local')}
            label={t('settings.mcp.copy')}
          />
        </div>
      </Row>

      <Row
        label={t('settings.mcp.publicUrl.label')}
        helper={probeLine ?? t('settings.mcp.publicUrl.hint')}
        htmlFor="mcp-public-url"
      >
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-1.5">
            <Input
              id="mcp-public-url"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value)
                setUrlError(null)
              }}
              placeholder="https://mcp.example.com/mcp"
              className="w-[240px] font-mono"
              spellCheck={false}
              aria-invalid={urlError != null || undefined}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleSave()}
              disabled={isWeb || saving || trimmed === savedPublicUrl}
            >
              {t('settings.mcp.publicUrl.save')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleProbe()}
              disabled={probing || trimmed === ''}
            >
              {probing ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t('settings.mcp.publicUrl.probe')}
            </Button>
          </div>
          {urlError ? (
            <div role="alert" className="w-full text-meta text-fail">
              {t(`settings.mcp.publicUrl.errors.${urlError}`)}
            </div>
          ) : null}
        </div>
      </Row>

      {showGuide ? (
        <div className="px-[var(--settings-tile-px,1rem)] py-2.5">
          <button
            type="button"
            onClick={() => onGuideOpenChange(!guideOpen)}
            aria-expanded={guideOpen}
            aria-controls="mcp-public-url-guide"
            className="inline-flex items-center gap-1.5 text-aux text-coral hover:underline"
          >
            <CollapseChevron expanded={guideOpen} />
            {t('settings.mcp.guide.toggle')}
          </button>
          <CollapsibleRegion
            expanded={guideOpen}
            id="mcp-public-url-guide"
            bodyClassName="pt-2.5 flex flex-col gap-2.5 text-aux text-ink-fg-1"
          >
            <p>{t('settings.mcp.guide.intro')}</p>
            <p>
              {t('settings.mcp.guide.recommend')}{' '}
              <button
                type="button"
                onClick={() => openExternal(CLOUDFLARE_TUNNEL_DOCS_URL)}
                className="text-coral hover:underline"
              >
                {t('settings.mcp.guide.docsLink')}
              </button>
            </p>
            <ol className="list-decimal pl-5 flex flex-col gap-1">
              <li>{t('settings.mcp.guide.step1')}</li>
              <li>{t('settings.mcp.guide.step2', guideVars)}</li>
              <li>{t('settings.mcp.guide.step3')}</li>
              <li>{t('settings.mcp.guide.step4', guideVars)}</li>
            </ol>
            <div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => copy(t('settings.mcp.guide.agentTask', guideVars), 'agent')}
              >
                {copied === 'agent' ? <CheckCircle2 className="text-ok" /> : <Copy />}
                {t('settings.mcp.guide.copyForAgent')}
              </Button>
            </div>
          </CollapsibleRegion>
        </div>
      ) : null}
    </Section>
  )
}

// ── 访问密钥 ────────────────────────────────────────────────────────────────

function KeysSection({
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

  const [createOpen, setCreateOpen] = React.useState(false)
  const [confirmTarget, setConfirmTarget] = React.useState<{
    key: McpApiKey
    action: KeyAction
  } | null>(null)
  const [busyId, setBusyId] = React.useState<string | null>(null)

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: qk.mcpService.all() })
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
        <Button size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
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
            onRotate={() => setConfirmTarget({ key, action: 'rotate' })}
            onRevoke={() => setConfirmTarget({ key, action: 'revoke' })}
          />
        ))
      )}

      <CreateKeyDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(r) => {
          invalidate()
          setCreateOpen(false)
          onRevealed(r)
        }}
      />
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
  onRotate,
  onRevoke
}: {
  apiKey: McpApiKey
  busy: boolean
  onRotate: () => void
  onRevoke: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const created = formatEpoch(apiKey.created_at)
  const lastUsed = formatEpoch(apiKey.last_used_at)
  const stateLabel = apiKey.revoked_at
    ? t('settings.mcp.keys.state.revoked')
    : apiKey.active
      ? null
      : t('settings.mcp.keys.state.expired')

  const helper = [
    `${apiKey.key_prefix}…`,
    t(presetLabelKey(apiKey.preset)),
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
      helper={<span title={apiKey.scopes.join(', ')}>{helper}</span>}
    >
      {apiKey.active ? (
        <div className="flex items-center gap-1.5">
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

function CreateKeyDialog({
  open,
  onOpenChange,
  onCreated
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (r: McpKeyWithPlaintext) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const [label, setLabel] = React.useState('')
  const [preset, setPreset] = React.useState<McpUiKeyPreset>('readonly')
  const [submitting, setSubmitting] = React.useState(false)

  function handleOpenChange(next: boolean): void {
    if (!next) {
      setLabel('')
      setPreset('readonly')
    }
    onOpenChange(next)
  }

  async function handleSubmit(): Promise<void> {
    setSubmitting(true)
    try {
      const result = await api.mcpService.createKey(label.trim(), preset)
      setLabel('')
      setPreset('readonly')
      onCreated(result)
    } catch (err) {
      toastError(t('settings.mcp.keys.createFailed'), errorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('settings.mcp.create.title')}</DialogTitle>
          <DialogDescription>{t('settings.mcp.create.desc')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="mcp-key-label" className="text-aux font-medium text-ink-fg">
            {t('settings.mcp.create.nameLabel')}
          </label>
          <Input
            id="mcp-key-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t('settings.mcp.create.namePlaceholder')}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="text-aux font-medium text-ink-fg">
            {t('settings.mcp.create.presetLabel')}
          </div>
          <RadioGroup
            value={preset}
            onValueChange={(v) => setPreset(v as McpUiKeyPreset)}
            aria-label={t('settings.mcp.create.presetLabel')}
          >
            {UI_PRESETS.map((p) => {
              const id = `mcp-preset-${p}`
              return (
                <div
                  key={p}
                  className={cn(
                    'flex items-start gap-2.5 rounded-md border px-3 py-2.5',
                    'transition-colors duration-fast ease-standard',
                    preset === p ? 'border-coral/60' : 'border-ink-border-soft'
                  )}
                >
                  <RadioGroupItem value={p} id={id} className="mt-1" />
                  <div className="min-w-0 flex-1">
                    <label htmlFor={id} className="block text-aux text-ink-fg cursor-pointer">
                      {t(`settings.mcp.presets.${p}.label`)}
                    </label>
                    <div className="text-meta text-ink-fg-2 mt-0.5 leading-relaxed">
                      {t(`settings.mcp.presets.${p}.desc`)}
                    </div>
                  </div>
                </div>
              )
            })}
          </RadioGroup>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => handleOpenChange(false)}>
            {t('settings.mcp.cancel')}
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={submitting || label.trim() === ''}>
            {submitting ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t('settings.mcp.create.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function KeyRevealedDialog({
  revealed,
  localUrl,
  publicUrl,
  publicUrlUnverified,
  onNeedPublicUrl,
  onClose
}: {
  revealed: McpKeyWithPlaintext | null
  localUrl: string
  publicUrl: string
  /** 已填公网地址、但最近一次检测结果不是 reachable。 */
  publicUrlUnverified: boolean
  /** 没填公网地址时点「复制 Notion 配置」：展开页面上的公网地址引导。 */
  onNeedPublicUrl: () => void
  onClose: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const { copied, copy } = useCopy()
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
          <Button size="sm" onClick={onClose}>
            {t('settings.mcp.revealed.done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type KeyAction = 'rotate' | 'revoke'

// 轮换和撤销都会让已配置的客户端立即失效，所以两者都先确认。
function ConfirmKeyActionDialog({
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

// ── 对外工具 ────────────────────────────────────────────────────────────────

function ToolsSection(): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const toolsQuery = useQuery({
    queryKey: qk.mcpService.tools(),
    queryFn: () => api.mcpService.tools()
  })

  const tools = toolsQuery.data ?? []
  const groups: { key: 'read' | 'write'; items: McpExposedTool[] }[] = [
    { key: 'read', items: tools.filter((tool) => tool.annotations.readOnlyHint) },
    { key: 'write', items: tools.filter((tool) => !tool.annotations.readOnlyHint) }
  ]

  return (
    <Section title={t('settings.mcp.tools.title')} helper={t('settings.mcp.tools.helper')}>
      {toolsQuery.isError ? (
        <Row
          label={t('settings.mcp.loadFailed')}
          helper={<span className="text-fail">{errorMessage(toolsQuery.error)}</span>}
        >
          <Button size="sm" variant="outline" onClick={() => void toolsQuery.refetch()}>
            {t('settings.mcp.retry')}
          </Button>
        </Row>
      ) : toolsQuery.isPending ? (
        <Row label={t('settings.mcp.loading')}>
          <Loader2 className="size-4 animate-spin text-ink-fg-3" aria-label="loading" />
        </Row>
      ) : (
        groups
          .filter((g) => g.items.length > 0)
          .map((g) => (
            <React.Fragment key={g.key}>
              <div className="px-[var(--settings-tile-px,1rem)] py-2 text-meta font-medium text-ink-fg-2">
                {t(`settings.mcp.tools.group.${g.key}`, { count: g.items.length })}
              </div>
              {g.items.map((tool) => (
                <ToolRow key={tool.name} tool={tool} />
              ))}
            </React.Fragment>
          ))
      )}
    </Section>
  )
}

/** 预设名的本地化连接（zh「A、B」/ en "A, B"）。 */
function joinLabels(locale: string, labels: string[]): string {
  try {
    return new Intl.ListFormat(locale, { style: 'narrow', type: 'conjunction' }).format(labels)
  } catch {
    return labels.join(', ')
  }
}

function ToolRow({ tool }: { tool: McpExposedTool }): React.ReactElement {
  const { t, i18n } = useTranslation()
  const readOnly = tool.annotations.readOnlyHint
  const presets = joinLabels(
    i18n.language,
    tool.presets.map((p) => t(`settings.mcp.presets.${p}.label`))
  )
  return (
    <Row
      compact
      label={tool.title || tool.name}
      helper={
        <span title={tool.description}>
          <span className="font-mono">{tool.name}</span>
          {tool.auth_scopes.length > 0 ? (
            <> · {t('settings.mcp.tools.scopes', { scopes: tool.auth_scopes.join(', ') })}</>
          ) : null}
          {presets ? <> · {t('settings.mcp.tools.presets', { presets })}</> : null}
        </span>
      }
    >
      <span className={cn('text-meta', readOnly ? 'text-ink-fg-2' : 'text-warn')}>
        {readOnly ? t('settings.mcp.tools.suggestAuto') : t('settings.mcp.tools.suggestAsk')}
      </span>
    </Row>
  )
}

// ── 最近调用 ────────────────────────────────────────────────────────────────

function AuditSection(): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const auditQuery = useQuery({
    queryKey: qk.mcpService.audit(AUDIT_LIMIT),
    queryFn: () => api.mcpService.audit(AUDIT_LIMIT)
  })
  const entries = auditQuery.data ?? []

  return (
    <Section
      title={t('settings.mcp.audit.title')}
      meta={
        <button
          type="button"
          onClick={() => void auditQuery.refetch()}
          disabled={auditQuery.isFetching}
          aria-label={t('settings.mcp.audit.refresh')}
          className={cn(
            'inline-flex h-7 w-7 items-center justify-center rounded-md',
            'text-ink-fg-2 hover:bg-ink-3 hover:text-ink-fg',
            'transition-colors duration-fast ease-standard',
            'disabled:opacity-40 disabled:pointer-events-none'
          )}
        >
          <RefreshCw className={cn('size-3.5', auditQuery.isFetching && 'animate-spin')} />
        </button>
      }
    >
      {auditQuery.isError ? (
        <Row
          label={t('settings.mcp.loadFailed')}
          helper={<span className="text-fail">{errorMessage(auditQuery.error)}</span>}
        >
          <span />
        </Row>
      ) : auditQuery.isPending ? (
        <Row label={t('settings.mcp.loading')}>
          <Loader2 className="size-4 animate-spin text-ink-fg-3" aria-label="loading" />
        </Row>
      ) : entries.length === 0 ? (
        <Row label={t('settings.mcp.audit.empty')}>
          <span />
        </Row>
      ) : (
        entries.map((entry) => <AuditRow key={entry.id} entry={entry} />)
      )}
    </Section>
  )
}

function AuditRow({ entry }: { entry: McpAuditEntry }): React.ReactElement {
  const { t } = useTranslation()
  const ok = entry.status === 'ok'
  const helper = [
    formatEpoch(entry.created_at),
    entry.key_label ?? t('settings.mcp.audit.unknownKey'),
    entry.duration_ms != null ? `${entry.duration_ms} ms` : null
  ]
    .filter((x): x is string => Boolean(x))
    .join(' · ')
  return (
    <Row
      compact
      label={<span className="font-mono">{entry.tool ?? entry.route}</span>}
      helper={helper}
    >
      <span className={cn('text-meta font-mono', ok ? 'text-ok' : 'text-fail')}>
        {ok ? t('settings.mcp.audit.ok') : (entry.error_code ?? t('settings.mcp.audit.failed'))}
      </span>
    </Row>
  )
}
