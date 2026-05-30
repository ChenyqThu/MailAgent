// Onboarding branch scenarios — ported from docs/packaging/onboarding/scenarios.jsx
// to production TSX, wired to the real onboarding:* IPC.
//
//   - LegacyFlow:  detect → backup/copy (legacyInherit) → migrate (legacyMigrate)
//                  → verify (legacyVerify) → backfill (informational) → complete.
//                  0.1.0 only supports the SAFE COPY path (the demo's in-place
//                  "就地继承（指向旧路径）" button is removed). Verify failure →
//                  RollbackScreen (legacyRollback).
//   - HalfFlow:    bootBackend() then reload to app.
//   - DBCorruptScreen / RollbackScreen: diagnostic screens.
//
// InboxMock is dropped — the real app loads on completion instead.

import { useEffect, useRef, useState } from 'react'

import { Banner, Icon, ProgressBar, type IconName } from './components'
import * as ipc from './ipc'
import type { CompleteConfig, DetectLegacyResult, VerifyCheck } from './ipc'

/* ─── LEGACY migration flow (safe-copy state machine) ──────────────────────── */
type LegacyPhase = 'detect' | 'copy' | 'migrate' | 'verify' | 'backfill'

export interface LegacyFlowProps {
  detect: DetectLegacyResult | null
  /** assembled config from the NEW wizard, if the user also filled it; else handler
   *  reuses the old .env when hasConfig. */
  cfg?: CompleteConfig
  /** main reloads the window into the app on success */
  onComplete: () => void
  onRollback: () => void
}

const BACKFILL_CARDS = [
  {
    key: 'body',
    name: '邮件正文 + 附件',
    sub: '~1.5–2h · AppleScript',
    warn: '与主同步争用 AppleScript'
  },
  {
    key: 'metadata',
    name: 'To / CC / 发件人',
    sub: '~15–25 min · Notion',
    warn: null as string | null
  },
  {
    key: 'labels',
    name: 'AI 优先级 / 动作项',
    sub: '~15–25 min · 从 Notion 反拉',
    warn: null as string | null
  }
]

export function LegacyFlow({
  detect,
  cfg,
  onComplete,
  onRollback
}: LegacyFlowProps): React.JSX.Element {
  const [phase, setPhase] = useState<LegacyPhase>('detect')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [doubleWriter, setDoubleWriter] = useState(false)
  const [verBefore, setVerBefore] = useState<number | null>(null)
  const [verAfter, setVerAfter] = useState<number | null>(null)
  const [checks, setChecks] = useState<VerifyCheck[]>([])
  const [backfill, setBackfill] = useState<Record<string, boolean>>({})

  const titleFor: Record<LegacyPhase, string> = {
    detect: '检测到旧版本数据',
    copy: '正在安全复制数据',
    migrate: '升级数据库 Schema',
    verify: '校验迁移结果',
    backfill: '推荐补全任务'
  }

  const startCopy = (): void => {
    setError(null)
    setDoubleWriter(false)
    setBusy(true)
    setPhase('copy')
    void ipc
      .legacyInherit(cfg)
      .then((res) => {
        if (!res?.ok) {
          if (res?.error?.code === 'E_DOUBLE_WRITER') {
            setDoubleWriter(true)
            setError(res.error.message)
          } else {
            setError(res?.error?.message ?? '复制失败，请重试。')
          }
          setBusy(false)
          setPhase('detect')
          return
        }
        startMigrate()
      })
      .catch((err: unknown) => {
        setError(`复制出错：${err instanceof Error ? err.message : String(err)}`)
        setBusy(false)
        setPhase('detect')
      })
  }

  const startMigrate = (): void => {
    setError(null)
    setBusy(true)
    setPhase('migrate')
    void ipc
      .legacyMigrate()
      .then((res) => {
        if (!res?.ok) {
          setError(res?.error?.message ?? '迁移失败。')
          setBusy(false)
          // migration failure → rollback path
          onRollback()
          return
        }
        setVerBefore(res.dbVersionBefore ?? null)
        setVerAfter(res.dbVersionAfter ?? null)
        startVerify()
      })
      .catch((err: unknown) => {
        setError(`迁移出错：${err instanceof Error ? err.message : String(err)}`)
        setBusy(false)
        onRollback()
      })
  }

  const startVerify = (): void => {
    setError(null)
    setBusy(true)
    setPhase('verify')
    void ipc
      .legacyVerify()
      .then((res) => {
        setChecks(Array.isArray(res?.checks) ? res.checks : [])
        setBusy(false)
        if (!res?.verified) {
          // verification failed → rollback (RollbackScreen calls legacyRollback)
          onRollback()
        }
      })
      .catch((err: unknown) => {
        setError(`校验出错：${err instanceof Error ? err.message : String(err)}`)
        setBusy(false)
        onRollback()
      })
  }

  // backfill → finish: boot backend if needed, then reload to app.
  const finish = (): void => {
    setBusy(true)
    void ipc
      .bootBackend()
      .catch(() => undefined) // backend may already be running from migrate; ignore
      .finally(() => {
        onComplete()
      })
  }

  const verified = checks.length > 0 && checks.every((c) => c.pass)

  return (
    <div className="wiz-content">
      <div className="wiz-body scrollbar-thin step-enter">
        <div className="eyebrow">老用户迁移 · LEGACY</div>
        <h1 className="wiz-h1">{titleFor[phase]}</h1>

        {phase === 'detect' && (
          <>
            <p className="wiz-lede">
              在旧目录发现历史数据。0.1.0 采用安全复制迁移 ——
              原始旧数据全程不被修改，复制到新位置后再升级 Schema。
            </p>
            <div className="ds-card ds-card-pad mt-6">
              <div className="grid grid-cols-2 gap-y-3 gap-x-4 text-[13px]">
                <div className="text-ink-fg-2">数据目录</div>
                <div className="font-mono text-[12px] text-ink-fg text-right">
                  {detect?.oldDataPath ?? '~/Documents/MailAgent'}
                </div>
                <div className="text-ink-fg-2">当前版本</div>
                <div className="text-right">
                  <span className="pill pill-warn">db_version v{detect?.dbVersion ?? '?'}</span>
                </div>
                <div className="text-ink-fg-2">目标版本</div>
                <div className="text-right">
                  <span className="pill pill-ok">v17</span>
                </div>
                <div className="text-ink-fg-2">历史邮件</div>
                <div className="font-mono text-[12px] text-ink-fg text-right">
                  {(detect?.emailCount ?? 0).toLocaleString()} 封
                </div>
              </div>
            </div>
            {doubleWriter ? (
              <div className="mt-4">
                <Banner kind="fail" icon="alert">
                  <div className="font-semibold text-[13px] mb-1">检测到旧后端可能仍在运行</div>
                  {error ??
                    '旧目录的数据库正被写入（单一 writer 约束）。请先停止旧版 mail-sync / PM2，再重试迁移。'}
                </Banner>
              </div>
            ) : (
              <div className="mt-4">
                <Banner kind="warn">
                  升级后旧版后端 / PM2 将无法再使用复制出来的新数据库。请确认旧后端已停止（单一
                  writer），避免并发写冲突。
                </Banner>
              </div>
            )}
            {error && !doubleWriter && (
              <div className="mt-4">
                <Banner kind="fail">{error}</Banner>
              </div>
            )}
          </>
        )}

        {(phase === 'copy' || phase === 'migrate') && (
          <>
            <p className="wiz-lede">
              {phase === 'copy'
                ? '复制旧数据目录到新位置，并生成 sync_store.db.bak 备份。原始数据保持只读，不被修改。'
                : '从旧版本一路升级到 v17，后端自动执行幂等迁移。大库 CREATE INDEX 会锁表数秒，请勿关闭。'}
            </p>
            <div className="ds-card ds-card-pad mt-6">
              <div className="flex items-center justify-between mb-2.5">
                <span className="text-[14px] font-semibold text-ink-fg flex items-center gap-2">
                  <Icon
                    name={phase === 'copy' ? 'archive' : 'layers'}
                    size={16}
                    style={{ color: 'rgb(var(--c-accent))' }}
                  />
                  {phase === 'copy' ? '安全复制中' : '升级 Schema 中'}
                </span>
                <span className="font-mono text-[12px] text-ink-fg-2">请稍候…</span>
              </div>
              <ProgressBar indeterminate />
            </div>
            {phase === 'migrate' && (
              <div className="mt-4">
                <Banner kind="warn" icon="lock">
                  升级中，请勿关闭应用。
                </Banner>
              </div>
            )}
          </>
        )}

        {phase === 'verify' && (
          <>
            <p className="wiz-lede">迁移完成，正在自动校验数据完整性。</p>
            {verBefore != null && verAfter != null && (
              <div className="ds-card ds-card-pad mt-5">
                <div className="flex items-center justify-center gap-3 text-[13px]">
                  <span className="pill pill-warn">v{verBefore}</span>
                  <Icon name="arrowRight" size={14} style={{ color: 'rgb(var(--ink-fg-2))' }} />
                  <span className="pill pill-ok">v{verAfter}</span>
                </div>
              </div>
            )}
            <div className="flex flex-col gap-2 mt-6">
              {(checks.length > 0
                ? checks
                : [{ key: 'pending', label: '正在运行校验…', pass: false }]
              ).map((c) => (
                <div key={c.key} className="chk-row">
                  <span className={`chk-icon ${c.pass ? 'chk-pass' : 'chk-pending'}`}>
                    {c.pass ? (
                      <Icon name="check" size={13} sw={3} style={{ color: 'rgb(var(--c-ok))' }} />
                    ) : (
                      <Icon
                        name="refresh"
                        size={13}
                        cls="spin"
                        style={{ color: 'rgb(var(--ink-fg-2))' }}
                      />
                    )}
                  </span>
                  <span className="text-[13.5px] text-ink-fg flex-1">{c.label}</span>
                </div>
              ))}
            </div>
            {verified && (
              <div className="mt-4">
                <Banner kind="info" icon="check">
                  校验全部通过，0 数据丢失。
                </Banner>
              </div>
            )}
            {error && (
              <div className="mt-4">
                <Banner kind="fail">{error}</Banner>
              </div>
            )}
          </>
        )}

        {phase === 'backfill' && (
          <>
            <p className="wiz-lede">
              这些是后台补全任务，不影响现在使用。新邮件正常同步，历史邮件缺失字段会逐步补齐。
            </p>
            <div className="flex flex-col gap-2.5 mt-6">
              {BACKFILL_CARDS.map((b) => (
                <label
                  key={b.key}
                  className="ds-card flex items-center gap-3 cursor-pointer"
                  style={{ padding: '12px 14px' }}
                >
                  <span
                    className={`cb ${backfill[b.key] ? 'cb-on' : ''}`}
                    onClick={(e) => {
                      e.preventDefault()
                      setBackfill((s) => ({ ...s, [b.key]: !s[b.key] }))
                    }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] text-ink-fg">{b.name}</div>
                    <div className="text-[12px] text-ink-fg-2 mt-0.5 font-mono">
                      {b.sub}
                      {b.warn && <span className="text-warn"> · {b.warn}</span>}
                    </div>
                  </div>
                </label>
              ))}
            </div>
            <div className="mt-4">
              <Banner kind="info">
                0.1.0 暂不自动运行补全任务 ——
                上方勾选仅作记录，迁移后请在设置里手动启用。顺序约束：先 body / metadata 填满
                SSoT，再启用 NOTION_READ_FROM_SQLITE，否则会用空值覆写 Notion。
              </Banner>
            </div>
          </>
        )}
      </div>

      <div className="wiz-footer">
        {phase === 'detect' && (
          <>
            <button
              className="btn-sec"
              disabled
              title="0.1.0 仅支持安全复制迁移"
              style={{ opacity: 0.45, cursor: 'not-allowed' }}
            >
              就地继承（指向旧路径）
            </button>
            <div className="ml-auto">
              <button className="btn-primary" onClick={startCopy} disabled={busy}>
                安全复制并迁移 <Icon name="arrowRight" size={14} />
              </button>
            </div>
          </>
        )}
        {(phase === 'copy' || phase === 'migrate') && (
          <div className="ml-auto">
            <button className="btn-primary" disabled>
              {phase === 'copy' ? '复制中…' : '迁移中…'}
            </button>
          </div>
        )}
        {phase === 'verify' && (
          <div className="ml-auto">
            <button
              className="btn-primary"
              disabled={!verified}
              onClick={() => setPhase('backfill')}
            >
              查看补全建议 <Icon name="arrowRight" size={14} />
            </button>
          </div>
        )}
        {phase === 'backfill' && (
          <>
            <button className="btn-sec" onClick={finish} disabled={busy}>
              跳过
            </button>
            <div className="ml-auto">
              <button className="btn-primary" onClick={finish} disabled={busy}>
                {busy ? (
                  <>
                    <Icon name="refresh" size={14} cls="spin" /> 启动中…
                  </>
                ) : (
                  <>
                    完成（后台运行）
                    <Icon name="check" size={14} sw={3} />
                  </>
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/* ─── HALF shortcut (boot backend + reload to app) ─────────────────────────── */
export interface HalfFlowProps {
  onComplete: () => void
}

export function HalfFlow({ onComplete }: HalfFlowProps): React.JSX.Element {
  const [state, setState] = useState<'idle' | 'booting' | 'done' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  const boot = (): void => {
    setError(null)
    setState('booting')
    void ipc
      .bootBackend()
      .then((res) => {
        if (!res?.ok) {
          setError(res?.error?.message ?? '后端启动失败，请重试。')
          setState('error')
          return
        }
        setState('done')
      })
      .catch((err: unknown) => {
        setError(`启动出错：${err instanceof Error ? err.message : String(err)}`)
        setState('error')
      })
  }

  const primary =
    state === 'done' ? onComplete : state === 'idle' || state === 'error' ? boot : undefined

  return (
    <div className="wiz-content">
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
          <Icon
            name={state === 'done' ? 'check' : 'server'}
            size={28}
            sw={state === 'done' ? 3 : 2}
          />
        </span>
        <div className="eyebrow">半装捷径 · HALF</div>
        <h1 className="wiz-h1">{state === 'done' ? '后端已就绪' : '检测到未完成的安装'}</h1>
        <p className="wiz-lede" style={{ textAlign: 'center' }}>
          {state === 'done'
            ? '数据库已出现，后端已就绪。正在进入主窗口。'
            : '你已配置好账户，但后端还没成功运行过。点击下方按钮启动同步，向导会轮询数据库就绪。'}
        </p>
        {state === 'booting' && (
          <div className="w-full mt-7" style={{ maxWidth: 360 }}>
            <div className="flex items-center justify-between mb-2 text-[12px] font-mono text-ink-fg-2">
              <span className="flex items-center gap-2">
                <Icon name="refresh" size={13} cls="spin" /> 启动后端 · 等待就绪…
              </span>
            </div>
            <ProgressBar indeterminate />
          </div>
        )}
        {state === 'error' && error && (
          <div className="w-full mt-5" style={{ maxWidth: 360 }}>
            <Banner kind="fail">{error}</Banner>
          </div>
        )}
        <button
          className="btn-primary mt-7"
          style={{ padding: '10px 22px' }}
          onClick={primary}
          disabled={state === 'booting'}
        >
          {state === 'done' ? (
            <>
              进入收件箱 <Icon name="arrowRight" size={15} />
            </>
          ) : state === 'booting' ? (
            <>
              <Icon name="refresh" size={15} cls="spin" /> 启动中…
            </>
          ) : (
            <>
              {state === 'error' ? '重试启动' : '启动同步'} <Icon name="arrowRight" size={15} />
            </>
          )}
        </button>
      </div>
    </div>
  )
}

/* ─── Diagnostic: DB corrupt ───────────────────────────────────────────────── */
export interface DBCorruptScreenProps {
  onRetry: () => void
}

export function DBCorruptScreen({ onRetry }: DBCorruptScreenProps): React.JSX.Element {
  const options: { ic: IconName; t: string; d: string; primary?: boolean }[] = [
    { ic: 'archive', t: '从最近备份恢复', d: 'sync_store.db.bak.<时间戳>', primary: true },
    { ic: 'refresh', t: '重新初始化（清空重建）', d: '会丢历史 SSoT，需重新 init 同步' },
    { ic: 'download', t: '导出损坏文件供排查', d: '复制到桌面，附日志' }
  ]
  return (
    <div className="wiz-content">
      <div className="wiz-body scrollbar-thin step-enter">
        <span
          className="grid place-items-center w-14 h-14 rounded-2xl mb-4"
          style={{
            background: 'rgb(var(--c-fail)/0.12)',
            border: '1px solid rgb(var(--c-fail)/0.3)',
            color: 'rgb(var(--c-fail))'
          }}
        >
          <Icon name="fileWarn" size={26} />
        </span>
        <div className="eyebrow" style={{ color: 'rgb(var(--c-fail))' }}>
          异常 · DB 损坏
        </div>
        <h1 className="wiz-h1">数据库文件损坏</h1>
        <p className="wiz-lede">
          getDb() 抛 SQLITE_CORRUPT，无法打开 sync_store.db。请选择恢复方式 —— 优先从最近备份恢复。
        </p>
        <div className="flex flex-col gap-2.5 mt-6">
          {options.map((o) => (
            <button
              key={o.t}
              className="ds-card flex items-center gap-3 text-left"
              style={{
                padding: '13px 15px',
                borderColor: o.primary ? 'rgb(var(--c-accent)/0.4)' : undefined
              }}
            >
              <span style={{ color: o.primary ? 'rgb(var(--c-accent))' : 'rgb(var(--ink-fg-2))' }}>
                <Icon name={o.ic} size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[14px] text-ink-fg">{o.t}</div>
                <div className="text-[12px] text-ink-fg-2 mt-0.5">{o.d}</div>
              </div>
              <Icon name="arrowRight" size={15} style={{ color: 'rgb(var(--ink-fg-3))' }} />
            </button>
          ))}
        </div>
      </div>
      <div className="wiz-footer">
        <button className="btn-link" onClick={onRetry}>
          <Icon name="arrowLeft" size={13} /> 返回
        </button>
      </div>
    </div>
  )
}

/* ─── Diagnostic: migration rollback (calls legacyRollback on mount) ───────── */
export interface RollbackScreenProps {
  /** "重试迁移" → back to legacy detect */
  onRetry: () => void
  onBack: () => void
}

export function RollbackScreen({ onRetry, onBack }: RollbackScreenProps): React.JSX.Element {
  const [rolling, setRolling] = useState(true)
  const [rolledBack, setRolledBack] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)

  // Roll back the COPY on mount (original old data is never touched → always safe).
  useEffect(() => {
    alive.current = true
    void ipc
      .legacyRollback()
      .then((res) => {
        if (!alive.current) return
        if (!res?.ok) setError(res?.error?.message ?? '回滚遇到问题，但原始旧数据未受影响。')
        else setRolledBack(true)
      })
      .catch((err: unknown) => {
        if (!alive.current) return
        setError(`回滚出错：${err instanceof Error ? err.message : String(err)}`)
      })
      .finally(() => {
        if (alive.current) setRolling(false)
      })
    return () => {
      alive.current = false
    }
  }, [])

  return (
    <div className="wiz-content">
      <div className="wiz-body scrollbar-thin step-enter">
        <span
          className="grid place-items-center w-14 h-14 rounded-2xl mb-4"
          style={{
            background: 'rgb(var(--c-fail)/0.12)',
            border: '1px solid rgb(var(--c-fail)/0.3)',
            color: 'rgb(var(--c-fail))'
          }}
        >
          <Icon name="alert" size={26} />
        </span>
        <div className="eyebrow" style={{ color: 'rgb(var(--c-fail))' }}>
          异常 · 迁移回滚
        </div>
        <h1 className="wiz-h1">迁移校验未通过</h1>
        <p className="wiz-lede">
          {rolling
            ? '正在停止后端并清理复制出来的数据…'
            : '已停止后端并清理了复制出来的新数据。原始旧数据从未被修改，0 丢失 —— 你可以重试迁移。'}
        </p>
        <div className="ds-card ds-card-pad mt-6">
          <div className="flex items-center gap-2.5 text-[13px]">
            <Icon
              name="archive"
              size={16}
              style={{ color: rolledBack ? 'rgb(var(--c-ok))' : 'rgb(var(--ink-fg-2))' }}
            />
            <span className="text-ink-fg">{rolling ? '回滚进行中' : '原始旧数据完好'}</span>
            {rolledBack && <span className="pill pill-ok ml-auto">已清理副本</span>}
          </div>
        </div>
        {error && (
          <div className="mt-4">
            <Banner kind="fail">{error}</Banner>
          </div>
        )}
        <div className="mt-4">
          <Banner kind="fail">
            单向不可降级：复制出的新库已清理，原始旧数据保持迁移前状态，可用旧版本应用继续打开。
          </Banner>
        </div>
      </div>
      <div className="wiz-footer">
        <button className="btn-link" onClick={onBack}>
          <Icon name="arrowLeft" size={13} /> 返回
        </button>
        <div className="ml-auto flex items-center gap-2.5">
          <button className="btn-primary" onClick={onRetry} disabled={rolling}>
            <Icon name="refresh" size={14} /> 重试迁移
          </button>
        </div>
      </div>
    </div>
  )
}
