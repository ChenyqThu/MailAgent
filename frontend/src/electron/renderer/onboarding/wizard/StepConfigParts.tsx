// Onboarding step 3 sub-blocks: DavMail connection fields and Notion OAuth setup.

import { useEffect, useState } from 'react'

import { fetchNotionOauthEnabled } from '@shared/components/settings/custom-ai/shared'
import { useNotionOauthFlow, type NotionOauthDoneInfo } from '@shared/hooks/useNotionOauthFlow'
import type {
  NotionDbCandidate,
  NotionOauthErrorCode,
  NotionOauthPhase
} from '@shared/lib/notionOauthContract'
import { notionOauthAvailable } from '@shared/lib/notionOauthIpc'

import { Banner, Field, Icon, Toggle } from '../components'
import type { DetectDavmailResult } from '../ipc'
import {
  DAVMAIL_DEFAULT_HOST,
  DAVMAIL_DEFAULT_IMAP_PORT,
  DAVMAIL_DEFAULT_SMTP_PORT,
  type ConfigForm
} from './types'

/* ─── DavMail-specific config fields (账户/认证/桥状态/高级 host·port) ──────────
   davmail 分支不枚举 Mail.app 账户 (USER_EMAIL 即登录名), 改为: 桥状态 banner +
   USER_EMAIL (relabeled) + PoC 默认密钥 toggle / cipher 输入 + 高级折叠 host/port。 */
export interface DavmailFieldsProps {
  form: ConfigForm
  set: <K extends keyof ConfigForm>(k: K, v: ConfigForm[K]) => void
  blur: (k: string) => void
  showErr: (k: string) => string | undefined
  pocMode: boolean
  davDetect: DetectDavmailResult | null
}

export function DavmailFields({
  form,
  set,
  blur,
  showErr,
  pocMode,
  davDetect
}: DavmailFieldsProps): React.JSX.Element {
  const [advOpen, setAdvOpen] = useState(false)
  const host = davDetect?.host ?? DAVMAIL_DEFAULT_HOST
  const imapPort = davDetect?.imapPort ?? Number(DAVMAIL_DEFAULT_IMAP_PORT)
  const smtpPort = davDetect?.smtpPort ?? Number(DAVMAIL_DEFAULT_SMTP_PORT)
  return (
    <>
      {/* davmail 桥探测状态 (非阻断, 仅提示)。 */}
      {davDetect === null ? (
        <div className="fld flex items-center gap-2 text-ink-fg-2">
          <Icon name="refresh" size={14} cls="spin" /> 正在检测 davmail 桥…
        </div>
      ) : davDetect.imapReachable && davDetect.smtpReachable ? (
        // 后端 probe 要求 IMAP + SMTP 都通 (davmail_backend.probe_readiness), 故两个都可达才算成功。
        <Banner kind="info" icon="check">
          已检测到 davmail 桥 (IMAP {host}:{imapPort} · SMTP :{smtpPort})。
        </Banner>
      ) : (
        <Banner kind="warn" icon="alert">
          <div className="font-semibold text-[13px] mb-0.5">
            {davDetect.imapReachable || davDetect.smtpReachable
              ? 'davmail 桥端口未全部就绪'
              : '未检测到 davmail 桥'}
          </div>
          <div className="text-[12.5px] text-ink-fg-1">
            IMAP {host}:{imapPort} {davDetect.imapReachable ? '✓ 可达' : '✗ 不通'} · SMTP :
            {smtpPort} {davDetect.smtpReachable ? '✓ 可达' : '✗ 不通'}。请先启动 davmail-poc（
            <span className="font-mono">pm2 start davmail-poc</span>）确保 IMAP 与 SMTP 都可达再继续
            —— 后端启动会同时探这两个端口, 缺一个就起不来。
          </div>
        </Banner>
      )}

      <Field
        label="邮箱账户 (EWS/IMAP 登录名)"
        icon="mail"
        required
        error={showErr('USER_EMAIL')}
        hint="DavMail 用它作 IMAP/SMTP 登录名 (= USER_EMAIL)"
      >
        <input
          className={`fld ${showErr('USER_EMAIL') ? 'err' : ''}`}
          placeholder="you@company.com"
          value={form.USER_EMAIL ?? ''}
          onChange={(e) => set('USER_EMAIL', e.target.value)}
          onBlur={() => blur('USER_EMAIL')}
        />
      </Field>

      <Field label="认证方式" icon="key">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[14px] text-ink-fg">使用 PoC 默认密钥</div>
            <div className="text-[12px] text-ink-fg-2 mt-0.5">
              开启则用内置共享密钥 (DAVMAIL_POC_MODE=true)；关闭需手填 cipher key。
            </div>
          </div>
          <Toggle on={pocMode} onChange={(v) => set('DAVMAIL_POC_MODE', v)} />
        </div>
      </Field>

      {!pocMode && (
        <Field
          label="Cipher Key (DAVMAIL_POC_CIPHER_KEY)"
          icon="lock"
          required
          error={showErr('DAVMAIL_POC_CIPHER_KEY')}
          hint="DavMail OAuth cipher 密钥 (写入 .env，镜像到钥匙串)"
        >
          <input
            className={`fld mono ${showErr('DAVMAIL_POC_CIPHER_KEY') ? 'err' : ''}`}
            placeholder="cipher key…"
            value={form.DAVMAIL_POC_CIPHER_KEY ?? ''}
            onChange={(e) => set('DAVMAIL_POC_CIPHER_KEY', e.target.value)}
            onBlur={() => blur('DAVMAIL_POC_CIPHER_KEY')}
            type="password"
            autoComplete="off"
          />
        </Field>
      )}

      {/* 高级: host / port (默认 127.0.0.1 / 1143 / 1025, 可被 detect 预填覆盖)。 */}
      <div>
        <button
          type="button"
          className="flex items-center gap-1.5 text-[13px] text-ink-fg-2 hover:text-ink-fg transition"
          onClick={() => setAdvOpen(!advOpen)}
        >
          <Icon name={advOpen ? 'x' : 'settings'} size={13} />{' '}
          {advOpen ? '收起高级连接设置' : '高级连接设置 (host / port)'}
        </button>
        {advOpen && (
          <div className="flex flex-col gap-3 mt-3 step-enter">
            <Field label="DavMail Host" icon="server">
              <input
                className="fld mono"
                placeholder={DAVMAIL_DEFAULT_HOST}
                value={form.DAVMAIL_HOST ?? ''}
                onChange={(e) => set('DAVMAIL_HOST', e.target.value)}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="IMAP Port" icon="server">
                <input
                  className="fld mono"
                  placeholder={DAVMAIL_DEFAULT_IMAP_PORT}
                  value={form.DAVMAIL_IMAP_PORT ?? ''}
                  onChange={(e) => set('DAVMAIL_IMAP_PORT', e.target.value)}
                />
              </Field>
              <Field label="SMTP Port" icon="server">
                <input
                  className="fld mono"
                  placeholder={DAVMAIL_DEFAULT_SMTP_PORT}
                  value={form.DAVMAIL_SMTP_PORT ?? ''}
                  onChange={(e) => set('DAVMAIL_SMTP_PORT', e.target.value)}
                />
              </Field>
            </div>
          </div>
        )}
      </div>
    </>
  )
}

/* ─── Notion 授权块 (task 08-20 Notion OAuth) ─────────────────────────────────
   「连接 Notion」→ 系统浏览器完成授权 → main 直接把 token / 两个库 ID / workspace
   原子写进 .env。🔴 renderer 全程见不到 token, 所以授权成功后**不回填**下面的手填
   字段, 而是把它们收起来 (想手填可点「改为手动填写」展开) —— 空着的输入框看起来像
   没配, 回填掩码则会在提交时把真 token 覆盖掉, 两者都不行。

   flag (MAILAGENT_NOTION_OAUTH) 关 / 非 Electron 环境 → 整块不渲染, 手填路径原样。
   注: 同本文件既有约定, onboarding 是 Chinese-only 原型 (无 i18n)。 */

const NOTION_OAUTH_PHASE_TEXT: Record<NotionOauthPhase, string> = {
  waiting_callback: '已在浏览器打开 Notion 授权页，请在那里完成授权。',
  exchanging: '正在换取访问令牌…',
  discovering: '正在识别邮件库与日历库…',
  need_selection: '请在下面各选一个数据库。',
  writing: '正在写入配置…',
  done: '授权完成。',
  error: '授权未完成。'
}

/** 错误码 → 用户能据此行动的一句话。向导里手填字段就在下面, 故兜底文案明确指路。 */
function notionOauthErrorText(code: NotionOauthErrorCode | null): string {
  switch (code) {
    case 'denied':
    case 'cancelled':
      return '授权已取消，原有配置未改动。'
    case 'timeout':
      return '5 分钟内没有完成授权，本次已取消。'
    case 'port_unavailable':
      return '本机 9280 / 9281 端口都被占用，收不到 Notion 的回调。关掉占用这两个端口的程序后重试。'
    case 'discovery_failed':
    case 'no_databases_found':
      return '没能在已授权的内容里找到数据库。重新授权时请选择复制模板，或勾选包含邮件库、日历库的页面。'
    case 'selection_invalid':
      return '所选数据库不可用（可能已被改动或不再可见），请重新选择。'
    case 'rate_limited':
      return '短时间内尝试次数过多，请等一分钟再试。'
    case 'env_write_failed':
      return '配置写入失败，原有配置未改动。'
    default:
      return '授权失败，原有配置未改动 —— 可以重试，或在下面手动填写。'
  }
}

/** 候选在某个角色下是否可选 + 不可选的原因 (下拉里直接说清楚, 不让用户猜)。 */
function notionCandidateLabel(c: NotionDbCandidate, role: 'email' | 'calendar'): string {
  const title = c.title || '（未命名）'
  if (c.role === role && c.valid) {
    return c.warnings.length > 0 ? `${title} — 缺少可选字段：${c.warnings.join('、')}` : title
  }
  if (c.role !== role) return `${title} — 不是这一类的库`
  if (c.missing.length > 0) return `${title} — 缺少必需字段：${c.missing.join('、')}`
  return `${title} — 无法识别用途`
}

export interface NotionAuthBlockProps {
  connected: NotionOauthDoneInfo | null
  onConnected: (info: NotionOauthDoneInfo) => void
}

export function NotionAuthBlock({
  connected,
  onConnected
}: NotionAuthBlockProps): React.JSX.Element | null {
  // null = flag 还没问出来 (先不渲染, 免得按钮闪现后消失)。serve-api 此时通常还没起,
  // fetch 失败 → default-ON → true。
  const [enabled, setEnabled] = useState<boolean | null>(() =>
    notionOauthAvailable() ? null : false
  )
  const [emailId, setEmailId] = useState('')
  const [calendarId, setCalendarId] = useState('')
  const flow = useNotionOauthFlow({ onWritten: onConnected })

  useEffect(() => {
    if (!notionOauthAvailable()) return
    let alive = true
    void fetchNotionOauthEnabled()
      .then((v) => {
        if (alive) setEnabled(v)
      })
      .catch(() => {
        if (alive) setEnabled(true)
      })
    return () => {
      alive = false
    }
  }, [])

  if (enabled !== true) return null

  const busy = flow.busy || (flow.phase !== null && flow.phase !== 'error' && flow.phase !== 'done')
  const candidates = flow.candidates ?? []
  const canSubmit = emailId !== '' && calendarId !== '' && emailId !== calendarId && !flow.busy

  if (connected) {
    return (
      <Banner kind="accent" icon="check">
        <div className="font-semibold text-[13px] mb-0.5">
          已连接 Notion{connected.workspaceName ? ` · ${connected.workspaceName}` : ''}
        </div>
        <div className="text-[12.5px] text-ink-fg-1">
          邮件库「{connected.emailDbTitle || '未命名'}」、日历库「
          {connected.calendarDbTitle || '未命名'}」已自动写入配置，无需手填。
        </div>
      </Banner>
    )
  }

  return (
    <Field
      label="连接 Notion（推荐）"
      icon="plug"
      hint="点一下在浏览器完成授权，可顺带复制官方模板；Token 与两个数据库 ID 会自动写入，不用手填。也可以跳过，用下面的字段手动填写。"
    >
      <div className="flex flex-col gap-2.5">
        <div>
          <button type="button" className="btn-sec" onClick={flow.start} disabled={busy}>
            <Icon name={busy ? 'refresh' : 'external'} size={14} cls={busy ? 'spin' : undefined} />
            {busy ? '授权进行中…' : '连接 Notion'}
          </button>
          {busy && (
            <button
              type="button"
              className="btn-sec ml-2"
              onClick={() => {
                setEmailId('')
                setCalendarId('')
                flow.cancel()
              }}
            >
              取消
            </button>
          )}
        </div>

        {flow.phase !== null && flow.phase !== 'done' && (
          <Banner kind={flow.phase === 'error' ? 'fail' : 'info'}>
            <div className="text-[12.5px] text-ink-fg-1">
              {flow.phase === 'error'
                ? notionOauthErrorText(flow.errorCode)
                : NOTION_OAUTH_PHASE_TEXT[flow.phase]}
            </div>
          </Banner>
        )}

        {flow.phase === 'need_selection' && (
          <div className="flex flex-col gap-2">
            <div className="selwrap">
              <select
                className="fld"
                aria-label="邮件库"
                value={emailId}
                onChange={(e) => setEmailId(e.target.value)}
              >
                <option value="" disabled>
                  选择邮件库
                </option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id} disabled={!(c.role === 'email' && c.valid)}>
                    {notionCandidateLabel(c, 'email')}
                  </option>
                ))}
              </select>
            </div>
            <div className="selwrap">
              <select
                className="fld"
                aria-label="日历库"
                value={calendarId}
                onChange={(e) => setCalendarId(e.target.value)}
              >
                <option value="" disabled>
                  选择日历库
                </option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id} disabled={!(c.role === 'calendar' && c.valid)}>
                    {notionCandidateLabel(c, 'calendar')}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <button
                type="button"
                className="btn-primary"
                disabled={!canSubmit}
                onClick={() => flow.submitSelection(emailId, calendarId)}
              >
                使用所选数据库
              </button>
            </div>
          </div>
        )}
      </div>
    </Field>
  )
}
