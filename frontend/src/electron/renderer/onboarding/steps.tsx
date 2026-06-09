// Onboarding NEW-user wizard steps (7) — ported from docs/packaging/onboarding/wizard.jsx
// to production TSX, wired to the real onboarding:* IPC. The 'detailed' tone copy is
// the shipped default (the demo's tone Tweak is dropped — rail layout only).
//
// Collection model: each step mutates shared state held in OnboardingRoot; nothing
// is committed until StepDone calls complete() with EVERYTHING gathered. Any IPC
// channel that errors degrades gracefully (mock/empty) — the wizard never blocks.

/* eslint-disable react-refresh/only-export-components -- this module co-exports the
   step components plus the ConfigForm/SubmitError types + buildCompleteConfig helper
   used by OnboardingRoot; splitting them would be over-abstraction for the wizard. */

import { useEffect, useRef, useState } from 'react'

import {
  Banner,
  ChipSelect,
  Field,
  Icon,
  ProgressBar,
  Toggle,
  WizFooter,
  type IconName
} from './components'
import * as ipc from './ipc'
import type {
  BackendKind,
  CheckEnvResult,
  CompleteConfig,
  DetectDavmailResult,
  PluginFlags,
  Status
} from './ipc'
import type { FolderInfo, FolderTreeNode } from '@shared/api/types'

/* ════════════════════════════════════════════════════════════════════════
   Shared step state (lifted to OnboardingRoot)
   ════════════════════════════════════════════════════════════════════════ */

export interface ConfigForm {
  USER_EMAIL?: string
  NOTION_TOKEN?: string
  EMAIL_DATABASE_ID?: string
  CALENDAR_DATABASE_ID?: string
  MAIL_ACCOUNT_NAME?: string
  SYNC_MAILBOXES?: string[]
  // — DavMail 连接配置 (仅 backend==='davmail' 时填; applescript 分支不展示/不收集)。
  DAVMAIL_HOST?: string
  DAVMAIL_IMAP_PORT?: string
  DAVMAIL_SMTP_PORT?: string
  /** PoC 默认密钥开关。true → DAVMAIL_POC_MODE=true (用默认 shared key);
   *  false → 需填 DAVMAIL_POC_CIPHER_KEY。默认 true。 */
  DAVMAIL_POC_MODE?: boolean
  DAVMAIL_POC_CIPHER_KEY?: string
}

const DAVMAIL_DEFAULT_HOST = '127.0.0.1'
const DAVMAIL_DEFAULT_IMAP_PORT = '1143'
const DAVMAIL_DEFAULT_SMTP_PORT = '1025'

export interface SubmitError {
  title: string
  message: string
}

/* ─── Step 0 · Welcome ─────────────────────────────────────────────────────── */
export interface StepWelcomeProps {
  onNext: () => void
  onLegacy: () => void
  legacyFound: boolean
}

export function StepWelcome({
  onNext,
  onLegacy,
  legacyFound
}: StepWelcomeProps): React.JSX.Element {
  const features: { ic: IconName; t: string; d: string }[] = [
    { ic: 'mail', t: '实时同步', d: '邮件镜像进 Notion 数据库' },
    { ic: 'spark', t: 'AI 分类', d: '优先级 · 动作项 · 起草回复' },
    { ic: 'lock', t: '本地优先', d: '数据存本机，不上传第三方' }
  ]
  return (
    <>
      <div className="wiz-body scrollbar-thin step-enter">
        <div className="flex flex-col items-center text-center pt-3">
          <span
            className="grid place-items-center w-16 h-16 rounded-2xl mb-5"
            style={{
              background: 'rgb(var(--c-accent)/0.12)',
              border: '1px solid rgb(var(--c-accent)/0.3)',
              color: 'rgb(var(--c-accent))'
            }}
          >
            <Icon name="spark" size={30} fill />
          </span>
          <div className="eyebrow">Welcome</div>
          <h1 className="wiz-h1">欢迎使用 MailAgent</h1>
          <p className="wiz-lede" style={{ textAlign: 'center' }}>
            把你的邮件实时同步到 Notion，并用 AI 帮你分类、起草回复。接下来约 5 分钟完成设置 ——
            全程无需终端命令。
          </p>
        </div>

        <div className="grid grid-cols-3 gap-3 mt-8">
          {features.map((c) => (
            <div key={c.t} className="ds-card" style={{ padding: '14px 13px' }}>
              <span className="text-ink-fg-1" style={{ color: 'rgb(var(--c-accent))' }}>
                <Icon name={c.ic} size={18} fill={c.ic === 'spark'} />
              </span>
              <div className="text-[14px] font-semibold text-ink-fg mt-2.5">{c.t}</div>
              <div className="text-[12px] text-ink-fg-2 mt-1 leading-snug">{c.d}</div>
            </div>
          ))}
        </div>

        <div className="mt-5">
          <Banner kind="info" icon="folder">
            你的所有数据保存在本机{' '}
            <span className="font-mono text-[12px] text-ink-fg">
              ~/Library/Application Support/MailAgent
            </span>
            ，不上传到第三方服务器（除你自己配置的 Notion）。
          </Banner>
        </div>
      </div>
      <WizFooter
        onNext={onNext}
        nextLabel="开始设置"
        left={
          legacyFound ? (
            <button
              className="btn-link ml-2 inline-flex items-center gap-1.5 whitespace-nowrap"
              onClick={onLegacy}
            >
              <Icon name="folder" size={13} /> 我已有旧版数据，从旧目录导入
            </button>
          ) : null
        }
      />
    </>
  )
}

/* ─── Step 1 · Environment & permissions (FDA) ─────────────────────────────── */
interface FdaCheckDef {
  key: keyof CheckEnvResult
  label: string
  detail: string
  kind: 'system' | 'perm'
}

const FDA_CHECKS: FdaCheckDef[] = [
  { key: 'os', label: 'macOS 版本', detail: '需要 macOS 12 (Monterey) 或更高', kind: 'system' },
  {
    key: 'pythonRuntime',
    label: '嵌入式 Python 运行时',
    detail: 'MAILAGENT_BIN 可执行',
    kind: 'system'
  },
  { key: 'dataWritable', label: 'DATA_ROOT 可写', detail: '数据目录可创建 / 写入', kind: 'system' },
  { key: 'fda', label: '完全磁盘访问 (FDA)', detail: '读取 Mail.app 邮件数据', kind: 'perm' },
  {
    key: 'automation',
    label: '自动化 · 控制 Mail.app',
    detail: '草稿 / 回复需 Apple Events 权限',
    kind: 'perm'
  }
]

type CheckState = Status | 'pending'

export interface StepFdaProps {
  onNext: () => void
  onBack: () => void
  onSkip: () => void
}

export function StepFDA({ onNext, onBack, onSkip }: StepFdaProps): React.JSX.Element {
  const [results, setResults] = useState<Record<string, CheckState>>({})
  const [scanning, setScanning] = useState(true)
  const alive = useRef(true)
  const scanTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const runScan = (): void => {
    setScanning(true)
    setResults(Object.fromEntries(FDA_CHECKS.map((c) => [c.key, 'pending'])))
    // Degrade to a non-blocking warn state (skippable). Used by both the
    // catch (reject) path AND the timeout (hang) path so a checkEnv handler
    // that never resolves can't pin the user on an eternal "检测中" spinner.
    const degradeToWarn = (): void => {
      if (!alive.current) return
      setResults(Object.fromEntries(FDA_CHECKS.map((c) => [c.key, 'warn'])))
      setScanning(false)
    }
    if (scanTimer.current) clearTimeout(scanTimer.current)
    // ~8s timeout bound: if checkEnv hangs (no resolve/reject), fall to warn so
    // the escape hatch ("稍后设置") becomes reachable.
    scanTimer.current = setTimeout(degradeToWarn, 8000)
    void ipc
      .checkEnv()
      .then((r) => {
        if (!alive.current) return
        // Map real result; any missing key degrades to 'warn' (non-blocking).
        const next: Record<string, CheckState> = {}
        for (const c of FDA_CHECKS) {
          const v = r?.[c.key]
          next[c.key] = v === 'pass' || v === 'fail' || v === 'warn' ? v : 'warn'
        }
        setResults(next)
        setScanning(false)
      })
      .catch(() => {
        // checkEnv unavailable → don't block: system checks warn, FDA warn (skippable).
        degradeToWarn()
      })
      .finally(() => {
        if (scanTimer.current) {
          clearTimeout(scanTimer.current)
          scanTimer.current = null
        }
      })
  }

  useEffect(() => {
    alive.current = true
    // runScan() sets 'pending'/scanning synchronously then resolves via IPC; the
    // initial render already shows scanning=true, so the sync setState here is
    // intentional (kick off the first scan on mount).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    runScan()
    return () => {
      alive.current = false
      if (scanTimer.current) {
        clearTimeout(scanTimer.current)
        scanTimer.current = null
      }
    }
  }, [])

  const openSettings = (): void => {
    void ipc.openPrivacyPane('AllFiles').catch(() => undefined)
  }

  const r = results
  const allDone = FDA_CHECKS.every((c) => r[c.key] && r[c.key] !== 'pending') && !scanning
  // systemBlocked only when os/pythonRuntime/dataWritable == fail (automation 'warn' is never blocking).
  const systemBlocked = FDA_CHECKS.some((c) => c.kind === 'system' && r[c.key] === 'fail')
  const fdaOk = r.fda === 'pass'
  const canProceed = allDone && !systemBlocked

  const iconFor = (st: CheckState): React.JSX.Element =>
    st === 'pass' ? (
      <Icon name="check" size={13} sw={3} style={{ color: 'rgb(var(--c-ok))' }} />
    ) : st === 'fail' ? (
      <Icon name="x" size={13} sw={3} style={{ color: 'rgb(var(--c-fail))' }} />
    ) : st === 'warn' ? (
      <Icon name="alert" size={13} style={{ color: 'rgb(var(--c-warn))' }} />
    ) : (
      <Icon name="refresh" size={13} cls="spin" style={{ color: 'rgb(var(--ink-fg-2))' }} />
    )
  const boxClass = (st: CheckState): string =>
    st === 'pass'
      ? 'chk-pass'
      : st === 'fail'
        ? 'chk-fail'
        : st === 'warn'
          ? 'chk-warn'
          : 'chk-pending'

  return (
    <>
      <div className="wiz-body scrollbar-thin step-enter">
        <div className="eyebrow">Step 1 — 环境与权限</div>
        <h1 className="wiz-h1">检查运行环境</h1>
        <p className="wiz-lede">
          MailAgent 正在检测系统环境与所需权限。完全磁盘访问是读取 Mail.app 邮件的前提。
        </p>

        <div className="flex flex-col gap-2 mt-6">
          {FDA_CHECKS.map((c) => {
            const st = r[c.key] ?? 'pending'
            return (
              <div key={c.key} className="chk-row">
                <span className={`chk-icon ${boxClass(st)}`}>{iconFor(st)}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] text-ink-fg flex items-center gap-2">
                    {c.label}
                    {c.kind === 'perm' && <span className="pill pill-muted">需授权</span>}
                  </div>
                  <div className="text-[12px] text-ink-fg-2 mt-0.5">{c.detail}</div>
                </div>
                {st === 'fail' && c.key === 'fda' && (
                  <button
                    className="btn-sec"
                    style={{ padding: '5px 10px', fontSize: 13 }}
                    onClick={openSettings}
                  >
                    <Icon name="external" size={13} /> 打开系统设置
                  </button>
                )}
              </div>
            )
          })}
        </div>

        {systemBlocked && allDone && (
          <div className="mt-5">
            <Banner kind="fail" icon="alert">
              <div className="font-semibold text-[13px] mb-1">系统环境检查未通过</div>
              <span>
                嵌入式 Python 运行时 / 数据目录 / 系统版本存在问题，后续同步可能无法启动。
                你可以「重新检测」，或先「跳过并继续」到后续步骤，回头在设置里修复后再启动后端。
              </span>
            </Banner>
          </div>
        )}
        {!systemBlocked && !fdaOk && allDone && (
          <div className="mt-5">
            <Banner kind="warn">
              <div className="font-semibold text-[13px] mb-1">完全磁盘访问未授权</div>
              <span>
                请点击「打开系统设置」→ 隐私与安全 → 完全磁盘访问 → 勾选
                MailAgent，然后回来点「重新检测」。你也可以「稍后设置」，但邮件读取功能会受限。
              </span>
            </Banner>
          </div>
        )}
        {!systemBlocked && fdaOk && allDone && (
          <div className="mt-5">
            <Banner kind="info" icon="check">
              环境检查全部通过，可以继续。
            </Banner>
          </div>
        )}
      </div>
      <WizFooter
        onBack={onBack}
        secondary={
          // Escape hatch is decoupled from systemBlocked: it shows whenever the
          // scan finished but is not fully clean (FDA not granted OR a system
          // check failed). systemBlocked alone used to leave the user with the
          // primary button永久 disabled and NO secondary (the old `!fdaOk` gate
          // hid it when fda happened to pass) — that was the headline dead-end.
          allDone && (!fdaOk || systemBlocked) ? (
            <button
              className="btn-link"
              onClick={() => {
                onSkip()
                onNext()
              }}
            >
              {systemBlocked ? '跳过并继续' : '稍后设置'}
            </button>
          ) : null
        }
        left={
          allDone ? (
            <button className="btn-link ml-3" onClick={runScan}>
              <Icon name="refresh" size={13} /> 重新检测
            </button>
          ) : null
        }
        onNext={onNext}
        nextDisabled={!canProceed}
        busy={scanning}
        nextLabel={fdaOk ? '下一步' : '仍要继续'}
      />
    </>
  )
}

/* ─── Step 2 · Backend selection ───────────────────────────────────────────── */
export interface StepBackendProps {
  backend: BackendKind
  setBackend: (b: BackendKind) => void
  davAck: boolean
  setDavAck: (v: boolean) => void
  onNext: () => void
  onBack: () => void
}

export function StepBackend({
  backend,
  setBackend,
  davAck,
  setDavAck,
  onNext,
  onBack
}: StepBackendProps): React.JSX.Element {
  const [advOpen, setAdvOpen] = useState(false)
  const canNext = backend === 'applescript' || (backend === 'davmail' && davAck)
  return (
    <>
      <div className="wiz-body scrollbar-thin step-enter">
        <div className="eyebrow">Step 2 — 后端选择</div>
        <h1 className="wiz-h1">选择邮件后端</h1>
        <p className="wiz-lede">
          决定 MailAgent 如何读写你的邮件。个人用户推荐 AppleScript —— 零配置、零合规风险。
        </p>

        <div className="flex flex-col gap-3 mt-6">
          <button
            type="button"
            className={`opt-card ${backend === 'applescript' ? 'on' : ''}`}
            onClick={() => setBackend('applescript')}
          >
            <div className="flex items-start gap-3">
              <span className="opt-radio mt-0.5" />
              <span
                className="text-ink-fg-1 mt-0.5"
                style={{ color: backend === 'applescript' ? 'rgb(var(--c-accent))' : undefined }}
              >
                <Icon name="mail" size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[15px] font-semibold text-ink-fg">AppleScript</span>
                  <span className="pill pill-ok">推荐</span>
                </div>
                <div className="text-[13px] text-ink-fg-1 mt-1 leading-snug">
                  使用你 Mail.app 里已登录的账户读写邮件。零配置，需要上一步授予完全磁盘访问。
                </div>
              </div>
            </div>
          </button>

          <button
            type="button"
            className={`opt-card ${backend === 'davmail' ? 'on' : ''}`}
            onClick={() => {
              setBackend('davmail')
              setAdvOpen(true)
            }}
          >
            <div className="flex items-start gap-3">
              <span className="opt-radio mt-0.5" />
              <span
                className="text-ink-fg-1 mt-0.5"
                style={{ color: backend === 'davmail' ? 'rgb(var(--c-accent))' : undefined }}
              >
                <Icon name="server" size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[15px] font-semibold text-ink-fg">DavMail</span>
                  <span className="pill pill-info">企业 · Outlook/EWS</span>
                  <span className="pill pill-warn">Beta</span>
                </div>
                <div className="text-[13px] text-ink-fg-1 mt-1 leading-snug">
                  用于 Outlook / Exchange 企业邮箱。需系统 Java + 引导式配置，有合规前提。
                </div>
              </div>
            </div>
          </button>
        </div>

        {backend === 'davmail' && (
          <div className="mt-3 step-enter">
            <button
              type="button"
              className="flex items-center gap-1.5 text-[13px] text-ink-fg-2 hover:text-ink-fg transition"
              onClick={() => setAdvOpen(!advOpen)}
            >
              <Icon name={advOpen ? 'x' : 'alert'} size={13} />{' '}
              {advOpen ? '收起合规说明' : '展开合规说明（必读）'}
            </button>
            {advOpen && (
              <div className="mt-3">
                <Banner kind="warn">
                  <div className="font-semibold text-[13px] mb-1.5">重要提示 · 请仔细阅读</div>
                  <ul
                    className="text-[12.5px] text-ink-fg-1 leading-relaxed space-y-1.5"
                    style={{ listStyle: 'disc', paddingLeft: 16 }}
                  >
                    <li>
                      DavMail 当前使用 Outlook 的 well-known client_id
                      进行身份伪装，属概念验证（PoC），
                      <span className="text-ink-fg">未经公司 IT 审批</span>，不可用于正式分发。
                    </li>
                    <li>
                      EWS 协议将于 <span className="font-mono text-[12px]">2026-10-01</span>{' '}
                      关停，长期方案需申请独立 Microsoft Graph API 应用注册。
                    </li>
                    <li>
                      OAuth 初次授权需手动操作，本向导不在此处自动化，请参阅《DavMail
                      高级配置》文档。
                    </li>
                  </ul>
                  {/* 整行单 button: 点方块或文字都能勾 (原 label+span 只有 14px 方块
                      可点、文字无反应 → 勾不上 → canNext 永 false 卡死)。 */}
                  <button
                    type="button"
                    className="flex w-full items-center gap-2.5 mt-3 cursor-pointer select-none text-left"
                    onClick={() => setDavAck(!davAck)}
                    aria-pressed={davAck}
                  >
                    <span className={`cb ${davAck ? 'cb-on' : ''}`} />
                    <span className="text-[13px] text-ink-fg">
                      我已了解上述风险，仍要继续配置 DavMail（仅限个人评估用途）
                    </span>
                  </button>
                </Banner>
              </div>
            )}
          </div>
        )}
      </div>
      <WizFooter onBack={onBack} onNext={onNext} nextDisabled={!canNext} />
    </>
  )
}

/* ─── Step 3 · Mail sync config (real account detect + client validation) ──── */
const HEX32 = /^[0-9a-f]{32}$/i
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DEFAULT_MAILBOXES = ['收件箱', '发件箱', '已发送', '归档', '重要']

/* ─── DavMail-specific config fields (账户/认证/桥状态/高级 host·port) ──────────
   davmail 分支不枚举 Mail.app 账户 (USER_EMAIL 即登录名), 改为: 桥状态 banner +
   USER_EMAIL (relabeled) + PoC 默认密钥 toggle / cipher 输入 + 高级折叠 host/port。 */
interface DavmailFieldsProps {
  form: ConfigForm
  set: <K extends keyof ConfigForm>(k: K, v: ConfigForm[K]) => void
  blur: (k: string) => void
  showErr: (k: string) => string | undefined
  pocMode: boolean
  davDetect: DetectDavmailResult | null
}

function DavmailFields({
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
  const [accounts, setAccounts] = useState<string[] | null>(null) // null = loading
  const [mailboxes, setMailboxes] = useState<string[]>(DEFAULT_MAILBOXES)
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
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
    // davmail 后端不枚举 Mail.app 账户 (debug mail-structure 是 AppleScript-only,
    // davmail 无账户枚举, USER_EMAIL 即登录名)。不调 listMailAccounts —— davmail 分支
    // 的账户 UI (accounts 消费方) 全在 !isDavmail 后渲染, 这里直接跳过即可。
    if (isDavmail) {
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
  }, [isDavmail])

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
          message: err instanceof Error ? err.message : String(err)
        })
        setBusy(false)
      })
  }

  // davmail PoC 模式默认开 (form 字段 undefined 视为 true)。
  const pocMode = form.DAVMAIL_POC_MODE !== false
  const errs: Record<string, string> = {}
  if (!form.USER_EMAIL) errs.USER_EMAIL = '必填项'
  else if (!EMAIL_RE.test(form.USER_EMAIL)) errs.USER_EMAIL = '邮箱格式不正确'
  if (!form.NOTION_TOKEN) errs.NOTION_TOKEN = '必填项'
  if (!form.EMAIL_DATABASE_ID) errs.EMAIL_DATABASE_ID = '必填项'
  if (isDavmail) {
    // davmail 不要求 MAIL_ACCOUNT_NAME (USER_EMAIL 即登录名); 但要求一种认证方式:
    // PoC 默认密钥 或 非空 cipher。
    if (!pocMode && !(form.DAVMAIL_POC_CIPHER_KEY ?? '').trim()) {
      errs.DAVMAIL_POC_CIPHER_KEY = '请填写密钥或改用 PoC 默认密钥'
    }
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

  const valid = Object.keys(errs).length === 0
  const showErr = (k: string): string | undefined => (touched[k] ? errs[k] : undefined)
  const accountsEmpty = accounts !== null && accounts.length === 0

  return (
    <>
      <div className="wiz-body scrollbar-thin step-enter">
        <div className="eyebrow">Step 3 — 邮件同步配置</div>
        <h1 className="wiz-h1">连接 Notion 与邮箱</h1>
        <p className="wiz-lede">
          填写后写入 DATA_ROOT/.env（行级原子写，不破坏注释）。Token 会镜像到系统钥匙串。
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

          <Field
            label="Notion Token"
            icon="key"
            required
            error={showErr('NOTION_TOKEN')}
            warn={warns.NOTION_TOKEN}
            hint={
              <span>
                在 Notion → Settings → Connections 创建 Integration，粘贴 secret。
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
            required
            error={showErr('EMAIL_DATABASE_ID')}
            warn={warns.EMAIL_DATABASE_ID}
            hint="打开你的邮件数据库 → 复制 URL 里的 32 位 ID"
          >
            <input
              className={`fld mono ${showErr('EMAIL_DATABASE_ID') ? 'err' : ''}`}
              placeholder="a1b2c3d4e5f6…（32 位）"
              value={form.EMAIL_DATABASE_ID ?? ''}
              onChange={(e) => set('EMAIL_DATABASE_ID', e.target.value)}
              onBlur={() => blur('EMAIL_DATABASE_ID')}
            />
          </Field>

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
        </div>
      </div>
      <WizFooter
        onBack={busy ? null : onBack}
        onNext={() => {
          setTouched({
            USER_EMAIL: true,
            NOTION_TOKEN: true,
            EMAIL_DATABASE_ID: true,
            // davmail 不要求账户名, 但要求 cipher (非 PoC 模式时); applescript 反之。
            MAIL_ACCOUNT_NAME: !isDavmail,
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

/* ─── Step 3.5 · 选择要同步的文件夹 (多文件夹同步 P4, davmail-only) ──────────────
   邮箱配置 (StepConfig commitConfig 已起后端) 之后插一步。临摹 wiz-body 版式 +
   FolderPicker 的树渲染 (缩进 + 展开/收起)。系统文件夹默认选中并锁定; 自定义默认全
   不选; 大文件夹轻量提示。底部 [跳过](弱) + [继续](coral), 强调可跳过 —— 整步可跳过
   (拉取失败 / 非 davmail / 用户不想选), 不阻塞 onboarding。此步不放管理操作 (保持简洁)。

   注: onboarding 是 Chinese-only 移植原型 (全部 7 步硬编码中文, 无 i18n), 本步保持同一
   约定以维持隔离一致性; FolderPicker (设置页) 才走双语 t()。 */

const ONBOARDING_LARGE_FOLDER_THRESHOLD = 1000

/** flatten tree → 系统 imap_name 集合 (默认选中并锁定)。 */
export function collectSystemImapNames(folders: FolderInfo[]): Set<string> {
  const out = new Set<string>()
  for (const f of folders) if (f.is_system) out.add(f.imap_name)
  return out
}

interface OnboardingFolderRowProps {
  node: FolderTreeNode
  depth: number
  selected: ReadonlySet<string>
  expanded: ReadonlySet<string>
  onToggle: (imapName: string) => void
  onToggleExpand: (imapName: string) => void
}

/** onboarding 文件夹树单行 — 临摹 FolderPicker.FolderRow, 但不含管理 ⋯ 菜单 (引导简洁)。 */
function OnboardingFolderRow({
  node,
  depth,
  selected,
  expanded,
  onToggle,
  onToggleExpand
}: OnboardingFolderRowProps): React.JSX.Element {
  const hasChildren = node.children.length > 0
  const isOpen = expanded.has(node.imap_name)
  const isChecked = selected.has(node.imap_name)
  const isLarge = (node.message_count ?? 0) > ONBOARDING_LARGE_FOLDER_THRESHOLD
  const indentPx = depth * 22

  return (
    <>
      <div
        className="flex items-center gap-2 px-3 py-2"
        style={{ paddingLeft: `${12 + indentPx}px`, opacity: node.is_system ? 0.75 : 1 }}
      >
        {node.is_system ? (
          <span
            className="shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-[4px] bg-ink-3 border border-ink-border-soft text-ink-fg-3"
            title="系统文件夹 · 默认同步"
          >
            <Icon name="lock" size={9} />
          </span>
        ) : (
          <button
            type="button"
            role="checkbox"
            aria-checked={isChecked}
            aria-label={node.display_name}
            onClick={() => onToggle(node.imap_name)}
            className={`shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-[4px] border transition-colors ${
              isChecked
                ? 'border-transparent text-ink-fg'
                : 'bg-transparent border-ink-border hover:border-ink-fg-2'
            }`}
            style={
              isChecked
                ? { background: 'rgb(var(--c-accent))', color: 'rgb(var(--c-accent-fg))' }
                : undefined
            }
          >
            {isChecked ? <Icon name="check" size={11} sw={3} /> : null}
          </button>
        )}

        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggleExpand(node.imap_name)}
            aria-label={isOpen ? '收起' : '展开'}
            aria-expanded={isOpen}
            className="shrink-0 inline-flex items-center justify-center w-4 h-4 rounded text-ink-fg-2 hover:text-ink-fg"
          >
            <Icon
              name="chevron"
              size={12}
              style={{
                transition: 'transform var(--dur-fast, 120ms)',
                transform: isOpen ? 'rotate(90deg)' : undefined
              }}
            />
          </button>
        ) : (
          <span className="shrink-0 w-4 h-4" aria-hidden="true" />
        )}

        <span className="text-ink-fg-2 shrink-0">
          <Icon
            name={
              node.is_system
                ? node.special_use === '\\sent'
                  ? 'send'
                  : node.imap_name.toUpperCase() === 'INBOX'
                    ? 'inbox'
                    : 'folder'
                : 'folder'
            }
            size={14}
          />
        </span>
        <span className="flex-1 min-w-0 truncate text-[13px] text-ink-fg">{node.display_name}</span>

        {typeof node.message_count === 'number' ? (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-fg-2">
            {node.message_count.toLocaleString('en-US')}
          </span>
        ) : null}

        {isLarge && !node.is_system ? (
          <span className="shrink-0 inline-flex items-center gap-1 px-1.5 py-px rounded text-[10px] font-mono bg-warn/15 text-warn">
            <Icon name="clock" size={10} /> 首次同步较慢
          </span>
        ) : null}

        {node.is_system ? (
          <span className="shrink-0 text-[11px] text-ink-fg-3">默认 · 已锁定</span>
        ) : null}
      </div>

      {hasChildren && isOpen
        ? node.children.map((child) => (
            <OnboardingFolderRow
              key={child.imap_name}
              node={child}
              depth={depth + 1}
              selected={selected}
              expanded={expanded}
              onToggle={onToggle}
              onToggleExpand={onToggleExpand}
            />
          ))
        : null}
    </>
  )
}

export interface StepFoldersProps {
  /** 仅 davmail 渲染本步 (OnboardingRoot 在 applescript 时跳过)。 */
  onNext: () => void
  onBack: () => void
  /** 强调可跳过: 跳过 = 仅同步收件箱/发件箱, 不写白名单。 */
  onSkip: () => void
}

export function StepFolders({ onNext, onBack, onSkip }: StepFoldersProps): React.JSX.Element {
  // null = 加载中; [] 视情况为空态; 'gated'/'error' 走可跳过降级。
  const [tree, setTree] = useState<FolderTreeNode[] | null>(null)
  const [folders, setFolders] = useState<FolderInfo[]>([])
  const [phase, setPhase] = useState<'loading' | 'ready' | 'gated' | 'error'>('loading')
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const alive = useRef(true)
  // ~8s hang 兜底 (twin of StepFDA/StepConfig): discover 走 IMAP LIST 可能 hang →
  // 降级到 error 态 (仍可跳过), 不把用户钉死在 spinner。
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    alive.current = true
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      if (!alive.current) return
      setPhase((p) => (p === 'loading' ? 'error' : p))
    }, 8000)
    const clearTimer = (): void => {
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
      }
    }
    void ipc
      .discoverFolders(true)
      .then((res) => {
        if (!alive.current) return
        setFolders(res.folders)
        setTree(res.tree)
        // 系统文件夹默认选中并锁定; 自定义默认全不选 (whitelist 在 onboarding 不预选)。
        setSelected(collectSystemImapNames(res.folders))
        setPhase('ready')
      })
      .catch((e: unknown) => {
        if (!alive.current) return
        const code = (e as { code?: string } | null)?.code
        // 非 davmail 后端 (E_INVALID_ARG) → 门控态 (理论上 applescript 不渲染本步, 兜底)。
        setPhase(code === 'E_INVALID_ARG' ? 'gated' : 'error')
      })
      .finally(clearTimer)
    return () => {
      alive.current = false
      clearTimer()
    }
  }, [])

  const toggle = (imapName: string): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(imapName)) next.delete(imapName)
      else next.add(imapName)
      return next
    })

  const toggleExpand = (imapName: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(imapName)) next.delete(imapName)
      else next.add(imapName)
      return next
    })

  // 「继续」: 把已选的自定义文件夹 (排除系统) 存白名单, 然后进 StepSync。
  // 系统文件夹由后端 SYNC_MAILBOXES 处理, 不进 SYNC_FOLDERS 白名单。
  const proceed = (): void => {
    const systemSet = collectSystemImapNames(folders)
    const custom = Array.from(selected).filter((n) => !systemSet.has(n))
    // 没有自定义勾选 = 等价跳过, 但仍显式写空白名单以收敛状态。
    setSaving(true)
    void ipc
      .setFolderWhitelist(custom)
      .catch(() => undefined) // 写失败不阻塞 onboarding (用户稍后可在设置里改)
      .finally(() => {
        if (!alive.current) return
        setSaving(false)
        onNext()
      })
  }

  const customCount = tree
    ? folders.filter((f) => !f.is_system && selected.has(f.imap_name)).length
    : 0

  return (
    <>
      <div className="wiz-body scrollbar-thin step-enter">
        <div className="eyebrow">Step · 文件夹</div>
        <h1 className="wiz-h1">选择要同步的文件夹</h1>
        <p className="wiz-lede">
          勾选要同步进 MailAgent 的文件夹，邮件将享受 AI 分类、Notion 同步等完整能力。
          可稍后在「设置 → 同步」修改。
        </p>

        {phase === 'loading' && (
          <div className="ds-card ds-card-pad mt-6 flex items-center justify-center gap-2 text-ink-fg-2">
            <Icon name="refresh" size={15} cls="spin" /> 正在拉取文件夹…
          </div>
        )}

        {phase === 'gated' && (
          <div className="mt-6">
            <Banner kind="info" icon="folder">
              多文件夹同步仅在 DavMail 后端可用。当前后端无需选择文件夹，点「继续」即可。
            </Banner>
          </div>
        )}

        {phase === 'error' && (
          <div className="mt-6">
            <Banner kind="warn" icon="alert">
              暂时无法拉取文件夹列表（可能是 DavMail 桥尚未就绪）。可先「跳过」，稍后在「设置 →
              同步」里随时勾选要同步的文件夹。
            </Banner>
          </div>
        )}

        {phase === 'ready' && tree && tree.length === 0 && (
          <div className="mt-6">
            <Banner kind="info" icon="folder">
              你的邮箱里暂未发现收件箱 / 发件箱以外的文件夹。可直接「继续」，稍后在设置里随时调整。
            </Banner>
          </div>
        )}

        {phase === 'ready' && tree && tree.length > 0 && (
          <>
            <div className="ds-card mt-6 overflow-hidden">
              <div className="max-h-72 overflow-y-auto scrollbar-thin divide-y divide-ink-border-soft/60">
                {tree.map((node) => (
                  <OnboardingFolderRow
                    key={node.imap_name}
                    node={node}
                    depth={0}
                    selected={selected}
                    expanded={expanded}
                    onToggle={toggle}
                    onToggleExpand={toggleExpand}
                  />
                ))}
              </div>
            </div>
            <p className="text-[12px] text-ink-fg-2 mt-3 font-mono">
              已选 {customCount} 个自定义文件夹（收件箱 / 发件箱始终同步）。
            </p>
          </>
        )}
      </div>
      <WizFooter
        onBack={saving ? null : onBack}
        secondary={
          <button
            className="btn-link"
            onClick={() => {
              onSkip()
              onNext()
            }}
            disabled={saving}
          >
            跳过（仅同步收件箱 / 发件箱）
          </button>
        }
        onNext={proceed}
        nextLabel={saving ? '保存中…' : '继续'}
        busy={saving}
      />
    </>
  )
}

/* ─── Step 4 · First init sync (real progress polling) ─────────────────────── */
const SYNC_STAGES = [
  { key: 'db', label: '建表 · 初始化数据库', sub: 'sync_store.db → v17' },
  { key: 'fetch', label: '拉取邮件缓存', sub: '读取 Mail.app / IMAP' },
  { key: 'notion', label: '写入 Notion', sub: '镜像到邮件数据库' }
]

export interface SyncState {
  done: boolean
  background: boolean
}

export interface StepSyncProps {
  onNext: () => void
  onBack: () => void
  /** lifted so StepDone can show the background banner */
  setBackground: (v: boolean) => void
}

export function StepSync({ onNext, onBack, setBackground }: StepSyncProps): React.JSX.Element {
  const [total, setTotal] = useState(0)
  const [synced, setSynced] = useState(0)
  const [dbVersion, setDbVersion] = useState<number | null>(null)
  const [stage, setStage] = useState(0) // 0 db, 1 fetch, 2 notion
  const [done, setDone] = useState(false)
  const [bg, setBg] = useState(false)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const alive = useRef(true)
  // In-flight guard: skip a tick if the previous syncProgress() hasn't settled,
  // so a slow/wedged handler can't accumulate pending IPC every 1.5s.
  const inFlight = useRef(false)

  useEffect(() => {
    alive.current = true
    const poll = (): void => {
      if (inFlight.current) return
      inFlight.current = true
      void ipc
        .syncProgress()
        .then((r) => {
          if (!alive.current) return
          if (!r) return
          setTotal(r.total ?? 0)
          setSynced(r.synced ?? 0)
          setDbVersion(r.dbVersion ?? null)
          // Derive a 3-stage indicator from real signals:
          //   db not ready yet → stage 0; db exists but still syncing → 1;
          //   ready → 2 (done).
          if (r.ready) {
            setStage(2)
            setDone(true)
          } else if (r.exists && r.dbVersion != null) {
            setStage((r.synced ?? 0) > 0 ? 2 : 1)
          } else {
            setStage(0)
          }
        })
        .catch(() => undefined) // never throw — keep polling, keep wizard alive
        .finally(() => {
          inFlight.current = false
        })
    }
    poll()
    timer.current = setInterval(poll, 1500)
    return () => {
      alive.current = false
      if (timer.current) clearInterval(timer.current)
    }
  }, [])

  // Stop polling once done.
  useEffect(() => {
    if (done && timer.current) {
      clearInterval(timer.current)
      timer.current = null
    }
  }, [done])

  const stageObj = SYNC_STAGES[Math.min(stage, SYNC_STAGES.length - 1)]
  const pctRaw = total > 0 ? Math.round((synced / total) * 100) : done ? 100 : stage === 0 ? 5 : 35
  const pct = done ? 100 : Math.min(99, pctRaw)
  const indeterminate = !done && total === 0

  const goBackground = (): void => {
    setBg(true)
    setBackground(true)
    if (timer.current) clearInterval(timer.current)
    onNext()
  }

  return (
    <>
      <div className="wiz-body scrollbar-thin step-enter">
        <div className="eyebrow">Step 4 — 首次同步</div>
        <h1 className="wiz-h1">{done ? '首次同步完成' : '正在初始化并同步邮件'}</h1>
        <p className="wiz-lede">
          {done
            ? '数据库已就绪，邮件已开始镜像到 Notion。'
            : '后端正在建表并拉取你的邮件。向导直读 sync_state 表轮询就绪状态。'}
        </p>

        <div className="ds-card ds-card-pad mt-6">
          <div className="flex items-center justify-between mb-2.5">
            <div className="flex items-center gap-2.5">
              {done ? (
                <span style={{ color: 'rgb(var(--c-ok))' }}>
                  <Icon name="check" size={18} sw={3} />
                </span>
              ) : (
                <span style={{ color: 'rgb(var(--c-accent))' }}>
                  <Icon name="refresh" size={18} cls="spin" />
                </span>
              )}
              <span className="text-[15px] font-semibold text-ink-fg">
                {done ? '同步就绪' : stageObj.label}
              </span>
            </div>
            <span className="font-mono text-[12px] text-ink-fg-2 tabular-nums">
              已同步 {synced.toLocaleString()}
              {total > 0 ? ` / ${total.toLocaleString()}` : ''}
            </span>
          </div>
          <ProgressBar value={pct} indeterminate={indeterminate} />
          <div className="flex items-center justify-between mt-3">
            <span className="font-mono text-[11px] text-ink-fg-2">
              {done ? `sync_state.db_version = ${dbVersion ?? 17} ✓` : stageObj.sub}
            </span>
            <span className="font-mono text-[11px] text-ink-fg-2">
              {indeterminate ? '…' : `${pct}%`}
            </span>
          </div>

          <div className="flex items-center gap-2 mt-4">
            {SYNC_STAGES.map((st, i) => (
              <div
                key={st.key}
                className="flex items-center gap-1.5 text-[11px] font-mono"
                style={{
                  color:
                    i < stage || done
                      ? 'rgb(var(--c-ok))'
                      : i === stage
                        ? 'rgb(var(--c-accent))'
                        : 'rgb(var(--ink-fg-3))'
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 99,
                    background: 'currentColor',
                    display: 'inline-block'
                  }}
                />
                {st.key}
              </div>
            ))}
          </div>
        </div>

        {!done && (
          <div className="mt-4">
            <Banner kind="info" icon="clock">
              邮箱较大（约 6
              万封）时，首次同步可能需要数分钟到数小时。你可以让它在后台继续，先去配置插件。
            </Banner>
          </div>
        )}
        {done && (
          <div className="mt-4">
            <Banner kind="info" icon="check">
              数据库版本校验通过，前端只读连接已打开。
            </Banner>
          </div>
        )}
      </div>
      <WizFooter
        onBack={done ? null : onBack}
        secondary={
          !done ? (
            <button className="btn-link" onClick={goBackground}>
              转入后台并继续
            </button>
          ) : null
        }
        onNext={onNext}
        nextDisabled={!done && !bg}
        nextLabel={done ? '下一步' : '请稍候…'}
        busy={!done && !bg}
      />
    </>
  )
}

/* ─── Step 5 · Plugins (feature bundles) ───────────────────────────────────── */
interface PluginDef {
  key: string
  icon: IconName
  name: string
  desc: string
  core?: boolean
  needs?: string
  needsBackend?: BackendKind
  needCred?: boolean
  extDep?: string
  restart: string
}

const PLUGINS: PluginDef[] = [
  {
    key: 'notion',
    icon: 'database',
    name: 'Notion 同步',
    desc: '邮件镜像到 Notion 数据库（核心）',
    core: true,
    restart: 'mail-sync'
  },
  {
    key: 'agent',
    icon: 'brain',
    name: 'Notion Agent CLI',
    desc: '在 chat 里调用 notion-agent 操作 Notion',
    needs: 'notion',
    needCred: true,
    restart: 'Electron'
  },
  {
    key: 'island',
    icon: 'bell',
    name: '灵动岛通知',
    desc: '新邮件 / AI 结果推送到灵动岛',
    extDep: 'ping-island.app',
    restart: '免重启'
  },
  {
    key: 'llm',
    icon: 'spark',
    name: 'LLM AI 智能',
    desc: '本地大模型分类 · 起草回复',
    needCred: true,
    restart: 'mail-sync'
  },
  {
    key: 'digest',
    icon: 'clock',
    name: '每日巡检',
    desc: '每天定时汇总未读 / 待办',
    needs: 'island',
    restart: 'mail-sync'
  },
  {
    key: 'calendar',
    icon: 'calendar',
    name: '日历同步',
    desc: '会议事件双向同步（仅 DavMail）',
    needsBackend: 'davmail',
    restart: 'mail-sync'
  }
]

export interface StepPluginsProps {
  plugins: Record<string, boolean>
  setPlugins: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  backend: BackendKind
  onNext: () => void
  onBack: () => void
}

export function StepPlugins({
  plugins,
  setPlugins,
  backend,
  onNext,
  onBack
}: StepPluginsProps): React.JSX.Element {
  const toggle = (k: string): void => setPlugins((p) => ({ ...p, [k]: !p[k] }))
  // 依赖是否满足: core plugin (如 'notion') 恒视为已开启 —— 它从不出现在
  // plugins[] 勾选 map 里 (用户从不勾它, 它是核心)。旧实现把 needs:'notion' 当
  // 普通 plugins.notion 判断 → 永远 false → 依赖 notion 的 'agent' 永久置灰。
  const depSatisfied = (key: string): boolean => {
    const dep = PLUGINS.find((x) => x.key === key)
    if (dep?.core) return true
    return Boolean(plugins[key])
  }
  const isGrayed = (pl: PluginDef): boolean =>
    Boolean(
      (pl.needs && !depSatisfied(pl.needs)) || (pl.needsBackend && backend !== pl.needsBackend)
    )
  const grayReason = (pl: PluginDef): string =>
    pl.needsBackend && backend !== pl.needsBackend
      ? `需 ${pl.needsBackend} 后端`
      : pl.needs
        ? `需先开启「${PLUGINS.find((x) => x.key === pl.needs)?.name ?? pl.needs}」`
        : ''
  return (
    <>
      <div className="wiz-body scrollbar-thin step-enter">
        <div className="eyebrow">Step 5 — 插件</div>
        <h1 className="wiz-h1">按需开启功能</h1>
        <p className="wiz-lede">
          以下是可选功能，现在开启或稍后在设置里随时调整。缺凭证不会阻断 ——
          标橙色「未配置」引导补全（凭证稍后在设置里填）。
        </p>

        <div className="flex flex-col gap-2.5 mt-6">
          {PLUGINS.map((pl) => {
            const on = pl.core || plugins[pl.key]
            const grayed = isGrayed(pl)
            const unconfigured = Boolean(on && !pl.core && pl.needCred)
            return (
              <div
                key={pl.key}
                className="ds-card"
                style={{ padding: '13px 15px', opacity: grayed ? 0.5 : 1 }}
              >
                <div className="flex items-center gap-3">
                  <span
                    style={{
                      color: on && !grayed ? 'rgb(var(--c-accent))' : 'rgb(var(--ink-fg-2))',
                      flexShrink: 0
                    }}
                  >
                    <Icon name={pl.icon} size={18} fill={pl.icon === 'spark'} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[14px] font-semibold text-ink-fg">{pl.name}</span>
                      {pl.core && <span className="pill pill-ok">核心</span>}
                      {unconfigured && (
                        <span className="pill pill-warn">
                          <Icon name="alert" size={10} /> 未配置
                        </span>
                      )}
                      {pl.extDep && on && !pl.core && (
                        <span className="pill pill-info">安装引导</span>
                      )}
                      <span className="pill pill-muted">
                        {pl.restart === '免重启' ? '免重启' : `重启 ${pl.restart}`}
                      </span>
                    </div>
                    <div className="text-[12px] text-ink-fg-2 mt-1 leading-snug">
                      {grayed ? <span className="text-warn">{grayReason(pl)}</span> : pl.desc}
                    </div>
                  </div>
                  <div className="flex items-center gap-2.5 shrink-0">
                    <Toggle
                      on={Boolean(on)}
                      disabled={pl.core || grayed}
                      onChange={() => toggle(pl.key)}
                    />
                  </div>
                </div>
              </div>
            )
          })}
        </div>
        <div className="mt-4">
          <Banner kind="info">
            两类重启已标注：改后端开关重启 mail-sync 进程；Notion Agent 需重启
            Electron；灵动岛免重启。
          </Banner>
        </div>
      </div>
      <WizFooter onBack={onBack} onNext={onNext} nextLabel="完成设置" nextIcon="arrowRight" />
    </>
  )
}

/* ─── Step 6 · Done (writes plugin flags + reloads via finalize()) ─────────── */
export interface StepDoneProps {
  /** 仅插件勾选 (核心配置 + 后端已在 StepConfig 的 commitConfig 提交/起过)。 */
  plugins: Record<string, boolean>
  fdaSkipped: boolean
  background: boolean
  /** main reloads the window into the app on success */
  onLaunched: () => void
}

/** 可切换的插件 key (核心 'notion' 恒开、无 flag)。key → .env flag 的权威映射
 *  只存在于主进程 (handlers/onboarding.ts PLUGIN_FLAG_MAP, 单测已 pin); 渲染层
 *  只需把勾选状态按 key 透传, 不复制 flag 名以免 SSoT 漂移。 */
const PLUGIN_KEYS = ['agent', 'island', 'llm', 'digest', 'calendar'] as const

export function buildCompleteConfig(
  form: ConfigForm,
  backend: BackendKind,
  plugins: Record<string, boolean>
): CompleteConfig {
  const pluginFlags: PluginFlags = {}
  for (const key of PLUGIN_KEYS) {
    pluginFlags[key] = Boolean(plugins[key])
  }
  const cfg: CompleteConfig = {
    NOTION_TOKEN: (form.NOTION_TOKEN ?? '').trim(),
    EMAIL_DATABASE_ID: (form.EMAIL_DATABASE_ID ?? '').trim(),
    USER_EMAIL: (form.USER_EMAIL ?? '').trim(),
    MAILAGENT_BACKEND: backend,
    plugins: pluginFlags
  }
  const cal = (form.CALENDAR_DATABASE_ID ?? '').trim()
  if (cal) cfg.CALENDAR_DATABASE_ID = cal
  const acct = (form.MAIL_ACCOUNT_NAME ?? '').trim()
  if (acct) cfg.MAIL_ACCOUNT_NAME = acct
  const mailboxes = form.SYNC_MAILBOXES ?? []
  if (mailboxes.length > 0) cfg.SYNC_MAILBOXES = mailboxes.join(',')
  // davmail 连接配置 (仅 davmail 后端收集; handler 在 applescript 模式忽略这些 key)。
  if (backend === 'davmail') {
    const host = (form.DAVMAIL_HOST ?? '').trim()
    if (host) cfg.DAVMAIL_HOST = host
    const imapPort = (form.DAVMAIL_IMAP_PORT ?? '').trim()
    if (imapPort) cfg.DAVMAIL_IMAP_PORT = imapPort
    const smtpPort = (form.DAVMAIL_SMTP_PORT ?? '').trim()
    if (smtpPort) cfg.DAVMAIL_SMTP_PORT = smtpPort
    // POC_MODE 默认 true (form 字段 undefined 视为 true)。
    cfg.DAVMAIL_POC_MODE = form.DAVMAIL_POC_MODE === false ? 'false' : 'true'
    const cipher = (form.DAVMAIL_POC_CIPHER_KEY ?? '').trim()
    if (cipher) cfg.DAVMAIL_POC_CIPHER_KEY = cipher
  }
  return cfg
}

export function StepDone({
  plugins,
  fdaSkipped,
  background,
  onLaunched
}: StepDoneProps): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // If complete() succeeds but the main-process window reload never arrives
  // (handler bug / non-Electron harness / reload not triggered), the button
  // would stay disabled "正在启动…" forever — this surfaces a retry escape.
  const [slow, setSlow] = useState(false)
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // attemptId: 标记本次 finalize 提交, settle 时不匹配 (超时已 fire / 重提) 则忽略
  // 迟到结果 (BLOCKER 2)。
  const attemptId = useRef(0)

  useEffect(() => {
    return () => {
      if (reloadTimer.current) clearTimeout(reloadTimer.current)
    }
  }, [])

  const launch = (): void => {
    const id = ++attemptId.current
    setError(null)
    setSlow(false)
    setBusy(true)
    // 核心配置 + 后端已在 StepConfig 的 commitConfig 写过/起过; 这里只写 plugin
    // flag + reload 进 app (finalize)。BLOCKER 2: reload-timeout arm 在调用前;
    // attemptId 丢弃迟到结果。
    if (reloadTimer.current) clearTimeout(reloadTimer.current)
    reloadTimer.current = setTimeout(() => {
      if (id !== attemptId.current) return
      reloadTimer.current = null
      setSlow(true)
      setBusy(false)
    }, 9000)
    void ipc
      .finalize(plugins)
      .then((res) => {
        if (id !== attemptId.current) return // 迟到结果 (超时已 fire / 重提): 忽略
        if (!res?.ok) {
          if (reloadTimer.current) {
            clearTimeout(reloadTimer.current)
            reloadTimer.current = null
          }
          setError(res?.error?.message ?? '配置失败，请重试。')
          setBusy(false)
          return
        }
        // On ok the main process reloads the window into the main app — keep the
        // busy "正在启动…" state until that happens (reloadTimer above is the
        // safety net if the reload never arrives).
        onLaunched()
      })
      .catch((err: unknown) => {
        if (id !== attemptId.current) return
        if (reloadTimer.current) {
          clearTimeout(reloadTimer.current)
          reloadTimer.current = null
        }
        setError(`提交出错：${err instanceof Error ? err.message : String(err)}`)
        setBusy(false)
      })
  }

  return (
    <div
      className="wiz-body scrollbar-thin step-enter flex flex-col items-center justify-center text-center"
      style={{ minHeight: '100%' }}
    >
      <span
        className="grid place-items-center w-16 h-16 rounded-2xl mb-5"
        style={{
          background: 'rgb(var(--c-accent)/0.12)',
          border: '1px solid rgb(var(--c-accent)/0.3)',
          color: 'rgb(var(--c-accent))'
        }}
      >
        <Icon name="rocket" size={30} />
      </span>
      <div className="eyebrow">Done</div>
      <h1 className="wiz-h1">设置完成！</h1>
      <p className="wiz-lede" style={{ textAlign: 'center' }}>
        {background
          ? 'MailAgent 正在后台继续同步你的邮件，主窗口顶部会显示进度。'
          : 'MailAgent 已准备就绪，正在打开收件箱。'}
      </p>
      <div className="flex flex-col gap-2 mt-6 w-full" style={{ maxWidth: 360 }}>
        {fdaSkipped && (
          <Banner kind="warn">FDA 未授权 —— 主窗口将持续显示授权横幅，邮件读取功能受限。</Banner>
        )}
        {error && (
          <Banner kind="fail">
            <div className="font-semibold text-[13px] mb-0.5">启动失败</div>
            <div className="text-[12.5px] text-ink-fg-1">{error}</div>
          </Banner>
        )}
        {slow && !error && (
          <Banner kind="warn" icon="clock">
            <div className="font-semibold text-[13px] mb-0.5">启动较慢</div>
            <div className="text-[12.5px] text-ink-fg-1">
              配置已写入，后端可能正在后台启动（大库迁移会更久）。可点下方按钮重试，或稍候主窗口会自动打开。
            </div>
          </Banner>
        )}
        <div className="ds-card" style={{ padding: '12px 14px' }}>
          <div className="flex items-center justify-between text-[13px]">
            <span className="text-ink-fg-1">onboarding_done</span>
            <span className="font-mono text-ok flex items-center gap-1.5">
              <Icon name="check" size={13} sw={3} /> true
            </span>
          </div>
        </div>
      </div>
      <button
        className="btn-primary mt-7"
        style={{ padding: '10px 22px' }}
        onClick={launch}
        disabled={busy}
      >
        {busy ? (
          <>
            <Icon name="refresh" size={15} cls="spin" /> 正在启动…
          </>
        ) : (
          <>
            {error || slow ? '重试' : '进入收件箱'} <Icon name="arrowRight" size={15} />
          </>
        )}
      </button>
    </div>
  )
}
