// MCP connection address & Cloudflare public-URL guide section.

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Copy, Loader2 } from 'lucide-react'

import { openExternal } from '@shared/components/connectors/consoleShared'
import { Button } from '@shared/components/ui/button'
import { CollapseChevron, CollapsibleRegion } from '@shared/components/ui/collapsible'
import { Input } from '@shared/components/ui/input'
import { useMailApi } from '@shared/hooks/useMailApi'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { applyEnvPatch } from '@shared/state/env'
import { toastError, toastSuccess } from '@shared/state/toast'

import { Row } from '../../parts/Row'
import { Section } from '../../parts/Section'
import {
  CLOUDFLARE_TUNNEL_DOCS_URL,
  hostOf,
  isReachable,
  portOf,
  PUBLIC_URL_ENV_KEY,
  useCopy,
  validatePublicUrl,
  type ProbeState,
  type PublicUrlError
} from './mcpServiceUtils'

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

// ── 连接地址 ────────────────────────────────────────────────────────────────

export function ConnectionSection({
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
