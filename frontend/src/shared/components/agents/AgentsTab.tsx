// Sprint 20 — Agents tab：邮件日报 agent 概览卡（启用/运行/配置 + 最近报告）+
// 配置 slide-over（prompt / 排程 / 回看窗口 / 模型 / KOS 增强）+ 新建占位。
// 移植自 ~/Downloads/agents/agents-tab.jsx，接 report:getConfig/setConfig/runNow。
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { ReportAgentConfig, ReportCadence, ReportConfigPatch } from '@shared/api/types'
import { ReportIcon, StatusBadge, Switch } from './primitives'
import { useReportConfig, useReportList, useRunNow, useSetConfig } from './hooks'

const DEFAULT_AGENT_ID = 'daily_email_digest'
const HOUR_OPTIONS = [6, 7, 8, 9, 10, 12, 18, 21]
// 回看窗口随 cadence 自适应：日报按小时、周报按天、月报按月。每个 cadence 都是
// 独立取数 + 总结（非层级聚合：月报不是周报的综合），所以窗口确实有意义 ——
// 它就是「这份报告覆盖多长时间」。切 cadence 时窗口重置为该档默认。
const WINDOW_BY_CADENCE: Record<ReportCadence, Array<[number, string]>> = {
  daily: [
    [24, '24h'],
    [48, '48h'],
    [72, '72h']
  ],
  weekly: [
    [168, '7d'],
    [336, '14d']
  ],
  monthly: [
    [720, '30d'],
    [1440, '60d']
  ]
}
const DEFAULT_WINDOW: Record<ReportCadence, number> = { daily: 24, weekly: 168, monthly: 720 }
const MODELS: Array<{ id: string; label: string; hint: string }> = [
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', hint: '默认 · 最强推理' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', hint: '更快 · 质量均衡' },
  { id: 'gpt-5.5', label: 'GPT-5.5', hint: '限流时自动兜底' }
]

function scheduleText(
  cfg: ReportAgentConfig,
  t: (k: string, o?: Record<string, unknown>) => string
): string {
  const h = String(cfg.schedule.hours?.[0] ?? 9).padStart(2, '0')
  if (cfg.schedule.cadence === 'weekly') return t('agents.card.schedWeekly', { hour: h })
  if (cfg.schedule.cadence === 'monthly') return t('agents.card.schedMonthly', { hour: h })
  return t('agents.card.schedDaily', { hour: h })
}

// ─── 概览卡 ─────────────────────────────────────────────────────────────────
function AgentCard({
  cfg,
  onConfig,
  onOpenReports
}: {
  cfg: ReportAgentConfig
  onConfig: () => void
  onOpenReports: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const { save } = useSetConfig()
  const { run, isRunning } = useRunNow()
  const { items } = useReportList()
  const last = items[0]

  const toggle = (v: boolean): void => {
    void save(cfg.id, { enabled: v })
  }
  const runNow = (): void => {
    if (!isRunning) void run(cfg.id)
  }
  const modelLabel = MODELS.find((m) => m.id === cfg.model)?.label ?? cfg.model ?? MODELS[0].label

  return (
    <div
      style={{
        borderRadius: 14,
        background: 'rgb(var(--ink-2))',
        border: '1px solid rgb(var(--ink-border))',
        overflow: 'hidden'
      }}
    >
      {/* head */}
      <div className="flex items-center" style={{ gap: 13, padding: '18px 20px 16px' }}>
        <span
          style={{
            width: 42,
            height: 42,
            borderRadius: 11,
            display: 'grid',
            placeItems: 'center',
            flexShrink: 0,
            background: 'rgb(var(--c-accent) / 0.14)',
            border: '1px solid rgb(var(--c-accent) / 0.30)',
            color: 'rgb(var(--c-accent))'
          }}
        >
          <ReportIcon name="sparkles" size={20} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="flex items-center" style={{ gap: 9 }}>
            <h3 style={{ fontSize: 16, fontWeight: 600, color: 'rgb(var(--ink-fg))' }}>
              {cfg.title}
            </h3>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 5,
                color: cfg.enabled ? 'rgb(var(--c-ok))' : 'rgb(var(--ink-fg-3))',
                background: cfg.enabled ? 'rgb(var(--c-ok) / 0.12)' : 'rgb(var(--ink-fg) / 0.05)',
                border: `1px solid ${cfg.enabled ? 'rgb(var(--c-ok) / 0.25)' : 'rgb(var(--ink-border))'}`
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: cfg.enabled ? 'rgb(var(--c-ok))' : 'rgb(var(--ink-fg-3))'
                }}
              />
              {cfg.enabled ? t('agents.card.enabled') : t('agents.card.disabled')}
            </span>
          </div>
          <div
            className="flex items-center"
            style={{
              gap: 8,
              marginTop: 4,
              fontFamily: 'ui-monospace, monospace',
              fontSize: 11.5,
              color: 'rgb(var(--ink-fg-2))'
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <ReportIcon name="clock" size={11} />
              {scheduleText(cfg, t)}
            </span>
            <span>·</span>
            <span>{t('agents.card.window', { hours: cfg.window_hours ?? 24 })}</span>
            <span>·</span>
            <span>{modelLabel}</span>
          </div>
        </div>
        <Switch on={cfg.enabled} onChange={toggle} />
      </div>

      {/* last report */}
      <div
        style={{
          margin: '0 20px',
          padding: '13px 0',
          borderTop: '1px solid rgb(var(--ink-border-soft))'
        }}
      >
        <div
          style={{
            fontFamily: 'ui-monospace, monospace',
            fontSize: 10.5,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color: 'rgb(var(--ink-fg-3))',
            marginBottom: 8
          }}
        >
          {t('agents.card.lastReport')}
        </div>
        {last ? (
          <button
            type="button"
            onClick={onOpenReports}
            className="flex items-center"
            style={{
              gap: 11,
              width: '100%',
              textAlign: 'left',
              padding: '10px 12px',
              borderRadius: 9,
              cursor: 'pointer',
              fontFamily: 'inherit',
              background: 'rgb(var(--ink-1))',
              border: '1px solid rgb(var(--ink-border-soft))',
              transition: 'border-color 120ms'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'rgb(var(--ink-border))')}
            onMouseLeave={(e) =>
              (e.currentTarget.style.borderColor = 'rgb(var(--ink-border-soft))')
            }
          >
            <span
              style={{
                fontFamily: 'ui-monospace, monospace',
                fontSize: 12,
                color: 'rgb(var(--ink-fg-2))',
                flexShrink: 0
              }}
            >
              {last.report_date.slice(5).replace('-', '/')}
            </span>
            <span
              style={{
                flex: 1,
                fontSize: 13,
                color: 'rgb(var(--ink-fg-1))',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
            >
              {last.headline}
            </span>
            <StatusBadge status={last.status} />
            <ReportIcon
              name="chevronright"
              size={14}
              style={{ color: 'rgb(var(--ink-fg-3))', flexShrink: 0 }}
            />
          </button>
        ) : (
          <div style={{ fontSize: 13, color: 'rgb(var(--ink-fg-3))', padding: '4px 0' }}>
            {t('agents.card.noReport')}
          </div>
        )}
      </div>

      {/* actions */}
      <div
        className="flex items-center"
        style={{
          gap: 10,
          padding: '14px 20px',
          borderTop: '1px solid rgb(var(--ink-border-soft))',
          background: 'rgb(var(--ink-1) / 0.4)'
        }}
      >
        <button
          type="button"
          onClick={runNow}
          disabled={isRunning}
          className="flex items-center"
          style={{
            gap: 7,
            padding: '8px 15px',
            borderRadius: 8,
            fontFamily: 'inherit',
            fontSize: 13.5,
            fontWeight: 500,
            cursor: isRunning ? 'wait' : 'pointer',
            color: 'rgb(var(--c-accent-fg))',
            background: 'rgb(var(--c-accent-dim))',
            border: 0
          }}
          onMouseEnter={(e) => {
            if (!isRunning) e.currentTarget.style.background = 'rgb(var(--c-accent))'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgb(var(--c-accent-dim))'
          }}
        >
          {isRunning ? (
            <>
              <span className="spin" style={{ display: 'flex' }}>
                <ReportIcon name="loader" size={14} />
              </span>
              {t('agents.card.running')}
            </>
          ) : (
            <>
              <ReportIcon name="play" size={13} />
              {t('agents.card.runNow')}
            </>
          )}
        </button>
        <button
          type="button"
          onClick={onConfig}
          className="flex items-center"
          style={{
            gap: 7,
            padding: '8px 15px',
            borderRadius: 8,
            fontFamily: 'inherit',
            fontSize: 13.5,
            cursor: 'pointer',
            color: 'rgb(var(--ink-fg-1))',
            background: 'transparent',
            border: '1px solid rgb(var(--ink-border))'
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'rgb(var(--ink-4))')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <ReportIcon name="cog" size={14} />
          {t('agents.card.configure')}
        </button>
        <span style={{ flex: 1 }} />
        {isRunning && (
          <span
            style={{
              fontFamily: 'ui-monospace, monospace',
              fontSize: 11.5,
              color: 'rgb(var(--ink-fg-3))'
            }}
          >
            {t('agents.card.runningHint')}
          </span>
        )}
      </div>
    </div>
  )
}

function NewAgentTile(): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div
      style={{
        borderRadius: 14,
        border: '1px dashed rgb(var(--ink-border))',
        padding: '22px 20px',
        display: 'flex',
        alignItems: 'center',
        gap: 13,
        opacity: 0.7
      }}
    >
      <span
        style={{
          width: 42,
          height: 42,
          borderRadius: 11,
          display: 'grid',
          placeItems: 'center',
          flexShrink: 0,
          background: 'rgb(var(--ink-3))',
          color: 'rgb(var(--ink-fg-3))'
        }}
      >
        <ReportIcon name="plus" size={20} />
      </span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: 'rgb(var(--ink-fg-2))' }}>
          {t('agents.card.newAgent')}
        </div>
        <div style={{ fontSize: 12, color: 'rgb(var(--ink-fg-3))', marginTop: 2 }}>
          {t('agents.card.newAgentHint')}
        </div>
      </div>
      <span
        style={{
          fontFamily: 'ui-monospace, monospace',
          fontSize: 10.5,
          color: 'rgb(var(--ink-fg-3))',
          padding: '3px 8px',
          borderRadius: 5,
          background: 'rgb(var(--ink-fg) / 0.04)',
          border: '1px solid rgb(var(--ink-border))'
        }}
      >
        v1.x
      </span>
    </div>
  )
}

// ─── 配置 slide-over ─────────────────────────────────────────────────────────
function ConfigDrawer({
  cfg,
  onClose
}: {
  cfg: ReportAgentConfig
  onClose: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const { save, isSaving } = useSetConfig()
  const [enabled, setEnabled] = useState(cfg.enabled)
  const [prompt, setPrompt] = useState(cfg.prompt)
  const [promptDirty, setPromptDirty] = useState(false)
  const [cadence, setCadence] = useState<ReportCadence>(cfg.schedule.cadence)
  const [hour, setHour] = useState<number>(cfg.schedule.hours?.[0] ?? 9)
  const [windowHours, setWindowHours] = useState<number>(cfg.window_hours ?? 24)
  const [model, setModel] = useState<string>(cfg.model || MODELS[0].id)
  const [kosEnrich, setKosEnrich] = useState(cfg.kos_enrich)

  const inputStyle: React.CSSProperties = {
    width: '100%',
    fontFamily: 'inherit',
    fontSize: 13.5,
    color: 'rgb(var(--ink-fg))',
    background: 'rgb(var(--ink-1))',
    border: '1px solid rgb(var(--ink-border))',
    borderRadius: 8,
    padding: '9px 11px',
    outline: 'none'
  }

  const onSave = (): void => {
    const patch: ReportConfigPatch = {
      enabled,
      // prompt 未改且仍是默认态 → 传 null 保持"用默认"；改过 → 传文本。
      prompt: promptDirty ? prompt : cfg.prompt_is_default ? null : cfg.prompt,
      model,
      window_hours: windowHours,
      kos_enrich: kosEnrich,
      schedule: { ...cfg.schedule, cadence, hours: [hour] }
    }
    void save(cfg.id, patch).then(onClose)
  }

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'absolute', inset: 0, zIndex: 60, background: 'rgb(0 0 0 / 0.4)' }}
      />
      <aside
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: 480,
          maxWidth: '92%',
          zIndex: 61,
          background: 'rgb(var(--ink-1))',
          borderLeft: '1px solid rgb(var(--ink-border))',
          boxShadow: 'var(--shadow-raised)',
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        <header
          className="flex items-center"
          style={{
            gap: 10,
            padding: '15px 18px',
            borderBottom: '1px solid rgb(var(--ink-border-soft))',
            flexShrink: 0
          }}
        >
          <span style={{ color: 'rgb(var(--c-accent))', display: 'flex' }}>
            <ReportIcon name="cog" size={16} />
          </span>
          <h2 style={{ fontSize: 15, fontWeight: 600, color: 'rgb(var(--ink-fg))', flex: 1 }}>
            {t('agents.config.title', { title: cfg.title })}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('agents.source.close')}
            style={{
              display: 'grid',
              placeItems: 'center',
              width: 28,
              height: 28,
              borderRadius: 7,
              background: 'transparent',
              border: 0,
              cursor: 'pointer',
              color: 'rgb(var(--ink-fg-2))'
            }}
          >
            <ReportIcon name="x" size={16} />
          </button>
        </header>

        <div className="scrollbar-thin" style={{ flex: 1, overflowY: 'auto', padding: 18 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {/* enable */}
            <div
              className="flex items-center"
              style={{
                gap: 12,
                padding: '13px 14px',
                borderRadius: 10,
                background: 'rgb(var(--ink-2))',
                border: '1px solid rgb(var(--ink-border))'
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 500, color: 'rgb(var(--ink-fg))' }}>
                  {t('agents.config.enable')}
                </div>
                <div style={{ fontSize: 12, color: 'rgb(var(--ink-fg-3))', marginTop: 2 }}>
                  {t('agents.config.enableHint')}
                </div>
              </div>
              <Switch on={enabled} onChange={setEnabled} />
            </div>

            {/* prompt */}
            <Field label={t('agents.config.prompt')} hint={t('agents.config.promptHint')}>
              <textarea
                value={prompt}
                onChange={(e) => {
                  setPrompt(e.target.value)
                  setPromptDirty(true)
                }}
                rows={11}
                className="scrollbar-thin"
                style={{
                  ...inputStyle,
                  resize: 'vertical',
                  lineHeight: 1.6,
                  fontSize: 13,
                  minHeight: 200
                }}
              />
              <div
                style={{
                  fontSize: 11.5,
                  color: 'rgb(var(--ink-fg-3))',
                  marginTop: 6,
                  lineHeight: 1.5
                }}
              >
                {t('agents.config.promptNote')}
              </div>
            </Field>

            {/* schedule */}
            <Field label={t('agents.config.schedule')}>
              <div className="seg" style={{ width: '100%', marginBottom: 10 }}>
                {(['daily', 'weekly', 'monthly'] as ReportCadence[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={cadence === k ? 'on' : ''}
                    style={{ flex: 1, justifyContent: 'center' }}
                    onClick={() => {
                      setCadence(k)
                      setWindowHours(DEFAULT_WINDOW[k])
                    }}
                  >
                    {t(`agents.cadence.${k}`)}
                  </button>
                ))}
              </div>
              <div className="flex items-center" style={{ gap: 10 }}>
                <span style={{ fontSize: 13, color: 'rgb(var(--ink-fg-2))' }}>
                  {t('agents.config.at')}
                </span>
                <select
                  value={hour}
                  onChange={(e) => setHour(Number(e.target.value))}
                  style={{ ...inputStyle, width: 'auto', flex: 1 }}
                >
                  {HOUR_OPTIONS.map((h) => (
                    <option key={h} value={h}>
                      {String(h).padStart(2, '0')}:00
                    </option>
                  ))}
                </select>
              </div>
            </Field>

            {/* window */}
            <Field label={t('agents.config.window')} hint={t('agents.config.windowHint')}>
              <div className="seg" style={{ width: '100%' }}>
                {WINDOW_BY_CADENCE[cadence].map(([v, l]) => (
                  <button
                    key={v}
                    type="button"
                    className={windowHours === v ? 'on' : ''}
                    style={{ flex: 1, justifyContent: 'center' }}
                    onClick={() => setWindowHours(v)}
                  >
                    {l}
                  </button>
                ))}
              </div>
            </Field>

            {/* model */}
            <Field label={t('agents.config.model')}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {MODELS.map((m) => {
                  const on = model === m.id
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setModel(m.id)}
                      className="flex items-center"
                      style={{
                        gap: 11,
                        padding: '11px 13px',
                        borderRadius: 9,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                        textAlign: 'left',
                        background: on ? 'rgb(var(--c-accent) / 0.07)' : 'rgb(var(--ink-1))',
                        border: `1px solid ${on ? 'rgb(var(--c-accent) / 0.35)' : 'rgb(var(--ink-border))'}`
                      }}
                    >
                      <span
                        style={{
                          width: 16,
                          height: 16,
                          borderRadius: '50%',
                          flexShrink: 0,
                          border: `1.5px solid ${on ? 'rgb(var(--c-accent))' : 'rgb(var(--ink-fg-3))'}`,
                          display: 'grid',
                          placeItems: 'center'
                        }}
                      >
                        {on && (
                          <span
                            style={{
                              width: 8,
                              height: 8,
                              borderRadius: '50%',
                              background: 'rgb(var(--c-accent))'
                            }}
                          />
                        )}
                      </span>
                      <div style={{ flex: 1 }}>
                        <div
                          style={{ fontSize: 13.5, fontWeight: 500, color: 'rgb(var(--ink-fg))' }}
                        >
                          {m.label}
                        </div>
                        <div
                          style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))', marginTop: 1 }}
                        >
                          {m.hint}
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            </Field>

            {/* kos enrich */}
            <div
              className="flex items-center"
              style={{
                gap: 12,
                padding: '13px 14px',
                borderRadius: 10,
                background: 'rgb(var(--c-ai) / 0.06)',
                border: '1px solid rgb(var(--c-ai) / 0.22)'
              }}
            >
              <span style={{ color: 'rgb(var(--c-ai))', flexShrink: 0 }}>
                <ReportIcon name="database" size={16} />
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 500, color: 'rgb(var(--ink-fg))' }}>
                  {t('agents.config.kos')}
                </div>
                <div style={{ fontSize: 12, color: 'rgb(var(--ink-fg-3))', marginTop: 2 }}>
                  {t('agents.config.kosHint')}
                </div>
              </div>
              <Switch on={kosEnrich} onChange={setKosEnrich} />
            </div>
          </div>
        </div>

        <footer
          className="flex items-center"
          style={{
            gap: 10,
            padding: '13px 18px',
            borderTop: '1px solid rgb(var(--ink-border-soft))',
            flexShrink: 0,
            justifyContent: 'flex-end'
          }}
        >
          <button
            type="button"
            onClick={onClose}
            className="btn-ghost"
            style={{ fontFamily: 'inherit' }}
          >
            {t('agents.config.cancel')}
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={isSaving}
            style={{
              fontFamily: 'inherit',
              fontSize: 13.5,
              fontWeight: 500,
              padding: '8px 18px',
              borderRadius: 8,
              cursor: isSaving ? 'wait' : 'pointer',
              color: 'rgb(var(--c-accent-fg))',
              background: 'rgb(var(--c-accent-dim))',
              border: 0
            }}
            onMouseEnter={(e) => {
              if (!isSaving) e.currentTarget.style.background = 'rgb(var(--c-accent))'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgb(var(--c-accent-dim))'
            }}
          >
            {t('agents.config.save')}
          </button>
        </footer>
      </aside>
    </>
  )
}

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div>
      <div className="flex items-baseline" style={{ gap: 8, marginBottom: 7 }}>
        <label style={{ fontSize: 13, fontWeight: 500, color: 'rgb(var(--ink-fg))' }}>
          {label}
        </label>
        {hint && <span style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))' }}>{hint}</span>}
      </div>
      {children}
    </div>
  )
}

// ─── tab ─────────────────────────────────────────────────────────────────────
export function AgentsTab({ onOpenReports }: { onOpenReports: () => void }): React.ReactElement {
  const { t } = useTranslation()
  const { agents, isLoading } = useReportConfig()
  const [configOpen, setConfigOpen] = useState(false)

  const cfg = useMemo(
    () => agents.find((a) => a.id === DEFAULT_AGENT_ID) ?? agents[0] ?? null,
    [agents]
  )

  return (
    <div
      className="scrollbar-thin"
      style={{ position: 'relative', flex: 1, overflowY: 'auto', height: '100%' }}
    >
      {/* 左对齐 + 限宽 880（margin 留默认即贴左，不 auto 居中）：标题贴左 = 全宽感、
          不再有「居中两侧留白」被误读为预留 chat panel；卡片限宽避免宽屏拉伸变形。 */}
      <div
        style={{
          maxWidth: 880,
          padding: '22px 28px 60px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16
        }}
      >
        <div>
          <h1
            style={{
              fontSize: 20,
              fontWeight: 600,
              color: 'rgb(var(--ink-fg))',
              letterSpacing: '-0.01em'
            }}
          >
            {t('agents.title')}
          </h1>
          <p style={{ fontSize: 13.5, color: 'rgb(var(--ink-fg-2))', marginTop: 5 }}>
            {t('agents.subtitle')}
          </p>
        </div>
        {cfg ? (
          <AgentCard cfg={cfg} onConfig={() => setConfigOpen(true)} onOpenReports={onOpenReports} />
        ) : (
          <div
            style={{
              borderRadius: 14,
              border: '1px solid rgb(var(--ink-border))',
              padding: '22px 20px',
              fontSize: 13,
              color: 'rgb(var(--ink-fg-3))'
            }}
          >
            {isLoading ? t('agents.reports.loading') : t('agents.card.noAgent')}
          </div>
        )}
        <NewAgentTile />
      </div>
      {cfg && configOpen && <ConfigDrawer cfg={cfg} onClose={() => setConfigOpen(false)} />}
    </div>
  )
}
