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
//   · 上下文缺口卡（MatterContextGapCard）与「授权扩检索」
//   · 事项快捷 prompt（设计稿：位置与全局面板的快捷动作一致 —— 换一组，不是删掉）
//   · MatterChatSurface（写入回执 + 撤销）—— 没有它，matter 写入卡会 fall through 成通用工具卡
//
// 🔴 锚点二源：`sessionMatter`（会话行自己的 anchor，从历史里选中时的真相）优先于 `seed`
// （dock 唤出时带的那件事）。两者都没有 = 这就是一场普通对话。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ClipboardList } from 'lucide-react'

import type {
  AgentContextSnapshot,
  CapabilityContext,
  ContextScope
} from '@shared/assistant/context/contextSnapshot'
import { ConversationContextChip } from '@shared/components/agents/ConversationContextChip'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import type { MatterChatTarget } from '@shared/state/ai-chat-panel'
import { toastError } from '@shared/state/toast'

import { useMattersApi } from './hooks'
import { MatterContextGapCard } from './MatterContextGapCard'
import { MatterQuickPrompts } from './MatterQuickPrompts'
import type { MatterChatSurface } from './matterChatContext'
import { useMatterContextSnapshot } from './useMatterContextSnapshot'
import { useMatterUndoRunner } from './useMatterUndoRunner'

/** 会话行 → 事项身份的**三态**。收口前的真 bug：`anchor_type='matter'` 的历史会话在主 chat 里以
 *  `general` 渲染 —— 事项上下文没注入、写入回执也没了 surface。
 *
 *  🔴 三态而不是两态，是这条链最要命的一处：`anchor_id` 只是内部 id，而事项的 REST 面全按 MAT-xxxx
 *  寻址，公共编号来自服务端 join 投影（`matter_public_id`）。「拿不到投影」与「这不是事项会话」如果
 *  都表示成同一个 `null`，用户就会在一个看起来完全正常的历史对话里说「更新这件事」，而请求根本没有
 *  matter 快照 ⇒ 模型手里没有这件事的任何上下文，可能命中**错误的事项**。
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
  /** 线程重置 epoch —— 换会话 / 新会话时复位撤销回执。 */
  navEpoch: number
  /** 当前会话 id（进快照的 scope；新对话为 null）。 */
  sessionId: number | null
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
  /** composer 上方的可移除 chip（事项 chip + 每份置顶资料各一颗）。 */
  chip: React.ReactNode
  /** chip 之上的一组事项控件（上下文缺口卡）。 */
  controls: React.ReactNode
  /** 空态快捷 prompt（换一组，不是删掉 —— 设计稿位置同全局面板）。 */
  quickPrompts: React.ReactNode
  /** G-20 空态标题/副标题（设计稿："the empty state names the matter"）；非事项对话为 null，
   *  调用方据此回落通用 welcome。 */
  welcome: { title: string; hint: string } | null
}

export function useMatterConversation(
  input: UseMatterConversationInput
): MatterConversationBinding {
  const { sessionMatter, navEpoch, sessionId, enabled, thinkingEnabled } = input
  // 🔴 未就绪时把种子也一并掐掉：否则「A 的会话拿不到编号」会退回去采纳 dock 上一次带的 B，
  // 于是界面显示 B、审计写 B、而这条历史其实锚在 A 上。
  const unresolved = input.sessionMatterUnresolved === true
  const seed = unresolved ? null : input.seed
  const chatIsEmpty = input.chatIsEmpty
  const { t } = useTranslation()
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

  // 0812 dogfood —— 「本事项 / 全库」检索范围开关已整体移除（owner：单给事项搞一档没意义），
  // 事项对话恒全库检索。随之退役的还有 G5「审计先行」链（ensureSession → recordChatScope →
  // 本地翻档）与它背后的 `POST /matters/{id}/chat-scope` 端点。
  const contextScope = useMemo<ContextScope>(
    () => ({
      surface: 'general-agent',
      anchorType: 'matter',
      // 快照 scope 里的锚点是**内部** id，不是 MAT-xxxx（会话行 anchor_id 同一口径）。
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
  // D15 —— composer 上的置顶资料 chip（G-21）连同它唯一的移除入口一起退役，快照于是照旧
  // 带上全部置顶摘录（注入面零变化；hook 侧那个恒空的剔除参数也已一并删除）。
  const {
    snapshot,
    chips,
    hasContextGap,
    isError: snapshotFailed
  } = useMatterContextSnapshot({
    publicId: chipTarget?.publicId ?? '',
    scope: contextScope,
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

  // 🔴 异步落地时"当前这条线程是谁"的活体真相。`anchor` 是 props 派生值，await 期间会变；
  // 闭包里那份只是**发起时**的快照，不能拿来判"现在还是不是它"（撤销执行前的复核靠它）。
  const anchorRef = useRef<MatterChatTarget | null>(anchor)
  anchorRef.current = anchor

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

  // D15（0813 dogfood）—— composer 上**只摆一颗**「编号 · 标题」chip。
  //
  // 改动前这里还按设计 `chat.jsx:161` 给每份置顶资料各挂一颗可移除 chip（G-21）。实测
  // owner 判「把全部上下文显示成一堆附件，加载感很差」：置顶资料多的事项一进对话就是一排
  // 长得像附件的方块，且它们要等 context-snapshot 回来才逐个冒出来。
  //
  // 🔴 只收**显示层**：注入模型的那份快照一个字节没变（剔除入口没了 ⇒ 置顶摘录照旧
  // 全带，hook 侧那个恒空的剔除参数也已删掉）。代价是「本轮临时排除某份置顶资料」这个能力
  // 没有了 —— owner 明确要单 chip，排除入口若要回来该走事项页的置顶开关，不是 composer。
  const chip = chipTarget ? (
    <ConversationContextChip
      icon={<ClipboardList size={12} strokeWidth={2} className="shrink-0 text-coral" />}
      label={`${chipTarget.publicId} · ${chipTarget.title}`}
      removeLabel={t('matters.chat.removeContext')}
      onRemove={onRemoveChip}
    />
  ) : null

  // 检索范围控件下线后这一格只剩「快照读不到」与「上下文缺口卡」两件事；两件都没有就整块不渲染
  // （空的 flex 容器不该留在 composer 上方）。
  const controls =
    chipTarget && (snapshotFailed || hasContextGap) ? (
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
      </div>
    ) : null

  const quickPrompts = anchor ? <MatterQuickPrompts /> : null

  // G-20 —— 设计稿文件头三件事之三：「the empty state names the matter」。标题就是事项标题
  // （用户内容，不翻译），副标题给出这轮带了多少条上下文 + 还能用 @ 补别的资料。
  const welcome = anchor
    ? { title: anchor.title, hint: t('matters.chat.empty.hint', { count: contextCount }) }
    : null

  // 🔴 未就绪 = 整个绑定惰性。半个事项 UI（chip 在、编号不在）比没有更危险：它会让用户以为
  // 上下文已经就位。调用方另外摆「上下文未就绪」并禁发（见 AgentConversation）。
  if (unresolved) {
    return {
      anchor: null,
      snapshot: null,
      surface: null,
      chip: null,
      controls: null,
      quickPrompts: null,
      welcome: null
    }
  }
  return { anchor, snapshot, surface, chip, controls, quickPrompts, welcome }
}
