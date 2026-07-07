// V2 Remote Access — serve-api 远程访问配置 tab.
//
// 把 V2 远程访问从 dogfood (手动 nohup serve-api) 收尾成生产态的用户侧入口:
// serve-api 进程由打包 app 的 BackendLifecycleManager 托管 (lifecycle agent 负责),
// 本 tab 只负责把 5 个 .env 字段经 env:set 写进 app .env + 展示状态 + 提供重启。
//
// 字段 (全部经 <EnvField> → env:set → 乐观更新 useEnvStore → markRestartRequired,
// 所以顶部全局 RestartBanner 改字段后会自动浮出):
//   - MAILAGENT_REMOTE_ACCESS_ENABLED (toggle, 默认开): serve-api 启停 gate。
//   - CF_AUDIENCE (text): Cloudflare Access Application Audience tag。空 → serve-api
//     auth.py import 期 raise → 进程拒起 (lifecycle 软门控会处理, 这里 UI 提示必填)。
//   - CF_TEAM_DOMAIN (text): xxx.cloudflareaccess.com 团队域名。
//   - MAILAGENT_API_PORT (number, 默认 8200): 本地 API 端口, bind 127.0.0.1。
//   - MAILAGENT_API_ALLOWED_EMAIL (text, 留空=USER_EMAIL): 放行邮箱。
//
// CF/port/email 子字段在总开关 OFF 时 disabled — 关掉远程访问后不需要再填这些。
//
// 状态区:
//   - 进程状态 chip: 经 services.status() 读 mail-sync 状态作近似信号 (serve-api
//     专属 probe IPC 由 lifecycle agent 后续提供, 见 TODO)。
//   - 访问 URL: 从 CF_TEAM_DOMAIN + ALLOWED_EMAIL 派生展示 (public 隧道 hostname
//     是用户自管的 cloudflared tunnel, 非本 app env, 故给 runbook 指引而非硬拼)。
//   - "改配置后需重启 serve-api 生效" 提示 + 重启按钮 (services.restart('mail-sync'),
//     与 RestartBanner 同契约; 打包态 pm2 分流由 lifecycle agent 处理)。
//   - cloudflared tunnel 需用户自行 pm2/launchd 托管的 runbook 提示 (不在 app 生命周期内)。

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  ExternalLink,
  Globe,
  Loader2,
  RefreshCw
} from 'lucide-react'

import { useEnvStore } from '@shared/state/env'
import { useMailApi } from '@shared/hooks/useMailApi'
import { toastError, toastSuccess } from '@shared/state/toast'
import { cn } from '@shared/lib/cn'
import type { ServiceStatus } from '@shared/api/types'

import { PageHeader } from '../parts/PageHeader'
import { Section } from '../parts/Section'
import { Row } from '../parts/Row'
import { EnvField } from '../parts/EnvField'

const DEFAULT_API_PORT = '8200'
const STATUS_PROBE_DELAY_MS = 1500
const STATUS_PROBE_TIMEOUT_MS = 5000

/** Read a single managed-env value out of the store without subscribing the
 *  whole component to every key — mirrors how EnvField pulls `s.state`. */
function useEnvValue(key: string): string {
  return useEnvStore((s) =>
    s.state.status === 'ready' ? (s.state.snapshot.values[key] ?? '') : ''
  )
}

function isToggleOn(value: string): boolean {
  // serveApiEnabled() 语义: !=='false' 即开 (默认开)。这里同步: 空 / 'true' / '1'
  // 都算开, 仅显式 'false' / '0' 关。
  const v = value.trim().toLowerCase()
  return v !== 'false' && v !== '0'
}

type ProbeState = 'idle' | 'loading' | 'online' | 'stopped' | 'errored' | 'unknown'

function StatusChip({ state }: { state: ProbeState }): React.ReactElement {
  const { t } = useTranslation()
  const map: Record<ProbeState, { chipClass: string; dotClass: string; labelKey: string }> = {
    idle: {
      chipClass: 'bg-ink-3 text-ink-fg-2',
      dotClass: 'bg-ink-fg-3',
      labelKey: 'settings.remote.status.idle'
    },
    loading: {
      chipClass: 'bg-coral/15 text-coral',
      dotClass: 'bg-coral/100 animate-pulse motion-reduce:animate-none',
      labelKey: 'settings.remote.status.loading'
    },
    online: {
      chipClass: 'bg-ok/15 text-ok',
      dotClass: 'bg-ok',
      labelKey: 'settings.remote.status.online'
    },
    stopped: {
      chipClass: 'bg-ink-3 text-ink-fg-2',
      dotClass: 'bg-ink-fg-3',
      labelKey: 'settings.remote.status.stopped'
    },
    errored: {
      chipClass: 'bg-fail/15 text-fail',
      dotClass: 'bg-fail',
      labelKey: 'settings.remote.status.errored'
    },
    unknown: {
      chipClass: 'bg-ink-3 text-ink-fg-2',
      dotClass: 'bg-ink-fg-3',
      labelKey: 'settings.remote.status.unknown'
    }
  }
  const entry = map[state]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-meta font-mono',
        entry.chipClass
      )}
    >
      <span className={cn('w-1.5 h-1.5 rounded-full', entry.dotClass)} />
      {t(entry.labelKey)}
    </span>
  )
}

export function RemoteAccessTab(): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()

  const enabledRaw = useEnvValue('MAILAGENT_REMOTE_ACCESS_ENABLED')
  const cfTeamDomain = useEnvValue('CF_TEAM_DOMAIN')
  const cfAudience = useEnvValue('CF_AUDIENCE')
  const apiPort = useEnvValue('MAILAGENT_API_PORT')
  const allowedEmail = useEnvValue('MAILAGENT_API_ALLOWED_EMAIL')
  const userEmail = useEnvValue('USER_EMAIL')

  const remoteEnabled = isToggleOn(enabledRaw)
  // CF/port/email 仅在远程访问开启时可编辑。
  const subFieldsDisabled = !remoteEnabled

  // serve-api 专属 status/health probe IPC 暂未由 lifecycle agent 提供;
  // TODO(lifecycle): 替换成 'backend:serviceState'('serve-api') + probeApiHealth。
  // 在此之前用 services.status() 的 mail-sync 状态作近似 (后端进程整体是否在线)。
  const [probe, setProbe] = React.useState<ProbeState>('idle')
  const [restarting, setRestarting] = React.useState(false)

  // User-triggered refresh (refresh button + post-restart): flip to loading
  // immediately (event-handler setState is allowed) then write the probe result.
  // `api` is a cheap stable singleton (makeMailApi()) so depping on it is safe.
  const refreshStatus = React.useCallback(async (): Promise<void> => {
    setProbe('loading')
    try {
      const list = await api.services.status()
      const mailSync = list.find((s: ServiceStatus) => s.name === 'mail-sync')
      setProbe(mailSync?.state ?? 'unknown')
    } catch {
      // HttpApi V2 stub on web build, or pm2 absent — fall back to unknown
      // rather than surfacing a scary error; the runbook hint covers it.
      setProbe('unknown')
    }
  }, [api])

  // Mount probe — inline promise chain (mirrors RealtimeStorageTab's settings
  // fetch): the setProbe write lands in a `.then`/`.catch` callback, not in the
  // effect body, and the `cancelled` flag drops a stale write after unmount.
  React.useEffect(() => {
    let cancelled = false
    void api.services
      .status()
      .then((list) => {
        if (cancelled) return
        const mailSync = list.find((s: ServiceStatus) => s.name === 'mail-sync')
        setProbe(mailSync?.state ?? 'unknown')
      })
      .catch(() => {
        if (!cancelled) setProbe('unknown')
      })
    return () => {
      cancelled = true
    }
  }, [api])

  async function handleRestart(): Promise<void> {
    setRestarting(true)
    try {
      // serve-api 专属重启: 打包态 services.ts 把它分流到
      // getBackendLifecycle().restartService('serve-api') (热读 env:set 同步后的
      // process.env), dev 态走 pm2(无此进程 → E_PM2_NOT_FOUND fallback 提示)。
      const result = await api.services.restart('serve-api')
      if (result.ok) {
        toastSuccess(t('settings.remote.restart.requested'))
        await new Promise<void>((resolve) => setTimeout(resolve, STATUS_PROBE_DELAY_MS))
        await Promise.race([
          refreshStatus(),
          new Promise<void>((resolve) => setTimeout(resolve, STATUS_PROBE_TIMEOUT_MS))
        ])
      } else if (result.error?.code === 'E_PM2_NOT_FOUND') {
        // 打包态无 pm2 — lifecycle agent 会把 packaged 重启分流到
        // getBackendLifecycle().restart(); 在那之前给终端命令兜底。
        toastError(
          t('settings.remote.restart.pm2NotFound'),
          result.error.fallbackCommand ?? 'pm2 restart mail-sync'
        )
      } else {
        toastError(
          t('settings.remote.restart.failed'),
          result.error?.message ?? result.stderr ?? 'unknown'
        )
      }
    } catch (err) {
      toastError(t('settings.remote.restart.failed'), (err as Error).message)
    } finally {
      setRestarting(false)
    }
  }

  // 访问 URL 展示: public 隧道 hostname 是用户自管的 cloudflared tunnel, 非 app
  // 持有的 env, 无法硬拼出去。能从已知 env 给出的是 Cloudflare Zero Trust 团队
  // 域名 (dashboard) + 本地 loopback 地址。public app URL 走 runbook 文案提示
  // (用户在 cloudflared 配置里把 tunnel hostname 指向 127.0.0.1:<port>/app)。
  const port = (apiPort.trim() || DEFAULT_API_PORT).trim()
  const localUrl = `http://127.0.0.1:${port}/app`
  const teamDomainUrl = cfTeamDomain.trim()
    ? `https://${cfTeamDomain.trim().replace(/^https?:\/\//, '')}`
    : ''
  const effectiveEmail = allowedEmail.trim() || userEmail.trim()

  const [copied, setCopied] = React.useState<string | null>(null)
  async function copy(value: string, which: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(which)
      setTimeout(() => setCopied((c) => (c === which ? null : c)), 1500)
    } catch {
      /* clipboard blocked — non-fatal, user can select manually */
    }
  }

  return (
    <>
      <PageHeader
        eyebrow={t('settings.remote.page.eyebrow', { defaultValue: 'REMOTE ACCESS' })}
        title={t('settings.remote.page.title', { defaultValue: '远程访问' })}
        description={t('settings.remote.page.intro', {
          defaultValue:
            '通过 Cloudflare Access 在外网安全访问邮件 Web 界面。serve-api 仅监听 127.0.0.1，由 Cloudflare 隧道转发并强制零信任鉴权。'
        })}
      />

      <Section
        title={t('settings.remote.gate.title', { defaultValue: '远程访问' })}
        helper={t('settings.remote.gate.helper', {
          defaultValue: '开启后 serve-api 随应用启动，监听本机回环端口；关闭则不暴露任何远程能力。'
        })}
      >
        <EnvField
          envKey="MAILAGENT_REMOTE_ACCESS_ENABLED"
          control="toggle"
          label={t('settings.remote.enabled.label', { defaultValue: '启用远程访问 (serve-api)' })}
          helper={t('settings.remote.enabled.helper', {
            defaultValue: '默认开启 · 仅 bind 127.0.0.1，无 Cloudflare 隧道时外网不可达'
          })}
        />
      </Section>

      <Section
        title={t('settings.remote.cf.title', { defaultValue: 'Cloudflare Access' })}
        helper={t('settings.remote.cf.helper', {
          defaultValue:
            'serve-api 在每个请求上校验 Cloudflare Access 签发的 JWT；Audience 留空进程将拒绝启动。'
        })}
      >
        <EnvField
          envKey="CF_AUDIENCE"
          control="text"
          disabled={subFieldsDisabled}
          label={t('settings.remote.audience.label', {
            defaultValue: 'Application Audience Tag'
          })}
          helper={t('settings.remote.audience.helper', {
            defaultValue:
              'Cloudflare Zero Trust → Access → 你的应用 → Overview 的 Audience (AUD) 标签'
          })}
          placeholder={t('settings.remote.audience.placeholder', {
            defaultValue: 'e.g. 6f1d…（必填）'
          })}
        />
        <EnvField
          envKey="CF_TEAM_DOMAIN"
          control="text"
          disabled={subFieldsDisabled}
          label={t('settings.remote.teamDomain.label', { defaultValue: '团队域名' })}
          helper={t('settings.remote.teamDomain.helper', {
            defaultValue: 'xxx.cloudflareaccess.com — 用于拉取 JWKS 公钥验签'
          })}
          placeholder="tplinkomada.cloudflareaccess.com"
        />
      </Section>

      <Section
        title={t('settings.remote.api.title', { defaultValue: '本地 API' })}
        helper={t('settings.remote.api.helper', {
          defaultValue: '端口与放行邮箱。cloudflared 隧道应指向此回环端口。'
        })}
      >
        <EnvField
          envKey="MAILAGENT_API_PORT"
          control="number"
          disabled={subFieldsDisabled}
          min={1}
          max={65535}
          label={t('settings.remote.port.label', { defaultValue: '本地 API 端口' })}
          helper={t('settings.remote.port.helper', {
            defaultValue: '默认 8200，bind 127.0.0.1。改成被占用端口会导致 serve-api 启动失败。'
          })}
          placeholder={DEFAULT_API_PORT}
        />
        <EnvField
          envKey="MAILAGENT_API_ALLOWED_EMAIL"
          control="text"
          disabled={subFieldsDisabled}
          label={t('settings.remote.allowedEmail.label', { defaultValue: '允许访问的邮箱' })}
          helper={t('settings.remote.allowedEmail.helper', {
            defaultValue: '只有该邮箱通过 Cloudflare Access 才放行；留空则回退为 USER_EMAIL。'
          })}
          placeholder={userEmail.trim() || 'you@example.com'}
        />
      </Section>

      <Section
        title={t('settings.remote.statusSection.title', { defaultValue: '状态与访问' })}
        helper={t('settings.remote.statusSection.helper', {
          defaultValue: '改完上面任意配置后，需要重启 serve-api 才会生效。'
        })}
      >
        {/* CF_AUDIENCE 缺失告警 — 远程访问开但 Audience 空时, serve-api auth.py
            import 期会 raise → 进程拒起 (规格 P0)。这里前置提示, 避免用户对着
            "启动失败" 一头雾水。 */}
        {remoteEnabled && !cfAudience.trim() ? (
          <Row
            label={
              <span className="inline-flex items-center gap-1.5 text-warn">
                <AlertTriangle className="size-3.5" />
                {t('settings.remote.warnAudience.label', { defaultValue: '缺少 Audience' })}
              </span>
            }
            helper={t('settings.remote.warnAudience.hint', {
              defaultValue:
                '远程访问已开启但 Application Audience Tag 为空，serve-api 会拒绝启动。请在上方 Cloudflare Access 填入 Audience。'
            })}
          >
            <span className="text-meta font-mono text-warn">
              {t('settings.remote.warnAudience.tag', { defaultValue: '必填' })}
            </span>
          </Row>
        ) : null}

        {/* 进程状态 + 重启 */}
        <Row
          label={t('settings.remote.status.label', { defaultValue: '后端进程' })}
          helper={t('settings.remote.status.hint', {
            defaultValue: 'serve-api 随后端进程一同托管；下方为后端在线状态。'
          })}
        >
          <div className="flex items-center gap-2 flex-wrap">
            <StatusChip state={remoteEnabled ? probe : 'idle'} />
            <button
              type="button"
              onClick={() => void refreshStatus()}
              disabled={probe === 'loading'}
              aria-label={t('settings.remote.status.refresh', { defaultValue: '刷新状态' })}
              className={cn(
                'inline-flex h-7 w-7 items-center justify-center rounded-md',
                'text-ink-fg-2 hover:bg-ink-3 hover:text-ink-fg',
                'transition-colors duration-fast ease-standard',
                'disabled:opacity-40 disabled:pointer-events-none'
              )}
            >
              <RefreshCw className={cn('size-3.5', probe === 'loading' && 'animate-spin')} />
            </button>
          </div>
        </Row>

        {/* 重启 serve-api */}
        <Row
          label={t('settings.remote.restart.label', { defaultValue: '应用配置' })}
          helper={t('settings.remote.restart.hint', {
            defaultValue: '重启会顺带中断当前同步批次几秒，随后用新配置拉起 serve-api。'
          })}
        >
          <button
            type="button"
            onClick={() => void handleRestart()}
            disabled={restarting}
            className={cn(
              'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-aux',
              'text-coral border border-coral/30 bg-coral/10 hover:bg-coral/15',
              'transition-colors duration-fast',
              'disabled:opacity-60 disabled:cursor-not-allowed'
            )}
          >
            {restarting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            {restarting
              ? t('settings.remote.restart.busy', { defaultValue: '重启中…' })
              : t('settings.remote.restart.cta', { defaultValue: '重启 serve-api' })}
          </button>
        </Row>

        {/* 本地访问地址 */}
        <Row
          label={t('settings.remote.url.localLabel', { defaultValue: '本地地址' })}
          helper={t('settings.remote.url.localHint', {
            defaultValue: '在本机浏览器直接打开（不经 Cloudflare）'
          })}
        >
          <UrlPill
            url={localUrl}
            copied={copied === 'local'}
            onCopy={() => void copy(localUrl, 'local')}
            t={t}
          />
        </Row>

        {/* Cloudflare 团队域名 dashboard */}
        {teamDomainUrl ? (
          <Row
            label={t('settings.remote.url.teamLabel', { defaultValue: 'Cloudflare 团队域名' })}
            helper={t('settings.remote.url.teamHint', {
              defaultValue: '打开 Zero Trust 应用列表确认 Access 策略'
            })}
          >
            <UrlPill
              url={teamDomainUrl}
              copied={copied === 'team'}
              onCopy={() => void copy(teamDomainUrl, 'team')}
              t={t}
            />
          </Row>
        ) : null}

        {/* 放行邮箱回显 */}
        <Row
          label={t('settings.remote.url.emailLabel', { defaultValue: '当前放行邮箱' })}
          helper={t('settings.remote.url.emailHint', {
            defaultValue: '通过 Cloudflare Access 鉴权的允许邮箱'
          })}
        >
          <span className="text-aux font-mono text-ink-fg-1 break-all">
            {effectiveEmail || <span className="text-ink-fg-3">—</span>}
            {!allowedEmail.trim() && userEmail.trim() ? (
              <span className="ml-1 text-meta text-ink-fg-3">
                {t('settings.remote.url.emailFallback', { defaultValue: '(默认 USER_EMAIL)' })}
              </span>
            ) : null}
          </span>
        </Row>

        {/* public 隧道 + cloudflared 托管 runbook 提示 */}
        <Row
          label={
            <span className="inline-flex items-center gap-1.5">
              <Globe className="size-3.5 text-ink-fg-2" />
              {t('settings.remote.runbook.label', { defaultValue: '公网访问 (隧道)' })}
            </span>
          }
          helper={t('settings.remote.runbook.hint', {
            defaultValue:
              '公网 URL 形如 https://你的域名/app，由你自管的 cloudflared 隧道把 hostname 指向上面的本地端口。cloudflared 需你自行用 pm2 / launchd 托管，不在本应用生命周期内。'
          })}
        >
          <span className="text-meta font-mono text-ink-fg-3">
            {t('settings.remote.runbook.tag', { defaultValue: '自管' })}
          </span>
        </Row>
      </Section>
    </>
  )
}

/** Small copy-to-clipboard + open-external URL pill reused for local / team
 *  URLs. Kept inline (single-file scope) rather than promoted to parts/. */
function UrlPill({
  url,
  copied,
  onCopy,
  t
}: {
  url: string
  copied: boolean
  onCopy: () => void
  t: (key: string, opts?: Record<string, unknown>) => string
}): React.ReactElement {
  return (
    <div className="inline-flex items-center gap-1.5 max-w-[300px]">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-aux font-mono text-coral hover:underline truncate"
        title={url}
      >
        {url.replace(/^https?:\/\//, '')}
      </a>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t('settings.remote.url.open', { defaultValue: '在浏览器打开' })}
        className={cn(
          'shrink-0 inline-flex h-6 w-6 items-center justify-center rounded-md',
          'text-ink-fg-2 hover:bg-ink-3 hover:text-ink-fg',
          'transition-colors duration-fast ease-standard'
        )}
      >
        <ExternalLink className="size-3.5" />
      </a>
      <button
        type="button"
        onClick={onCopy}
        aria-label={t('settings.remote.url.copy', { defaultValue: '复制' })}
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
    </div>
  )
}
