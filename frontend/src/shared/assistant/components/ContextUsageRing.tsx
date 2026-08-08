// WP-15「context 环」（task 08-05）—— composer 右下 Send 旁的上下文占用指示器。
//
// 回答一个问题：**这个会话已经占了多少上下文**。环本体 = Total Used（+ 有上限时的比例环）；
// 点开是 WP-22 的四段明细（见本文件头第二段）。
//
// ── 数据从哪来（三层，每层都可能「不知道」，不知道时一律往下降级、绝不猜）───────────────
//   ① **占用** = `ai_chat_messages.context_tokens`（chat_db v23）= gateway 在回合落库时取的
//      **末 step 的 inputTokens**（chatRun.ts `lastStepContextTokens`；🔴 不是 `usage.inputTokens`，
//      那个是多 step 求和）。拿不到 → 整个控件不渲染（老会话 / 首轮未完成 = 现状）。
//   ② **上限** = WP-0M 的模型元数据目录（`controls.availableModels[].contextWindow`，models.dev
//      快照）。命中 → 画比例环；未命中（自建中转 / 冷门模型）→ 退化成中性 token 药丸 `~91K`。
//      🔴 绝不拿猜的上限画环 —— 画错比不画更糟，会诱导用户误判还能塞多少。
//   ③ **刷新时机** = 「回合间刷新」，**零 wire 改动**：不动 SSE 的 messageMetadata、不动
//      systemPrompt（那两处都在 agent_eval 回归网的判据里）。代价 = 进行中不动，回合结束才更新，
//      文案因此如实说「上一轮请求」。
//
// ── 两个刷新触发器（互补，不是二选一）───────────────────────────────────────────────
//   (a) `chat:turn-persisted` 广播（Electron only）—— lifecycle 在**落库之后**发，是权威信号；
//       后台 detached run 结束也只有它能告诉我们。
//   (b) 线程 `isRunning` 的 true→false 沿 —— 远程 web 没有 IPC 广播（`onTurnPersisted` optional
//       缺省），靠它兜底。🔴 它并**不**竞态：ai@7 的 `handleUIMessageStreamFinish` 在终端
//       transform 的 `flush()` 里 **await** onFinish（node_modules/ai/dist/index.js
//       `async flush() { await callOnEnd() }`），而 onFinish 又 await 了 `cfg.persistTurn` ——
//       即客户端看到流关闭时，落库已经完成。（唯一例外是 detached drain 下客户端提前断开，
//       那一档正是 (a) 覆盖的。）

// ── WP-22（08-05）叠加的分段明细：hover / 点环 → 弹层 ─────────────────────────────
//   四段 = 系统提示 / 工具定义与其他（残差）/ 记忆 / 聊天消息。**只有 Total Used 是权威值**，
//   段值全是字符数换算的估算。可测段的两份原料：
//     · `/chat/config` 的 `standingContext` + `memorySummary`（**开弹层时才拉**——composer 每次
//       挂载都去拉一次配置，为的是一个多数人不会点开的面，不成比例）；
//     · 已经在拉的会话消息行（`listMessages`，环本体的同一次请求，零新增读）。
//   零 wire 改动的取舍与「为什么不让 gateway 落库各段」写在 contextUsage.lib.ts 的 WP-22 段。

// ── 08-06 owner dogfood ①：**hover 直接出明细，短提示整个删掉** ────────────────────
//   owner 原话「不需要那个 hover tips，把点击的那个直接改为 hover 效果」。于是：
//     · 原来的 `HoverTip`（一句话短提示）删除 —— 它与弹层是同一件事的两种详略，留着就是
//       「先给你一个不够用的版本、要看真的还得点」。
//     · 打开方式变成**三条并存**：hover（新增，主路径）/ 点击（保留，且点击 = **钉住**，
//       移开鼠标不收）/ 键盘 Enter（就是点击那条，`aria-expanded`/`aria-haspopup` 一字未动）。
//       触屏与无指针环境因此仍然可用 —— hover 是**多出来**的入口，不是替换。
//   🔴 两个延迟都不是装饰：
//     · 开 180ms —— 环紧挨着 effort/模型/发送，用户去点发送时**必然**扫过它；零延迟会让这个面
//       在每次发消息的路上弹一下。
//     · 收 120ms —— 弹层与环之间有 6px 间隙（mb-1.5），指针穿过间隙时会离开包裹层；没有这段
//       宽限期，鼠标根本进不到面上（面本身是 DOM 子节点，进去之后 mouseleave 不再触发）。
//   丢掉短提示会连带丢掉它里面两句**只在提示里存在**的诚实话，所以补进弹层（见
//   ContextUsageDetails 的 limitUnknown / overflow 两行）：上限未知的原因、以及超限告警。

// ── 08-06 owner dogfood ①（第二件）：环比同行控件高 2px 的**对齐 bug** ──────────────
//   根因不是 margin 也不是 line-height，是**包裹层是块级盒**：它唯一的孩子是 inline 级的
//   （原来是 HoverTip 的 `inline-flex` span，现在是按钮本身 `inline-flex`），于是包裹层要开一个
//   **行盒**，孩子按**基线**对齐在里面。而 inline-flex 的基线取自它第一个 flex item ——
//   这里是那颗 16px 的 svg，其合成基线 = svg 的下边缘，只比按钮自己的下边缘高 2px（py-0.5）。
//   包裹层的 strut（继承 16px 字号 + `line-height: normal`）却要求基线以下留约 4px 降部空间，
//   多出来的 ~4px 全加在**按钮下方** → 包裹层 24px、按钮 20px，行的 `items-center` 居中的是
//   包裹层，按钮因此比 effort/发送**高 2px**。（同排的 effort/「+」不中招：它们的图标在 28px
//   方盒里居中，合成基线离自己下边缘 7.5px > strut 降部，行盒被按钮自己撑满，没有富余。）
//   修法是消掉行盒本身：包裹层加 `flex items-center` → 孩子变成 flex item，不再有 strut 与基线
//   参与，包裹层高度 = 按钮高度。实测（Chromium + 本仓编译后的真实 CSS）：改前环心比 effort/
//   发送心高 2.00px，改后 0.00px。给 margin 硬怼只会在字号/图标尺寸一变就再次错位。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuiState } from '@assistant-ui/react'

import { cn } from '@shared/lib/cn'
import { DUR } from '@shared/lib/gsap'
import { useMailApi } from '@shared/hooks/useMailApi'
import { resolveApiBaseUrl } from '@shared/hooks/useLlmModels'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'

import { useChatComposerControls } from './composerControlsContext'
import { formatTokens } from './modelDetailCard.lib'
import { ContextUsageDetails } from './ContextUsageDetails'
import {
  buildContextBreakdown,
  buildContextUsageView,
  estimateMessagesTokens,
  estimateTokens,
  latestContextTokens
} from './contextUsage.lib'

import type { ChatMessage } from '@shared/api/types'
import type { ContextMeasuredSegments, ContextUsageView } from './contextUsage.lib'

// 环的几何（与 Send 钮 h-9 / size-8 同一行，取 16px 直径不抢视觉重心）。
const RING_SIZE = 16
const RING_STROKE = 2
const RING_R = (RING_SIZE - RING_STROKE) / 2
const RING_C = 2 * Math.PI * RING_R

// hover 开/收的宽限期（ms）。理由见文件头 08-06 ① 段：开延迟挡住「去点发送路过环」的误弹，
// 收延迟让指针能穿过环与弹层之间那 6px 间隙。
const HOVER_OPEN_MS = 180
const HOVER_CLOSE_MS = 120

const TONE_CLASS: Record<ContextUsageView['tone'], string> = {
  normal: 'text-ink-fg-3',
  warn: 'text-warn',
  danger: 'text-fail'
}

/** 比例环本体（纯展示）。底圈用 currentColor/20，进度弧从 12 点顺时针。 */
function Ring({ view }: { view: ContextUsageView }): React.JSX.Element {
  const ratio = view.ratio ?? 0
  return (
    <svg
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      className={cn('shrink-0', TONE_CLASS[view.tone])}
      aria-hidden="true"
    >
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={RING_R}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.2}
        strokeWidth={RING_STROKE}
      />
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={RING_R}
        fill="none"
        stroke="currentColor"
        strokeWidth={RING_STROKE}
        strokeLinecap="round"
        strokeDasharray={RING_C}
        strokeDashoffset={RING_C * (1 - ratio)}
        transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
      />
    </svg>
  )
}

/** 「不属于当前会话」时返回的稳定空值 —— 每次返回新字面量会让下游 useMemo 每帧失效。 */
const EMPTY_USAGE: { tokens: number | null; rows: ChatMessage[] } = { tokens: null, rows: [] }

/** 当前会话最新一轮的上下文占用（token 数）+ 该次快照的消息行；tokens=null = 没有可信数值 → 不渲染。
 *
 *  读路径刻意复用**既有**的 `chat.listMessages`（两端同一条 serve-api `/chat/sessions/{id}/messages`，
 *  `SELECT *` 自带新列）—— 不新开端点、不新加 IPC，远程 web 天然平权（`ai_gateway_proxy.py` 因此
 *  无需新增代理条目）。
 *
 *  🔴 **有意不用 react-query**：这个 hook 长在 composer 的叶子上，而 composer 有多个渲染路径
 *  （只读 notion-agent 线程、若干组件测试）**没有** QueryClientProvider —— `useQueryClient()` 在
 *  那些位置直接 throw，等于为了一个整数把整条 composer 变脆。一次 fetch + 一个 useState 够用，
 *  代价只是不与 ChatsTab 共用缓存（一次回合一次请求，会话消息量级下可忽略）。 */
function useContextTokens(sessionId: number | null): {
  tokens: number | null
  rows: ChatMessage[]
} {
  const mailApi = useMailApi()
  // 🔴 值与它**属于哪个会话**存在同一个 state 里，读出时按当前 sessionId 比对 —— 切会话瞬间
  // 派生值自然变 null，不需要在 effect 里 setState 清空（那会引起级联渲染，也留不住不变式：
  // 「屏幕上的数字永远属于当前会话」在这里是结构保证，不是靠清空的时序）。
  // WP-22 起同一份 state 里还留着**行本身**（分段明细的「聊天消息」段要数它们的字符量）——
  // 行已经在这次请求里拿到了，另存一份引用比再拉一遍便宜，且天然跟 tokens 属于同一次快照。
  const [usage, setUsage] = useState<{
    sessionId: number | null
    tokens: number | null
    rows: ChatMessage[]
  }>({
    sessionId: null,
    tokens: null,
    rows: []
  })
  const enabled = typeof sessionId === 'number' && sessionId >= 0
  // 递增序号：连发两次刷新时只认最后一次的响应（乱序回来的旧响应会把新值盖回去）。
  const reqSeq = useRef(0)

  const refresh = useCallback(() => {
    if (!enabled) return
    const seq = ++reqSeq.current
    void mailApi.chat
      .listMessages(sessionId as number)
      .then((rows) => {
        if (seq !== reqSeq.current) return
        setUsage({ sessionId, tokens: latestContextTokens(rows), rows })
      })
      .catch(() => {
        /* listMessages 自身已 graceful（失败返 []）；这一层只是兜住实现换了之后的抛出 */
      })
  }, [enabled, mailApi, sessionId])

  // 首挂 + 切会话：拉一次。
  useEffect(() => {
    refresh()
  }, [refresh])

  // (a) 落库广播（Electron）。onTurnPersisted 是 optional（web HttpApi 缺省）→ `?.`；
  // 🔴 IPC 订阅必须用返回的 disposer 清理（fe0437e：跨 contextBridge removeListener 匹配不到 →
  // listener 泄漏 + StrictMode 双订阅）。
  useEffect(() => {
    if (!enabled) return undefined
    return mailApi.chat.onTurnPersisted?.((payload) => {
      if (payload.sessionId !== sessionId) return
      refresh()
    })
  }, [enabled, mailApi, sessionId, refresh])

  // (b) isRunning 的 true→false 沿（远程 web 兜底；文件头解释了为什么它不竞态）。
  const running = useAuiState((s) => s.thread.isRunning)
  const wasRunning = useRef(running)
  useEffect(() => {
    const prev = wasRunning.current
    wasRunning.current = running
    if (prev && !running) refresh()
  }, [running, refresh])

  const mine = usage.sessionId === sessionId
  return mine ? { tokens: usage.tokens, rows: usage.rows } : EMPTY_USAGE
}

/** WP-22 —— 系统提示 / 记忆两段的原料：`/chat/config` 的 `standingContext` + `memorySummary`
 *  （都是全文字符串，gateway 每轮就是拿它们拼 system prompt 的）。
 *
 *  **开弹层时才拉**，且拉失败/未开时返回 null → 弹层只显示总量、明说「分段明细暂不可用」，
 *  绝不拿 0 顶上（0 会被读成「身份文档没占地方」，那是假的）。
 *
 *  🔴 有意不用 react-query：与 useContextTokens 同一条理由 —— 这个 hook 长在 composer 的叶子上，
 *  而 composer 有没有 QueryClientProvider 的渲染路径（见 useContextTokens 的注释）。 */
function usePromptSourceTokens(open: boolean): {
  measured: Pick<ContextMeasuredSegments, 'system' | 'memory'> | null
  loading: boolean
} {
  // 🔴 只在 async 回调里 setState —— effect 体内同步 setState 会级联渲染（eslint
  // react-hooks/set-state-in-effect）。所以「加载中」不是一个 state，而是**派生**的：
  // 「面开着且还没有任何一次请求落地」。第二次打开时沿用上一次的结果（配置不会秒变），
  // 后台静默刷新，避免每次开面都闪一下空态。
  const [settled, setSettled] = useState<{
    data: Pick<ContextMeasuredSegments, 'system' | 'memory'> | null
  } | null>(null)
  const reqSeq = useRef(0)

  useEffect(() => {
    if (!open) return
    const seq = ++reqSeq.current
    void (async () => {
      let next: Pick<ContextMeasuredSegments, 'system' | 'memory'> | null = null
      try {
        const resp = await fetch(`${resolveApiBaseUrl()}/chat/config`, { credentials: 'include' })
        if (resp.ok) {
          const body = (await resp.json()) as {
            data?: { standingContext?: unknown; memorySummary?: unknown }
          }
          const standing = body?.data?.standingContext
          const memory = body?.data?.memorySummary
          // 两个字段都缺席（老后端）→ null（= 不可得）；只要有一个是字符串就算拿到了配置：
          // standing context 关掉时它确实是 ""，那是真值 0 而不是「不知道」。
          if (typeof standing === 'string' || typeof memory === 'string') {
            next = {
              system: estimateTokens(typeof standing === 'string' ? standing : ''),
              memory: estimateTokens(typeof memory === 'string' ? memory : '')
            }
          }
        }
      } catch {
        /* 后端不可达 → next 保持 null → 弹层如实说分段不可用 */
      }
      if (seq !== reqSeq.current) return
      setSettled({ data: next })
    })()
  }, [open])

  return { measured: settled?.data ?? null, loading: open && settled === null }
}

/** Send 旁的上下文占用指示器 + 点开的分段明细。三态：比例环 / 中性药丸 / 什么都不渲染
 *  （见文件头）。两个 composer 共用一份（ComposerAttachmentChips 先例），避免两面再次漂移。 */
export function ContextUsageRing(): React.JSX.Element | null {
  const { t } = useTranslation()
  const controls = useChatComposerControls()
  const sessionId = controls?.sessionId ?? null
  const { tokens: used, rows } = useContextTokens(sessionId)
  const threadRunning = useAuiState((state) => state.thread.isRunning)

  // 「开着的是**哪个会话**的明细」而不是一个裸 boolean：切会话时环会先因为没有占用值而整个
  // 消失（组件 return null 但**状态还在**），等新会话的数字回来时一个裸 open=true 会让弹层
  // 自己弹出来。把 open 与 sessionId 绑在一起 → 换会话即派生成 false，不需要 effect 清（那既
  // 会级联渲染，也守不住这条不变式）。与本文件里 usage 的存法同一条纪律。
  //
  // `pinned` = 这次是**点开**的（含键盘 Enter）→ 鼠标移开不收，要再点一次 / Escape / 点外面
  // 才关。hover 开的则跟着指针走。两者共用同一个 open，所以弹层只有一份。
  const [openState, setOpenState] = useState<{ session: number | null; pinned: boolean }>({
    session: null,
    pinned: false
  })
  const open = openState.session !== null && openState.session === sessionId
  const pinned = open && openState.pinned
  const closePanel = useCallback(() => setOpenState({ session: null, pinned: false }), [])
  const rootRef = useRef<HTMLDivElement>(null)

  // hover 开/收的定时器（同一个 ref，任一动作先取消对方的排程）。卸载时必须清 —— 否则
  // 定时器会在已卸载的组件上 setState。
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelHover = useCallback(() => {
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
  }, [])
  useEffect(() => cancelHover, [cancelHover])

  const onPointerEnter = useCallback(() => {
    cancelHover()
    if (open) return
    hoverTimer.current = setTimeout(
      () => setOpenState({ session: sessionId, pinned: false }),
      HOVER_OPEN_MS
    )
  }, [cancelHover, open, sessionId])

  const onPointerLeave = useCallback(() => {
    cancelHover()
    if (!open || pinned) return
    hoverTimer.current = setTimeout(closePanel, HOVER_CLOSE_MS)
  }, [cancelHover, closePanel, open, pinned])

  // 点击（含键盘 Enter/Space）= 钉住/取消钉住。hover 开着时点一下变成钉住，不是关掉 ——
  // 「我要仔细看」是这个动作的唯一合理意图。
  const onToggleClick = useCallback(() => {
    cancelHover()
    if (pinned) closePanel()
    else setOpenState({ session: sessionId, pinned: true })
  }, [cancelHover, closePanel, pinned, sessionId])
  // 右组控件 → 弹层右锚（EffortPicker 文件头记了同一条：左锚会把面推出右边界）。
  const { shouldRender, scopeRef: popRef } = useExitAnimation<HTMLDivElement>(open, {
    backdrop: false,
    from: { autoAlpha: 0, y: 4, scale: 0.98, transformOrigin: 'bottom right' },
    enterDuration: DUR.fast
  })
  const { measured: promptTokens, loading: promptLoading } = usePromptSourceTokens(open)

  useEffect(() => {
    if (!open) return undefined
    const onDoc = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) closePanel()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closePanel()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return (): void => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, closePanel])

  // 消息段：只在弹层开着时数（长会话的 ui_message_json 加起来是几百 KB 级，没人看的时候
  // 不值得每次刷新都扫一遍）。
  const messageTokens = useMemo(
    () => (shouldRender ? estimateMessagesTokens(rows) : 0),
    [shouldRender, rows]
  )

  // 上限取**当前选中**的模型（下一轮就发给它，头寸算它的才有用）；占用则来自上一轮请求 ——
  // 刚切过模型时这两半的口径会短暂不一致，tooltip 里的「上一轮请求」说明已经把这点讲清。
  // 不 memo：availableModels 是 10 量级的数组，一次 find 比维护依赖便宜。
  const activeModel = controls?.model ?? null
  const limit =
    activeModel === null
      ? null
      : (controls?.availableModels.find((m) => m.ref === activeModel)?.contextWindow ?? null)

  const view = buildContextUsageView(used, limit)
  if (!view) return null

  const usedText = formatTokens(view.used)
  const breakdown = buildContextBreakdown(
    view,
    promptTokens ? { ...promptTokens, messages: messageTokens } : null
  )

  return (
    // 🔴 **这一层刻意不是 `relative`** —— 弹层的包含块要落在**工具条那一行**（两个 composer 的
    // 动作行都加了 `relative`，见 composer.tsx / AgentComposer.tsx 的注释）。
    // 算式：环是右组的**第一颗**，它右边还有 effort(28) + 模型 chip(≤195) + 发送(32) + 三个间隙，
    // 即环的右缘离行右缘 ≈ 200px。若按环自己的右缘锚（EffortPicker / ModelPicker 那样），
    // 260px 的面在 320px 窄侧栏里左缘会落到 −100 上下，而 AssistantChatModal 根是
    // `overflow-hidden` —— 越界不是「盖住旁边」，是**直接被裁掉**。改锚到行以后：面的右缘 = 行
    // 右缘，宽度再由 `max-w-full`（百分比对包含块解析）兜底，结构上不可能越界。
    //
    // 🔴 `flex items-center` 是**对齐 bug 的修法本体**（不是排版偏好）：见文件头 08-06 ① 第二段。
    // 去掉它，包裹层退回块级 → 行盒 + strut 降部 → 环又比 effort/发送高 2px。
    <div
      className="mr-1.5 flex items-center"
      ref={rootRef}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
    >
      <button
        // 🔴 邮件面的 composer 根是一个 <form>：不写 type="button" 的按钮默认 submit，
        // 点一下明细就把消息发出去了。
        type="button"
        onClick={onToggleClick}
        onFocus={onPointerEnter}
        onBlur={onPointerLeave}
        aria-label={t('chat.contextUsage.label', { used: usedText })}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="context-usage"
        data-variant={view.variant}
        className={cn(
          'inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-micro tabular-nums',
          'transition-colors duration-fast hover:bg-ink-4',
          view.variant === 'pill' ? 'text-ink-fg-3' : TONE_CLASS[view.tone],
          open && 'bg-ink-4'
        )}
      >
        {view.variant === 'ring' ? <Ring view={view} /> : <span aria-hidden="true">~</span>}
        <span>{usedText}</span>
      </button>
      {shouldRender && (
        <div
          ref={popRef}
          role="dialog"
          aria-label={t('chat.contextUsage.detailsTitle')}
          data-testid="context-usage-details"
          // 锚在**工具条行**的右缘（见上面 wrapper 的注释）。260px 放得下最长的中文段名 +
          // 数字；`max-w-full` 是结构性兜底：行比 260 窄时面跟着缩，永远不会被 overflow-hidden
          // 裁掉。几何全走类 —— 内联 style 会被 reduced-motion 分支的 clearProps:'all' 清空
          //（16b 踩过）。
          className="glass-pop absolute bottom-full right-0 z-50 mb-1.5 w-[260px] max-w-full rounded-[var(--r-ctl)] p-3"
        >
          <ContextUsageDetails
            breakdown={breakdown}
            loading={promptLoading}
            overflow={view.overflow}
          />
          {controls?.compactEnabled === true && controls.sessionId != null && (
            <button
              type="button"
              disabled={
                controls.compactActive !== true && (threadRunning || controls.sendDisabled === true)
              }
              onClick={() => {
                if (controls.compactActive) controls.onCompactStop?.()
                else controls.onCompact?.()
              }}
              className="mt-2 w-full rounded-md border border-ink-border px-2 py-1.5 text-left text-aux text-ink-fg hover:bg-ink-4 disabled:opacity-40"
            >
              {controls.compactActive ? t('chat.compact.stop') : t('chat.compact.action')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
