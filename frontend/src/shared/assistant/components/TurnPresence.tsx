// living-bot-avatar WP5 — the in-flow turn presence row（回合头像行）.
//
// Replaces the retired turn status line (assistant-ui `Empty` slot, harness-chat lane B) as the
// message-flow status surface. The owner-approved design (prd §6.3-1): a small animated BotAvatar
// rides ON TOP of the latest assistant message for the WHOLE run — thinking / calling-tool /
// writing / awaiting-approval / stalled / error all show as facial expressions — and a text area
// beside it keeps EXACTLY the old status-line discipline (the "shimmer must stop" fix from three
// generations of shimmer governance — do not loosen):
//   - connecting / thinking → one truthful ShimmerText phrase (+ stopwatch)
//   - stalled              → STATIC waiting line, never a shimmer (+ stopwatch)
//   - error                → STATIC red line, no stopwatch (a terminal row with a running clock
//                            reads as "still going")
//   - writing / calling-tool / awaiting-approval → NO TEXT (the streaming body / tool card /
//                            approval card narrates itself); only the avatar stays.
// DotMatrix is RETIRED from the message flow (owner: avatar is the motion carrier now); the
// composer-side ThreadRunStatusBar keeps its own DotMatrix untouched.
//
// Why NOT the `Empty` slot: MessageParts unmounts `Empty` the moment parts become non-empty, but
// the avatar must persist through writing / tool phases. So both assistant message wrappers
// (assistant/components/message.tsx + components/agents/AgentMessage.tsx) mount this ABOVE the
// message content, gated on `message.isLast` — history messages never carry an avatar.
//
// Completion choreography (prd §6.3): on the falling edge to idle WITH message status 'complete'
// (an abort lands on idle too, but with status 'incomplete' — no celebration for a cancelled
// run), the avatar switches to `celebrate` for CELEBRATE_HOLD_MS, then fades out over DUR.slow
// and unmounts. reduced-motion: no celebrate, no fade — the row simply disappears (motion-gsap §3
// "the animation does not appear at all"). The edge lives in an effect + prev ref so re-renders
// can never replay it.

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuiState } from '@assistant-ui/react'

import { cn } from '@shared/lib/cn'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'
import { BotAvatar, type BotAvatarProps } from '@shared/bot-avatar/BotAvatar'
import { turnStageToBotState } from '@shared/bot-avatar/states'
import type { BotState } from '@shared/bot-avatar/types'
import { ShimmerText } from '@shared/components/ShimmerText'
import {
  useTurnStage,
  type TurnStage,
  type StallLevel
} from '@shared/assistant/runtime/useTurnStage'
import { useThreadReadOnly } from '@shared/assistant/components/threadReadOnlyContext'
import { formatToolDuration, useToolElapsed } from '@shared/assistant/tools/generic/useToolElapsed'
import {
  isAgentAvatarImage,
  OFFICIAL_ASSISTANT_AVATAR
} from '@shared/components/agents/agentAvatarIdentity'
import { useAssistantIdentity } from '@shared/assistant/assistantIdentity'

/** 主 agent 身份（0813）→ 本行的头像/名字投影：owner 配置的 bot 头像直接用；上传图走
 *  imageSrc（静态 img —— 状态表情对图片无意义）；未配置/legacy = 官方形象 sphere/orange。 */
function useAssistantPresenceIdentity(): {
  name: string | undefined
  config: NonNullable<BotAvatarProps['config']>
  imageSrc: string | undefined
} {
  const identity = useAssistantIdentity()
  const avatar = identity.avatar
  return {
    name: identity.name ?? undefined,
    config: avatar?.type === 'bot' ? avatar : OFFICIAL_ASSISTANT_AVATAR,
    imageSrc: isAgentAvatarImage(avatar) ? avatar.data : undefined
  }
}

/** celebrate 保持时长（prd §6.3 ≈2.5s），之后进入淡出。 */
export const CELEBRATE_HOLD_MS = 2500
/** 淡出时长 = DUR.slow（380ms，仓规三档；CSS transition 与卸载 timer 必须同值）。 */
export const CELEBRATE_FADE_MS = 380

/** 状态行退役后两个 partComponents 显式提供的空槽：assistant-ui 在
 *  contentLength===0 时不给 Empty 会退回 EmptyPartsImpl（渲染一个空字符串 text part）——
 *  显式 null 让「无内容阶段什么都不画」成为确定行为（状态叙述整体归 TurnPresence）。 */
export function TurnPresenceEmpty(): null {
  return null
}

/** 秒表可见的三态 = 文字区会渲染内容的三态（沿袭老状态行 W3-② 的取舍：calling-tool
 *  归工具卡自己的秒表；error 是终态，旁边挂走动的秒数只会读成「还在跑」）。 */
function isStopwatchStage(stage: TurnStage): boolean {
  return stage === 'connecting' || stage === 'thinking' || stage === 'stalled'
}

type CelebratePhase = 'hold' | 'fading'

interface TurnPresenceRowProps {
  stage: TurnStage
  stallLevel: StallLevel
  /** message status === 'complete'（celebrate 只庆祝真完成；abort/incomplete 不庆祝）。 */
  completed: boolean
  config?: BotAvatarProps['config']
  /** 主 agent 上传图头像（0813）：设了就渲染静态 img 替代 BotAvatar（表情对图片无意义）。 */
  imageSrc?: string
  /** 主 agent 名字（0813）：进「{{name}} 思考中…」文案；缺省 'AI'（= 改动前文案逐字）。 */
  assistantName?: string
  className?: string
}

/** 展示层 + celebrate 状态机（导出仅供测试直驱：假时钟下演练 hold→fading→卸载 的完整时序，
 *  不必透过 runtime 拼流）。生产入口是下面的 TurnPresence。 */
export function TurnPresenceRow({
  stage,
  stallLevel,
  completed,
  config,
  imageSrc,
  assistantName,
  className
}: TurnPresenceRowProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const reduce = useReducedMotion()
  const [celebrate, setCelebrate] = useState<CelebratePhase | null>(null)
  // 下降沿检测在 render 期做（React 官方「adjusting state when a prop changes」模式，
  // 免掉 effect 里同步 setState 的级联渲染）：只有真实的 stage 变化能触发/取消 celebrate，
  // 重渲染绝不重播；挂载帧（prevStage===null）不是边沿。
  const [prevStage, setPrevStage] = useState<TurnStage | null>(null)
  if (prevStage !== stage) {
    setPrevStage(stage)
    if (prevStage !== null) {
      if (stage !== 'idle') {
        // 新回合开始（或转入 error）：任何进行中的庆祝立即让位给真实状态。
        setCelebrate(null)
      } else if (!completed || prevStage === 'error' || reduce) {
        // 下降沿 → idle。只庆祝「真完成」：abort 也落 idle 但 status 是 incomplete；error → idle
        // 不经此路（error 由 status 派生，同一条消息不会翻回 complete）。reduced-motion 跳过
        // celebrate 与淡出 —— 行直接消失（stage 已是 idle，下面的 visible 判定自然为 false）。
        setCelebrate(null)
      } else {
        setCelebrate('hold')
      }
    }
  }

  // hold → fading → 卸载 的两段计时。celebrate 被上面的效果取消时 timer 随 cleanup 清掉。
  useEffect(() => {
    if (celebrate === null) return
    const t = window.setTimeout(
      () => setCelebrate(celebrate === 'hold' ? 'fading' : null),
      celebrate === 'hold' ? CELEBRATE_HOLD_MS : CELEBRATE_FADE_MS
    )
    return (): void => {
      window.clearTimeout(t)
    }
  }, [celebrate])

  // 回合级秒表：三条契约照搬（没起点不编造 0.0s / cleanup 落终值 / reduced-motion 不 tick）。
  // 起点 = 本实例第一次进入可计时阶段的时刻；本组件整回合常驻（不再是 Empty slot 的分段重挂），
  // 读数因此是「本回合已进行多久」，跨 thinking↔calling-tool↔stalled 不清零。
  const elapsed = useToolElapsed(isStopwatchStage(stage))

  const visible = stage !== 'idle' || celebrate !== null
  if (!visible) return null

  const botState: BotState = celebrate !== null ? 'celebrate' : turnStageToBotState(stage)

  const stopwatch =
    isStopwatchStage(stage) && elapsed !== null ? (
      <span
        className="shrink-0 font-mono text-meta tabular-nums text-ink-fg-3"
        title={t('chat.toolStep.duration')}
      >
        {formatToolDuration(elapsed)}
      </span>
    ) : null

  // 文字区 —— 老状态行的显隐纪律逐条搬运（见文件头）；celebrate 阶段 stage 已是 idle，
  // 三个分支全不命中 → 只剩头像在庆祝。
  let text: React.ReactNode = null
  if (stage === 'connecting' || stage === 'thinking') {
    // {{name}} 插值：主 agent 起了名（如 Jarvis）就是「Jarvis 思考中…」；缺省 'AI'
    // 两语言字面与改名前逐字一致。
    text = <ShimmerText shiny text={t('chat.status.thinking', { name: assistantName ?? 'AI' })} />
  } else if (stage === 'stalled') {
    text = (
      <span className="text-aux">
        {t(stallLevel >= 2 ? 'chat.status.waitingLong' : 'chat.status.waiting')}
      </span>
    )
  } else if (stage === 'error') {
    text = <span className="text-aux text-fail">{t('chat.status.error')}</span>
  }

  return (
    <div
      data-testid="turn-presence"
      data-bot-state={botState}
      className={cn(
        'flex items-center gap-2 text-ink-fg-3',
        'transition-opacity duration-slow motion-reduce:transition-none',
        celebrate === 'fading' ? 'opacity-0' : 'opacity-100',
        className
      )}
    >
      {imageSrc ? (
        <img
          src={imageSrc}
          alt=""
          width={28}
          height={28}
          draggable={false}
          className="h-7 w-7 shrink-0 rounded-full object-cover"
        />
      ) : (
        <BotAvatar
          animated
          size={28}
          state={botState}
          config={config ?? OFFICIAL_ASSISTANT_AVATAR}
        />
      )}
      {text}
      {stopwatch}
    </div>
  )
}

interface TurnPresenceProps {
  /** 会话绑定 agent 的 bot 头像（WP3 统一 resolve 链接线用的缝）；缺省 = 官方助手形象。 */
  config?: BotAvatarProps['config']
  className?: string
}

/** Store 接线层：只挂「最后一条 assistant 消息」且非只读线程 —— 历史消息零头像、只读回放
 *  （AgentRecordView 等）零头像。必须在 message scope 内渲染（两个 assistant 消息包装层）。 */
export function TurnPresence({ config, className }: TurnPresenceProps): React.JSX.Element | null {
  const isLast = useAuiState((s) => s.message.isLast)
  const readOnly = useThreadReadOnly()
  const { stage, stallLevel } = useTurnStage()
  const completed = useAuiState((s) => s.message.status?.type === 'complete')
  const identity = useAssistantPresenceIdentity()
  if (!isLast || readOnly) return null
  return (
    <TurnPresenceRow
      stage={stage}
      stallLevel={stallLevel}
      completed={completed}
      config={config ?? identity.config}
      imageSrc={config ? undefined : identity.imageSrc}
      assistantName={identity.name}
      className={className}
    />
  )
}

/** 面板头的官方助手头像（AiChatPanel 标题栏，替换原 13px Sparkles）：无 run 时 idle 稀疏微动，
 *  有后台 run（useBackgroundChatRun().backgroundActive）时 working ——「AI 在后台干活」一眼可见。
 *  前台流式回合的状态由消息流内的 TurnPresence 叙述，这里不重复（backgroundActive 对 own-run
 *  已做掩蔽）。 */
export function AssistantPanelBotAvatar({ working }: { working: boolean }): React.JSX.Element {
  const state: BotState = working ? 'working' : 'idle'
  const identity = useAssistantPresenceIdentity()
  return (
    <span className="inline-flex shrink-0" data-testid="panel-bot-avatar" data-bot-state={state}>
      {identity.imageSrc ? (
        <img
          src={identity.imageSrc}
          alt=""
          width={20}
          height={20}
          draggable={false}
          className="h-5 w-5 rounded-full object-cover"
        />
      ) : (
        <BotAvatar animated size={20} state={state} config={identity.config} />
      )}
    </span>
  )
}
