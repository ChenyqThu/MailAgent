// task 08-20 Notion OAuth — 设置页「连接 Notion」区（Lane 3）。
//
// 一次授权替掉四件手工活：建 internal integration、复制 token、复制模板库、
// 从 URL 抠 database id。状态机与 IPC 在 @shared/hooks/useNotionOauthFlow，
// 这里只画界面。
//
// 三条诚实性纪律（design.md v2「UI 状态」，逐条对应）：
//   1. **已连接判据 = token 已设 ∧ NOTION_WORKSPACE_ID ∧ EMAIL_DATABASE_ID**
//      （isNotionOauthConnected 单源）。只看 workspace 名会把半配置显示成已连接。
//   2. 「从本机移除连接」不叫「断开」—— Notion 侧的授权仍然存在，文案必须说清
//      去哪儿撤销；也**不提供**「保留 token 只清显示」（那会造成「界面显示未连接、
//      后台仍在同步」的假象）。
//   3. 每个 errorCode 一句具体文案，不做「操作失败」这种等于没说的兜底。
//
// token 明文全程不过 renderer：main 直接写 .env，这里只在写成功后刷新 env 快照
//（secret 在 env:get 里恒为掩码）并标记「需重启后端」。

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, Loader2 } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { Button } from '@shared/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@shared/components/ui/dialog'
import { useNotionOauthFlow } from '@shared/hooks/useNotionOauthFlow'
import {
  isNotionOauthConnected,
  NOTION_OAUTH_ENV_KEYS,
  type NotionOauthErrorCode,
  type NotionOauthPhase
} from '@shared/lib/notionOauthContract'
import { removeNotionConnection } from '@shared/lib/notionOauthIpc'
import { useEnvStore } from '@shared/state/env'
import { useRestartStore } from '@shared/state/restart'
import { toastError, toastSuccess } from '@shared/state/toast'

import { Row } from './Row'
import { NotionDbSelectDialog } from './NotionDbSelectDialog'

/** 进行中的阶段（既未成功也未失败）——决定「取消」按钮与进度条文案的显隐。 */
const IN_FLIGHT_PHASES: ReadonlySet<NotionOauthPhase> = new Set<NotionOauthPhase>([
  'waiting_callback',
  'exchanging',
  'discovering',
  'need_selection',
  'writing'
])

function usePhaseText(): (phase: NotionOauthPhase) => string {
  const { t } = useTranslation()
  return (phase) => {
    switch (phase) {
      case 'waiting_callback':
        return t('settings.accounts.notion.oauth.phase.waitingCallback', {
          defaultValue: '已在浏览器打开 Notion 授权页，请在那里完成授权（本页保持打开）。'
        })
      case 'exchanging':
        return t('settings.accounts.notion.oauth.phase.exchanging', {
          defaultValue: '正在换取访问令牌…'
        })
      case 'discovering':
        return t('settings.accounts.notion.oauth.phase.discovering', {
          defaultValue: '正在识别邮件库与日历库…'
        })
      case 'need_selection':
        return t('settings.accounts.notion.oauth.phase.needSelection', {
          defaultValue: '需要你选择要使用的数据库。'
        })
      case 'writing':
        return t('settings.accounts.notion.oauth.phase.writing', {
          defaultValue: '正在写入配置…'
        })
      case 'done':
        return t('settings.accounts.notion.oauth.phase.done', { defaultValue: '授权完成。' })
      case 'error':
        return t('settings.accounts.notion.oauth.phase.error', { defaultValue: '授权未完成。' })
    }
  }
}

function useErrorText(): (code: NotionOauthErrorCode | null) => string {
  const { t } = useTranslation()
  return (code) => {
    switch (code) {
      case 'client_id_missing':
        return t('settings.accounts.notion.oauth.error.clientIdMissing', {
          defaultValue: '本机没有可用的 Notion 集成 ID，无法发起授权。请更新到新版本或手动填写。'
        })
      case 'port_unavailable':
        return t('settings.accounts.notion.oauth.error.portUnavailable', {
          defaultValue:
            '本机 9280 与 9281 端口都被占用，收不到 Notion 的回调。关掉占用这两个端口的程序后重试。'
        })
      case 'browser_open_failed':
        return t('settings.accounts.notion.oauth.error.browserOpenFailed', {
          defaultValue: '打不开系统浏览器，授权未发起。'
        })
      case 'denied':
        return t('settings.accounts.notion.oauth.error.denied', {
          defaultValue: '你在 Notion 页面取消了授权，原有配置未改动。'
        })
      case 'timeout':
        return t('settings.accounts.notion.oauth.error.timeout', {
          defaultValue: '5 分钟内没有完成授权，本次已取消，原有配置未改动。'
        })
      case 'cancelled':
        return t('settings.accounts.notion.oauth.error.cancelled', {
          defaultValue: '授权已取消，原有配置未改动。'
        })
      case 'invalid_grant':
        return t('settings.accounts.notion.oauth.error.invalidGrant', {
          defaultValue: '授权码已失效（多为等待过久），请重新授权。'
        })
      case 'upstream_error':
        return t('settings.accounts.notion.oauth.error.upstreamError', {
          defaultValue: 'Notion 侧换取令牌失败，请稍后重试。'
        })
      case 'not_configured':
        return t('settings.accounts.notion.oauth.error.notConfigured', {
          defaultValue: '授权服务暂不可用，请稍后重试，或先用下方手动填写。'
        })
      case 'rate_limited':
        return t('settings.accounts.notion.oauth.error.rateLimited', {
          defaultValue: '短时间内尝试次数过多，请等一分钟再试。'
        })
      case 'invalid_redirect_uri':
        return t('settings.accounts.notion.oauth.error.invalidRedirectUri', {
          defaultValue: '回调地址未被授权服务接受，请更新到新版本。'
        })
      case 'network_error':
        return t('settings.accounts.notion.oauth.error.networkError', {
          defaultValue: '网络不可达，换取令牌失败，原有配置未改动。'
        })
      case 'invalid_response':
        return t('settings.accounts.notion.oauth.error.invalidResponse', {
          defaultValue: '授权服务返回了无法识别的内容，原有配置未改动。'
        })
      case 'discovery_failed':
        return t('settings.accounts.notion.oauth.error.discoveryFailed', {
          defaultValue: '读取 Notion 数据库失败。请重新授权，并确认已把需要的页面授权给 MailAgent。'
        })
      case 'no_databases_found':
        return t('settings.accounts.notion.oauth.error.noDatabasesFound', {
          defaultValue:
            '在已授权的内容里没找到数据库。请重新授权并选择复制模板，或勾选包含邮件库、日历库的页面。'
        })
      case 'selection_invalid':
        return t('settings.accounts.notion.oauth.error.selectionInvalid', {
          defaultValue: '所选数据库不可用（可能已被改动或不再可见），请重新选择。'
        })
      case 'env_write_failed':
        return t('settings.accounts.notion.oauth.error.envWriteFailed', {
          defaultValue: '配置写入失败，原有配置未改动（详见应用日志）。'
        })
      default:
        return t('settings.accounts.notion.oauth.error.unknown', {
          defaultValue: '授权未完成，原有配置未改动。'
        })
    }
  }
}

/** 「从本机移除连接」确认框 —— 会清掉 token 与两个库 ID，值得一次确认。 */
function RemoveConnectionDialog({
  open,
  busy,
  onCancel,
  onConfirm
}: {
  open: boolean
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t('settings.accounts.notion.oauth.remove.title', { defaultValue: '从本机移除连接' })}
          </DialogTitle>
          <DialogDescription>
            {t('settings.accounts.notion.oauth.remove.description', {
              defaultValue:
                '将清除本机保存的 Notion Token、邮件库与日历库 ID，以及 workspace 信息；Notion 侧的授权仍然存在，如需彻底撤销请到 Notion 的「设置 → 我的连接」里移除 MailAgent。已同步到 Notion 的邮件不受影响。'
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {t('settings.accounts.notion.oauth.remove.cancel', { defaultValue: '取消' })}
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={busy}>
            {t('settings.accounts.notion.oauth.remove.confirm', { defaultValue: '移除连接' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function NotionConnection(): React.ReactElement {
  const { t } = useTranslation()
  const phaseText = usePhaseText()
  const errorText = useErrorText()
  const markRestartRequired = useRestartStore((s) => s.markRestartRequired)
  const [removeOpen, setRemoveOpen] = React.useState(false)
  const [removing, setRemoving] = React.useState(false)

  const connected = useEnvStore((s) =>
    s.state.status === 'ready' ? isNotionOauthConnected(s.state.snapshot.values) : false
  )
  const workspaceName = useEnvStore((s) =>
    s.state.status === 'ready' ? (s.state.snapshot.values['NOTION_WORKSPACE_NAME'] ?? '') : ''
  )

  // NOTION_OAUTH_ENV_KEYS 由 main 原子写；renderer 只需重读快照（secret 恒掩码）+ 标记需重启。
  const handleWritten = React.useCallback(() => {
    void useEnvStore.getState().refresh()
    markRestartRequired([...NOTION_OAUTH_ENV_KEYS])
  }, [markRestartRequired])

  const flow = useNotionOauthFlow({ onWritten: handleWritten })
  const inFlight = flow.phase !== null && IN_FLIGHT_PHASES.has(flow.phase)

  const handleRemove = React.useCallback(() => {
    setRemoving(true)
    void removeNotionConnection()
      .then((res) => {
        setRemoving(false)
        setRemoveOpen(false)
        if (res?.ok) {
          void useEnvStore.getState().refresh()
          markRestartRequired([...NOTION_OAUTH_ENV_KEYS])
          toastSuccess(
            t('settings.accounts.notion.oauth.remove.done', { defaultValue: '已从本机移除连接' })
          )
        } else {
          toastError(
            t('settings.accounts.notion.oauth.remove.failTitle', { defaultValue: '移除失败' }),
            errorText('env_write_failed')
          )
        }
      })
      .catch(() => {
        setRemoving(false)
        setRemoveOpen(false)
        toastError(
          t('settings.accounts.notion.oauth.remove.failTitle', { defaultValue: '移除失败' }),
          errorText('env_write_failed')
        )
      })
  }, [errorText, markRestartRequired, t])

  return (
    <>
      <Row
        label={
          connected
            ? workspaceName ||
              t('settings.accounts.notion.oauth.connectedUnknownWorkspace', {
                defaultValue: '已连接 Notion'
              })
            : t('settings.accounts.notion.oauth.connect.label', { defaultValue: '连接 Notion' })
        }
        helper={
          connected
            ? t('settings.accounts.notion.oauth.connectedHelper', {
                defaultValue:
                  '已通过 Notion 授权连接。「从本机移除连接」只清本机配置；Notion 侧的授权需要到 Notion 的「设置 → 我的连接」里撤销。'
              })
            : t('settings.accounts.notion.oauth.connect.helper', {
                defaultValue:
                  '在浏览器里授权一次即可，可顺带复制官方模板；完成后 Token 与两个数据库 ID 自动写入，无需手填。'
              })
        }
      >
        <div className="flex items-center gap-2">
          <Button
            variant={connected ? 'secondary' : 'default'}
            size="sm"
            onClick={flow.start}
            disabled={flow.busy || inFlight}
          >
            {flow.busy || inFlight ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : null}
            {connected
              ? t('settings.accounts.notion.oauth.reauthorize', { defaultValue: '重新授权' })
              : t('settings.accounts.notion.oauth.connect.button', { defaultValue: '连接 Notion' })}
          </Button>
          {connected ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setRemoveOpen(true)}
              disabled={inFlight || removing}
            >
              {t('settings.accounts.notion.oauth.remove.button', {
                defaultValue: '从本机移除连接'
              })}
            </Button>
          ) : null}
        </div>
      </Row>

      {inFlight || flow.phase === 'error' || flow.doneInfo ? (
        <div className="px-[var(--settings-tile-px,1rem)] pb-[var(--settings-tile-py,0.875rem)] -mt-1">
          <div
            role="status"
            className={cn(
              'flex items-start gap-2 rounded-lg border px-2.5 py-2',
              flow.phase === 'error'
                ? 'border-fail/30 bg-fail/10'
                : flow.doneInfo
                  ? 'border-ok/30 bg-ok/10'
                  : 'border-ink-border bg-ink-2/50'
            )}
          >
            {flow.phase === 'error' ? null : flow.doneInfo ? (
              <CheckCircle2 size={13} className="shrink-0 mt-0.5 text-ok" aria-hidden="true" />
            ) : (
              <Loader2
                size={13}
                className="shrink-0 mt-0.5 text-ink-fg-2 animate-spin"
                aria-hidden="true"
              />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-aux text-ink-fg-1 leading-relaxed">
                {flow.phase === 'error'
                  ? errorText(flow.errorCode)
                  : flow.doneInfo
                    ? t('settings.accounts.notion.oauth.doneDetail', {
                        emailDb: flow.doneInfo.emailDbTitle,
                        calendarDb: flow.doneInfo.calendarDbTitle,
                        defaultValue:
                          '已连接。邮件库「{emailDb}」，日历库「{calendarDb}」。重启后端后开始同步到 Notion。'
                      })
                    : phaseText(flow.phase ?? 'waiting_callback')}
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={inFlight ? flow.cancel : flow.dismiss}>
              {inFlight
                ? t('settings.accounts.notion.oauth.cancel', { defaultValue: '取消' })
                : t('settings.accounts.notion.oauth.dismiss', { defaultValue: '知道了' })}
            </Button>
          </div>
        </div>
      ) : null}

      <NotionDbSelectDialog
        open={flow.phase === 'need_selection' && flow.candidates !== null}
        candidates={flow.candidates ?? []}
        busy={flow.busy}
        errorText={flow.errorCode ? errorText(flow.errorCode) : null}
        onCancel={flow.cancel}
        onSubmit={flow.submitSelection}
      />

      <RemoveConnectionDialog
        open={removeOpen}
        busy={removing}
        onCancel={() => setRemoveOpen(false)}
        onConfirm={handleRemove}
      />
    </>
  )
}
