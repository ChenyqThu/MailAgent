// Connectors 配置台 —— 未连接目录条目 + Composio 账户 两个右栏 detail（Lane B）。
//
// 双轨（08-06 契约 §3）在这里分岔：
//   · `composio` 轨：受 BYOK gate 约束（没配 key → 连接 disabled + 三步引导跳「Composio
//     账户」面）；首连过一次性出站告知 confirm；远程 web 也能连（授权页在 Composio 云上）。
//   · `direct` 轨：自建 OAuth 2.1 + PKCE + DCR 对官方端点 —— 不需要任何 key、不经
//     Composio、不弹出站告知；🔴 远程 web **不能**发起（回调走本机 loopback），disabled +
//     明示去桌面 App。工具数不显示（那一轨没有 curated 白名单，清单以连上后 tools/list
//     实际返回为准 —— 编个数字就是撒谎）。

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'

import { useMailApi } from '@shared/hooks/useMailApi'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { toastError, toastSuccess } from '@shared/state/toast'
import type { ComposioKeyStatus, ConnectorCatalogEntry } from '@shared/api/types'
import { Button } from '@shared/components/ui/button'
import { Input } from '@shared/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@shared/components/ui/dialog'

import {
  PILL_BASE,
  formatEpoch,
  isWebBuild,
  openExternal,
  readComposioNoticeAck,
  resolveCatalogTrack,
  writeComposioNoticeAck
} from './consoleShared'

/** 品牌字母牌（代码内数据，零网络）——见 `catalog.py` 的 logo 取舍注释。 */
export function CatalogLogo({
  entry,
  size = 'md'
}: {
  entry: ConnectorCatalogEntry
  size?: 'sm' | 'md'
}): React.ReactElement {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex shrink-0 items-center justify-center rounded-[var(--r-ctl)] font-semibold text-white',
        size === 'md' ? 'size-8 text-aux' : 'size-5 text-[10px]'
      )}
      style={{ backgroundColor: entry.logo_color }}
    >
      {entry.logo_text}
    </span>
  )
}

export function CatalogDetailPane({
  entry,
  keyConfigured,
  onSelectComposio
}: {
  entry: ConnectorCatalogEntry
  /** Composio BYOK key 是否已配（gate 判据；direct 轨不消费）。 */
  keyConfigured: boolean
  /** 跳到「Composio 账户」面（三步引导的落点）。 */
  onSelectComposio(): void
}): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const qc = useQueryClient()
  const isWeb = isWebBuild()
  const track = resolveCatalogTrack(entry)
  const [connecting, setConnecting] = React.useState(false)
  // 出站告知②：首次连接任一 Composio 轨服务前的一次性 confirm。直连轨不经它。
  const [noticeOpen, setNoticeOpen] = React.useState(false)

  async function startConnect(): Promise<void> {
    setConnecting(true)
    try {
      const started = await api.connector.oauthStart(entry.connector_id)
      // 🔴 没有 URL = 这家在 Composio 侧之前就授权过：不开浏览器，行已建出来。
      if (started.authorize_url) openExternal(started.authorize_url)
      // 行由授权流建出来 → 刷新列表与目录；选中项归一成 connector detail 后由它接手轮询。
      await qc.invalidateQueries({ queryKey: qk.connectors() })
      await qc.invalidateQueries({ queryKey: qk.connectorCatalog() })
    } catch (err) {
      toastError(t('settings.connectors.authFailed'), errorMessage(err))
    } finally {
      setConnecting(false)
    }
  }

  function handleConnect(): void {
    if (track === 'composio' && !readComposioNoticeAck()) {
      setNoticeOpen(true)
      return
    }
    void startConnect()
  }

  // direct 轨在 web 面结构性连不上（loopback 回调）；composio 轨不受限。
  const webBlocked = track === 'direct' && isWeb
  const gateBlocked = track === 'composio' && !keyConfigured
  const disabled = entry.configured || connecting || webBlocked || gateBlocked

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <CatalogLogo entry={entry} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lead font-medium text-ink-fg">{entry.display_name}</h2>
              <span className={cn(PILL_BASE, 'bg-ink-4 text-ink-fg-3')}>
                {track === 'composio'
                  ? t('settings.connectors.viaComposio')
                  : t('settings.connectors.viaDirect')}
              </span>
              {/* 🔴 direct 轨 tool_count 恒 null：清单来自官方端点 tools/list，连上之前
                  拿不到数量 —— 渲染成「0 个工具」是说谎，如实说「连接后获取」。 */}
              {typeof entry.tool_count === 'number' ? (
                <span className={cn(PILL_BASE, 'bg-ink-4 text-ink-fg-3')}>
                  {t('settings.connectors.catalog.toolCount', { count: entry.tool_count })}
                </span>
              ) : (
                <span className={cn(PILL_BASE, 'bg-ink-4 text-ink-fg-3')}>
                  {t('connectorsConsole.toolCountUnknown')}
                </span>
              )}
            </div>
            <p className="mt-1 text-aux leading-relaxed text-ink-fg-2">
              {t(entry.description_key)}
            </p>
            {track === 'direct' && entry.server_url ? (
              <div className="mt-1 truncate font-mono text-meta text-ink-fg-2">
                {entry.server_url}
              </div>
            ) : null}
            {/* 出站告知①：composio 轨的常驻声明（不折叠、不 hover 才出现）。 */}
            {track === 'composio' ? (
              <p className="mt-1 text-meta text-ink-fg-3">
                {t('settings.connectors.catalog.outboundNotice')}
              </p>
            ) : (
              <p className="mt-1 text-meta text-ink-fg-3">
                {t('connectorsConsole.directTrackNote')}
              </p>
            )}
            {entry.superseded ? (
              <p className="mt-1 text-micro text-warn">
                {t('settings.connectors.catalog.supersedes')}
              </p>
            ) : null}
            {webBlocked ? (
              <p className="mt-1 text-micro text-ink-fg-3">{t('settings.connectors.connectWeb')}</p>
            ) : null}
          </div>
        </div>
        <div className="shrink-0">
          <Button
            size="sm"
            variant={entry.configured ? 'ghost' : 'default'}
            disabled={disabled}
            title={webBlocked ? t('settings.connectors.connectWeb') : undefined}
            onClick={handleConnect}
          >
            {connecting ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {entry.configured
              ? t('settings.connectors.catalog.alreadyAdded')
              : t('settings.connectors.connect')}
          </Button>
        </div>
      </div>

      {/* BYOK gate（composio 轨 · 没配 key）：三步引导 + 跳「Composio 账户」面。 */}
      {gateBlocked && !entry.configured ? (
        <div className="mt-3 rounded-[var(--r-card)] border border-ink-border bg-ink-4/40 p-3">
          <div className="text-aux font-medium text-ink-fg">
            {t('settings.connectors.catalog.gateTitle')}
          </div>
          <div className="mt-0.5 whitespace-pre-line text-meta text-ink-fg-2">
            {t('settings.connectors.catalog.gateBody')}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" onClick={onSelectComposio}>
              {t('settings.connectors.catalog.gateCta')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => openExternal('https://app.composio.dev')}
            >
              {t('settings.connectors.catalog.gateSignup')}
            </Button>
          </div>
        </div>
      ) : null}

      {/* 出站告知②：一次性 confirm —— 数据过境 / token 托管 / 去 dashboard 关日志留存。 */}
      <Dialog
        open={noticeOpen}
        onOpenChange={(open) => {
          if (!open) setNoticeOpen(false)
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.connectors.catalog.outboundDialog.title')}</DialogTitle>
            <DialogDescription className="whitespace-pre-line">
              {t('settings.connectors.catalog.outboundDialog.desc')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setNoticeOpen(false)}>
              {t('settings.connectors.catalog.outboundDialog.cancel')}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setNoticeOpen(false)
                writeComposioNoticeAck()
                void startConnect()
              }}
            >
              {t('settings.connectors.catalog.outboundDialog.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** 「Composio 账户」面 —— BYOK key 只写不回显；已配置时只显示「什么时候配的」。 */
export function ComposioAccountPane({
  status
}: {
  status: ComposioKeyStatus | null
}): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const qc = useQueryClient()
  const [keyDraft, setKeyDraft] = React.useState('')
  const [savingKey, setSavingKey] = React.useState(false)
  const configured = status?.configured === true

  async function saveKey(): Promise<void> {
    const value = keyDraft.trim()
    if (!value) return
    setSavingKey(true)
    try {
      await api.connector.setComposioKey(value)
      // 🔴 明文只在这一刻存在于内存里，保存后立刻清空输入框（不做任何回显）。
      setKeyDraft('')
      await qc.invalidateQueries({ queryKey: qk.connectors() })
      toastSuccess(t('settings.connectors.catalog.keySaved'))
    } catch (err) {
      toastError(t('settings.connectors.saveFailed'), errorMessage(err))
    } finally {
      setSavingKey(false)
    }
  }

  async function clearKey(): Promise<void> {
    try {
      await api.connector.clearComposioKey()
      await qc.invalidateQueries({ queryKey: qk.connectors() })
    } catch (err) {
      toastError(t('settings.connectors.saveFailed'), errorMessage(err))
    }
  }

  return (
    <div>
      <h2 className="text-lead font-medium text-ink-fg">
        {t('connectorsConsole.composioAccount')}
      </h2>
      <p className="mt-1 text-aux leading-relaxed text-ink-fg-2">
        {t('settings.connectors.catalog.outboundNotice')}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Input
          type="password"
          value={keyDraft}
          autoComplete="off"
          spellCheck={false}
          placeholder={t('settings.connectors.catalog.keyPlaceholder')}
          aria-label={t('settings.connectors.catalog.keyLabel')}
          className="h-8 max-w-xs flex-1 text-aux"
          onChange={(e) => setKeyDraft(e.target.value)}
        />
        <Button
          size="sm"
          disabled={savingKey || keyDraft.trim() === ''}
          onClick={() => void saveKey()}
        >
          {savingKey ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {t('settings.connectors.catalog.keySave')}
        </Button>
        {configured ? (
          <>
            <span className="text-micro text-ink-fg-3">
              {t('settings.connectors.catalog.keyConfigured', {
                time: formatEpoch(status?.updated_at) ?? '—'
              })}
            </span>
            <Button size="sm" variant="ghost" onClick={() => void clearKey()}>
              {t('settings.connectors.catalog.keyClear')}
            </Button>
          </>
        ) : null}
      </div>

      {!configured ? (
        <div className="mt-3 rounded-[var(--r-card)] border border-ink-border bg-ink-4/40 p-3">
          <div className="text-aux font-medium text-ink-fg">
            {t('settings.connectors.catalog.gateTitle')}
          </div>
          <div className="mt-0.5 whitespace-pre-line text-meta text-ink-fg-2">
            {t('settings.connectors.catalog.gateBody')}
          </div>
          <div className="mt-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => openExternal('https://app.composio.dev')}
            >
              {t('settings.connectors.catalog.gateSignup')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
