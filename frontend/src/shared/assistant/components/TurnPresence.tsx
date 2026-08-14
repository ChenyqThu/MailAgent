// living-bot-avatar WP5 — the in-flow turn presence row（回合头像行）.
//
// Replaces the retired turn status line (assistant-ui `Empty` slot, harness-chat lane B) as the
// message-flow status surface. The owner-approved design (prd §6.3-1): a small animated BotAvatar
// rides ON TOP of the latest assistant message for the WHOLE run — thinking / calling-tool /
// writing / awaiting-approval / stalled / error all show as facial expressions — and a text area
// beside it narrates what is actually happening.
//
// 🔴 0813 dogfood 轮 5（C）——「运行条整条退役，实时叙述搬到这里」。owner：「AI Chat 对话框上的
// 那个状态栏，感觉不需要了，直接替换到 agent 答复顶部的那个状态？底部的那个状态更新要比顶部的
// 更多更及时，所以要替换到实时状态。时间保留，但是那句『切走也不会中断』的提示不必保留。」
// （末句是原话的转述：`chat.runStatus.safeToLeave` 整条退役，中英两份 locale 都已清掉。）
// 由此**放宽**了本文件原先那条明文纪律（写在这里免得后人当成漏改）：
//   原纪律：writing / calling-tool / awaiting-approval 一律**不出文字**，理由是流式正文 / 工具卡 /
//           审批卡自己会叙述，出文字就是双重叙述。
//   现纪律：writing / calling-tool **出文字**（沿用退役运行条的那份 label 集，含工具人话名），
//           因为 owner 要的正是那份「更多更及时」的叙述，而它的原载体没了；
//           awaiting-approval **维持沉默**（审批卡确实就是状态本身，这一条没被推翻）。
// 没有被放宽的是 shimmer 治理（三代「shimmer must stop」）：只有**进行中**的阶段流光，
//   - connecting / thinking / calling-tool / writing → ShimmerText 一句真话 + 秒表
//   - stalled → STATIC waiting line，never a shimmer（+ 秒表）
//   - error   → STATIC red line，无秒表（终态旁边挂个走动的读数会读成「还在跑」）
//   - awaiting-approval → 无文字无秒表，只剩头像。
// DotMatrix 仍然**不搬上来**（owner：头像是消息流里唯一的动效载体）—— 搬的是文案与秒表。
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
//
// 🔴 0813 dogfood 轮 5（D）—— **后台（detached）run 的在场提示也用这套呈现**：`BackgroundRunPresence`
// 与 `TurnPresenceRow` 共用同一个展示壳 `PresenceRow`（一份组件双面挂载，绝不写第二份「头像 +
// 文案 + 秒表」的行）。它**不能**复用 TurnPresence 本身：TurnPresence 挂在最后一条 assistant
// 消息上（`message.isLast`，必须在 message scope 内），而用户切回来时后台 run 可能还没产出任何
// part —— 那条 assistant 消息根本不存在，没有宿主。故后台形态落在 thread 的 `pendingSlot`
// （消息流内、消息之外），也正是它 WP-14 之前的老家。

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
import { formatRunElapsed, useRunElapsed } from '@shared/assistant/runtime/useRunElapsed'
import { toolTitleKey } from '@shared/components/chat/tool_steps'
import {
  isAgentAvatarImage,
  OFFICIAL_ASSISTANT_AVATAR
} from '@shared/components/agents/agentAvatarIdentity'
import { avatarShellClass } from '@shared/components/agents/avatarShell'
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

/** 秒表可见的阶段 = **所有进行中的**阶段（0813 轮 5 C-②：owner 要退役运行条那份「一直在走的
 *  秒表」，运行条覆盖 connecting/thinking/calling-tool/writing 四态）。
 *
 *  与旧取舍的差异只有 calling-tool / writing 两态：旧版把 calling-tool 让给工具卡自己的秒表，
 *  现在回合秒表答的是**另一个**问题（「这一整回合跑了多久」，工具卡答的是「这一次调用多久」），
 *  owner 明确要前者，两口表并存是有意的。
 *  仍然不挂表的三态：idle（没在跑）、awaiting-approval（审批卡即状态，也避免历史会话重放出一个
 *  从打开会话才起算的假秒表）、error（终态旁边走动的读数会读成「还在跑」）。
 *
 *  🔴 Record 而不是 if 串：`satisfies` 让两个方向都成为编译错误（上游 TurnStage 加新态而这里漏判
 *  = 缺属性错误），沿用 `toolPhase.ts::RESOLUTION_WITHOUT_DECISION` 的先例。 */
const STAGE_HAS_STOPWATCH = {
  idle: false,
  connecting: true,
  thinking: true,
  'calling-tool': true,
  'awaiting-approval': false,
  writing: true,
  stalled: true,
  error: false
} satisfies Record<TurnStage, boolean>

function isStopwatchStage(stage: TurnStage): boolean {
  return STAGE_HAS_STOPWATCH[stage]
}

type CelebratePhase = 'hold' | 'fading'

interface PresenceRowProps {
  /** 引擎状态（也落 `data-bot-state`，测试与 dogfood 都按它读表情）。 */
  botState: BotState
  config?: BotAvatarProps['config']
  /** 上传图头像：设了就渲染静态 img 替代 BotAvatar（表情对图片无意义）。 */
  imageSrc?: string
  testId: string
  /** 头像右侧的全部内容（文案 / 秒表 / 提示），由两个调用方各自组合。 */
  children?: React.ReactNode
  className?: string
}

/** 「头像 + 右侧内容」的展示壳 —— 回合在场行与后台在场行**共用这一份**（本仓纪律：一份组件
 *  双面挂载，不写第二份长得一样的行）。它不含任何状态机：celebrate 归 TurnPresenceRow，
 *  后台文案/锚点秒表归 BackgroundRunPresence。 */
function PresenceRow({
  botState,
  config,
  imageSrc,
  testId,
  children,
  className
}: PresenceRowProps): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      data-bot-state={botState}
      className={cn('flex items-center gap-2 text-ink-fg-3', className)}
    >
      {/* 0813 dogfood：外壳口径与 AgentAvatar 收成同一份（avatarShell）——
          此前这里 bot **完全没有外壳**、只有上传图 rounded-full，跟列表侧的一律圆裁三方分裂。 */}
      <span className={avatarShellClass(28)}>
        {imageSrc ? (
          <img
            src={imageSrc}
            alt=""
            width={28}
            height={28}
            draggable={false}
            className="h-7 w-7 object-cover"
          />
        ) : (
          <BotAvatar
            animated
            size={28}
            state={botState}
            config={config ?? OFFICIAL_ASSISTANT_AVATAR}
          />
        )}
      </span>
      {children}
    </div>
  )
}

/** 回合秒表读数（叶子组件）。
 *
 *  🔴 单独一个叶子：`useToolElapsed` 每 100ms setState 一次，挂在整行上会让 BotAvatar 与
 *  ShimmerText 每秒重渲 10 次（0813 轮 5 起秒表覆盖到 calling-tool / writing，这段时间大幅变长）。
 *  沿用退役运行条 `RunElapsed` 的形状：读数只影响它自己那一小块。
 *
 *  🔴 **必须整回合常驻**（`live` 为假时返回 null 而不是被父层条件卸载）：`useToolElapsed` 的起点
 *  存在实例的 ref 里 —— 卸载即丢起点，审批门批准后就会从 0 重新起表。 */
function TurnStopwatch({
  live,
  title
}: {
  live: boolean
  title: string
}): React.JSX.Element | null {
  const elapsed = useToolElapsed(live)
  if (!live || elapsed === null) return null
  return (
    <span className="shrink-0 font-mono text-meta tabular-nums text-ink-fg-3" title={title}>
      {formatToolDuration(elapsed)}
    </span>
  )
}

interface TurnPresenceRowProps {
  stage: TurnStage
  stallLevel: StallLevel
  /** message status === 'complete'（celebrate 只庆祝真完成；abort/incomplete 不庆祝）。 */
  completed: boolean
  /** `calling-tool` 时的工具名（`useTurnStage` 派生），进「正在{工具人话名}…」。 */
  toolName?: string | undefined
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
  toolName,
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

  const visible = stage !== 'idle' || celebrate !== null
  if (!visible) return null

  const botState: BotState = celebrate !== null ? 'celebrate' : turnStageToBotState(stage)

  // 文字区 —— 0813 轮 5 起接管退役运行条的 label 集（见文件头那段改判说明）。celebrate 阶段
  // stage 已是 idle，所有分支全不命中 → 只剩头像在庆祝。
  let text: React.ReactNode = null
  if (stage === 'connecting') {
    text = <ShimmerText shiny text={t('chat.runStatus.connecting')} />
  } else if (stage === 'thinking') {
    // {{name}} 插值：主 agent 起了名（如 Jarvis）就是「Jarvis 思考中…」；缺省 'AI'
    // 两语言字面与改名前逐字一致。
    text = <ShimmerText shiny text={t('chat.status.thinking', { name: assistantName ?? 'AI' })} />
  } else if (stage === 'calling-tool') {
    // 工具人话名复用工具卡那份标题表（`toolTitleKey`）；词表未登记的名字（connector 的
    // `mcp__x__y`、新工具）**原样落回裸标识符** —— 与 ToolTraceCard 逐字同款的降级，绝不返回
    // 缺翻译占位符。拿不到工具名（理论上不会：calling-tool 必带）→ 退回通用「思考中」，不拼半句话。
    const key = toolName == null ? null : toolTitleKey(toolName)
    const tool = key === null ? (toolName ?? '') : t(key)
    text = (
      <ShimmerText
        shiny
        text={
          tool === ''
            ? t('chat.status.thinking', { name: assistantName ?? 'AI' })
            : t('chat.runStatus.callingTool', { tool })
        }
      />
    )
  } else if (stage === 'writing') {
    text = <ShimmerText shiny text={t('chat.runStatus.writing')} />
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
    <PresenceRow
      testId="turn-presence"
      botState={botState}
      config={config}
      imageSrc={imageSrc}
      className={cn(
        'transition-opacity duration-slow motion-reduce:transition-none',
        celebrate === 'fading' ? 'opacity-0' : 'opacity-100',
        className
      )}
    >
      {/* 窄容器（320px 侧栏）里文案可收缩截断，秒表恒不缩 —— 「跑了多久」是最不该丢的那一格；
          词表外的裸工具名（mcp__x__y）超长时也在这里被截住。沉默的阶段（awaiting-approval /
          celebrate）连这个 span 都不画，否则 flex gap 会在头像右边留一格空白。 */}
      {text !== null && <span className="min-w-0 truncate">{text}</span>}
      {/* 回合级秒表：三条契约照搬（没起点不编造 0.0s / cleanup 落终值 / reduced-motion 不 tick）。
          起点 = 本实例第一次进入可计时阶段的时刻；本组件整回合常驻（不再是 Empty slot 的分段重挂），
          读数因此是「本回合已进行多久」，跨 connecting↔thinking↔calling-tool↔writing↔stalled
          不清零 —— `useToolElapsed` 在 live 翻假时是**冻结**（cleanup 取终值）而非清零，起点存在
          实例 ref 里，翻回真时接着原起点走。 */}
      <TurnStopwatch live={isStopwatchStage(stage)} title={t('chat.runStatus.elapsed')} />
    </PresenceRow>
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
  const { stage, stallLevel, toolName } = useTurnStage()
  const completed = useAuiState((s) => s.message.status?.type === 'complete')
  const identity = useAssistantPresenceIdentity()
  if (!isLast || readOnly) return null
  return (
    <TurnPresenceRow
      stage={stage}
      stallLevel={stallLevel}
      completed={completed}
      toolName={toolName}
      config={config ?? identity.config}
      imageSrc={config ? undefined : identity.imageSrc}
      assistantName={identity.name}
      className={className}
    />
  )
}

/** 后台（detached）run 的在场提示 —— 与上面那行**共用** `PresenceRow`，只是三处不同：
 *   ① 头像状态恒 `working`（服务端只给 `{active, runId, ageMs}`，还原不出动态阶段，绝不猜 ——
 *      这是退役运行条留下的同一条边界，`/run/active` 不扩就不编）；
 *   ② 文案恒 `chat.runStatus.background`（+ `backgroundHint`「完成后自动刷新」）；
 *   ③ 秒表走 `useRunElapsed(anchorMs)` 而不是回合那口 `useToolElapsed`。
 *
 *  🔴 **两口秒表有意保留两份、不收敛**：它们的起点来源根本不同 —— 回合表的起点只能是「本实例第一次
 *  进入可计时阶段」的本地墙钟（`useToolElapsed`，并带 live 冻结/续走语义）；后台表的起点必须来自
 *  服务端 `ageMs` 折算出的 epoch 锚点，否则用户切走再切回就会从 0:00 重来（本批 D 的核心验收项）。
 *  硬要合成一个 hook，就得在一个 hook 里同时表达「锚点优先」与「live 冻结」，而两个形态各自只用
 *  其中一半 —— 那是把两件事捆成一个更难读的东西，不是消灭重复。
 *
 *  🔴 退役运行条那条「显式 key 换实例」的纪律在这里**结构性消失**：后台形态与附着回合形态现在是
 *  两个不同组件、挂在两个不同位点（pendingSlot vs. 最后一条 assistant 消息内），React 不可能把
 *  `startedAtRef` 跨过这条边界复用。 */
export function BackgroundRunPresence({
  active,
  startedAt = null,
  className
}: {
  /** `useBackgroundChatRun().backgroundActive`（own-run 已在那里掩蔽：前台流式回合不会同时冒这条）。 */
  active: boolean
  /** 回合起点（epoch ms，由 `/run/active` 的 `ageMs` 换算）。秒表据此**接续**。 */
  startedAt?: number | null
  className?: string
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const identity = useAssistantPresenceIdentity()
  if (!active) return null
  return (
    <PresenceRow
      testId="background-run-presence"
      botState="working"
      config={identity.config}
      imageSrc={identity.imageSrc}
      className={className}
    >
      <span className="min-w-0 truncate">
        <ShimmerText shiny text={t('chat.runStatus.background')} />
      </span>
      <BackgroundStopwatch anchorMs={startedAt} title={t('chat.runStatus.elapsed')} />
      <span className="truncate text-meta text-ink-fg-3">{t('chat.runStatus.backgroundHint')}</span>
    </PresenceRow>
  )
}

/** 锚点秒表读数（叶子组件，理由同 `TurnStopwatch`：100ms setState 只该影响它自己那一小块）。 */
function BackgroundStopwatch({
  anchorMs,
  title
}: {
  anchorMs: number | null
  title: string
}): React.JSX.Element | null {
  const elapsed = useRunElapsed(anchorMs)
  if (elapsed === null) return null
  return (
    <span className="shrink-0 font-mono text-meta tabular-nums text-ink-fg-3" title={title}>
      {formatRunElapsed(elapsed)}
    </span>
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
    <span className={avatarShellClass(20)} data-testid="panel-bot-avatar" data-bot-state={state}>
      {identity.imageSrc ? (
        <img
          src={identity.imageSrc}
          alt=""
          width={20}
          height={20}
          draggable={false}
          className="h-5 w-5 object-cover"
        />
      ) : (
        <BotAvatar animated size={20} state={state} config={identity.config} />
      )}
    </span>
  )
}
