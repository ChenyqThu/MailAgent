// WP-15「context 环」（task 08-05）—— composer 右下 Send 旁的上下文占用指示器。
//
// 回答一个问题：**这个会话已经占了多少上下文**。lobe-chat 在同一位置放了一个四段明细的环，
// 我们这一版只做 Total Used（+ 有上限时的比例环），四段明细留给 WP-22。
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

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuiState } from '@assistant-ui/react'

import { cn } from '@shared/lib/cn'
import { useMailApi } from '@shared/hooks/useMailApi'
import { HoverTip } from '@shared/components/ui/HoverTip'

import { useChatComposerControls } from './composerControlsContext'
import { formatTokens } from './modelDetailCard.lib'
import { buildContextUsageView, latestContextTokens } from './contextUsage.lib'

import type { ContextUsageView } from './contextUsage.lib'

// 环的几何（与 Send 钮 h-9 / size-8 同一行，取 16px 直径不抢视觉重心）。
const RING_SIZE = 16
const RING_STROKE = 2
const RING_R = (RING_SIZE - RING_STROKE) / 2
const RING_C = 2 * Math.PI * RING_R

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

/** 当前会话最新一轮的上下文占用（token 数）；null = 没有可信数值 → 不渲染。
 *
 *  读路径刻意复用**既有**的 `chat.listMessages`（两端同一条 serve-api `/chat/sessions/{id}/messages`，
 *  `SELECT *` 自带新列）—— 不新开端点、不新加 IPC，远程 web 天然平权（`ai_gateway_proxy.py` 因此
 *  无需新增代理条目）。
 *
 *  🔴 **有意不用 react-query**：这个 hook 长在 composer 的叶子上，而 composer 有多个渲染路径
 *  （只读 notion-agent 线程、若干组件测试）**没有** QueryClientProvider —— `useQueryClient()` 在
 *  那些位置直接 throw，等于为了一个整数把整条 composer 变脆。一次 fetch + 一个 useState 够用，
 *  代价只是不与 ChatsTab 共用缓存（一次回合一次请求，会话消息量级下可忽略）。 */
function useContextTokens(sessionId: number | null): number | null {
  const mailApi = useMailApi()
  // 🔴 值与它**属于哪个会话**存在同一个 state 里，读出时按当前 sessionId 比对 —— 切会话瞬间
  // 派生值自然变 null，不需要在 effect 里 setState 清空（那会引起级联渲染，也留不住不变式：
  // 「屏幕上的数字永远属于当前会话」在这里是结构保证，不是靠清空的时序）。
  const [usage, setUsage] = useState<{ sessionId: number | null; tokens: number | null }>({
    sessionId: null,
    tokens: null
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
        setUsage({ sessionId, tokens: latestContextTokens(rows) })
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

  return usage.sessionId === sessionId ? usage.tokens : null
}

/** Send 旁的上下文占用指示器。三态：比例环 / 中性药丸 / 什么都不渲染（见文件头）。
 *  两个 composer 共用一份（ComposerAttachmentChips 先例），避免两面再次漂移。 */
export function ContextUsageRing(): React.JSX.Element | null {
  const { t } = useTranslation()
  const controls = useChatComposerControls()
  const sessionId = controls?.sessionId ?? null
  const used = useContextTokens(sessionId)

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
  const tip =
    view.variant === 'ring'
      ? t('chat.contextUsage.ringTip', {
          used: usedText,
          total: formatTokens(view.limit as number),
          percent: view.percent as number
        }) + (view.overflow ? `\n${t('chat.contextUsage.overflowTip')}` : '')
      : t('chat.contextUsage.pillTip', { used: usedText })

  return (
    <HoverTip text={tip} side="top">
      <span
        role="img"
        aria-label={t('chat.contextUsage.label', { used: usedText })}
        data-testid="context-usage"
        data-variant={view.variant}
        className={cn(
          'mr-1.5 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-micro tabular-nums',
          view.variant === 'pill' ? 'text-ink-fg-3' : TONE_CLASS[view.tone]
        )}
      >
        {view.variant === 'ring' ? <Ring view={view} /> : <span aria-hidden="true">~</span>}
        <span>{usedText}</span>
      </span>
    </HoverTip>
  )
}
