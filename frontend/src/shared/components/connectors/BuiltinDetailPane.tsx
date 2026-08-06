// Connectors 配置台 —— 内置工具功能域的右栏 detail（Lane B）。
//
// 数据面与旧 settings/custom-ai/ToolApprovalSection 完全同源：行来自 GET /api/agent/tool-prefs
// （canonical 注册表在 Python tool_prefs.py，**前端不手抄工具名** —— 分组、默认档、
// configurable、dangerAuto 全是 wire 字段）；写端点回全量负载 → 由页面原地 setData。
// 迁移时**必须保住**的语义（复核抓过的真 bug 逐条在此落位）：
//   · dangerAuto 行设 auto → 一次性红色确认；**组级批量设 auto 且组里有 dangerAuto 可配行
//     同样先过红确认**（否则「calendar 组批量 auto」恰好只改 delete 一行、静默绕过单行确认）。
//   · configurable=false 行渲染成禁用而不是消失，「为什么锁着」由 fixedAsk 药丸 + tip 解释
//     （send=收件人白名单 / run_command=policy_rules / 供应链与 custom-agent CRUD 恒弹卡）。
//   · deny 与 auto/ask 不同轴（作用在注册面：模型根本看不见），effective 文案单独说。
//   · send 收件人白名单 = email_prepare_send 唯一的免卡形状，跟着 outbound 组走。

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Ban, Check, Hand, Loader2, Lock } from 'lucide-react'

import { useMailApi } from '@shared/hooks/useMailApi'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { Button } from '@shared/components/ui/button'
import { toastError, toastSuccess } from '@shared/state/toast'
import type {
  ToolApprovalPrefRow,
  ToolApprovalPrefsPayload,
  ToolApprovalTierValue
} from '@shared/api/types'

import { PILL_BASE } from './consoleShared'
import { BulkMenu, SegIconSelect, ToolCategoryGroup, type SegOption } from './parts'

const TIER_ICONS: Record<
  ToolApprovalTierValue,
  React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>
> = {
  auto: Check,
  ask: Hand,
  deny: Ban
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
  const options: SegOption<ToolApprovalTierValue>[] = (['auto', 'ask', 'deny'] as const).map(
    (tier) => ({
      value: tier,
      label: t(`settings.ai.toolPrefs.tier.${tier}`),
      icon: TIER_ICONS[tier]
    })
  )
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
        {/* 不可配置行不能只是灰掉：把「为什么锁着」摊开写在行下（PRD §5 硬要求）。 */}
        {!row.configurable ? (
          <div className="mt-0.5 text-micro leading-relaxed text-ink-fg-3">
            {t('settings.ai.toolPrefs.fixedAskTip')}
          </div>
        ) : null}
      </div>
      <SegIconSelect
        value={row.effectiveTier}
        options={options}
        disabled={!row.configurable}
        ariaLabel={`${t('settings.ai.toolPrefs.tier.label')} · ${row.toolName}`}
        onChange={(next) => onChange(row, next)}
      />
    </div>
  )
}

/** send 收件人白名单编辑（D2=a：send 唯一免卡形状；空 = 恒 ask）。旧 ToolApprovalSection
 *  原样搬来 —— 保存走 setSendWhitelist，服务端回规范化列表。 */
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
  const [dirty, setDirty] = React.useState(false)

  async function save(): Promise<void> {
    setSaving(true)
    try {
      const recipients = draft
        .split(/[\n,;]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
      const normalized = await api.chat.setSendWhitelist(recipients)
      onSaved(normalized)
      // 服务端回**规范化**列表 —— 草稿直接对齐它（旧实现靠「entries 变了且不 dirty 就同步」
      // 的 effect；本页里 entries 的唯一外部来源就是这次保存，直接写省掉 set-state-in-effect）。
      setDraft(normalized.join(', '))
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
    <div className="mt-4 rounded-[var(--r-card)] border border-ink-border-soft p-3">
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

export function BuiltinDetailPane({
  group,
  data,
  busy,
  onMutate,
  onWhitelistSaved
}: {
  group: string
  data: ToolApprovalPrefsPayload
  busy: boolean
  /** 页面级写通道：run 返回全量负载（写端点契约），页面 setData 原地刷新左右两栏。 */
  onMutate(run: () => Promise<ToolApprovalPrefsPayload>): Promise<void>
  onWhitelistSaved(next: string[]): void
}): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  // 🔴 owner 拍板：类别默认折叠，点组头单独展开。「换功能域折叠态归零」由父级 key={group}
  // 重挂载承担（不是 effect 里 setState —— react-hooks/set-state-in-effect）。
  const [expanded, setExpanded] = React.useState(false)
  const [confirmDanger, setConfirmDanger] = React.useState<
    | { kind: 'row'; row: ToolApprovalPrefRow }
    | { kind: 'bulk'; group: string; dangerTools: string[] }
    | null
  >(null)

  const rows = React.useMemo(() => data.tools.filter((r) => r.group === group), [data, group])

  function handleTier(row: ToolApprovalPrefRow, next: ToolApprovalTierValue): void {
    if (next === 'auto' && row.dangerAuto) {
      setConfirmDanger({ kind: 'row', row })
      return
    }
    void onMutate(() => api.chat.setToolPref(row.toolName, next))
  }

  async function runBulk(tier: ToolApprovalTierValue | null): Promise<void> {
    await onMutate(async () => {
      const result = await api.chat.bulkSetToolPrefs({ tier, group })
      toastSuccess(t('settings.ai.toolPrefs.bulkDone', { count: result.updated ?? 0 }))
      return result
    })
  }

  function handleBulk(tier: ToolApprovalTierValue | null): void {
    if (tier === 'auto') {
      const dangerTools = rows.filter((r) => r.dangerAuto && r.configurable).map((r) => r.toolName)
      if (dangerTools.length > 0) {
        setConfirmDanger({ kind: 'bulk', group, dangerTools })
        return
      }
    }
    void runBulk(tier)
  }

  const bulkItems = [
    { key: 'auto', label: t('settings.ai.toolPrefs.bulk.auto'), icon: TIER_ICONS.auto },
    { key: 'ask', label: t('settings.ai.toolPrefs.bulk.ask'), icon: TIER_ICONS.ask },
    { key: 'deny', label: t('settings.ai.toolPrefs.bulk.deny'), icon: TIER_ICONS.deny },
    { key: 'clear', label: t('settings.ai.toolPrefs.bulk.clear') }
  ]

  const hasSendWhitelist = rows.some((r) => r.toolName === 'email_prepare_send')

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lead font-medium text-ink-fg">
            {t(`settings.ai.toolPrefs.group.${group}`)}
          </h2>
          <p className="mt-1 text-aux leading-relaxed text-ink-fg-2">
            {t(`connectorsConsole.builtinGroupDesc.${group}`, {
              defaultValue: t('settings.ai.toolPrefs.helper')
            })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            title={t('settings.ai.toolPrefs.presetTip')}
            onClick={() =>
              void onMutate(async () => {
                const result = await api.chat.applyToolPrefsPreset()
                toastSuccess(t('settings.ai.toolPrefs.presetDone', { count: result.updated ?? 0 }))
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
              void onMutate(async () => {
                const result = await api.chat.resetToolPrefs()
                toastSuccess(t('settings.ai.toolPrefs.resetDone', { count: result.removed ?? 0 }))
                return result
              })
            }
          >
            {t('settings.ai.toolPrefs.reset')}
          </Button>
        </div>
      </div>

      {confirmDanger != null ? (
        <div className="mt-3 rounded-[var(--r-ctl)] border border-[rgb(var(--c-fail)/0.35)] bg-[rgb(var(--c-fail)/0.08)] px-3 py-2">
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
                  void onMutate(() => api.chat.setToolPref(pending.row.toolName, 'auto'))
                } else {
                  void runBulk('auto')
                }
              }}
            >
              {t('settings.ai.toolPrefs.confirm')}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="mt-3">
        <ToolCategoryGroup
          id={`console-builtin-${group}`}
          expanded={expanded}
          onToggle={() => setExpanded((v) => !v)}
          labelPill={
            <span className={cn(PILL_BASE, 'bg-ink-4 text-ink-fg-2')}>
              {t(`settings.ai.toolPrefs.group.${group}`)}
            </span>
          }
          count={rows.length}
          bulk={
            <BulkMenu
              ariaLabel={`${t('settings.ai.toolPrefs.bulk.label')} · ${t(`settings.ai.toolPrefs.group.${group}`)}`}
              items={bulkItems}
              onApply={(key) => handleBulk(key === 'clear' ? null : (key as ToolApprovalTierValue))}
            />
          }
        >
          <div>
            {rows.map((row) => (
              <ToolPrefRow
                key={row.toolName}
                row={row}
                onChange={handleTier}
                onClear={(r) => void onMutate(() => api.chat.setToolPref(r.toolName, null))}
              />
            ))}
          </div>
        </ToolCategoryGroup>
      </div>

      {hasSendWhitelist ? (
        <SendWhitelistEditor entries={data.sendWhitelist} onSaved={onWhitelistSaved} />
      ) : null}
    </div>
  )
}
