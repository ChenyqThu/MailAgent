// Onboarding steps 4 & 5: Initial sync progress polling and optional plugins.

import { useEffect, useRef, useState } from 'react'

import { calendarUiEnabled, detectUiPlatform } from '@shared/lib/mailBackend'

import { Banner, Icon, ProgressBar, Toggle, WizFooter, type IconName } from '../components'
import * as ipc from '../ipc'
import type { BackendKind } from '../ipc'

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
    key: 'llm',
    icon: 'spark',
    name: 'LLM AI 智能',
    desc: '本地大模型分类 · 起草回复',
    needCred: true,
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
  // win 恒隐藏日历插件卡 (日历整体出范围, owner 2026-08-13 拍板; 不是置灰是不渲染)。
  const visiblePlugins = calendarUiEnabled(detectUiPlatform())
    ? PLUGINS
    : PLUGINS.filter((pl) => pl.key !== 'calendar')
  // 依赖是否满足: core plugin (如 'notion') 恒视为已开启 —— 它从不出现在
  // plugins[] 勾选 map 里 (用户从不勾它, 它是核心)。旧实现把 needs:'notion' 当
  // 普通 plugins.notion 判断 → 永远 false → 依赖它的插件永久置灰。
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
          {visiblePlugins.map((pl) => {
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
