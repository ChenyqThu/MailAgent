// 08-05 WP-11 — Settings「工具审批档」：built-in 写工具的 per-tool 审批档（ask/auto/deny）。
//
// 复用 WP-10 connector 三档的 UI 语言（ConnectorsSection 的 seg 图标单选 / 分组 + 组级批量 /
// Reset permissions / 危险工具设 auto 的一次性红色确认），但数据面完全不同：行来自
// GET /api/agent/tool-prefs（canonical 注册表在 Python tool_prefs.py，**前端不手抄工具名**——
// 分组、默认档、configurable、dangerAuto 全是 wire 字段）。写端点回全量负载 → 原地 setData，
// 无需 react-query 缓存键。
//
// 语义提示（helper 里说清）：per-tool 档只作用于 owner 在场的 manual 对话；bypass 压过一切
// （D1=a）；send / run_command / skill 安装 / custom-agent CRUD 是 configurable=false 的固定
// 形状行（send 的免卡形状 = 底部的收件人白名单，D2=a）。

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Ban, Check, ChevronDown, Hand, Loader2, Lock } from 'lucide-react'

import { useMailApi } from '@shared/hooks/useMailApi'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { Button } from '@shared/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@shared/components/ui/popover'
import { toastError, toastSuccess } from '@shared/state/toast'
import type {
  ToolApprovalPrefRow,
  ToolApprovalPrefsPayload,
  ToolApprovalTierValue
} from '@shared/api/types'

const PILL_BASE =
  'inline-flex items-center gap-1 rounded-full px-1.5 py-px text-micro font-medium leading-4'

const TIERS: readonly ToolApprovalTierValue[] = ['auto', 'ask', 'deny']

const TIER_ICONS: Record<
  ToolApprovalTierValue,
  React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>
> = {
  auto: Check,
  ask: Hand,
  deny: Ban
}

/** 三档图标单选（WP-10 ToolModeControl 同款：authored `.seg` + `.on`；configurable=false 行
 *  渲染成禁用而不是消失——「这行为什么锁着」由旁边的 fixedAsk 药丸解释）。 */
function TierControl({
  value,
  disabled,
  ariaLabel,
  onChange
}: {
  value: ToolApprovalTierValue
  disabled: boolean
  ariaLabel: string
  onChange(next: ToolApprovalTierValue): void
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div className="seg shrink-0" role="group" aria-label={ariaLabel}>
      {TIERS.map((tier) => {
        const Icon = TIER_ICONS[tier]
        return (
          <button
            key={tier}
            type="button"
            disabled={disabled}
            aria-pressed={value === tier}
            aria-label={t(`settings.ai.toolPrefs.tier.${tier}`)}
            title={t(`settings.ai.toolPrefs.tier.${tier}`)}
            onClick={() => {
              if (tier !== value) onChange(tier)
            }}
            className={cn(
              value === tier && 'on',
              disabled && 'cursor-not-allowed opacity-50 hover:text-ink-fg-2'
            )}
          >
            <Icon className="size-3.5" aria-hidden="true" />
          </button>
        )
      })}
    </div>
  )
}

function GroupBulkMenu({
  group,
  onApply
}: {
  group: string
  onApply(tier: ToolApprovalTierValue | null): void
}): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const items: Array<{ key: string; tier: ToolApprovalTierValue | null }> = [
    { key: 'auto', tier: 'auto' },
    { key: 'ask', tier: 'ask' },
    { key: 'deny', tier: 'deny' },
    { key: 'clear', tier: null }
  ]
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-[var(--r-ctl)] px-1.5 py-0.5 text-micro text-ink-fg-3 transition-colors duration-fast hover:bg-ink-4 hover:text-ink-fg"
          aria-label={`${t('settings.ai.toolPrefs.bulk.label')} · ${t(`settings.ai.toolPrefs.group.${group}`)}`}
        >
          {t('settings.ai.toolPrefs.bulk.label')}
          <ChevronDown className="size-3" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-44 p-1" align="end">
        {items.map(({ key, tier }) => {
          const Icon = tier != null ? TIER_ICONS[tier] : undefined
          return (
            <button
              key={key}
              type="button"
              className="flex w-full items-center gap-2 rounded-[var(--r-ctl)] px-2 py-1.5 text-left text-aux text-ink-fg transition-colors duration-fast hover:bg-ink-4"
              onClick={() => {
                setOpen(false)
                onApply(tier)
              }}
            >
              {Icon ? <Icon className="size-3.5 text-ink-fg-2" aria-hidden="true" /> : null}
              {t(`settings.ai.toolPrefs.bulk.${key}`)}
            </button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}

function ToolPrefRow({
  row,
  onChange,
  onClear
}: {
  row: ToolApprovalPrefRow
  onChange(row: ToolApprovalPrefRow, next: ToolApprovalTierValue): void
  onClear(row: ToolApprovalPrefRow): void
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div className="flex items-start gap-3 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="break-all font-mono text-micro text-ink-fg">{row.toolName}</span>
          {row.dangerAuto ? (
            <span className={cn(PILL_BASE, 'bg-warn/15 text-warn')}>
              <AlertTriangle className="size-2.5" aria-hidden="true" />
              {t('settings.ai.toolPrefs.danger')}
            </span>
          ) : null}
          {!row.configurable ? (
            <span
              className={cn(PILL_BASE, 'bg-ink-4 text-ink-fg-3')}
              title={t('settings.ai.toolPrefs.fixedAskTip')}
            >
              <Lock className="size-2.5" aria-hidden="true" />
              {t('settings.ai.toolPrefs.fixedAsk')}
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-micro text-ink-fg-3">
          <span>{t(`settings.ai.toolPrefs.effective.${row.effectiveTier}`)}</span>
          {row.tier == null ? (
            <span>· {t('settings.ai.toolPrefs.followDefault')}</span>
          ) : row.configurable ? (
            <button
              type="button"
              className="rounded px-1 text-micro text-ink-fg-3 underline decoration-ink-fg-3/40 transition-colors duration-fast hover:bg-ink-4 hover:text-ink-fg"
              onClick={() => onClear(row)}
            >
              {t('settings.ai.toolPrefs.clearOverride')}
            </button>
          ) : null}
        </div>
      </div>
      <TierControl
        value={row.effectiveTier}
        disabled={!row.configurable}
        ariaLabel={`${t('settings.ai.toolPrefs.tier.label')} · ${row.toolName}`}
        onChange={(next) => onChange(row, next)}
      />
    </div>
  )
}

/** send 收件人白名单编辑（D2=a：send 唯一免卡形状；空 = 恒 ask）。 */
function SendWhitelistEditor({
  entries,
  onSaved
}: {
  entries: string[]
  onSaved(next: string[]): void
}): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const [draft, setDraft] = React.useState(entries.join(', '))
  const [saving, setSaving] = React.useState(false)
  // 服务端保存后（onSaved 更新 entries）同步草稿——但用户正在编辑时不覆盖。
  const [dirty, setDirty] = React.useState(false)
  React.useEffect(() => {
    if (!dirty) setDraft(entries.join(', '))
  }, [entries, dirty])

  async function save(): Promise<void> {
    setSaving(true)
    try {
      const recipients = draft
        .split(/[\n,;]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
      const normalized = await api.chat.setSendWhitelist(recipients)
      onSaved(normalized)
      setDirty(false)
      toastSuccess(t('settings.ai.toolPrefs.sendWhitelist.saved', { count: normalized.length }))
    } catch (err) {
      toastError(
        t('settings.ai.toolPrefs.sendWhitelist.saveFailed', { message: errorMessage(err) })
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="px-[var(--settings-tile-px,1rem)] py-[var(--settings-tile-py,0.875rem)]">
      <div className="text-aux font-medium text-ink-fg">
        {t('settings.ai.toolPrefs.sendWhitelist.label')}
      </div>
      <div className="mt-0.5 text-meta text-ink-fg-2">
        {t('settings.ai.toolPrefs.sendWhitelist.helper')}
      </div>
      <div className="mt-2 flex items-start gap-2">
        <textarea
          value={draft}
          rows={2}
          spellCheck={false}
          placeholder={t('settings.ai.toolPrefs.sendWhitelist.placeholder')}
          onChange={(e) => {
            setDraft(e.target.value)
            setDirty(true)
          }}
          className="min-h-[3.25rem] flex-1 resize-y rounded-[var(--r-ctl)] border border-ink-border-soft bg-ink-2 px-2 py-1.5 font-mono text-micro text-ink-fg outline-none transition-colors duration-fast placeholder:text-ink-fg-3 focus:border-ink-border"
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={saving || !dirty}
          onClick={() => void save()}
        >
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {t('settings.ai.toolPrefs.sendWhitelist.save')}
        </Button>
      </div>
    </div>
  )
}

export function ToolApprovalSection(): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const [data, setData] = React.useState<ToolApprovalPrefsPayload | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  // 危险工具（dangerAuto）设 auto 的一次性红色确认（WP-10 destructive confirm 同款）。
  // check 2026-08-05 — 也覆盖组级批量：bulk auto 的目标组含 dangerAuto 可配行时同样先走
  // 红确认（否则「outbound 组批量 auto」恰好只改 notion_agent_chat 一行、静默绕过单行确认）。
  const [confirmDanger, setConfirmDanger] = React.useState<
    | { kind: 'row'; row: ToolApprovalPrefRow }
    | { kind: 'bulk'; group: string; dangerTools: string[] }
    | null
  >(null)

  const load = React.useCallback(async (): Promise<void> => {
    try {
      setLoadError(null)
      setData(await api.chat.getToolPrefs())
    } catch (err) {
      setLoadError(errorMessage(err))
    }
  }, [api])

  React.useEffect(() => {
    void load()
  }, [load])

  async function mutate(run: () => Promise<ToolApprovalPrefsPayload>): Promise<void> {
    setBusy(true)
    try {
      setData(await run())
    } catch (err) {
      toastError(t('settings.ai.toolPrefs.saveFailed'), errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  function handleTier(row: ToolApprovalPrefRow, next: ToolApprovalTierValue): void {
    if (next === 'auto' && row.dangerAuto) {
      setConfirmDanger({ kind: 'row', row })
      return
    }
    void mutate(() => api.chat.setToolPref(row.toolName, next))
  }

  async function runBulk(group: string, tier: ToolApprovalTierValue | null): Promise<void> {
    await mutate(async () => {
      const result = await api.chat.bulkSetToolPrefs({ tier, group })
      toastSuccess(t('settings.ai.toolPrefs.bulkDone', { count: result.updated ?? 0 }))
      return result
    })
  }

  function handleBulk(
    group: string,
    rows: ToolApprovalPrefRow[],
    tier: ToolApprovalTierValue | null
  ): void {
    if (tier === 'auto') {
      const dangerTools = rows.filter((r) => r.dangerAuto && r.configurable).map((r) => r.toolName)
      if (dangerTools.length > 0) {
        setConfirmDanger({ kind: 'bulk', group, dangerTools })
        return
      }
    }
    void runBulk(group, tier)
  }

  const groups = React.useMemo(() => {
    const map = new Map<string, ToolApprovalPrefRow[]>()
    for (const row of data?.tools ?? []) {
      const list = map.get(row.group)
      if (list) list.push(row)
      else map.set(row.group, [row])
    }
    return [...map.entries()]
  }, [data])

  const body: React.ReactNode = (() => {
    if (loadError != null) {
      return (
        <div className="flex items-center justify-between gap-3 px-[var(--settings-tile-px,1rem)] py-[var(--settings-tile-py,0.875rem)]">
          <div className="text-aux text-ink-fg-3">
            {t('settings.ai.toolPrefs.loadError', { message: loadError })}
          </div>
          <Button size="sm" variant="ghost" onClick={() => void load()}>
            {t('settings.ai.toolPrefs.retry')}
          </Button>
        </div>
      )
    }
    if (data == null) {
      return (
        <div className="flex items-center gap-2 px-[var(--settings-tile-px,1rem)] py-[var(--settings-tile-py,0.875rem)] text-aux text-ink-fg-2">
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
        </div>
      )
    }
    return (
      <>
        <div className="px-[var(--settings-tile-px,1rem)] py-[var(--settings-tile-py,0.875rem)]">
          <div className="flex items-center justify-end gap-1.5 pb-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              title={t('settings.ai.toolPrefs.presetTip')}
              onClick={() =>
                void mutate(async () => {
                  const result = await api.chat.applyToolPrefsPreset()
                  toastSuccess(
                    t('settings.ai.toolPrefs.presetDone', { count: result.updated ?? 0 })
                  )
                  return result
                })
              }
            >
              {t('settings.ai.toolPrefs.preset')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void mutate(async () => {
                  const result = await api.chat.resetToolPrefs()
                  toastSuccess(t('settings.ai.toolPrefs.resetDone', { count: result.removed ?? 0 }))
                  return result
                })
              }
            >
              {t('settings.ai.toolPrefs.reset')}
            </Button>
          </div>
          {confirmDanger != null ? (
            <div className="mb-2 rounded-[var(--r-ctl)] border border-[rgb(var(--c-fail)/0.35)] bg-[rgb(var(--c-fail)/0.08)] px-3 py-2">
              <div className="flex items-center gap-1.5 text-meta font-medium text-[rgb(var(--c-fail))]">
                <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
                {t('settings.ai.toolPrefs.dangerConfirmTitle', {
                  tool:
                    confirmDanger.kind === 'row'
                      ? confirmDanger.row.toolName
                      : confirmDanger.dangerTools.join(', ')
                })}
              </div>
              <p className="mt-1 text-micro leading-relaxed text-ink-fg-2">
                {t('settings.ai.toolPrefs.dangerConfirmBody')}
              </p>
              <div className="mt-2 flex justify-end gap-1.5">
                <Button size="sm" variant="ghost" onClick={() => setConfirmDanger(null)}>
                  {t('settings.ai.toolPrefs.cancel')}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => {
                    const pending = confirmDanger
                    setConfirmDanger(null)
                    if (pending == null) return
                    if (pending.kind === 'row') {
                      void mutate(() => api.chat.setToolPref(pending.row.toolName, 'auto'))
                    } else {
                      void runBulk(pending.group, 'auto')
                    }
                  }}
                >
                  {t('settings.ai.toolPrefs.confirm')}
                </Button>
              </div>
            </div>
          ) : null}
          {groups.map(([group, rows]) => (
            <div key={group} className="pt-1">
              <div className="flex items-center justify-between gap-3 border-b border-ink-border-soft pb-1">
                <div className="flex items-center gap-1.5">
                  <span className={cn(PILL_BASE, 'bg-ink-4 text-ink-fg-2')}>
                    {t(`settings.ai.toolPrefs.group.${group}`)}
                  </span>
                  <span className="text-micro text-ink-fg-3">{rows.length}</span>
                </div>
                <GroupBulkMenu group={group} onApply={(tier) => handleBulk(group, rows, tier)} />
              </div>
              {rows.map((row) => (
                <ToolPrefRow
                  key={row.toolName}
                  row={row}
                  onChange={handleTier}
                  onClear={(r) => void mutate(() => api.chat.setToolPref(r.toolName, null))}
                />
              ))}
            </div>
          ))}
        </div>
        <SendWhitelistEditor
          entries={data.sendWhitelist}
          onSaved={(next) => setData((prev) => (prev ? { ...prev, sendWhitelist: next } : prev))}
        />
      </>
    )
  })()

  return <>{body}</>
}
