// Onboarding step 3: Account detection, validation, and commitConfig.

import { useEffect, useRef, useState } from 'react'

import type { NotionOauthDoneInfo } from '@shared/hooks/useNotionOauthFlow'
import { errorMessage } from '@shared/lib/ipcErrors'
import { calendarUiEnabled, detectUiPlatform } from '@shared/lib/mailBackend'

import { Banner, ChipSelect, Field, Icon, WizFooter } from '../components'
import * as ipc from '../ipc'
import type { BackendKind, DetectDavmailResult } from '../ipc'
import { DavmailFields, NotionAuthBlock } from './StepConfigParts'
import {
  buildCompleteConfig,
  DAVMAIL_DEFAULT_HOST,
  DAVMAIL_DEFAULT_IMAP_PORT,
  DAVMAIL_DEFAULT_SMTP_PORT,
  type ConfigForm,
  type SubmitError
} from './types'

/* ─── Step 3 · Mail sync config (real account detect + client validation) ──── */
const HEX32 = /^[0-9a-f]{32}$/i
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DEFAULT_MAILBOXES = ['收件箱', '发件箱', '已发送', '归档', '重要']

export interface StepConfigProps {
  form: ConfigForm
  setForm: React.Dispatch<React.SetStateAction<ConfigForm>>
  /** backend selection — needed to build the cfg commitConfig writes here. */
  backend: BackendKind
  /** advance to StepSync after a successful commitConfig (backend now started). */
  onNext: () => void
  onBack: () => void
  submitError: SubmitError | null
  /** lifted so OnboardingRoot/StepSync知道后端已起 (commitConfig 成功)。 */
  setCommitError: (e: SubmitError | null) => void
}

export function StepConfig({
  form,
  setForm,
  backend,
  onNext,
  onBack,
  submitError,
  setCommitError
}: StepConfigProps): React.JSX.Element {
  const isDavmail = backend === 'davmail'
  const isOutlookCom = backend === 'outlook_com'
  // 日历 Notion 库字段: win 恒隐藏 (日历整体出范围, owner 2026-08-13 拍板)。
  const calendarFieldVisible = calendarUiEnabled(detectUiPlatform())
  const [accounts, setAccounts] = useState<string[] | null>(null) // null = loading
  const [mailboxes, setMailboxes] = useState<string[]>(DEFAULT_MAILBOXES)
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  // task 08-20 Notion OAuth: 授权成功后 main 已把 token / 两库 ID 写进 .env,
  // 这里只留展示信息 (token 不过 renderer)。非 null → 收起手填三件套。
  const [notionOauth, setNotionOauth] = useState<NotionOauthDoneInfo | null>(null)
  // 已授权后仍想手填 (改指其它库) 的逃生口。
  const [notionManualOpen, setNotionManualOpen] = useState(false)
  // davmail 桥探测状态: null = 检测中 (含 hang 兜底降级), 否则结果对象。
  const [davDetect, setDavDetect] = useState<DetectDavmailResult | null>(null)
  // commitConfig 提交超时逃生 (BLOCKER 2 模式): arm 在调用前 + attemptId 标记本次
  // 提交, 迟到结果按 attemptId 丢弃, 超时 setBusy(false) + 错误提示恢复按钮可点。
  const [slow, setSlow] = useState(false)
  const attemptId = useRef(0)
  const submitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const alive = useRef(true)
  const detectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // davmail 分支只在进入时预填一次 (detect 结果回填 host/port/pocMode/userEmail);
  // 用户随后手改不被覆盖。
  const davPrefilled = useRef(false)

  useEffect(() => {
    alive.current = true
    // davmail / outlook_com 后端不枚举 Mail.app 账户 (debug mail-structure 是
    // AppleScript-only; davmail/COM 无账户枚举, USER_EMAIL 即登录名)。不调
    // listMailAccounts —— 账户 UI (accounts 消费方) 只在 applescript 分支渲染。
    if (isDavmail || isOutlookCom) {
      return () => {
        alive.current = false
      }
    }
    // ~8s hang bound (twin of StepFDA's scanTimer): listMailAccounts() walks
    // AppleScript to enumerate accounts and can HANG (no resolve AND no reject)
    // on a stuck main-process handler. The .catch below only covers reject —
    // without this timeout, accounts stays null forever → '检测中…' spinner with
    // no input → MAIL_ACCOUNT_NAME never fillable → valid never true → 主按钮
    // 永久 disabled. On timeout we degrade to empty accounts (free-text input
    // branch) so the user can type the account name and proceed.
    if (detectTimer.current) clearTimeout(detectTimer.current)
    detectTimer.current = setTimeout(() => {
      if (!alive.current) return
      setAccounts((prev) => (prev === null ? [] : prev))
    }, 8000)
    const clearDetectTimer = (): void => {
      if (detectTimer.current) {
        clearTimeout(detectTimer.current)
        detectTimer.current = null
      }
    }
    void ipc
      .listMailAccounts()
      .then((r) => {
        if (!alive.current) return
        // empty (or error-with-empty) accounts → free-text input via accountsEmpty.
        setAccounts(Array.isArray(r?.accounts) && r.accounts.length > 0 ? r.accounts : [])
        if (Array.isArray(r?.mailboxes) && r.mailboxes.length > 0) setMailboxes(r.mailboxes)
      })
      .catch(() => {
        if (!alive.current) return
        // NEVER block on listMailAccounts error — degrade to empty accounts +
        // default '收件箱' mailbox; the user free-texts the account name.
        setAccounts([])
      })
      .finally(clearDetectTimer)
    return () => {
      alive.current = false
      clearDetectTimer()
    }
  }, [isDavmail, isOutlookCom])

  // davmail 桥探测 (davmail 分支专属)。~6s hang 兜底: detect 永不返回时降级为
  // bridgeUp=false 的占位结果, 让 banner 显示"未检测到桥"而不是永久转圈。
  const davTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!isDavmail) return
    alive.current = true
    if (davTimer.current) clearTimeout(davTimer.current)
    davTimer.current = setTimeout(() => {
      if (!alive.current) return
      setDavDetect((prev) =>
        prev === null
          ? {
              bridgeUp: false,
              imapReachable: false,
              smtpReachable: false,
              host: DAVMAIL_DEFAULT_HOST,
              imapPort: Number(DAVMAIL_DEFAULT_IMAP_PORT),
              smtpPort: Number(DAVMAIL_DEFAULT_SMTP_PORT),
              detected: {}
            }
          : prev
      )
    }, 6000)
    const clearDavTimer = (): void => {
      if (davTimer.current) {
        clearTimeout(davTimer.current)
        davTimer.current = null
      }
    }
    void ipc
      .detectDavmail()
      .then((r) => {
        if (!alive.current || !r) return
        setDavDetect(r)
        // 从 detect 预填 host/port/pocMode/userEmail (仅首次, 不覆盖用户手改)。
        if (!davPrefilled.current) {
          davPrefilled.current = true
          const d = r.detected ?? {}
          setForm((f) => {
            const next = { ...f }
            if (next.DAVMAIL_HOST == null) next.DAVMAIL_HOST = d.host ?? DAVMAIL_DEFAULT_HOST
            if (next.DAVMAIL_IMAP_PORT == null)
              next.DAVMAIL_IMAP_PORT =
                d.imapPort != null ? String(d.imapPort) : DAVMAIL_DEFAULT_IMAP_PORT
            if (next.DAVMAIL_SMTP_PORT == null)
              next.DAVMAIL_SMTP_PORT =
                d.smtpPort != null ? String(d.smtpPort) : DAVMAIL_DEFAULT_SMTP_PORT
            if (next.DAVMAIL_POC_MODE == null) next.DAVMAIL_POC_MODE = d.pocMode ?? true
            if ((next.USER_EMAIL ?? '') === '' && d.userEmail) next.USER_EMAIL = d.userEmail
            return next
          })
        }
      })
      .catch(() => {
        if (!alive.current) return
        // 探测失败不阻断: 给 bridgeUp=false 占位 + 默认值, 用户仍可手填后继续。
        setDavDetect(
          (prev) =>
            prev ?? {
              bridgeUp: false,
              imapReachable: false,
              smtpReachable: false,
              host: DAVMAIL_DEFAULT_HOST,
              imapPort: Number(DAVMAIL_DEFAULT_IMAP_PORT),
              smtpPort: Number(DAVMAIL_DEFAULT_SMTP_PORT),
              detected: {}
            }
        )
      })
      .finally(clearDavTimer)
    return () => {
      clearDavTimer()
    }
  }, [isDavmail, setForm])

  // Clear submit-timeout on unmount (detectTimer 已在上面 effect 的 cleanup 清)。
  useEffect(() => {
    return () => {
      if (submitTimer.current) clearTimeout(submitTimer.current)
    }
  }, [])

  const set = <K extends keyof ConfigForm>(k: K, v: ConfigForm[K]): void =>
    setForm((f) => ({ ...f, [k]: v }))
  const blur = (k: string): void => setTouched((t) => ({ ...t, [k]: true }))

  // 提交核心配置 + 起后端 (commitConfig), 成功后 onNext() 进 StepSync 轮询真实进度。
  // BLOCKER 2 模式: submit-timeout arm 在 ipc 调用前; attemptId 标记本次提交,
  // settle 时 attemptId 不匹配 (超时已 fire / 组件重提) 则忽略迟到结果。
  const commit = (): void => {
    const id = ++attemptId.current
    setCommitError(null)
    setSlow(false)
    setBusy(true)
    if (submitTimer.current) clearTimeout(submitTimer.current)
    submitTimer.current = setTimeout(() => {
      if (!alive.current || id !== attemptId.current) return
      submitTimer.current = null
      // invalidate 本次提交 (codex #2): 迟到的 commitConfig resolve 会因 id !==
      // attemptId.current 而被丢弃, 不再用旧表单 onNext() 把用户拽进 StepSync。
      attemptId.current++
      setSlow(true)
      setBusy(false)
    }, 10000)
    const cfg = buildCompleteConfig(form, backend, {})
    void ipc
      .commitConfig(cfg)
      .then((res) => {
        if (!alive.current || id !== attemptId.current) return
        if (submitTimer.current) {
          clearTimeout(submitTimer.current)
          submitTimer.current = null
        }
        if (!res?.ok) {
          setCommitError({
            title: '启动失败',
            message: res?.error?.message ?? '配置写入或后端启动失败，请重试。'
          })
          setBusy(false)
          return
        }
        // 后端已起 (ready 可能 false = 大库慢启动, StepSync 会继续轮询)。进 Sync。
        setBusy(false)
        onNext()
      })
      .catch((err: unknown) => {
        if (!alive.current || id !== attemptId.current) return
        if (submitTimer.current) {
          clearTimeout(submitTimer.current)
          submitTimer.current = null
        }
        setCommitError({
          title: '提交出错',
          message: errorMessage(err)
        })
        setBusy(false)
      })
  }

  // davmail PoC 模式默认开 (form 字段 undefined 视为 true)。
  const pocMode = form.DAVMAIL_POC_MODE !== false
  const errs: Record<string, string> = {}
  if (!form.USER_EMAIL) errs.USER_EMAIL = '必填项'
  else if (!EMAIL_RE.test(form.USER_EMAIL)) errs.USER_EMAIL = '邮箱格式不正确'
  // 07-12 P3b: NOTION_TOKEN / EMAIL_DATABASE_ID 改可选 —— 空 = 仅本地模式
  // (Notion 镜像/周报/日历同步停用), 不再阻断「开始同步」。commitConfig 的
  // missing 闸 (ONBOARDING_REQUIRED_KEYS) 已同批放开, 前后两道门保持一致。
  if (isDavmail) {
    // davmail 不要求 MAIL_ACCOUNT_NAME (USER_EMAIL 即登录名); 但要求一种认证方式:
    // PoC 默认密钥 或 非空 cipher。
    if (!pocMode && !(form.DAVMAIL_POC_CIPHER_KEY ?? '').trim()) {
      errs.DAVMAIL_POC_CIPHER_KEY = '请填写密钥或改用 PoC 默认密钥'
    }
  } else if (isOutlookCom) {
    // outlook_com 只要 USER_EMAIL —— 账户/认证都在本机 Outlook 里, 无账户名/密钥概念。
  } else if (!form.MAIL_ACCOUNT_NAME) {
    errs.MAIL_ACCOUNT_NAME = '请选择账户'
  }

  const warns: Record<string, string> = {}
  if (form.NOTION_TOKEN && !/^(secret_|ntn_)/.test(form.NOTION_TOKEN))
    warns.NOTION_TOKEN = 'Token 通常以 secret_ 或 ntn_ 开头，请确认'
  if (form.EMAIL_DATABASE_ID && !HEX32.test(form.EMAIL_DATABASE_ID.replace(/-/g, '')))
    warns.EMAIL_DATABASE_ID = '数据库 ID 通常为 32 位十六进制'
  if (form.CALENDAR_DATABASE_ID && !HEX32.test(form.CALENDAR_DATABASE_ID.replace(/-/g, '')))
    warns.CALENDAR_DATABASE_ID = '日历 DB ID 通常为 32 位十六进制'
  // Notion 两键成对才生效 (后端 notion_enabled = 双非空); 只填一个 → 非阻断提醒。
  if (form.NOTION_TOKEN && !form.EMAIL_DATABASE_ID && !warns.EMAIL_DATABASE_ID)
    warns.EMAIL_DATABASE_ID = '已填 Token 未填库 ID —— 两者都填才会启用 Notion 同步'
  if (!form.NOTION_TOKEN && form.EMAIL_DATABASE_ID && !warns.NOTION_TOKEN)
    warns.NOTION_TOKEN = '已填库 ID 未填 Token —— 两者都填才会启用 Notion 同步'

  const valid = Object.keys(errs).length === 0
  const showErr = (k: string): string | undefined => (touched[k] ? errs[k] : undefined)
  const accountsEmpty = accounts !== null && accounts.length === 0

  return (
    <>
      <div className="wiz-body scrollbar-thin step-enter">
        <div className="eyebrow">Step 3 — 邮件同步配置</div>
        <h1 className="wiz-h1">连接 Notion 与邮箱</h1>
        <p className="wiz-lede">
          填写后写入 DATA_ROOT/.env（行级原子写，不破坏注释）。Token 会镜像到系统钥匙串。 Notion
          为可选 —— 留空则以仅本地模式运行（Notion 镜像 / 项目周报 / 日历同步停用，
          稍后可在设置里补）。
        </p>

        {submitError && (
          <div className="mt-4">
            <Banner kind="fail">
              <div className="font-semibold text-[13px] mb-0.5">{submitError.title}</div>
              <div className="text-[12.5px] text-ink-fg-1">{submitError.message}</div>
            </Banner>
          </div>
        )}
        {slow && !submitError && (
          <div className="mt-4">
            <Banner kind="warn" icon="clock">
              <div className="font-semibold text-[13px] mb-0.5">启动较慢</div>
              <div className="text-[12.5px] text-ink-fg-1">
                配置可能已写入，后端正在后台启动（大库会更久）。可点「开始同步」重试，或稍候再试。
              </div>
            </Banner>
          </div>
        )}

        <div className="flex flex-col gap-4 mt-5">
          {isDavmail ? (
            <DavmailFields
              form={form}
              set={set}
              blur={blur}
              showErr={showErr}
              pocMode={pocMode}
              davDetect={davDetect}
            />
          ) : isOutlookCom ? (
            /* outlook_com: 账户在本机 Outlook 里, 只收 USER_EMAIL。 */
            <Field
              label="用户邮箱 (USER_EMAIL)"
              icon="mail"
              required
              error={showErr('USER_EMAIL')}
              hint="本机 Outlook 中已登录的邮箱地址"
            >
              <input
                className={`fld ${showErr('USER_EMAIL') ? 'err' : ''}`}
                placeholder="you@company.com"
                value={form.USER_EMAIL ?? ''}
                onChange={(e) => set('USER_EMAIL', e.target.value)}
                onBlur={() => blur('USER_EMAIL')}
              />
            </Field>
          ) : (
            <>
              <Field
                label="Mail.app 账户名"
                icon="mail"
                required
                error={showErr('MAIL_ACCOUNT_NAME')}
                hint={
                  accounts === null
                    ? '正在检测 Mail.app 账户…'
                    : accountsEmpty
                      ? '未检测到账户，请手动填写 Mail.app 里的账户名'
                      : '来自 mailagent debug mail-structure'
                }
              >
                {accounts === null ? (
                  <div className="fld flex items-center gap-2 text-ink-fg-2">
                    <Icon name="refresh" size={14} cls="spin" /> 检测中…
                  </div>
                ) : accountsEmpty ? (
                  <input
                    className={`fld ${showErr('MAIL_ACCOUNT_NAME') ? 'err' : ''}`}
                    placeholder="例如 Exchange / iCloud"
                    value={form.MAIL_ACCOUNT_NAME ?? ''}
                    onChange={(e) => set('MAIL_ACCOUNT_NAME', e.target.value)}
                    onBlur={() => blur('MAIL_ACCOUNT_NAME')}
                  />
                ) : (
                  <div className="selwrap">
                    <select
                      className={`fld ${showErr('MAIL_ACCOUNT_NAME') ? 'err' : ''}`}
                      value={form.MAIL_ACCOUNT_NAME ?? ''}
                      onChange={(e) => {
                        set('MAIL_ACCOUNT_NAME', e.target.value)
                        blur('MAIL_ACCOUNT_NAME')
                      }}
                      onBlur={() => blur('MAIL_ACCOUNT_NAME')}
                    >
                      <option value="" disabled>
                        请选择要同步的账户
                      </option>
                      {accounts.map((a) => (
                        <option key={a} value={a}>
                          {a}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </Field>

              <Field
                label="用户邮箱 (USER_EMAIL)"
                icon="mail"
                required
                error={showErr('USER_EMAIL')}
              >
                <input
                  className={`fld ${showErr('USER_EMAIL') ? 'err' : ''}`}
                  placeholder="you@company.com"
                  value={form.USER_EMAIL ?? ''}
                  onChange={(e) => set('USER_EMAIL', e.target.value)}
                  onBlur={() => blur('USER_EMAIL')}
                />
              </Field>
            </>
          )}

          <Field label="同步邮箱" icon="archive" hint="默认收件箱，可多选">
            <ChipSelect
              options={mailboxes}
              value={form.SYNC_MAILBOXES ?? ['收件箱']}
              onChange={(v) => set('SYNC_MAILBOXES', v.length ? v : ['收件箱'])}
            />
          </Field>

          <NotionAuthBlock
            connected={notionOauth}
            onConnected={(info) => {
              setNotionOauth(info)
              setNotionManualOpen(false)
            }}
          />

          {notionOauth && !notionManualOpen ? (
            <button
              type="button"
              className="help-link self-start"
              onClick={() => setNotionManualOpen(true)}
            >
              改为手动填写 Token 与数据库 ID
            </button>
          ) : (
            <>
              <Field
                label="Notion Token"
                icon="key"
                error={showErr('NOTION_TOKEN')}
                warn={warns.NOTION_TOKEN}
                hint={
                  <span>
                    选填 · 跳过则仅本地模式。在 Notion → Settings → Connections 创建
                    Integration，粘贴 secret。
                    <span className="help-link">如何创建？</span>
                  </span>
                }
              >
                <input
                  className={`fld mono ${showErr('NOTION_TOKEN') ? 'err' : ''}`}
                  placeholder="secret_xxxxxxxx…"
                  value={form.NOTION_TOKEN ?? ''}
                  onChange={(e) => set('NOTION_TOKEN', e.target.value)}
                  onBlur={() => blur('NOTION_TOKEN')}
                  type="text"
                  autoComplete="off"
                />
              </Field>

              <Field
                label="邮件数据库 ID"
                icon="database"
                error={showErr('EMAIL_DATABASE_ID')}
                warn={warns.EMAIL_DATABASE_ID}
                hint="选填 · 打开你的邮件数据库 → 复制 URL 里的 32 位 ID"
              >
                <input
                  className={`fld mono ${showErr('EMAIL_DATABASE_ID') ? 'err' : ''}`}
                  placeholder="a1b2c3d4e5f6…（32 位）"
                  value={form.EMAIL_DATABASE_ID ?? ''}
                  onChange={(e) => set('EMAIL_DATABASE_ID', e.target.value)}
                  onBlur={() => blur('EMAIL_DATABASE_ID')}
                />
              </Field>

              {calendarFieldVisible && (
                <Field
                  label="日历数据库 ID"
                  icon="calendar"
                  warn={warns.CALENDAR_DATABASE_ID}
                  hint="选填 · 如需同步会议到日历再填，可稍后在设置补"
                >
                  <input
                    className="fld mono"
                    placeholder="选填"
                    value={form.CALENDAR_DATABASE_ID ?? ''}
                    onChange={(e) => set('CALENDAR_DATABASE_ID', e.target.value)}
                  />
                </Field>
              )}
            </>
          )}
        </div>
      </div>
      <WizFooter
        onBack={busy ? null : onBack}
        onNext={() => {
          setTouched({
            USER_EMAIL: true,
            // 账户名只有 applescript 要求; davmail 要求 cipher (非 PoC 模式时);
            // outlook_com 两者都不要。Notion 两键已改选填 (07-12 P3b), 不进 touched/errs。
            MAIL_ACCOUNT_NAME: backend === 'applescript',
            DAVMAIL_POC_CIPHER_KEY: isDavmail
          })
          // "开始同步" 现在提交核心配置 + 起后端 (commitConfig), 成功才进 StepSync。
          // 这样 StepSync 才能轮询到真实后端进度 (旧实现把提交放最后 StepDone,
          // Sync 时后端没起 → 进度永远 exists=false → 首次同步永不完成)。
          if (valid && !busy) commit()
        }}
        nextDisabled={!valid}
        nextLabel={busy ? '正在启动…' : slow || submitError ? '重试' : '开始同步'}
        nextIcon="arrowRight"
        busy={busy}
      />
    </>
  )
}
