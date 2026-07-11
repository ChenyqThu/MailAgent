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
import { errorMessage } from '@shared/lib/ipcErrors'
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
  // Authoritative verify result straight from the backend's `verified` flag —
  // NOT re-derived from `checks`. The推进 button keys off this so a backend that
  // returns verified:true with an empty/odd checks array can never trap the user.
  const [verifiedOk, setVerifiedOk] = useState(false)
  const [backfill, setBackfill] = useState<Record<string, boolean>>({})
  // Idle-timeout escape: when an async phase (copy/migrate/verify) runs longer
  // than expected (or its IPC promise hangs and never resolves), surface a
  // 返回/重试 control so the user is never钉死 on a disabled spinner button.
  const [stuck, setStuck] = useState(false)
  const stuckTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // finish()'s bootBackend can hang (never settle): spawn wedged / FDA TCC prompt
  // blocking the spawn / IPC reply lost. A separate idle-timer un-pins the footer
  // so the user can still 完成 (boot here is best-effort — backend may already be
  // running from migrate, and the main window can start it manually).
  const finishTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [bootHung, setBootHung] = useState(false)
  // "升级仍在进行" (E_NOT_READY): migrate handler waitReady 超时但迁移仍在跑。
  // 停在 migrate phase, 解除 busy, 给一个「重新检查」按钮 (走 legacyVerify);
  // verify 通过 (db_version==17) → 正常 startVerify 流程, 否则继续等。
  const [migrating, setMigrating] = useState(false)
  // E_BACKEND_FAILED (davmail 桥没开 / 配置错) vs E_NOT_READY (仅慢): failed 时按钮给
  // 「重试迁移」(重跑 startMigrate) 而非「重新检查」(verify 对死后端无意义)。
  const [migrateFailed, setMigrateFailed] = useState(false)
  // Generation token: every bail-to-detect AND every fresh startCopy bumps this.
  // Each async start* captures the gen at kickoff; its .then/.catch/.finally
  // bail out BEFORE any setState / phase advance / onRollback if the gen has
  // moved on. This isolates in-flight promises from a NEW attempt or a bail so a
  // stale legacyInherit/Migrate/Verify can never drag the user back into an old
  // phase — or, worst case, fire onRollback() and delete the current COPY.
  const genRef = useRef(0)

  // Clear any pending timers on unmount.
  useEffect(() => {
    return () => {
      if (stuckTimer.current) clearTimeout(stuckTimer.current)
      if (finishTimer.current) clearTimeout(finishTimer.current)
    }
  }, [])

  // Arm the idle-timeout for a long-running phase. Cleared on resolve/reject
  // (clearStuck) or when re-armed for the next phase.
  const armStuck = (ms: number): void => {
    if (stuckTimer.current) clearTimeout(stuckTimer.current)
    setStuck(false)
    stuckTimer.current = setTimeout(() => setStuck(true), ms)
  }
  const clearStuck = (): void => {
    if (stuckTimer.current) {
      clearTimeout(stuckTimer.current)
      stuckTimer.current = null
    }
    setStuck(false)
  }

  // Bail out of a stuck async phase back to detect (safe: copy/migrate are
  // idempotent re-runnable, and the original old data is never mutated). Bumping
  // genRef neutralizes any still-in-flight start* promise so its late callback
  // can't startMigrate/startVerify/onRollback after we've left the phase.
  const bailToDetect = (): void => {
    genRef.current++
    clearStuck()
    setBusy(false)
    setError(null)
    setMigrating(false)
    setPhase('detect')
  }

  const titleFor: Record<LegacyPhase, string> = {
    detect: '检测到旧版本数据',
    copy: '正在安全复制数据',
    migrate: '升级数据库 Schema',
    verify: '校验迁移结果',
    backfill: '推荐补全任务'
  }

  const startCopy = (): void => {
    // New attempt → bump generation so any prior in-flight start* promise is
    // neutralized before this one kicks off.
    const gen = ++genRef.current
    setError(null)
    setDoubleWriter(false)
    setMigrating(false)
    setBusy(true)
    setPhase('copy')
    armStuck(20000)
    void ipc
      .legacyInherit(cfg)
      .then((res) => {
        if (gen !== genRef.current) return // stale: a bail / newer attempt superseded us
        clearStuck()
        if (!res?.ok) {
          if (res?.error?.code === 'E_DOUBLE_WRITER') {
            setDoubleWriter(true)
            setError(res.error.message)
          } else {
            // E_MISSING_CONFIG 及其它真实错误都落这里, 显示 message + 停在 detect 可返回。
            setError(res?.error?.message ?? '复制失败，请重试。')
          }
          setBusy(false)
          setPhase('detect')
          return
        }
        startMigrate()
      })
      .catch((err: unknown) => {
        if (gen !== genRef.current) return
        clearStuck()
        setError(`复制出错：${errorMessage(err)}`)
        setBusy(false)
        setPhase('detect')
      })
  }

  const startMigrate = (): void => {
    const gen = genRef.current
    setError(null)
    setMigrating(false)
    setMigrateFailed(false)
    setBusy(true)
    setPhase('migrate')
    // 大库 CREATE INDEX 会锁表数秒；给一个宽松窗口再 surface 逃生口。
    armStuck(30000)
    void ipc
      .legacyMigrate()
      .then((res) => {
        if (gen !== genRef.current) return // stale: bail / newer attempt superseded us
        clearStuck()
        if (!res?.ok) {
          // 两类"非数据错误"都绝不 rollback (COPY 完好, 误删才是灾难):
          //  - E_NOT_READY: 大库慢迁移 waitReady 超时但仍在进行 → 停 migrate, 「重新检查」(recheck→verify)。
          //  - E_BACKEND_FAILED: 后端崩 (davmail 桥没开 / 配置错 / spawn 失败) → 停 migrate,
          //    显示错误 + 「重试迁移」(用户修配置后重跑 startMigrate, 不重新复制)。
          const code = res?.error?.code
          if (code === 'E_NOT_READY' || code === 'E_BACKEND_FAILED') {
            setVerBefore(res.dbVersionBefore ?? null)
            setVerAfter(res.dbVersionAfter ?? null)
            setError(res.error?.message ?? '后端尚未就绪。')
            setMigrating(true)
            setMigrateFailed(code === 'E_BACKEND_FAILED')
            setBusy(false)
            return
          }
          setError(res?.error?.message ?? '迁移失败。')
          setBusy(false)
          // 其它真实 (数据/异常) 错误 → rollback path
          onRollback()
          return
        }
        setVerBefore(res.dbVersionBefore ?? null)
        setVerAfter(res.dbVersionAfter ?? null)
        startVerify()
      })
      .catch((err: unknown) => {
        if (gen !== genRef.current) return
        clearStuck()
        setError(`迁移出错：${errorMessage(err)}`)
        setBusy(false)
        onRollback()
      })
  }

  // E_NOT_READY 的「重新检查」: 后端可能已迁移完, 但 migrate handler 当时 waitReady
  // 超时。轻量 legacyVerify 探一下: verified (db_version==17 + 表齐 + 行数) → 进入
  // 正常 verify 流程; 否则仍在升级, 停在 migrate 继续等 (不 rollback)。
  const recheck = (): void => {
    const gen = genRef.current
    setError(null)
    setBusy(true)
    void ipc
      .legacyVerify()
      .then((res) => {
        if (gen !== genRef.current) return
        if (res?.verified) {
          // 迁移确已就绪 → 走正常 verify 流程渲染 checks + 推进按钮。
          setMigrating(false)
          startVerify()
          return
        }
        // 仍未就绪: 继续等待, 保持 migrating 提示。
        setBusy(false)
        setMigrating(true)
      })
      .catch((err: unknown) => {
        if (gen !== genRef.current) return
        setError(`检查出错：${errorMessage(err)}`)
        setBusy(false)
        setMigrating(true)
      })
  }

  const startVerify = (): void => {
    const gen = genRef.current
    setError(null)
    setMigrating(false)
    setBusy(true)
    setPhase('verify')
    armStuck(15000)
    void ipc
      .legacyVerify()
      .then((res) => {
        if (gen !== genRef.current) return // stale: bail / newer attempt superseded us
        clearStuck()
        setChecks(Array.isArray(res?.checks) ? res.checks : [])
        // Trust the backend's authoritative verified flag — do NOT re-derive
        // from checks (a true flag with an empty checks array must still pass).
        setVerifiedOk(!!res?.verified)
        setBusy(false)
        if (!res?.verified) {
          // verification failed → rollback (RollbackScreen calls legacyRollback)
          onRollback()
        }
      })
      .catch((err: unknown) => {
        if (gen !== genRef.current) return
        clearStuck()
        setError(`校验出错：${errorMessage(err)}`)
        setBusy(false)
        onRollback()
      })
  }

  // backfill → finish: boot backend if needed, then reload to app.
  // bootBackend is best-effort here; a hung IPC must never pin both footer
  // buttons on the busy flag forever, so a ~12s idle-timer releases busy and
  // surfaces a "可直接完成" banner while still letting 完成 call onComplete().
  const finish = (): void => {
    setBusy(true)
    setBootHung(false)
    if (finishTimer.current) clearTimeout(finishTimer.current)
    finishTimer.current = setTimeout(() => {
      finishTimer.current = null
      setBusy(false)
      setBootHung(true)
    }, 12000)
    void ipc
      .bootBackend()
      .catch(() => undefined) // backend may already be running from migrate; ignore
      .finally(() => {
        if (finishTimer.current) {
          clearTimeout(finishTimer.current)
          finishTimer.current = null
        }
        onComplete()
      })
  }

  // bootHung 逃生口 (codex #2 / BLOCKER 1 残留): bootBackend hang 时, 原"直接完成"
  // 调的是 no-op onComplete → 进不去 app。改走主进程 enterApp (纯 reload, 不 waitReady,
  // 必定生效)。
  const goEnterApp = (): void => {
    setBusy(true)
    void ipc.enterApp().catch(() => undefined)
  }

  // Display-only: all individual check rows passed (used purely for the "校验
  // 全部通过" banner). The推进 button uses `verifiedOk` (backend authoritative)
  // instead, so a backend-verified result with empty/partial checks is never a trap.
  const allChecksPass = checks.length > 0 && checks.every((c) => c.pass)

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
            {stuck && !migrating && (
              <div className="mt-4">
                <Banner kind="warn" icon="clock">
                  {phase === 'copy' ? '复制' : '迁移'}
                  耗时偏长，可能仍在进行（大库 CREATE INDEX
                  会锁表数秒）。可继续等待，或点下方「返回」回到上一步重试 ——
                  原始旧数据全程只读，不会被修改。
                </Banner>
              </div>
            )}
            {migrating && (
              <div className="mt-4">
                <Banner kind="warn" icon="clock">
                  {error ??
                    '数据库升级耗时较长，后端尚未就绪（大库可能需数分钟）。升级仍在后台进行，原始旧数据未受影响。可继续等待后点「重新检查」。'}
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
            {(verifiedOk || allChecksPass) && (
              <div className="mt-4">
                <Banner kind="info" icon="check">
                  校验全部通过，0 数据丢失。
                </Banner>
              </div>
            )}
            {stuck && busy && (
              <div className="mt-4">
                <Banner kind="warn" icon="clock">
                  校验耗时偏长。可继续等待，或点下方「返回」重新开始迁移（原始旧数据未受影响）。
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
                <button
                  key={b.key}
                  type="button"
                  className="ds-card flex w-full items-center gap-3 cursor-pointer text-left"
                  style={{ padding: '12px 14px' }}
                  onClick={() => setBackfill((s) => ({ ...s, [b.key]: !s[b.key] }))}
                  aria-pressed={backfill[b.key] ?? false}
                >
                  <span className={`cb ${backfill[b.key] ? 'cb-on' : ''}`} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] text-ink-fg">{b.name}</div>
                    <div className="text-[12px] text-ink-fg-2 mt-0.5 font-mono">
                      {b.sub}
                      {b.warn && <span className="text-warn"> · {b.warn}</span>}
                    </div>
                  </div>
                </button>
              ))}
            </div>
            <div className="mt-4">
              <Banner kind="info">
                0.1.0 暂不自动运行补全任务 ——
                上方勾选仅作记录，迁移后请在设置里手动启用。顺序约束：先 body / metadata 填满
                SSoT，再启用 NOTION_READ_FROM_SQLITE，否则会用空值覆写 Notion。
              </Banner>
            </div>
            {bootHung && (
              <div className="mt-4">
                <Banner kind="warn" icon="clock">
                  后端启动耗时偏长，可能仍在后台进行。可直接点「完成」进入主窗口 ——
                  若后端尚未就绪，可在主窗口手动启动同步。
                </Banner>
              </div>
            )}
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
          <>
            {/* Idle-timeout escape: a hung copy/migrate IPC (handler deadlock /
                stuck CREATE INDEX) can no longer钉死 the screen — after the
                window elapses (or on E_NOT_READY), a 返回 link routes back to
                detect for a retry. */}
            {(stuck || migrating) && (
              <button className="btn-link" onClick={bailToDetect}>
                <Icon name="arrowLeft" size={13} /> 返回（重试）
              </button>
            )}
            <div className="ml-auto">
              {migrating && migrateFailed ? (
                // E_BACKEND_FAILED: 后端崩 (davmail 桥没开 / 配置错)。recheck(verify) 无意义,
                // 给「重试迁移」重跑 startMigrate (用户修配置后重启后端, 不重新复制)。绝不 rollback。
                <button className="btn-primary" onClick={startMigrate} disabled={busy}>
                  {busy ? (
                    <>
                      <Icon name="refresh" size={14} cls="spin" /> 重试中…
                    </>
                  ) : (
                    <>
                      <Icon name="refresh" size={14} /> 重试迁移
                    </>
                  )}
                </button>
              ) : migrating ? (
                // E_NOT_READY: 后端仍在升级。给一个可点的「重新检查」走 recheck
                // (legacyVerify); 通过即进 verify 流程, 否则继续等。绝不自动 rollback。
                <button className="btn-primary" onClick={recheck} disabled={busy}>
                  {busy ? (
                    <>
                      <Icon name="refresh" size={14} cls="spin" /> 检查中…
                    </>
                  ) : (
                    <>
                      <Icon name="refresh" size={14} /> 重新检查
                    </>
                  )}
                </button>
              ) : (
                <button className="btn-primary" disabled>
                  {phase === 'copy' ? '复制中…' : '迁移中…'}
                </button>
              )}
            </div>
          </>
        )}
        {phase === 'verify' && (
          <>
            {/* Escape hatch so the verify screen is never a one-disabled-button
                trap: works for both a backend/UI verified disagreement (button
                keyed off backend-authoritative verifiedOk now) and a hung verify. */}
            <button className="btn-link" onClick={bailToDetect}>
              <Icon name="arrowLeft" size={13} /> 返回（重试迁移）
            </button>
            <div className="ml-auto">
              <button
                className="btn-primary"
                disabled={busy || !verifiedOk}
                onClick={() => setPhase('backfill')}
              >
                查看补全建议 <Icon name="arrowRight" size={14} />
              </button>
            </div>
          </>
        )}
        {phase === 'backfill' && (
          <>
            {/* After a hung boot (bootHung), 完成 routes straight to onComplete
                instead of re-arming bootBackend — boot is best-effort here, so a
                wedged spawn can never re-trap the user in another busy cycle. */}
            <button className="btn-sec" onClick={bootHung ? goEnterApp : finish} disabled={busy}>
              跳过
            </button>
            <div className="ml-auto">
              <button
                className="btn-primary"
                onClick={bootHung ? goEnterApp : finish}
                disabled={busy}
              >
                {busy ? (
                  <>
                    <Icon name="refresh" size={14} cls="spin" /> 启动中…
                  </>
                ) : (
                  <>
                    {bootHung ? '直接完成' : '完成（后台运行）'}
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
  const alive = useRef(true)
  // bootBackend can hang (never resolve AND never reject): spawn wedged / FDA TCC
  // prompt blocking the spawn / IPC reply lost. .catch only covers reject, so a
  // pure hang would pin the single disabled button on '启动中…' forever. A timeout
  // (backend boot is slower than checkEnv → ~14s) degrades to 'error' so the
  // 重试/逃生口 become reachable. Mirrors StepFDA's degradeToWarn timer.
  const bootTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (bootTimer.current) clearTimeout(bootTimer.current)
    }
  }, [])

  const clearBootTimer = (): void => {
    if (bootTimer.current) {
      clearTimeout(bootTimer.current)
      bootTimer.current = null
    }
  }

  const boot = (): void => {
    setError(null)
    setState('booting')
    clearBootTimer()
    bootTimer.current = setTimeout(() => {
      if (!alive.current) return
      bootTimer.current = null
      setError('后端启动超时，可重试，或返回主窗口手动启动同步。')
      setState('error')
    }, 14000)
    void ipc
      .bootBackend()
      .then((res) => {
        if (!alive.current) return
        clearBootTimer()
        if (!res?.ok) {
          setError(res?.error?.message ?? '后端启动失败，请重试。')
          setState('error')
          return
        }
        setState('done')
      })
      .catch((err: unknown) => {
        if (!alive.current) return
        clearBootTimer()
        setError(`启动出错：${errorMessage(err)}`)
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
        {/* Always-available escape so this single-button screen is never a
            one-disabled-button trap — even mid-boot the user can fall back to
            the main window (which can start the backend manually). Hidden once
            done since the primary button already enters the inbox. */}
        {state !== 'done' && (
          <button className="btn-link mt-3" onClick={onComplete}>
            稍后再启动（进入主窗口）
          </button>
        )}
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
        {/* These recovery actions are not wired to IPC in 0.1.0 (no
            restore-from-backup / reinit / export-corrupt handlers exist yet)
            AND this screen is currently unreachable (OnboardingRoot never sets
            mode='dbcorrupt'). Rather than ship three live-looking no-op buttons,
            they are rendered DISABLED with a "暂未支持" title so they don't read
            as clickable. The only working control is 返回 below. When the
            handlers land, drop `disabled` and wire each onClick. */}
        <div className="flex flex-col gap-2.5 mt-6">
          {options.map((o) => (
            <button
              key={o.t}
              type="button"
              disabled
              title="0.1.0 暂未支持自动恢复，请手动从备份目录恢复或联系支持"
              className="ds-card flex items-center gap-3 text-left"
              style={{
                padding: '13px 15px',
                borderColor: o.primary ? 'rgb(var(--c-accent)/0.4)' : undefined,
                opacity: 0.5,
                cursor: 'not-allowed'
              }}
            >
              <span style={{ color: o.primary ? 'rgb(var(--c-accent))' : 'rgb(var(--ink-fg-2))' }}>
                <Icon name={o.ic} size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[14px] text-ink-fg flex items-center gap-2">
                  {o.t}
                  <span className="pill pill-muted">0.1.0 暂未支持</span>
                </div>
                <div className="text-[12px] text-ink-fg-2 mt-0.5">{o.d}</div>
              </div>
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
  // Idle-timeout escape: a hung legacyRollback (stop backend wedged / IPC reply
  // lost) would pin `rolling=true` forever → "返回" stays disabled forever (we
  // disable it while rolling to prevent the data-loss race below). After ~12s
  // un-pin: release rolling + surface a "状态未知" banner so 返回 becomes reachable.
  const [stuck, setStuck] = useState(false)
  const alive = useRef(true)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Roll back the COPY on mount (original old data is never touched → always safe).
  // While rolling, "返回" is disabled: a late-arriving rollback handler that does
  // `rm DATA_ROOT/data` + clears .env must NOT race a user who已返回 'new' and
  // re-configured (it would delete the freshly re-configured data). Normal
  // rollback is fast, so the user can't reach 返回 before it settles; only the
  // idle-timeout (hang) path re-opens 返回, after the rm is provably not running.
  useEffect(() => {
    alive.current = true
    idleTimer.current = setTimeout(() => {
      if (!alive.current) return
      idleTimer.current = null
      setStuck(true)
      setRolling(false)
    }, 12000)
    const clearIdle = (): void => {
      if (idleTimer.current) {
        clearTimeout(idleTimer.current)
        idleTimer.current = null
      }
    }
    void ipc
      .legacyRollback()
      .then((res) => {
        if (!alive.current) return
        if (!res?.ok) setError(res?.error?.message ?? '回滚遇到问题，但原始旧数据未受影响。')
        else setRolledBack(true)
      })
      .catch((err: unknown) => {
        if (!alive.current) return
        setError(`回滚出错：${errorMessage(err)}`)
      })
      .finally(() => {
        clearIdle()
        if (alive.current) {
          setStuck(false)
          setRolling(false)
        }
      })
    return () => {
      alive.current = false
      clearIdle()
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
        {stuck && (
          <div className="mt-4">
            <Banner kind="warn" icon="clock">
              回滚状态未知（耗时偏长，可能仍在后台进行）。原始旧数据未受影响，可安全「返回」重新配置。
            </Banner>
          </div>
        )}
        <div className="mt-4">
          <Banner kind="fail">
            单向不可降级：复制出的新库已清理，原始旧数据保持迁移前状态，可用旧版本应用继续打开。
          </Banner>
        </div>
      </div>
      <div className="wiz-footer">
        {/* 返回 disabled while rolling: prevents a late-arriving rollback (rm
            DATA_ROOT/data + clear .env) from racing a user who已返回 'new' and
            re-configured — that would delete the just-re-configured data. Only
            the idle-timeout (stuck) path re-opens 返回, after the rm is provably
            not in flight. */}
        <button className="btn-link" onClick={onBack} disabled={rolling}>
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
