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
  McpClientMode,
  McpClientTarget,
  McpExposedTool,
  McpKeyBase,
  McpKeyWithPlaintext,
  McpProbeResult,
  McpWriteClientConfigResult
} from '@shared/api/types'
import { openExternal } from '@shared/components/connectors/consoleShared'
import { Button } from '@shared/components/ui/button'
import { Checkbox } from '@shared/components/ui/checkbox'
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

/** 从本机 `/mcp` 地址派生兼容的 `/mcp/sse` 地址（优先使用服务端下发的 `sse_url`）。 */
function deriveSseUrl(localUrl: string, explicitSseUrl?: string | null): string {
  const trimmed = explicitSseUrl?.trim()
  if (trimmed) return trimmed
  try {
    const url = new URL(localUrl)
    const cleanPath = url.pathname.replace(/\/+$/, '')
    url.pathname = cleanPath.endsWith('/mcp') ? `${cleanPath}/sse` : `${cleanPath}/mcp/sse`
    return url.toString()
  } catch {
    const clean = localUrl.trim().replace(/\/+$/, '')
    return clean.endsWith('/mcp') ? `${clean}/sse` : `${clean}/mcp/sse`
  }
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

/** Legacy HTTP+SSE MCP 客户端配置。 */
function buildSseClientConfigText(url: string, plaintext: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        mailagent: { type: 'sse', url, headers: { Authorization: `Bearer ${plaintext}` } }
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
          streamableHttpUrl={
            statusQuery.data.streamable_http_url?.trim() || statusQuery.data.local_url
          }
          sseUrl={deriveSseUrl(statusQuery.data.local_url, statusQuery.data.sse_url)}
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
  streamableHttpUrl,
  sseUrl,
  statusPublicUrl,
  activeKeyCount
}: {
  localUrl: string
  streamableHttpUrl: string
  sseUrl: string
  statusPublicUrl: string
  activeKeyCount: number
}): React.ReactElement {
  const envPublicUrl = useEnvValue(PUBLIC_URL_ENV_KEY).trim()
  // env store 是保存后立即可见的那一份（乐观更新）；env 没读到时退回 status 里的值。
  const savedPublicUrl = envPublicUrl || statusPublicUrl.trim()

  const [revealed, setRevealed] = React.useState<McpKeyWithPlaintext | null>(null)
  const [probe, setProbe] = React.useState<ProbeState | null>(null)
  const [guideOpen, setGuideOpen] = React.useState(false)
  const [clientConfigKey, setClientConfigKey] = React.useState<string | null>(null)
  const [clientConfigOpen, setClientConfigOpen] = React.useState(false)

  return (
    <>
      <ConnectionSection
        localUrl={localUrl}
        streamableHttpUrl={streamableHttpUrl}
        sseUrl={sseUrl}
        savedPublicUrl={savedPublicUrl}
        activeKeyCount={activeKeyCount}
        probe={probe}
        onProbe={setProbe}
        guideOpen={guideOpen}
        onGuideOpenChange={setGuideOpen}
        onOpenClientInstaller={() => {
          setClientConfigKey(null)
          setClientConfigOpen(true)
        }}
      />
      <KeysSection onRevealed={setRevealed} />
      <ToolsSection />
      <AuditSection />
      <KeyRevealedDialog
        revealed={revealed}
        localUrl={streamableHttpUrl}
        sseUrl={sseUrl}
        publicUrl={savedPublicUrl}
        publicUrlUnverified={
          savedPublicUrl !== '' && probe?.url === savedPublicUrl && !isReachable(probe)
        }
        onNeedPublicUrl={() => setGuideOpen(true)}
        onOpenClientInstaller={(plaintext) => {
          setClientConfigKey(plaintext)
          setClientConfigOpen(true)
        }}
        onClose={() => setRevealed(null)}
      />
      <ClientConfigDialog
        open={clientConfigOpen}
        initialApiKey={clientConfigKey ?? undefined}
        onClose={() => setClientConfigOpen(false)}
      />
    </>
  )
}

// ── 连接地址 ────────────────────────────────────────────────────────────────

function ConnectionSection({
  localUrl,
  streamableHttpUrl,
  sseUrl,
  savedPublicUrl,
  activeKeyCount,
  probe,
  onProbe,
  guideOpen,
  onGuideOpenChange,
  onOpenClientInstaller
}: {
  localUrl: string
  streamableHttpUrl: string
  sseUrl: string
  savedPublicUrl: string
  activeKeyCount: number
  probe: ProbeState | null
  onProbe: (p: ProbeState | null) => void
  guideOpen: boolean
  onGuideOpenChange: (open: boolean) => void
  onOpenClientInstaller: () => void
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

      <Row
        label={t('settings.mcp.localUrl.label')}
        helper={<span className="text-aux">{t('settings.mcp.localUrl.hint')}</span>}
      >
        <div className="inline-flex items-center gap-1.5 max-w-[300px]">
          <span className="text-meta font-mono text-ink-fg-1 truncate" title={streamableHttpUrl}>
            {streamableHttpUrl}
          </span>
          <CopyIconButton
            copied={copied === 'local'}
            onCopy={() => copy(streamableHttpUrl, 'local')}
            label={t('settings.mcp.localUrl.copy')}
          />
        </div>
      </Row>

      <Row
        label={t('settings.mcp.sseUrl.label')}
        helper={<span className="text-aux">{t('settings.mcp.sseUrl.hint')}</span>}
      >
        <div className="inline-flex items-center gap-1.5 max-w-[300px]">
          <span className="text-meta font-mono text-ink-fg-1 truncate" title={sseUrl}>
            {sseUrl}
          </span>
          <CopyIconButton
            copied={copied === 'sse'}
            onCopy={() => copy(sseUrl, 'sse')}
            label={t('settings.mcp.sseUrl.copy')}
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

      {!isWeb && api.mcpService.writeClientConfig != null ? (
        <Row
          label={t('settings.mcp.clientConfig.rowTitle')}
          helper={t('settings.mcp.clientConfig.rowHelper')}
        >
          <Button size="sm" variant="outline" onClick={onOpenClientInstaller}>
            {t('settings.mcp.clientConfig.openButton')}
          </Button>
        </Row>
      ) : null}
    </Section>
  )
}

// ── 访问密钥 ────────────────────────────────────────────────────────────────

/** 新建 / 修改权限共用一个弹窗；`target` 在关闭后保留，退场动画期间文案不跳。 */
type ScopesDialogTarget = { mode: 'create' } | { mode: 'edit'; key: McpApiKey }

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

/** 本地化连接（zh「A、B」/ en "A, B"）。 */
function joinLabels(locale: string, labels: string[]): string {
  try {
    return new Intl.ListFormat(locale, { style: 'narrow', type: 'conjunction' }).format(labels)
  } catch {
    return labels.join(', ')
  }
}

/** scope（如 `email:draft`）→ i18n key 段。`:` 是 i18next 的命名空间分隔符，不能原样进 key。 */
function scopeI18nKey(scope: string, field: 'label' | 'desc'): string {
  return `settings.mcp.scopes.${scope.replace(/[^a-zA-Z0-9]/g, '_')}.${field}`
}

/** scope 的显示名与说明。没有文案的 scope（后端新加、前端还没翻译）显示原始 scope、不出说明。 */
function useScopeText(): {
  label: (scope: string) => string
  desc: (scope: string) => string | null
} {
  const { t, i18n } = useTranslation()
  return {
    label: (scope) => {
      const key = scopeI18nKey(scope, 'label')
      return i18n.exists(key) ? t(key) : scope
    },
    desc: (scope) => {
      const key = scopeI18nKey(scope, 'desc')
      return i18n.exists(key) ? t(key) : null
    }
  }
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

function KeyScopesDialog({
  target,
  open,
  onClose,
  onCreated,
  onUpdated
}: {
  target: ScopesDialogTarget
  open: boolean
  onClose: () => void
  onCreated: (r: McpKeyWithPlaintext) => void
  onUpdated: (key: McpApiKey) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const scopeText = useScopeText()
  const editing = target.mode === 'edit' ? target.key : null

  const optionsQuery = useQuery({
    queryKey: qk.mcpService.scopeOptions(),
    queryFn: () => api.mcpService.getScopeOptions()
  })

  const [label, setLabel] = React.useState('')
  const [base, setBase] = React.useState<McpKeyBase>(editing?.base ?? 'readonly')
  const [extra, setExtra] = React.useState<readonly string[]>(editing?.extra ?? [])
  const [advancedOpen, setAdvancedOpen] = React.useState(false)
  const [granularMode, setGranularMode] = React.useState(false)
  const [granularScopes, setGranularScopes] = React.useState<string[]>(
    editing ? [...editing.scopes] : []
  )
  const [ttlDays, setTtlDays] = React.useState<number | null>(null)
  const [ttlDirty, setTtlDirty] = React.useState(false)
  const [writeRpmText, setWriteRpmText] = React.useState(
    editing?.write_rpm_limit != null ? String(editing.write_rpm_limit) : ''
  )
  const [rpmDirty, setRpmDirty] = React.useState(false)
  const [disabledTools, setDisabledTools] = React.useState<string[]>(
    editing?.disabled_tools ? [...editing.disabled_tools] : []
  )
  const [toolsDirty, setToolsDirty] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)

  const options = optionsQuery.data
  // 按接口给的顺序提交，与勾选先后无关。
  const selectedExtra = options
    ? options.extras.map((e) => e.scope).filter((scope) => extra.includes(scope))
    : []

  function toggleExtra(scope: string, checked: boolean): void {
    setExtra((prev) => (checked ? [...prev, scope] : prev.filter((s) => s !== scope)))
  }

  function enableGranularMode(): void {
    const baseScopes = options?.bases.find((b) => b.id === base)?.scopes ?? []
    setGranularScopes(Array.from(new Set([...baseScopes, ...selectedExtra])))
    setGranularMode(true)
  }

  function toggleGranularScope(scope: string, checked: boolean): void {
    setGranularScopes((prev) =>
      checked ? Array.from(new Set([...prev, scope])) : prev.filter((s) => s !== scope)
    )
  }

  function toggleDisabledTool(toolName: string, disabled: boolean): void {
    setToolsDirty(true)
    setDisabledTools((prev) =>
      disabled ? Array.from(new Set([...prev, toolName])) : prev.filter((n) => n !== toolName)
    )
  }

  async function handleSubmit(): Promise<void> {
    setSubmitting(true)
    const rpmTrim = writeRpmText.trim()
    const parsedRpm = rpmTrim === '' ? null : Math.max(1, Math.trunc(Number(rpmTrim)))
    const usePolicy = granularMode || ttlDirty || rpmDirty || toolsDirty
    try {
      if (editing) {
        if (usePolicy && api.mcpService.updateKeyPolicy) {
          const updated = await api.mcpService.updateKeyPolicy(editing.id, {
            ...(granularMode ? { scopes: granularScopes } : { base, extra: [...selectedExtra] }),
            ...(ttlDirty ? { ttl_days: ttlDays, ...(ttlDays === null ? { expires_at: null } : {}) } : {}),
            ...(rpmDirty ? { write_rpm_limit: Number.isFinite(parsedRpm) ? parsedRpm : null } : {}),
            ...(toolsDirty ? { disabled_tools: disabledTools } : {})
          })
          onUpdated(updated)
        } else {
          onUpdated(await api.mcpService.updateKeyScopes(editing.id, base, selectedExtra))
        }
      } else if (usePolicy && api.mcpService.createKeyWithPolicy) {
        const created = await api.mcpService.createKeyWithPolicy({
          label: label.trim(),
          ...(granularMode ? { scopes: granularScopes } : { base, extra: [...selectedExtra] }),
          ...(ttlDirty && ttlDays != null ? { ttl_days: ttlDays } : {}),
          ...(disabledTools.length > 0 ? { disabled_tools: disabledTools } : {}),
          ...(parsedRpm != null && Number.isFinite(parsedRpm)
            ? { write_rpm_limit: parsedRpm }
            : {})
        })
        onCreated(created)
      } else {
        onCreated(await api.mcpService.createKey(label.trim(), base, selectedExtra))
      }
    } catch (err) {
      toastError(
        t(editing ? 'settings.mcp.keys.updateScopesFailed' : 'settings.mcp.keys.createFailed'),
        errorMessage(err)
      )
    } finally {
      setSubmitting(false)
    }
  }

  const hasGranularCapabilities =
    options != null &&
    ((options.read_scopes?.length ?? 0) > 0 ||
      (options.available_tools?.length ?? 0) > 0 ||
      (options.ttl_presets_days?.length ?? 0) > 0)

  const canSubmit =
    options != null &&
    !submitting &&
    (editing != null || label.trim() !== '') &&
    (!granularMode || granularScopes.length > 0)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {editing
              ? t('settings.mcp.editScopes.title', { label: editing.label })
              : t('settings.mcp.create.title')}
          </DialogTitle>
          <DialogDescription>
            {editing ? t('settings.mcp.editScopes.desc') : t('settings.mcp.create.desc')}
          </DialogDescription>
        </DialogHeader>

        {editing ? null : (
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
        )}

        {optionsQuery.isError ? (
          <div className="flex items-center justify-between gap-2 text-aux">
            <span className="text-fail">{errorMessage(optionsQuery.error)}</span>
            <Button size="sm" variant="outline" onClick={() => void optionsQuery.refetch()}>
              {t('settings.mcp.retry')}
            </Button>
          </div>
        ) : !options ? (
          <div className="flex justify-center py-4">
            <Loader2 className="size-4 animate-spin text-ink-fg-3" aria-label="loading" />
          </div>
        ) : (
          <>
            {!granularMode ? (
              <>
                <div className="flex flex-col gap-1.5">
                  <div className="text-aux font-medium text-ink-fg">
                    {t('settings.mcp.create.baseLabel')}
                  </div>
                  <RadioGroup
                    value={base}
                    onValueChange={(v) => setBase(v as McpKeyBase)}
                    aria-label={t('settings.mcp.create.baseLabel')}
                  >
                    {options.bases.map(({ id: b }) => {
                      const id = `mcp-base-${b}`
                      return (
                        <div
                          key={b}
                          className={cn(
                            'flex items-start gap-2.5 rounded-md border px-3 py-2.5',
                            'transition-colors duration-fast ease-standard',
                            base === b ? 'border-coral/60' : 'border-ink-border-soft'
                          )}
                        >
                          <RadioGroupItem value={b} id={id} className="mt-1" />
                          <div className="min-w-0 flex-1">
                            <label htmlFor={id} className="block text-aux text-ink-fg cursor-pointer">
                              {t(`settings.mcp.presets.${b}.label`)}
                            </label>
                            <div className="text-meta text-ink-fg-2 mt-0.5 leading-relaxed">
                              {t(`settings.mcp.presets.${b}.desc`)}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </RadioGroup>
                </div>

                <div className="flex flex-col gap-1.5">
                  <div className="text-aux font-medium text-ink-fg">
                    {t('settings.mcp.create.extraLabel')}
                  </div>
                  {options.extras.map(({ scope, risk }) => {
                    const high = risk === 'high'
                    const checked = extra.includes(scope)
                    const descId = `mcp-extra-${scope.replace(/[^a-zA-Z0-9]/g, '-')}-desc`
                    const desc = scopeText.desc(scope)
                    return (
                      <label
                        key={scope}
                        data-risk={risk}
                        className={cn(
                          'flex items-start gap-2.5 rounded-md border px-3 py-2.5 cursor-pointer',
                          'transition-colors duration-fast ease-standard',
                          checked ? 'border-coral/60' : 'border-ink-border-soft'
                        )}
                      >
                        <Checkbox
                          className="mt-0.5"
                          checked={checked}
                          onCheckedChange={(next) => toggleExtra(scope, next)}
                          aria-label={scopeText.label(scope)}
                          aria-describedby={desc ? descId : undefined}
                        />
                        <div className="min-w-0 flex-1">
                          <div className={cn('text-aux', high ? 'text-warn' : 'text-ink-fg')}>
                            {scopeText.label(scope)}
                          </div>
                          {desc ? (
                            <div
                              id={descId}
                              className={cn(
                                'text-meta mt-0.5 leading-relaxed',
                                high ? 'text-warn' : 'text-ink-fg-2'
                              )}
                            >
                              {desc}
                            </div>
                          ) : null}
                        </div>
                      </label>
                    )
                  })}
                </div>
              </>
            ) : null}

            {hasGranularCapabilities ? (
              <div className="border-t border-ink-border-soft pt-2.5">
                <button
                  type="button"
                  aria-expanded={advancedOpen}
                  onClick={() => setAdvancedOpen((prev) => !prev)}
                  className="inline-flex items-center gap-1.5 text-aux text-coral hover:underline"
                >
                  <CollapseChevron expanded={advancedOpen} />
                  <span>{t('settings.mcp.policy.advancedToggle')}</span>
                </button>
                {advancedOpen ? (
                  <div className="mt-2.5 space-y-3 rounded-md border border-ink-border-soft bg-ink-1/40 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-aux font-medium text-ink-fg">
                        {t('settings.mcp.policy.scopeModeLabel')}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          if (granularMode) setGranularMode(false)
                          else enableGranularMode()
                        }}
                      >
                        {granularMode
                          ? t('settings.mcp.policy.usePresetMode')
                          : t('settings.mcp.policy.useGranularMode')}
                      </Button>
                    </div>

                    {granularMode ? (
                      <div className="space-y-2">
                        {(options.read_scopes?.length ?? 0) > 0 && (
                          <div className="space-y-1">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-aux text-ink-fg-2">
                                {t('settings.mcp.policy.readScopesLabel')}
                              </span>
                              <button
                                type="button"
                                onClick={() =>
                                  setGranularScopes((cur) =>
                                    Array.from(
                                      new Set([...cur, ...(options.read_scopes ?? [])])
                                    )
                                  )
                                }
                                className="text-aux text-coral hover:underline"
                              >
                                {t('settings.mcp.policy.selectAllRead')}
                              </button>
                            </div>
                            <div className="grid grid-cols-2 gap-1.5">
                              {(options.read_scopes ?? []).map((scope) => (
                                <label
                                  key={scope}
                                  className="flex items-center gap-2 rounded border border-ink-border-soft px-2 py-1.5 text-aux text-ink-fg cursor-pointer"
                                >
                                  <Checkbox
                                    checked={granularScopes.includes(scope)}
                                    onCheckedChange={(checked) =>
                                      toggleGranularScope(scope, checked)
                                    }
                                    aria-label={scopeText.label(scope)}
                                  />
                                  <span className="truncate">{scopeText.label(scope)}</span>
                                </label>
                              ))}
                            </div>
                          </div>
                        )}
                        {(options.write_scopes?.length ?? 0) > 0 && (
                          <div className="space-y-1">
                            <div className="text-aux text-ink-fg-2">
                              {t('settings.mcp.policy.writeScopesLabel')}
                            </div>
                            <div className="grid grid-cols-2 gap-1.5">
                              {(options.write_scopes ?? []).map(({ scope, risk }) => (
                                <label
                                  key={scope}
                                  className="flex items-center gap-2 rounded border border-ink-border-soft px-2 py-1.5 text-aux cursor-pointer"
                                >
                                  <Checkbox
                                    checked={granularScopes.includes(scope)}
                                    onCheckedChange={(checked) =>
                                      toggleGranularScope(scope, checked)
                                    }
                                    aria-label={scopeText.label(scope)}
                                  />
                                  <span
                                    className={cn(
                                      'truncate',
                                      risk === 'high' ? 'text-warn' : 'text-ink-fg'
                                    )}
                                  >
                                    {scopeText.label(scope)}
                                  </span>
                                </label>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ) : null}

                    <div className="grid grid-cols-2 gap-2.5">
                      <div>
                        <label
                          htmlFor="mcp-key-ttl"
                          className="mb-1 block text-aux text-ink-fg-2"
                        >
                          {t('settings.mcp.policy.ttlLabel')}
                        </label>
                        <select
                          id="mcp-key-ttl"
                          value={ttlDays == null ? 'never' : String(ttlDays)}
                          onChange={(e) => {
                            const val = e.target.value
                            setTtlDirty(true)
                            setTtlDays(val === 'never' ? null : Number(val))
                          }}
                          className="h-8 w-full rounded-[var(--r-ctl)] border border-ink-border bg-ink-1 px-2 text-aux text-ink-fg outline-none focus:border-coral"
                        >
                          <option value="never">{t('settings.mcp.policy.ttlNever')}</option>
                          <option value="7">{t('settings.mcp.policy.ttlDays', { days: 7 })}</option>
                          <option value="30">
                            {t('settings.mcp.policy.ttlDays', { days: 30 })}
                          </option>
                          <option value="90">
                            {t('settings.mcp.policy.ttlDays', { days: 90 })}
                          </option>
                        </select>
                      </div>
                      <div>
                        <label
                          htmlFor="mcp-key-rpm"
                          className="mb-1 block text-aux text-ink-fg-2"
                        >
                          {t('settings.mcp.policy.writeRpmLabel')}
                        </label>
                        <Input
                          id="mcp-key-rpm"
                          type="number"
                          min={1}
                          max={10000}
                          value={writeRpmText}
                          onChange={(e) => {
                            setRpmDirty(true)
                            setWriteRpmText(e.target.value)
                          }}
                          placeholder={t('settings.mcp.policy.writeRpmUnlimited')}
                        />
                      </div>
                    </div>

                    {(options.available_tools?.length ?? 0) > 0 && (
                      <div className="space-y-1.5">
                        <div className="text-aux text-ink-fg-2">
                          {t('settings.mcp.policy.disabledToolsLabel')}
                        </div>
                        <div className="max-h-36 space-y-1 overflow-y-auto rounded border border-ink-border-soft p-2 scrollbar-thin">
                          {(options.available_tools ?? []).map((tool) => {
                            const rawToolName = tool.tool || tool.name.replace(/^mailagent_/, '')
                            const isOff = disabledTools.includes(rawToolName)
                            return (
                              <label
                                key={tool.name}
                                className="flex items-center justify-between gap-2 text-aux cursor-pointer"
                              >
                                <span className="truncate font-mono text-meta text-ink-fg">
                                  {tool.name}
                                </span>
                                <span className="inline-flex shrink-0 items-center gap-1.5 text-aux text-ink-fg-2">
                                  <Checkbox
                                    checked={!isOff}
                                    onCheckedChange={(enabled) =>
                                      toggleDisabledTool(rawToolName, !enabled)
                                    }
                                    aria-label={tool.name}
                                  />
                                  <span>
                                    {isOff
                                      ? t('settings.mcp.policy.toolDisabled')
                                      : t('settings.mcp.policy.toolEnabled')}
                                  </span>
                                </span>
                              </label>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        )}

        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {t('settings.mcp.cancel')}
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={!canSubmit}>
            {submitting ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {editing ? t('settings.mcp.editScopes.submit') : t('settings.mcp.create.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function KeyRevealedDialog({
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
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenClientInstaller(plaintext)}
            >
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

function ClientConfigDialog({
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

interface ToolGroup {
  /** 排序后的 `auth_scopes` 连接串。 */
  id: string
  scopes: string[]
  /** 组里有任一写工具（非 readOnlyHint）。 */
  write: boolean
  items: McpExposedTool[]
}

/** 按所需权限分组：读组在前、写组在后，组内与组间都保持接口给的顺序。 */
function groupToolsByScope(tools: readonly McpExposedTool[]): ToolGroup[] {
  const groups = new Map<string, ToolGroup>()
  for (const tool of tools) {
    const scopes = [...tool.auth_scopes].sort()
    const id = scopes.join(',')
    let group = groups.get(id)
    if (!group) {
      group = { id, scopes, write: false, items: [] }
      groups.set(id, group)
    }
    group.items.push(tool)
    if (!tool.annotations.readOnlyHint) group.write = true
  }
  const all = [...groups.values()]
  return [...all.filter((g) => !g.write), ...all.filter((g) => g.write)]
}

function ToolsSection(): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const toolsQuery = useQuery({
    queryKey: qk.mcpService.tools(),
    queryFn: () => api.mcpService.tools()
  })
  // 与访问密钥一节同一个 query key，共用缓存，不多发请求。
  const keysQuery = useQuery({
    queryKey: qk.mcpService.keys(),
    queryFn: () => api.mcpService.listKeys()
  })

  const groups = groupToolsByScope(toolsQuery.data ?? [])
  const activeKeys = (keysQuery.data ?? []).filter((k) => k.active)

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
        groups.map((g) => (
          <ToolGroupBlock
            key={g.id}
            group={g}
            keyCount={activeKeys.filter((k) => g.scopes.every((s) => k.scopes.includes(s))).length}
          />
        ))
      )}
    </Section>
  )
}

function ToolGroupBlock({
  group,
  keyCount
}: {
  group: ToolGroup
  keyCount: number
}): React.ReactElement {
  const { t, i18n } = useTranslation()
  const scopeText = useScopeText()
  // 写入组默认折叠：工具多，且读者通常先关心「有什么能读」。
  const [expanded, setExpanded] = React.useState(!group.write)
  const regionId = `mcp-tools-${group.id.replace(/[^a-zA-Z0-9]/g, '-') || 'none'}`
  const name =
    group.scopes.length > 0
      ? joinLabels(i18n.language, group.scopes.map(scopeText.label))
      : t('settings.mcp.tools.noScope')

  return (
    <div data-testid="mcp-tool-group">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={regionId}
        className={cn(
          'flex w-full items-center gap-1.5 px-[var(--settings-tile-px,1rem)] py-2 text-left',
          'text-meta text-ink-fg-2 hover:bg-ink-3',
          'transition-colors duration-fast ease-standard'
        )}
      >
        <CollapseChevron expanded={expanded} />
        <span className="font-medium">
          {t('settings.mcp.tools.groupTitle', { name, count: group.items.length })}
        </span>
        <span className="ml-auto text-ink-fg-3">
          {t('settings.mcp.tools.groupKeys', { count: keyCount })}
        </span>
      </button>
      <CollapsibleRegion
        expanded={expanded}
        id={regionId}
        bodyClassName="border-t border-ink-border-soft divide-y divide-ink-border-soft"
      >
        {group.items.map((tool) => (
          <ToolRow key={tool.name} tool={tool} />
        ))}
      </CollapsibleRegion>
    </div>
  )
}

function ToolRow({ tool }: { tool: McpExposedTool }): React.ReactElement {
  const { t } = useTranslation()
  const readOnly = tool.annotations.readOnlyHint
  return (
    <Row
      compact
      label={tool.title || tool.name}
      helper={
        <span title={tool.description} className="font-mono">
          {tool.name}
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
