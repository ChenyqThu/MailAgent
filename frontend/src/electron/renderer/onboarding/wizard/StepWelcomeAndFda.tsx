// Onboarding steps 0 & 1: Welcome and Full Disk Access permission checks.

import { useEffect, useRef, useState } from 'react'

import { Banner, Icon, WizFooter, type IconName } from '../components'
import * as ipc from '../ipc'
import type { CheckEnvResult, Status } from '../ipc'

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
