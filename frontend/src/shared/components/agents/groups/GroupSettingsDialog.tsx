// L4 群聊 g1 — 群设置对话框（每成员响应模式 / 法官位 / 链上限与小时预算 / 用量）。
//
// 形态照同目录的 NewGroupDialog（Dialog + DialogHeader/Footer + 同一批 ui 原语），只在这里
// 多一段可滚动正文（设置项比建群多）。
//
// 三条纪律：
//   ① **只写改过的键**。服务端把 `group_config_json` 整块覆写，而「没配过」= NULL = 取出厂
//      默认（默认值单源在 groupFloors.ts，DB 里不存默认值副本）；把没动过的输入框原样回
//      写，等于把今天的默认值冻结进这个群，以后改默认它不跟。数字输入框留空 = 未配置，
//      placeholder 显示出厂默认。
//   ② **法官单选、可空**：用 RadioGroup（结构上就选不出两位）+ 一个「不设法官」档。选中后
//      提示「成员变动后需重新确认」—— 服务端在法官位变更时写 judgeScopeHash =
//      sha256(members_json 原文)，成员一变 hash 就失配（g2 的免卡判据）。
//   ③ **用量区两指标先于级联可见**（红线 4：先量得出来，再让 agent 互相唤醒）。null = 未知，
//      渲染成「—」而不是 0。

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import type { GroupConfig } from '@shared/chat_model'
import {
  getGroupConfig,
  getGroupMetrics,
  setGroupConfig,
  type GroupConfigPatch
} from '@shared/api/groupSettings'
import { qk } from '@shared/lib/queryKeys'
import { errorMessage } from '@shared/lib/ipcErrors'
import { toastError, toastSuccess } from '@shared/state/toast'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@shared/components/ui/dialog'
import { Button } from '@shared/components/ui/button'
import { Input } from '@shared/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@shared/components/ui/radio-group'
import { SegmentedControl } from '@shared/components/ui/segmented'

import { AgentAvatar } from '../AgentAvatar'
import type { GroupMemberMeta } from './members'

import {
  CHAIN_CAP_DEFAULT,
  HOURLY_TOKENS_DEFAULT,
  HOURLY_TURNS_DEFAULT,
  HOURLY_USD_DEFAULT,
  type GroupResponseMode
} from '../../../../ai-gateway/groupFloors'

/** 「不设法官」在 RadioGroup 里的值（Radix 不接受空串作为 item value）。 */
const JUDGE_NONE = '__none__'

/** 四个数值项：配置键 + 出厂默认（默认值只从 groupFloors 读，本文件零裸数字）。 */
const NUMERIC_FIELDS = [
  { key: 'chainCap', fallback: CHAIN_CAP_DEFAULT, step: 1 },
  { key: 'hourlyTurns', fallback: HOURLY_TURNS_DEFAULT, step: 1 },
  { key: 'hourlyTokens', fallback: HOURLY_TOKENS_DEFAULT, step: 1000 },
  { key: 'hourlyUsd', fallback: HOURLY_USD_DEFAULT, step: 0.5 }
] as const

type NumericKey = (typeof NUMERIC_FIELDS)[number]['key']

function numericText(config: GroupConfig, key: NumericKey): string {
  const raw = config[key]
  return typeof raw === 'number' ? String(raw) : ''
}

export function GroupSettingsDialog({
  open,
  onOpenChange,
  sessionId,
  memberIds,
  memberMeta
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionId: number
  /** members_json 序（= 群内候选序），设置里的成员顺序与群头像行一致。 */
  memberIds: string[]
  memberMeta: Map<string, GroupMemberMeta>
}): React.ReactElement {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const titleOf = (id: string): string => memberMeta.get(id)?.title?.trim() || id

  const configQ = useQuery({
    queryKey: qk.chat.groupConfig(sessionId),
    queryFn: () => getGroupConfig(sessionId),
    enabled: open,
    retry: false
  })
  const metricsQ = useQuery({
    queryKey: qk.chat.groupMetrics(sessionId),
    queryFn: () => getGroupMetrics(sessionId),
    enabled: open,
    retry: false
  })

  // 服务端读回的基线（保存时用来判定「哪些键真的改了」）。
  const loadedModes = useMemo(() => configQ.data?.modes ?? {}, [configQ.data])
  const loadedConfig = useMemo<GroupConfig>(() => configQ.data?.config ?? { v: 1 }, [configQ.data])

  // 编辑态是**叠在服务端事实上的覆盖层**，不是它的一份拷贝：`{}` = 什么都没动。
  // 🔴 刻意不写「data 到了就把 state 重置成 data」那种 effect —— 那种 effect 的依赖里必然
  // 有 memberIds / loadedConfig 这类每次渲染都可能换引用的值，一换就把 owner 正在改的东西
  // 冲掉（本批实测：父组件传字面量数组时，点了「实时」立刻被重置回「点名」）。
  // 覆盖层只在对话框**打开的那一刻**清空。
  const [modeEdits, setModeEdits] = useState<Record<string, GroupResponseMode>>({})
  const [judgeEdit, setJudgeEdit] = useState<string | null>(null)
  const [numberEdits, setNumberEdits] = useState<Partial<Record<NumericKey, string>>>({})

  const clearEdits = (): void => {
    setModeEdits({})
    setJudgeEdit(null)
    setNumberEdits({})
  }
  useEffect(() => {
    if (open) clearEdits()
  }, [open])

  const modeOf = (id: string): GroupResponseMode => modeEdits[id] ?? loadedModes[id] ?? 'mention'
  const judge = judgeEdit ?? loadedConfig.judgeAgentId ?? JUDGE_NONE
  const numberOf = (key: NumericKey): string => numberEdits[key] ?? numericText(loadedConfig, key)

  const save = useMutation({
    mutationFn: (patch: GroupConfigPatch) => setGroupConfig(sessionId, patch),
    onSuccess: () => {
      toastSuccess(t('groupChat.settings.saved'))
      clearEdits()
      void qc.invalidateQueries({ queryKey: qk.chat.groupConfig(sessionId) })
      void qc.invalidateQueries({ queryKey: qk.chat.groupMetrics(sessionId) })
      onOpenChange(false)
    },
    onError: (err) => toastError(t('groupChat.settings.saveFailed', { error: errorMessage(err) }))
  })

  const submit = (): void => {
    const patch: GroupConfigPatch = {}
    const changedModes: Record<string, GroupResponseMode> = {}
    for (const id of memberIds) {
      const next = modeOf(id)
      if (next !== (loadedModes[id] ?? 'mention')) changedModes[id] = next
    }
    if (Object.keys(changedModes).length > 0) patch.modes = changedModes
    const nextJudge = judge === JUDGE_NONE ? null : judge
    if (nextJudge !== (loadedConfig.judgeAgentId ?? null)) patch.judgeAgentId = nextJudge
    for (const field of NUMERIC_FIELDS) {
      const text = numberOf(field.key).trim()
      // 留空 = 未配置：服务端没有「清回默认」的写法，所以清空只是不写，不是写 null。
      if (text.length === 0) continue
      const value = Number(text)
      if (!Number.isFinite(value)) continue
      if (value === loadedConfig[field.key]) continue
      patch[field.key] = value
    }
    save.mutate(patch)
  }

  const metrics = metricsQ.data
  const pct = (value: number | null | undefined): string =>
    typeof value === 'number' ? `${(value * 100).toFixed(1)}%` : t('groupChat.metrics.unknown')
  const ratio = (value: number | null | undefined): string =>
    typeof value === 'number' ? value.toFixed(1) : t('groupChat.metrics.unknown')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('groupChat.settings.title')}</DialogTitle>
        </DialogHeader>

        <div className="scrollbar-thin flex max-h-[58vh] flex-col gap-5 overflow-y-auto">
          {/* 响应模式（每成员一行）。 */}
          <section className="flex flex-col gap-2">
            <span className="text-aux font-medium text-ink-fg-1">
              {t('groupChat.settings.modes')}
            </span>
            <span className="text-micro leading-relaxed text-ink-fg-3">
              {t('groupChat.settings.modesHelper')}
            </span>
            {memberIds.map((id) => (
              <div key={id} className="flex items-center gap-2.5">
                <AgentAvatar
                  agentId={id}
                  config={memberMeta.get(id)?.avatar}
                  size={24}
                  title={titleOf(id)}
                />
                <span className="min-w-0 flex-1 truncate text-body text-ink-fg">{titleOf(id)}</span>
                {/* 🔴 fluid 只给每段 flex-1，不撑容器：窄标签下必须在调用处补 w-full。 */}
                <SegmentedControl<GroupResponseMode>
                  value={modeOf(id)}
                  onChange={(next) => setModeEdits((prev) => ({ ...prev, [id]: next }))}
                  options={[
                    { value: 'realtime', label: t('groupChat.settings.modeRealtime') },
                    { value: 'mention', label: t('groupChat.settings.modeMention') }
                  ]}
                  ariaLabel={t('groupChat.settings.modeAria', { name: titleOf(id) })}
                  fluid
                  className="flex w-[8.5rem] shrink-0"
                />
              </div>
            ))}
          </section>

          {/* 法官位（单选，可空）。 */}
          <section className="flex flex-col gap-2">
            <span className="text-aux font-medium text-ink-fg-1">
              {t('groupChat.settings.judge')}
            </span>
            <span className="text-micro leading-relaxed text-ink-fg-3">
              {t('groupChat.settings.judgeHelper')}
            </span>
            <RadioGroup
              value={judge}
              onValueChange={setJudgeEdit}
              aria-label={t('groupChat.settings.judge')}
            >
              <label className="flex cursor-pointer items-center gap-2.5 text-body text-ink-fg">
                <RadioGroupItem value={JUDGE_NONE} />
                <span>{t('groupChat.settings.judgeNone')}</span>
              </label>
              {memberIds.map((id) => (
                <label
                  key={id}
                  className="flex cursor-pointer items-center gap-2.5 text-body text-ink-fg"
                >
                  <RadioGroupItem value={id} />
                  <span className="min-w-0 truncate">{titleOf(id)}</span>
                </label>
              ))}
            </RadioGroup>
            {judge !== JUDGE_NONE && (
              <span className="text-micro text-warn">{t('groupChat.settings.judgeStaleHint')}</span>
            )}
          </section>

          {/* 链上限 + 每小时预算。 */}
          <section className="flex flex-col gap-2">
            <span className="text-aux font-medium text-ink-fg-1">
              {t('groupChat.settings.limits')}
            </span>
            {NUMERIC_FIELDS.map((field) => (
              <label key={field.key} className="flex items-center gap-2.5">
                <span className="min-w-0 flex-1 text-body text-ink-fg">
                  {t(`groupChat.settings.${field.key}`)}
                </span>
                <Input
                  type="number"
                  inputMode="decimal"
                  step={field.step}
                  value={numberOf(field.key)}
                  placeholder={String(field.fallback)}
                  aria-label={t(`groupChat.settings.${field.key}`)}
                  onChange={(e) => setNumberEdits((prev) => ({ ...prev, [field.key]: e.target.value }))}
                  className="w-28 shrink-0"
                />
              </label>
            ))}
            <span className="text-micro text-ink-fg-3">{t('groupChat.settings.defaultHint')}</span>
          </section>

          {/* 用量（两指标 + 最近 1 小时）。 */}
          <section className="flex flex-col gap-2">
            <span className="text-aux font-medium text-ink-fg-1">
              {t('groupChat.settings.usage')}
            </span>
            <div className="flex flex-col gap-1 rounded-lg bg-ink-2 px-3 py-2.5 text-meta text-ink-fg-1">
              <div className="flex items-center justify-between gap-2">
                <span>{t('groupChat.metrics.silentRunRate')}</span>
                <span className="font-mono">{pct(metrics?.silentRunRate)}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span>{t('groupChat.metrics.turnsPerHumanMessage')}</span>
                <span className="font-mono">{ratio(metrics?.turnsPerHumanMessage)}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span>{t('groupChat.metrics.last1h')}</span>
                <span className="font-mono">
                  {t('groupChat.metrics.window', {
                    turns: metrics?.last1h.turns ?? 0,
                    tokens: metrics?.last1h.tokens ?? 0,
                    cost:
                      typeof metrics?.last1h.costUsd === 'number'
                        ? `$${metrics.last1h.costUsd.toFixed(2)}`
                        : t('groupChat.metrics.unknown')
                  })}
                </span>
              </div>
            </div>
          </section>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('groupChat.settings.cancel')}
          </Button>
          <Button onClick={submit} disabled={save.isPending || configQ.data == null}>
            {save.isPending ? t('groupChat.settings.saving') : t('groupChat.settings.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
