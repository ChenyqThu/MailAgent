// L4 群聊 UX 批 — 群详情面（右栏常驻，取代 g1 的 GroupSettingsDialog 模态）。
//
// 五节：基本 / 成员 / 上限与预算 / 用量 / 危险区。三条纪律：
//
//   ① **没有保存按钮**：逐项即改即存（数值项 blur 才写；分段 / 开关 / 选择即时），每项一条独立
//      mutation，失败只 toast 那一项。g1 那种「攒一批再按保存」的编辑覆盖层放在常驻右栏里会与
//      服务端事实长期分叉（对话框关掉就清，右栏不会关）。
//
//   ② **留空 = 未配置，不是 0**：数值项留空不写；已配过的值要清回出厂默认，走「恢复默认」显式
//      PUT `null` 删键 —— 服务端整块覆写 `group_config_json`，把今天的默认值原样回写等于把它
//      冻结进这个群，以后改默认它不跟。
//
//   ③ **labs off 只渲染 v1 真的生效的节**（基本 / 成员 / 危险区）。响应模式、法官位、上限与用量
//      在 v1 人驱动循环下一条都不生效，渲染出来就是骗人；节尾用 labsOffNote 说明去哪儿开。
//
// 成员加 / 踢的**权威校验只在 serve-api**（六条，全 400 E_INVALID_ARG + hint）：这里只做「已在群
// 的不出现在候选、满员禁用」这类省一次往返的提示，失败一律显示服务端的 hint。

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Plus, RotateCcw, X } from 'lucide-react'

import type { ChatSession } from '@shared/api/types'
import type { GroupConfig, GroupMetrics, GroupMetricsWindow } from '@shared/chat_model'
import {
  getGroupConfig,
  getGroupMetrics,
  getGroupTurns,
  patchGroupMembers,
  setGroupConfig,
  type GroupConfigPatch,
  type GroupMembersPatch,
  type GroupTurnWire
} from '@shared/api/groupSettings'
import { request } from '@shared/api/http_client'
import { resolveApiBaseUrl } from '@shared/lib/apiBaseUrl'
import { qk } from '@shared/lib/queryKeys'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { toastError, toastSuccess } from '@shared/state/toast'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useEnabledModels } from '@shared/hooks/useLlmModels'
import { stripProviderPrefix } from '@shared/hooks/useLlmProviders'
import { Button } from '@shared/components/ui/button'
import { Input } from '@shared/components/ui/input'
import { Switch } from '@shared/components/ui/switch'
import { SegmentedControl } from '@shared/components/ui/segmented'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shared/components/ui/select'
import { Popover, PopoverContent, PopoverTrigger } from '@shared/components/ui/popover'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@shared/components/ui/dialog'

import { AgentAvatar } from '../AgentAvatar'
import { ModelSelectItems } from '../drawers/ModelSelectItems'
import type { GroupCandidate, GroupMemberMeta } from './members'

import {
  CHAIN_CAP_DEFAULT,
  HOURLY_TOKENS_DEFAULT,
  HOURLY_TURNS_DEFAULT,
  HOURLY_USD_DEFAULT,
  MAIN_AGENT_MEMBER_ID,
  MAX_GROUP_MEMBERS,
  WEREWOLF_CHAIN_CAP,
  WEREWOLF_HOURLY_TOKENS,
  WEREWOLF_HOURLY_TURNS,
  WEREWOLF_HOURLY_USD,
  WEREWOLF_SESSION_TURN_CAP,
  type GroupResponseMode,
  type GroupTurnOutcome
} from '../../../../ai-gateway/groupFloors'

/** 「不设法官」/「各用各的」在 Select 里的哨兵值（Radix 不接受空串作为 item value）。 */
const NONE = '__none__'

/** 近期唤醒表的行数（用量节，design Q10）。 */
const RECENT_TURNS = 30

/** 五个数值项：配置键 + 出厂默认（默认值只从 groupFloors 读，本文件零裸数字）。
 *  `sessionTurnCap` 的出厂默认是「不限」（null）—— 没有可显示的默认值，占位留空。 */
const NUMERIC_FIELDS = [
  { key: 'chainCap', fallback: CHAIN_CAP_DEFAULT, step: 1 },
  { key: 'hourlyTurns', fallback: HOURLY_TURNS_DEFAULT, step: 1 },
  { key: 'hourlyTokens', fallback: HOURLY_TOKENS_DEFAULT, step: 1000 },
  { key: 'hourlyUsd', fallback: HOURLY_USD_DEFAULT, step: 0.5 },
  { key: 'sessionTurnCap', fallback: null, step: 1 }
] as const

/** 狼人杀预设下这五项的缺省换一套（调度器按 preset 取同一批常量；数值不落库，所以留空的
 *  输入框要显示的是**它实际会用的**那个数，而不是出厂默认）。 */
const WEREWOLF_FALLBACKS: Record<NumericKey, number | null> = {
  chainCap: WEREWOLF_CHAIN_CAP,
  hourlyTurns: WEREWOLF_HOURLY_TURNS,
  hourlyTokens: WEREWOLF_HOURLY_TOKENS,
  hourlyUsd: WEREWOLF_HOURLY_USD,
  sessionTurnCap: WEREWOLF_SESSION_TURN_CAP
}

type NumericKey = (typeof NUMERIC_FIELDS)[number]['key']

function fallbackOf(config: GroupConfig, field: (typeof NUMERIC_FIELDS)[number]): number | null {
  return config.preset === 'werewolf' ? WEREWOLF_FALLBACKS[field.key] : field.fallback
}

/** turn outcome → 色点 token（design §4.5：发言 ok / 沉默 norm / 重复 low / 跳过 low /
 *  失败 fail / 停止 warn）。 */
const OUTCOME_TONE: Record<GroupTurnOutcome, string> = {
  spoke: 'bg-ok',
  silent: 'bg-norm',
  held_dup: 'bg-low',
  skipped: 'bg-low',
  failed: 'bg-fail',
  stopped: 'bg-warn'
}

/** 单个数值键的 patch（不用计算属性字面量：那样得到的是 `{[x: string]: …}`，和 GroupConfigPatch
 *  的具名可选键对不上，只能靠 `as` 掩过去）。 */
function numericPatch(key: NumericKey, value: number | null): GroupConfigPatch {
  const patch: GroupConfigPatch = {}
  patch[key] = value
  return patch
}

/** 服务端 4xx 的 `hint` 是给人看的那句（`message` 是英文机器描述）。 */
function hintOf(err: unknown): string {
  const hint = (err as { hint?: unknown })?.hint
  return typeof hint === 'string' && hint.length > 0 ? hint : errorMessage(err)
}

/** 清空历史 = 从第一条起删（复用行内编辑重跑那条既有端点；成员 / 设置 / 唤醒台账都不动）。
 *  不放 groupSettings.ts：那面是「群配置」的客户端，这一条打的是会话消息面。 */
async function deleteMessagesFrom(sessionId: number, fromMessageId: number): Promise<void> {
  await request(
    resolveApiBaseUrl(),
    'DELETE',
    `/chat/sessions/${sessionId}/messages/from/${fromMessageId}`
  )
}

type ConfirmKind =
  | { kind: 'delete' }
  | { kind: 'clear' }
  | { kind: 'removeMember'; agentId: string }

export function GroupDetailsPane({
  sessionId,
  session,
  memberIds,
  familySessionIds,
  memberMeta,
  candidates,
  labsOn,
  onClose,
  onRenamed,
  onDeleted,
  onMembersChanged
}: {
  sessionId: number
  session: ChatSession
  /** members_json 序（= 无 @ 时的回复序）。服务端读回 `members` 后以后者为准。 */
  memberIds: string[]
  /** 本群 + 父群 + 子群（自己在首位）。狼人杀预设下用量按这组合计。 */
  familySessionIds: readonly number[]
  memberMeta: Map<string, GroupMemberMeta>
  /** 可入群的成员（主 Agent + 团队页 chat-capable），加人清单从这里减去已在群的。 */
  candidates: GroupCandidate[]
  labsOn: boolean
  onClose: () => void
  onRenamed: () => void
  onDeleted: () => void
  onMembersChanged: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const mailApi = useMailApi()
  const [confirm, setConfirm] = useState<ConfirmKind | null>(null)

  const configQ = useQuery({
    queryKey: qk.chat.groupConfig(sessionId),
    queryFn: () => getGroupConfig(sessionId),
    retry: false
  })
  const metricsQ = useQuery({
    queryKey: qk.chat.groupMetrics(sessionId),
    queryFn: () => getGroupMetrics(sessionId),
    enabled: labsOn,
    retry: false
  })
  // 🔴 key 尾段 'recent'：对话流那份 groupTurns 查的是「覆盖到最早一条消息」的窗口（limit 200 +
  // since），这里只要最近 30 行。同 key 两个不同窗口会互相覆写缓存，分成两份反而是省事的写法。
  const turnsQ = useQuery({
    queryKey: [...qk.chat.groupTurns(sessionId), 'recent'] as const,
    queryFn: () => getGroupTurns(sessionId, { limit: RECENT_TURNS }),
    enabled: labsOn,
    retry: false
  })
  const messagesQ = useQuery({
    queryKey: qk.chat.messages(sessionId),
    queryFn: () => mailApi.chat.listMessages(sessionId),
    staleTime: 5_000
  })
  const { models } = useEnabledModels()

  const config: GroupConfig = configQ.data?.config ?? { v: 1 }
  const modes = configQ.data?.modes ?? {}
  // 服务端读回的名单是权威（加 / 踢之后 members_json 才变）；读不到就用父组件传的那份兜底。
  const ids = configQ.data?.members ?? memberIds
  const titleOf = (id: string): string => memberMeta.get(id)?.title?.trim() || id
  const modelOf = (id: string): string | null =>
    candidates.find((c) => c.id === id)?.model?.trim() || null

  const setConfigM = useMutation({
    mutationFn: (patch: GroupConfigPatch) => setGroupConfig(sessionId, patch),
    onSuccess: (payload) => qc.setQueryData(qk.chat.groupConfig(sessionId), payload),
    onError: (err) => toastError(t('groupChat.details.saveFailed', { error: hintOf(err) }))
  })
  const membersM = useMutation({
    mutationFn: (patch: GroupMembersPatch) => patchGroupMembers(sessionId, patch),
    onSuccess: (payload) => {
      qc.setQueryData(qk.chat.groupConfig(sessionId), payload)
      onMembersChanged()
    },
    onError: (err) => toastError(t('groupChat.details.saveFailed', { error: hintOf(err) }))
  })
  const clearM = useMutation({
    mutationFn: (firstId: number) => deleteMessagesFrom(sessionId, firstId),
    onSuccess: () => {
      toastSuccess(t('groupChat.clearHistoryDone'))
      void qc.invalidateQueries({ queryKey: qk.chat.messages(sessionId) })
    },
    onError: (err) => toastError(t('groupChat.details.saveFailed', { error: hintOf(err) }))
  })
  const deleteM = useMutation({
    mutationFn: () => mailApi.chat.deleteSession(sessionId),
    onSuccess: onDeleted,
    onError: (err) => toastError(t('groupChat.deleteFailed', { error: errorMessage(err) }))
  })

  const groupTitle = session.title ?? t('groupChat.defaultTitle')
  const firstMessageId = messagesQ.data?.[0]?.id ?? null
  const addable = candidates.filter((c) => !ids.includes(c.id))
  const full = ids.length >= MAX_GROUP_MEMBERS
  // 🔴 狼人杀预设的主持人恒是模板「法官」行：开局口令 `@法官 开始游戏` 逐字依赖它的 title，
  // 模板 duty 也与主 agent 的 standing context 冲突 —— 主 Agent 顶不了这个位，故不进候选。
  // 其余群里主 Agent 可以当主持人（judgeAgentId 只做字符串比较，与是不是 report_agent 行无关）。
  const judgeCandidates =
    config.preset === 'werewolf' ? ids.filter((id) => id !== MAIN_AGENT_MEMBER_ID) : ids

  return (
    <div className="flex h-full min-h-0 w-full flex-col" data-group-details={sessionId}>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-ink-border px-3">
        <span className="min-w-0 flex-1 truncate text-body font-semibold text-ink-fg">
          {t('groupChat.details.title')}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('groupChat.details.close')}
          className="grid size-7 shrink-0 place-items-center rounded-md text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
        >
          <X size={15} strokeWidth={2} />
        </button>
      </div>

      {configQ.isError ? (
        <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-meta text-ink-fg-3">
          <span>{t('groupChat.details.loadFailed')}</span>
          <Button variant="ghost" onClick={() => void configQ.refetch()}>
            {t('groupChat.details.retryLoad')}
          </Button>
        </div>
      ) : (
        <div className="scrollbar-thin flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-3">
          {/* ── 基本 ───────────────────────────────────────────────────────── */}
          <section className="flex flex-col gap-2">
            <SectionTitle>{t('groupChat.details.basic')}</SectionTitle>
            <NameField
              title={groupTitle}
              label={t('groupChat.details.name')}
              onCommit={(next) => {
                void mailApi.chat
                  .updateSessionTitle(sessionId, next)
                  .then(onRenamed)
                  .catch((err: unknown) =>
                    toastError(t('groupChat.renameFailed', { error: errorMessage(err) }))
                  )
              }}
            />
            <TopicField
              topic={config.topic ?? ''}
              label={t('groupChat.details.topic')}
              placeholder={t('groupChat.dialogTopicPlaceholder')}
              onCommit={(next) => setConfigM.mutate({ topic: next.length > 0 ? next : null })}
            />
            <span className="text-micro leading-relaxed text-ink-fg-3">
              {t('groupChat.details.topicHelper')}
            </span>
          </section>

          {/* ── 成员 ───────────────────────────────────────────────────────── */}
          <section className="flex flex-col gap-2">
            <SectionTitle>{t('groupChat.details.members')}</SectionTitle>
            {ids.map((id) => (
              <div key={id} className="group/member flex items-center gap-2" data-member-row={id}>
                <AgentAvatar
                  agentId={id}
                  config={memberMeta.get(id)?.avatar}
                  size={24}
                  title={titleOf(id)}
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-body text-ink-fg">{titleOf(id)}</span>
                  <span className="truncate font-mono text-micro text-ink-fg-3">
                    {config.modelOverride != null && config.modelOverride.length > 0
                      ? `${stripProviderPrefix(config.modelOverride)} · ${t('groupChat.details.modelOverridden')}`
                      : (modelOf(id) ?? '—')}
                  </span>
                </span>
                {labsOn && (
                  // 🔴 fluid 只给每段 flex-1，不撑容器：窄标签下必须在调用处补 w-full。
                  <SegmentedControl<GroupResponseMode>
                    value={modes[id] ?? 'mention'}
                    onChange={(next) => setConfigM.mutate({ modes: { [id]: next } })}
                    options={[
                      { value: 'realtime', label: t('groupChat.details.modeRealtime') },
                      { value: 'mention', label: t('groupChat.details.modeMention') }
                    ]}
                    ariaLabel={t('groupChat.details.modeAria', { name: titleOf(id) })}
                    fluid
                    className="flex w-[7.5rem] shrink-0"
                  />
                )}
                <button
                  type="button"
                  data-remove-member={id}
                  onClick={() => setConfirm({ kind: 'removeMember', agentId: id })}
                  aria-label={t('groupChat.details.removeMember')}
                  className="grid size-6 shrink-0 place-items-center rounded text-ink-fg-3 opacity-0 transition-opacity duration-fast hover:bg-ink-4 hover:text-fail group-hover/member:opacity-100 focus-visible:opacity-100"
                >
                  <X size={13} strokeWidth={2} />
                </button>
              </div>
            ))}
            <AddMemberButton
              addable={addable}
              full={full}
              memberMeta={memberMeta}
              onAdd={(id) => membersM.mutate({ add: [id] })}
            />
            {labsOn && (
              <>
                <span className="text-micro leading-relaxed text-ink-fg-3">
                  {t('groupChat.details.modesHelper')}
                </span>
                <div className="flex flex-col gap-1.5 pt-1">
                  <span className="text-aux text-ink-fg-1">{t('groupChat.details.judge')}</span>
                  <Select
                    value={config.judgeAgentId ?? NONE}
                    onValueChange={(next) =>
                      setConfigM.mutate({ judgeAgentId: next === NONE ? null : next })
                    }
                  >
                    <SelectTrigger aria-label={t('groupChat.details.judge')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="z-[70]">
                      <SelectItem value={NONE}>{t('groupChat.details.judgeNone')}</SelectItem>
                      {judgeCandidates.map((id) => (
                        <SelectItem key={id} value={id}>
                          {titleOf(id)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="text-micro leading-relaxed text-ink-fg-3">
                    {t('groupChat.details.judgeHelper')}
                  </span>
                  {configQ.data?.judgeScopeStale === true && (
                    <div className="flex items-center gap-1.5">
                      <AlertTriangle size={13} strokeWidth={2} className="shrink-0 text-warn" />
                      <span className="min-w-0 flex-1 text-micro text-warn">
                        {t('groupChat.details.judgeStale')}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setConfigM.mutate({ judgeAgentId: config.judgeAgentId ?? null })
                        }
                        className="shrink-0 text-micro text-aux underline-offset-2 hover:underline"
                      >
                        {t('groupChat.details.judgeReconfirm')}
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
            {!labsOn && (
              <span className="text-micro leading-relaxed text-ink-fg-3">
                {t('groupChat.details.labsOffNote')}
              </span>
            )}
          </section>

          {/* ── 上限与预算（labs on 才生效，off 不渲染）─────────────────────── */}
          {labsOn && (
            <section className="flex flex-col gap-2">
              <SectionTitle>{t('groupChat.details.limits')}</SectionTitle>
              {NUMERIC_FIELDS.map((field) => (
                <NumericField
                  key={field.key}
                  label={t(`groupChat.details.${field.key}`)}
                  fieldKey={field.key}
                  step={field.step}
                  fallback={fallbackOf(config, field)}
                  value={config[field.key]}
                  resetLabel={t('groupChat.details.resetDefaults')}
                  onCommit={(next) => setConfigM.mutate(numericPatch(field.key, next))}
                />
              ))}
              <span className="text-micro leading-relaxed text-ink-fg-3">
                {t('groupChat.details.defaultHint')}
              </span>
              <div className="flex flex-col gap-1.5 pt-1">
                <span className="text-aux text-ink-fg-1">
                  {t('groupChat.details.modelOverride')}
                </span>
                <Select
                  value={config.modelOverride || NONE}
                  onValueChange={(next) =>
                    setConfigM.mutate({ modelOverride: next === NONE ? null : next })
                  }
                >
                  <SelectTrigger aria-label={t('groupChat.details.modelOverride')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="z-[70]">
                    <SelectItem value={NONE}>{t('groupChat.details.modelPerMember')}</SelectItem>
                    <ModelSelectItems models={models} current={config.modelOverride ?? null} />
                  </SelectContent>
                </Select>
                <span className="text-micro leading-relaxed text-ink-fg-3">
                  {t('groupChat.details.modelOverrideHelper')}
                </span>
              </div>
              <label className="flex items-center gap-2.5 pt-1">
                <span className="min-w-0 flex-1 text-body text-ink-fg">
                  {t('groupChat.details.notify')}
                </span>
                <Switch
                  checked={config.notify !== false}
                  aria-label={t('groupChat.details.notify')}
                  onCheckedChange={(next) => setConfigM.mutate({ notify: next })}
                />
              </label>
              <span className="text-micro leading-relaxed text-ink-fg-3">
                {t('groupChat.details.notifyHelper')}
              </span>
            </section>
          )}

          {/* ── 用量（labs on）───────────────────────────────────────────── */}
          {labsOn && (
            <UsageSection
              config={config}
              metrics={metricsQ.data}
              turns={turnsQ.data?.turns ?? []}
              titleOf={titleOf}
              familySessionIds={familySessionIds}
            />
          )}

          {/* ── 危险区 ─────────────────────────────────────────────────────── */}
          <section className="flex flex-col gap-2">
            <SectionTitle>{t('groupChat.details.danger')}</SectionTitle>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={firstMessageId == null || clearM.isPending}
                onClick={() => setConfirm({ kind: 'clear' })}
                className={cn(
                  'h-8 flex-1 rounded-lg border border-fail/30 text-aux text-fail',
                  'transition-colors duration-fast hover:bg-fail/10 disabled:cursor-not-allowed disabled:opacity-40'
                )}
              >
                {t('groupChat.details.clearHistory')}
              </button>
              <button
                type="button"
                disabled={deleteM.isPending}
                onClick={() => setConfirm({ kind: 'delete' })}
                className={cn(
                  'h-8 flex-1 rounded-lg border border-fail/30 text-aux text-fail',
                  'transition-colors duration-fast hover:bg-fail/10 disabled:cursor-not-allowed disabled:opacity-40'
                )}
              >
                {t('groupChat.details.deleteGroup')}
              </button>
            </div>
          </section>
        </div>
      )}

      {/* 三处破坏性动作共用一个二次确认（移出成员 / 清空历史 / 删除群）。 */}
      <Dialog open={confirm != null} onOpenChange={(open) => !open && setConfirm(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {confirm?.kind === 'delete'
                ? t('groupChat.deleteConfirmTitle')
                : confirm?.kind === 'clear'
                  ? t('groupChat.clearHistoryTitle')
                  : t('groupChat.details.removeMember')}
            </DialogTitle>
          </DialogHeader>
          <p className="text-meta leading-relaxed text-ink-fg-1">
            {confirm?.kind === 'delete'
              ? t('groupChat.deleteConfirmBody', { title: groupTitle })
              : confirm?.kind === 'clear'
                ? t('groupChat.clearHistoryBody')
                : confirm != null
                  ? t('groupChat.details.removeConfirm', { name: titleOf(confirm.agentId) })
                  : ''}
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              {t('groupChat.details.cancel')}
            </Button>
            <Button
              data-confirm-action={confirm?.kind}
              onClick={() => {
                const pending = confirm
                setConfirm(null)
                if (pending == null) return
                if (pending.kind === 'delete') deleteM.mutate()
                else if (pending.kind === 'clear') {
                  if (firstMessageId != null) clearM.mutate(firstMessageId)
                } else membersM.mutate({ remove: [pending.agentId] })
              }}
            >
              {confirm?.kind === 'clear'
                ? t('groupChat.clearHistoryConfirm')
                : confirm?.kind === 'removeMember'
                  ? t('groupChat.details.removeMember')
                  : t('groupChat.deleteConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }): React.ReactElement {
  return <span className="text-aux font-medium text-ink-fg-1">{children}</span>
}

/** 名称：blur 即写（空值回退原名，不允许把群名清空）。 */
function NameField({
  title,
  label,
  onCommit
}: {
  title: string
  label: string
  onCommit: (next: string) => void
}): React.ReactElement {
  const [draft, setDraft] = useState(title)
  const [seen, setSeen] = useState(title)
  if (title !== seen) {
    setSeen(title)
    setDraft(title)
  }
  return (
    <label className="flex flex-col gap-1">
      <span className="text-micro text-ink-fg-3">{label}</span>
      <Input
        value={draft}
        aria-label={label}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const next = draft.trim()
          if (next.length === 0) setDraft(title)
          else if (next !== title) onCommit(next)
        }}
      />
    </label>
  )
}

/** 用途：blur 即写；清空 = PUT `{topic: null}` 删键。**不设 maxLength** —— 长度上限的单源在
 *  serve-api（超限读 400 的 hint），renderer 再抄一份就是第二处无闸镜像。 */
function TopicField({
  topic,
  label,
  placeholder,
  onCommit
}: {
  topic: string
  label: string
  placeholder: string
  onCommit: (next: string) => void
}): React.ReactElement {
  const [draft, setDraft] = useState(topic)
  const [seen, setSeen] = useState(topic)
  if (topic !== seen) {
    setSeen(topic)
    setDraft(topic)
  }
  return (
    <label className="flex flex-col gap-1">
      <span className="text-micro text-ink-fg-3">{label}</span>
      <Input
        value={draft}
        aria-label={label}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const next = draft.trim()
          if (next !== topic) onCommit(next)
        }}
      />
    </label>
  )
}

/** 一个数值项：blur 即写；有显式值时右侧出「恢复默认」（PUT null 删键）。 */
function NumericField({
  label,
  fieldKey,
  step,
  fallback,
  value,
  resetLabel,
  onCommit
}: {
  label: string
  fieldKey: NumericKey
  step: number
  fallback: number | null
  value: number | null | undefined
  resetLabel: string
  onCommit: (next: number | null) => void
}): React.ReactElement {
  const stored = typeof value === 'number' ? String(value) : ''
  const [draft, setDraft] = useState(stored)
  const [seen, setSeen] = useState(stored)
  if (stored !== seen) {
    setSeen(stored)
    setDraft(stored)
  }
  return (
    <div className="flex items-center gap-1.5">
      <span className="min-w-0 flex-1 text-body text-ink-fg">{label}</span>
      {typeof value === 'number' && (
        <button
          type="button"
          data-reset={fieldKey}
          aria-label={resetLabel}
          title={resetLabel}
          onClick={() => onCommit(null)}
          className="grid size-6 shrink-0 place-items-center rounded text-ink-fg-3 transition-colors duration-fast hover:bg-ink-4 hover:text-ink-fg"
        >
          <RotateCcw size={13} strokeWidth={2} />
        </button>
      )}
      <Input
        type="number"
        inputMode="decimal"
        step={step}
        value={draft}
        aria-label={label}
        placeholder={fallback == null ? '' : String(fallback)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const text = draft.trim()
          // 留空 = 未配置：清空不写（要清回默认走「恢复默认」，那才是显式删键）。
          if (text.length === 0) return
          const next = Number(text)
          if (!Number.isFinite(next) || next === value) return
          onCommit(next)
        }}
        className="w-24 shrink-0"
      />
    </div>
  )
}

/** 加人：Popover 里列「还没在群里」的候选；满员时钮禁用并说明上限。 */
function AddMemberButton({
  addable,
  full,
  memberMeta,
  onAdd
}: {
  addable: GroupCandidate[]
  full: boolean
  memberMeta: Map<string, GroupMemberMeta>
  onAdd: (agentId: string) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={full || addable.length === 0}
            className={cn(
              'flex h-8 items-center gap-1.5 self-start rounded-lg border border-ink-border-soft bg-ink-2 px-2.5',
              'text-aux text-ink-fg transition-colors duration-fast hover:bg-ink-3',
              'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-ink-2'
            )}
          >
            <Plus size={14} strokeWidth={2} className="shrink-0 text-coral" />
            {t('groupChat.details.addMember')}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-56 p-1">
          {addable.map((c) => (
            <button
              key={c.id}
              type="button"
              data-add-member={c.id}
              onClick={() => {
                setOpen(false)
                onAdd(c.id)
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-aux text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3"
            >
              <AgentAvatar
                agentId={c.id}
                config={memberMeta.get(c.id)?.avatar ?? c.avatar}
                size={20}
                title={c.title}
              />
              <span className="min-w-0 flex-1 truncate">{c.title}</span>
            </button>
          ))}
        </PopoverContent>
      </Popover>
      {full && (
        <span className="text-micro text-ink-fg-3">
          {t('groupChat.details.membersFull', { max: MAX_GROUP_MEMBERS })}
        </span>
      )}
    </div>
  )
}

/** 用量：两指标 + 1h（带进度条）/ 24h 两行 + 上次停止 + 近期唤醒表；
 *  狼人杀预设另加一行「本局合计（含子群）」。 */
function UsageSection({
  config,
  metrics,
  turns,
  titleOf,
  familySessionIds
}: {
  config: GroupConfig
  metrics: GroupMetrics | undefined
  turns: GroupTurnWire[]
  titleOf: (id: string) => string
  familySessionIds: readonly number[]
}): React.ReactElement {
  const { t } = useTranslation()
  const unknown = t('groupChat.metrics.unknown')
  const preset = config.preset === 'werewolf'
  // family 合计：三个群各查一次再相加（**相加不是平均** —— 跨群平均没有意义，g1 已登记）。
  // 🔴 cost 只要有一个群未知就整体未知：把未知当 0 会让「花了多少」读成一个偏低的确定数。
  const familyQ = useQueries({
    queries: (preset ? familySessionIds : []).map((id) => ({
      queryKey: qk.chat.groupMetrics(id),
      queryFn: () => getGroupMetrics(id),
      retry: false
    }))
  })
  // useQueries 每次 render 都给新数组，memo 化只会把「已到达的那几份」藏起来，故直接算。
  const familyLoaded = familyQ.flatMap((q) => (q.data != null ? [q.data] : []))
  const familyCosts = familyLoaded.map((m) => m.sessionCostUsd)
  const family =
    familyLoaded.length === 0
      ? null
      : {
          turns: familyLoaded.reduce((sum, m) => sum + (m.sessionTurns ?? 0), 0),
          tokens: familyLoaded.reduce((sum, m) => sum + (m.sessionTokens ?? 0), 0),
          costUsd: familyCosts.every((c) => typeof c === 'number')
            ? (familyCosts as number[]).reduce((sum, c) => sum + c, 0)
            : null
        }
  const pct = (value: number | null | undefined): string =>
    typeof value === 'number' ? `${(value * 100).toFixed(1)}%` : unknown
  const ratio = (value: number | null | undefined): string =>
    typeof value === 'number' ? value.toFixed(1) : unknown
  const windowText = (w: GroupMetricsWindow | undefined): string =>
    t('groupChat.metrics.window', {
      turns: w?.turns ?? 0,
      tokens: w?.tokens ?? 0,
      cost: typeof w?.costUsd === 'number' ? `$${w.costUsd.toFixed(2)}` : unknown
    })
  const caps = useMemo(
    () => ({
      turns: config.hourlyTurns ?? HOURLY_TURNS_DEFAULT,
      tokens: config.hourlyTokens ?? HOURLY_TOKENS_DEFAULT,
      usd: config.hourlyUsd ?? HOURLY_USD_DEFAULT
    }),
    [config.hourlyTurns, config.hourlyTokens, config.hourlyUsd]
  )

  return (
    <section className="flex flex-col gap-2">
      <SectionTitle>{t('groupChat.details.usage')}</SectionTitle>
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
          <span className="font-mono">{windowText(metrics?.last1h)}</span>
        </div>
        {/* 小时地板的三条进度条（cap = 配置值 ?? 出厂默认）。24h 窗口没有对应地板，只报数字。
            cost 整窗未知（NULL ≠ 0）→ 那条不画：画一条 0% 的条等于宣称「这小时没花钱」。 */}
        <UsageBar name="turns" used={metrics?.last1h.turns ?? 0} cap={caps.turns} />
        <UsageBar name="tokens" used={metrics?.last1h.tokens ?? 0} cap={caps.tokens} />
        {typeof metrics?.last1h.costUsd === 'number' && (
          <UsageBar name="cost" used={metrics.last1h.costUsd} cap={caps.usd} />
        )}
        <div className="flex items-center justify-between gap-2">
          <span>{t('groupChat.details.last24h')}</span>
          <span className="font-mono">{windowText(metrics?.last24h)}</span>
        </div>
        {preset && family != null && (
          <div className="flex items-center justify-between gap-2" data-family-usage>
            <span>{t('groupChat.details.familyUsage')}</span>
            <span className="font-mono">
              {t('groupChat.details.familyCap', {
                used: family.turns,
                cap: WEREWOLF_SESSION_TURN_CAP
              })}
              {' · '}
              {family.costUsd != null
                ? t('groupChat.details.familyCap', {
                    used: `$${family.costUsd.toFixed(2)}`,
                    cap: `$${WEREWOLF_HOURLY_USD}`
                  })
                : unknown}
            </span>
          </div>
        )}
        {metrics?.lastStopReason != null && (
          <div className="text-micro text-ink-fg-3">
            {t('groupChat.details.lastStop', {
              reason: t(`groupChat.stopped.${metrics.lastStopReason}`, {
                defaultValue: metrics.lastStopReason
              })
            })}
          </div>
        )}
      </div>

      <span className="text-micro text-ink-fg-3">{t('groupChat.details.recentTurns')}</span>
      {turns.length === 0 ? (
        <span className="text-micro text-ink-fg-3">{t('groupChat.details.turnsEmpty')}</span>
      ) : (
        <div className="flex flex-col gap-0.5">
          {turns.map((turn) => (
            <div
              key={turn.id}
              data-turn-row={turn.id}
              className="flex items-center gap-2 text-micro text-ink-fg-3"
            >
              <span
                data-outcome={turn.outcome}
                className={cn('size-1.5 shrink-0 rounded-full', OUTCOME_TONE[turn.outcome])}
              />
              <span className="min-w-0 flex-1 truncate text-ink-fg-1">{titleOf(turn.agentId)}</span>
              <span className="shrink-0">{t(`groupChat.outcome.${turn.outcome}`)}</span>
              <span className="shrink-0 font-mono tabular-nums">
                {(turn.tokensInput ?? 0) + (turn.tokensOutput ?? 0)}
              </span>
              <span className="shrink-0 font-mono tabular-nums">
                {typeof turn.costUsd === 'number' ? `$${turn.costUsd.toFixed(2)}` : unknown}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/** 一条用量进度条（≥80% 警色、≥100% 失败色）。`name` 只作探针属性，不出文案。 */
function UsageBar({
  name,
  used,
  cap
}: {
  name: string
  used: number
  cap: number
}): React.ReactElement {
  const { t } = useTranslation()
  const filled = cap > 0 ? Math.min(100, (used / cap) * 100) : 0
  return (
    <div className="flex items-center gap-2">
      <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-ink-4">
        <div
          data-usage-bar={name}
          style={{ width: `${filled}%` }}
          className={cn(
            'h-full rounded-full',
            filled >= 100 ? 'bg-fail' : filled >= 80 ? 'bg-warn' : 'bg-ai'
          )}
        />
      </div>
      <span className="shrink-0 font-mono text-micro tabular-nums text-ink-fg-3">
        {t('groupChat.details.capUsed', { used, cap })}
      </span>
    </div>
  )
}
