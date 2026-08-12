// 0812 dogfood —— 事项对话收口进主 AI Chat 后，「事项特有的那部分」收在这里。
//
// 设计稿 `matters/chat.jsx` 开头逐字写着：*Matter Chat — the SAME shell as the global AI panel.
// Only three things change: the context chips are the matter, the quick actions are matter actions,
// and the empty state names the matter. **No second chat UI.*** 实现侧曾另起 MatterChatPanel，本
// 模块就是把那三件事搬回主 chat 的适配层 —— 它**不渲染 thread、不建 runtime**，只产出
// AgentConversation 要挂上去的几个槽位 + 锚点/快照/写入回执 surface。
//
// 保住的能力（删 MatterChatPanel 时逐个搬过来的，少一个都算功能倒退）：
//   · 可移除的事项 context chip（+ 移除后不再自动重新 seed，与邮件 chip 同款 ref 记忆）
//   · 检索范围分段控件 + G5「审计先行」链（ensureSession → recordChatScope → 本地翻档）
//   · 上下文缺口卡（MatterContextGapCard）与「授权扩检索」
//   · 事项快捷 prompt（设计稿：位置与全局面板的快捷动作一致 —— 换一组，不是删掉）
//   · MatterChatSurface（写入回执 + 撤销）—— 没有它，matter 写入卡会 fall through 成通用工具卡
//
// 🔴 锚点二源：`sessionMatter`（会话行自己的 anchor，从历史里选中时的真相）优先于 `seed`
// （dock 唤出时带的那件事）。两者都没有 = 这就是一场普通对话。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ClipboardList, Globe, Shield } from 'lucide-react'

import type {
  AgentContextSnapshot,
  CapabilityContext,
  ContextScope
} from '@shared/assistant/context/contextSnapshot'
import { ConversationContextChip } from '@shared/components/agents/ConversationContextChip'
import { SegmentedControl } from '@shared/components/ui/segmented'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import type { MatterChatTarget } from '@shared/state/ai-chat-panel'
import { toastError } from '@shared/state/toast'

import { useMatterChatApi, useMattersApi } from './hooks'
import { MatterContextGapCard } from './MatterContextGapCard'
import { MatterQuickPrompts } from './MatterQuickPrompts'
import type { MatterChatSurface } from './matterChatContext'
import { useMatterContextSnapshot, type MatterChatScope } from './useMatterContextSnapshot'
import { useMatterUndoRunner } from './useMatterUndoRunner'

/** 会话行 → 事项身份的**三态**。收口前的真 bug：`anchor_type='matter'` 的历史会话在主 chat 里以
 *  `general` 渲染 —— 事项上下文没注入、gateway 的 matterScopeFilter 推不出来、写入回执也没了 surface。
 *
 *  🔴 三态而不是两态，是这条链最要命的一处：`anchor_id` 只是内部 id，而事项的 REST 面全按 MAT-xxxx
 *  寻址，公共编号来自服务端 join 投影（`matter_public_id`）。「拿不到投影」与「这不是事项会话」如果
 *  都表示成同一个 `null`，用户就会在一个看起来完全正常的历史对话里说「更新这件事」，而请求既没有
 *  matter 快照、gateway 的 matterScopeFilter 也是 null ⇒ 模型在全局范围跑，可能命中**错误的事项**。
 *  故 `unresolved` 单独成态：调用方必须把它呈现成「上下文未就绪」并禁发，不许降级成普通会话。 */
export type MatterSessionIdentity =
  /** 这就是一场普通对话（非 matter 锚点）。 */
  | { state: 'none' }
  /** 是事项对话，但公共编号没拿到（服务端 join 失败 / 旧 serve-api 不投影）。 */
  | { state: 'unresolved'; anchorId: number }
  | { state: 'resolved'; target: MatterChatTarget }

export interface MatterAnchoredSessionRow {
  anchor_type?: string | null
  anchor_id?: number | null
  matter_public_id?: string | null
  matter_title?: string | null
}

export function matterIdentityFromSession(
  session: MatterAnchoredSessionRow | null
): MatterSessionIdentity {
  if (!session || session.anchor_type !== 'matter') return { state: 'none' }
  const id = session.anchor_id
  // anchor_type 说了是事项会话，连内部 id 都没有 = 这行本身坏了；同样不许当普通会话糊过去。
  if (typeof id !== 'number') return { state: 'unresolved', anchorId: -1 }
  const publicId = session.matter_public_id
  if (typeof publicId !== 'string' || publicId.length === 0) {
    return { state: 'unresolved', anchorId: id }
  }
  return { state: 'resolved', target: { id, publicId, title: session.matter_title ?? '' } }
}

/** 只要「认得出来的那一件事」；`unresolved` 与 `none` 都给 null —— 调用方**必须**另外读
 *  `matterIdentityFromSession` 才能把两者分开（见上面的红字）。 */
export function matterTargetFromSession(
  session: MatterAnchoredSessionRow | null
): MatterChatTarget | null {
  const identity = matterIdentityFromSession(session)
  return identity.state === 'resolved' ? identity.target : null
}

export interface UseMatterConversationInput {
  /** dock 唤出时带的事项（openMatterChat）—— 空会话上作为默认 chip 提供，可移除。 */
  seed: MatterChatTarget | null
  /** 当前会话行自己的事项身份（anchor_type='matter' 的历史会话）。 */
  sessionMatter: MatterChatTarget | null
  /** 🔴 会话**是**事项对话、但公共编号没拿到（`matterIdentityFromSession` 的 `unresolved`）。
   *  true 时整个绑定退成惰性：不采纳 dock 带的种子（那会把这场对话悄悄绑到**另一件**事上）、
   *  不出 chip / 控件 / 快捷 prompt / 写入回执 surface。调用方负责摆出「上下文未就绪」并禁发。 */
  sessionMatterUnresolved?: boolean
  /** 这场对话还是空的（seed 只在空会话上采纳，与邮件 chip 同门）。 */
  chatIsEmpty: boolean
  /** 线程重置 epoch —— 换会话 / 新会话时复位检索范围与撤销回执。 */
  navEpoch: number
  /** 当前会话 id（进快照的 scope；新对话为 null）。 */
  sessionId: number | null
  /** 取（必要时建）当前会话 id —— 范围切换的审计记录必须带 session_id。 */
  ensureSession: () => Promise<number>
  /** false → 不查快照（gateway 不可用 / 只读历史）。 */
  enabled: boolean
  thinkingEnabled: boolean
}

export interface MatterConversationBinding {
  /** 这场对话锚在哪件事上（会话行真相 ?? 种子 chip）；null = 普通对话。 */
  anchor: MatterChatTarget | null
  /** 喂给 runtime 的事项上下文快照；chip 被移除 / 快照读不到 → null（对话照常）。 */
  snapshot: AgentContextSnapshot | null
  /** 写入回执 + 撤销的 surface；null = 事项写入卡按通用工具卡渲染。 */
  surface: MatterChatSurface | null
  /** composer 上方的可移除 chip。 */
  chip: React.ReactNode
  /** chip 之上的一组事项控件（缺口卡 + 检索范围）。 */
  controls: React.ReactNode
  /** 空态快捷 prompt（换一组，不是删掉 —— 设计稿位置同全局面板）。 */
  quickPrompts: React.ReactNode
}

export function useMatterConversation(
  input: UseMatterConversationInput
): MatterConversationBinding {
  const { sessionMatter, navEpoch, sessionId, ensureSession, enabled, thinkingEnabled } = input
  // 🔴 未就绪时把种子也一并掐掉：否则「A 的会话拿不到编号」会退回去采纳 dock 上一次带的 B，
  // 于是界面显示 B、审计写 B、而这条历史其实锚在 A 上。
  const unresolved = input.sessionMatterUnresolved === true
  const seed = unresolved ? null : input.seed
  const chatIsEmpty = input.chatIsEmpty
  const { t } = useTranslation()
  const chatApi = useMatterChatApi()
  const mattersApi = useMattersApi()
  const queryClient = useQueryClient()

  // ── 可移除的事项 chip（邮件 chip 同款：显式移除后不再自动重新 seed，换一件事则重新提供）──
  const [chipTarget, setChipTarget] = useState<MatterChatTarget | null>(null)
  const removedRef = useRef<number | null>(null)
  const sessionMatterId = sessionMatter?.id ?? null
  const seedId = seed?.id ?? null
  useEffect(() => {
    const next = sessionMatter ?? seed
    if (next === null) {
      // 既没有会话锚点也没有种子 = 这不是事项对话（FAB 唤出 / 选了普通会话）→ 收掉 chip。
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setChipTarget(null)
      return
    }
    // 会话已经开始后不再采纳"种子"（chip 已锁定在这场对话的那件事上）；会话行自己的 anchor 例外。
    if (sessionMatter === null && !chatIsEmpty) return
    if (removedRef.current === next.id) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setChipTarget((cur) => (cur && cur.id === next.id ? cur : next))
    // sessionMatter / seed 的对象身份每次 render 都可能变，按 id 订阅。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionMatterId, seedId, chatIsEmpty])

  const onRemoveChip = useCallback((): void => {
    setChipTarget((cur) => {
      if (cur) removedRef.current = cur.id
      return null
    })
  }, [])

  // 锚点：会话行真相优先。chip 被移除后仍留在一个 matter 会话里 → 锚点不变（行就是这么写的），
  // 只是不再注入上下文 —— 与邮件会话移除 chip 的语义一致。
  const anchor = sessionMatter ?? chipTarget

  // ── 检索范围（D10：每轮新对话默认全库；每次切换仍走 G5 审计先行）──
  const [scope, setScope] = useState<MatterChatScope>('global')
  const [scopeBusy, setScopeBusy] = useState(false)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setScope('global')
  }, [navEpoch])

  const contextScope = useMemo<ContextScope>(
    () => ({
      surface: 'general-agent',
      anchorType: 'matter',
      // gateway 的 matterScopeFilter 要的是**内部** id，不是 MAT-xxxx。
      anchorId: anchor?.id ?? null,
      sessionId,
      backendKind: 'ai-sdk'
    }),
    [anchor?.id, sessionId]
  )
  const capabilities = useMemo<CapabilityContext>(
    () => ({
      thinkingEnabled,
      attachmentsEnabled: false,
      toolCallingEnabled: true,
      humanApprovalRequired: true,
      enabledSkills: []
    }),
    [thinkingEnabled]
  )
  const snapshotEnabled = enabled && chipTarget !== null
  const {
    snapshot,
    chips,
    hasContextGap,
    isError: snapshotFailed
  } = useMatterContextSnapshot({
    publicId: chipTarget?.publicId ?? '',
    scope: contextScope,
    chatScope: scope,
    capabilities,
    enabled: snapshotEnabled
  })

  const contextCount = chips
    ? 1 + chips.openItems + chips.stakeholders + chips.pinnedResources + chips.changes
    : 0

  const discovery = useMutation({
    mutationFn: () =>
      mattersApi.discoverResourceSuggestions(chipTarget?.publicId ?? '', {
        query: chipTarget?.title ?? '',
        expandReason: 'context_gap',
        limit: 10
      }),
    onSuccess: async () => {
      const publicId = chipTarget?.publicId
      if (!publicId) return
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.matters.detail(publicId) }),
        queryClient.invalidateQueries({ queryKey: qk.matters.resources(publicId) }),
        queryClient.invalidateQueries({ queryKey: qk.matters.contextSnapshot(publicId) })
      ])
    },
    onError: (error) => toastError(t('matters.chat.gap.failed'), errorMessage(error))
  })

  // 🔴 异步落地时"当前这条线程是谁"的活体真相。`anchor` / `navEpoch` 都是 props 派生值，
  // await 期间会变；闭包里那份只是**发起时**的快照，不能拿来判"现在还是不是它"。
  const anchorRef = useRef<MatterChatTarget | null>(anchor)
  anchorRef.current = anchor
  const navEpochRef = useRef(navEpoch)
  navEpochRef.current = navEpoch

  // G5: ensureSession → 持久审计 → 本地翻档。失败保留当前范围（审计不成立就不许改行为）。
  const onScopeChange = useCallback(
    (next: MatterChatScope): void => {
      const publicId = anchor?.publicId
      if (!publicId || next === scope || scopeBusy) return
      const epochAtStart = navEpochRef.current
      setScopeBusy(true)
      void (async (): Promise<void> => {
        try {
          const sessionId = await ensureSession()
          // 🔴 建会话是异步的：期间用户可能已经点到**另一件事**（或换了会话）。此时把这次范围
          // 切换记到刚拿到的 session 上，就是"把 B 的检索范围审计写进 A 的会话"。切走了 = 这次
          // 操作作废（下轮重来），绝不落审计、也不翻本地档。
          if (anchorRef.current?.publicId !== publicId || navEpochRef.current !== epochAtStart) {
            return
          }
          await chatApi.recordChatScope(publicId, next, sessionId)
          if (anchorRef.current?.publicId !== publicId || navEpochRef.current !== epochAtStart) {
            return
          }
          setScope(next)
          await queryClient.invalidateQueries({ queryKey: qk.matters.detail(publicId) })
        } catch (error) {
          toastError(t('matters.chat.scope.auditFailed'), errorMessage(error))
        } finally {
          setScopeBusy(false)
        }
      })()
    },
    [anchor?.publicId, chatApi, ensureSession, queryClient, scope, scopeBusy, t]
  )

  // ── 写入回执 + 撤销 ──
  const anchorPublicId = anchor?.publicId ?? null
  const { undoStates, runUndo, resetUndoStates } = useMatterUndoRunner(anchorPublicId ?? '')
  // 🔴 撤销态的身份是 `{sessionId, anchor.publicId}`，不是 navEpoch 一个人。历史查询与
  // selectSession/newSession 未落地时 store 的 seed 已经是 B、而 active session / navEpoch 仍属 A ——
  // 只按 navEpoch 复位，A 的回执会短暂挂到 B 的 surface 上（点下去就是对 B 执行 A 的反向操作）。
  useEffect(() => {
    resetUndoStates()
  }, [navEpoch, sessionId, anchorPublicId, resetUndoStates])
  // 执行前再核一次：卡片持有的是**渲染那一刻**的 surface，事项已经切走就不许再发这条反向请求。
  const guardedRunUndo = useCallback<MatterChatSurface['runUndo']>(
    (toolCallId, descriptor) => {
      if (anchorPublicId === null || anchorRef.current?.publicId !== anchorPublicId) return
      runUndo(toolCallId, descriptor)
    },
    [anchorPublicId, runUndo]
  )
  const surface = useMemo<MatterChatSurface | null>(
    () =>
      anchor === null ? null : { publicId: anchor.publicId, runUndo: guardedRunUndo, undoStates },
    [anchor, guardedRunUndo, undoStates]
  )

  const chip = chipTarget ? (
    <ConversationContextChip
      icon={<ClipboardList size={12} strokeWidth={2} className="shrink-0 text-coral" />}
      label={`${chipTarget.publicId} ${chipTarget.title}`}
      removeLabel={t('matters.chat.removeContext')}
      onRemove={onRemoveChip}
    />
  ) : null

  const controls = chipTarget ? (
    <div data-testid="matter-chat-controls" className="flex flex-col gap-2">
      {snapshotFailed ? (
        <p className="text-meta text-ink-fg-3">{t('matters.chat.chips.unavailable')}</p>
      ) : null}
      {hasContextGap ? (
        <MatterContextGapCard
          disabled={discovery.isPending}
          onExpand={() => discovery.mutate()}
          suggestedCount={discovery.data?.items.length ?? null}
          suppressedCount={discovery.data?.suppressed.length ?? 0}
        />
      ) : null}
      <div className="flex items-center gap-2">
        {scope === 'matter' ? (
          <Shield size={12} className="shrink-0 text-ok" />
        ) : (
          <Globe size={12} className="shrink-0 text-warn" />
        )}
        <span className="min-w-0 flex-1 truncate text-meta text-ink-fg-2">
          {t(
            scope === 'matter' ? 'matters.chat.scope.matterNote' : 'matters.chat.scope.globalNote'
          )}
        </span>
        <SegmentedControl<MatterChatScope>
          value={scope}
          onChange={onScopeChange}
          options={[
            { value: 'matter', label: t('matters.chat.scope.matter') },
            { value: 'global', label: t('matters.chat.scope.global') }
          ]}
          ariaLabel={t('matters.chat.scope.label')}
        />
      </div>
    </div>
  ) : null

  const quickPrompts = anchor ? <MatterQuickPrompts contextCount={contextCount} /> : null

  // 🔴 未就绪 = 整个绑定惰性。半个事项 UI（chip 在、编号不在）比没有更危险：它会让用户以为
  // 上下文已经就位。调用方另外摆「上下文未就绪」并禁发（见 AgentConversation）。
  if (unresolved) {
    return {
      anchor: null,
      snapshot: null,
      surface: null,
      chip: null,
      controls: null,
      quickPrompts: null
    }
  }
  return { anchor, snapshot, surface, chip, controls, quickPrompts }
}
