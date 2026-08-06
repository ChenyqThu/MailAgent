// WP-14 — composer 上方的**回合级运行状态条**（lobe 式：一条常驻、贴着输入框、跟着回合走）。
//
// 为什么要它（research C §1.2）：进行中的所有状态都长在消息流里 —— 阶段行在 assistant 气泡的
// Empty slot、耗时在每张工具卡上、后台运行提示在 pendingSlot。滚上去看历史，就再也看不见「现在
// 到底在干什么、跑了多久」。这条线把这三件事收到一个**位置固定**的地方。
//
// 三个来源，一处呈现：
//   1. 阶段 + 工具名 = `useThreadTurnStage()`（thread 作用域复用同一个纯函数 `deriveTurnStage`，
//      零 gateway 改动、零新状态通道）；
//   2. 回合秒表 = 渲染器墙钟（`useRunElapsed`），detached run 用 `/api/ai/run/active` 的 `ageMs`
//      换算出的起点**接续**，所以切走再切回不清零；
//   3. detached run 的「AI 还在后台跑」= `useBackgroundChatRun().backgroundActive` —— 原先那块
//      `backgroundRunNotice`（pendingSlot 里、随消息流滚动）已**收编进本条**，旧位置不再渲染，
//      不留双份。
//
// 有意不做的两件事（都在 research C §2.2 / WP-14 范围外）：
//   - detached run 的「正在干什么」**动态**文案：`/run/active` 只给 `{active, runId, ageMs}`，要还原
//     动态阶段得让 gateway 在 registry 里随流更新一份 stage 快照并扩端点 = 新状态通道（S 级后续）。
//     这里**降级为静态文案 + 已运行时长**，绝不猜。
//   - 消息流里的 `TurnStatusLine` 一个字节没动（owner 08-05 拍板：运行条上线后先并存，dogfood
//     一轮再议是否收窄）。
//
// 一份组件双面挂载（遵守本仓「两个 composer 一份组件」纪律）：通用面 `AgentThread` 的
// ViewportFooter、邮件面 `AssistantThread` 的 Viewport 与 composer 之间。两处的排版留白差异由
// 调用方给的 `className` 承担，组件本身只管自己那颗药丸。

import { useTranslation } from 'react-i18next'

import { cn } from '@shared/lib/cn'
import { DotMatrix, type DotMatrixState } from '@shared/components/ui/DotMatrix'
import { ShimmerText } from '@shared/components/ShimmerText'
import { toolTitleKey } from '@shared/components/chat/tool_steps'
import { formatRunElapsed, useRunElapsed } from '@shared/assistant/runtime/useRunElapsed'
import { useThreadTurnStage } from '@shared/assistant/runtime/useThreadTurnStage'
import type { TurnStage } from '@shared/assistant/runtime/useTurnStage'

/** 运行条会渲染的形态。前四个来自本地（附着）回合的阶段，`background` 是 detached run。
 *  阶段机的另外三态**不出现**：`idle`（没在跑）、`error`（终态，消息流里的错误 footer 才是那条
 *  线的归宿）、`awaiting-approval`（审批卡自己就是状态 —— 与 `TurnStatusLine` 同一条纪律；顺带
 *  避免历史会话里被重放的旧审批卡在这里挂一个从打开会话才起算的假秒表）。 */
type RunStatusVariant = 'connecting' | 'thinking' | 'calling-tool' | 'writing' | 'background'

/** 🔴 Record 而不是数组/Set：`satisfies` 让**两个方向**都变成编译错误 —— 多写一个不属于
 *  `RunStatusVariant` 的阶段是多余属性错误，上游给 `TurnStage` 加了新态而这里漏判则是缺属性错误
 *  （沿用 `toolPhase.ts::RESOLUTION_WITHOUT_DECISION` 的先例）。值 = 该阶段是否让运行条出现。 */
const STAGE_IS_LIVE = {
  idle: false,
  connecting: true,
  thinking: true,
  'calling-tool': true,
  'awaiting-approval': false,
  writing: true,
  stalled: false,
  error: false
} satisfies Record<TurnStage, boolean>

/** 类型收窄的可见性判据（真 → 该 stage 必是 RunStatusVariant，调用侧不需要断言）。 */
function isLiveStage(stage: TurnStage): stage is Exclude<RunStatusVariant, 'background'> {
  return STAGE_IS_LIVE[stage]
}

const DOT_STATE: Record<RunStatusVariant, DotMatrixState> = {
  connecting: 'connecting',
  thinking: 'thinking',
  'calling-tool': 'searching',
  writing: 'streaming',
  background: 'loading'
}

export interface ThreadRunStatusBarProps {
  /** detached（后台）run 的真值，来自 `useBackgroundChatRun`。true 时压过本地阶段：此时渲染器
   *  手上根本没有流，本地阶段必然是 idle。 */
  backgroundActive?: boolean
  /** detached run 的回合起点（epoch ms，由 `/run/active` 的 `ageMs` 换算）。秒表据此接续。 */
  backgroundStartedAt?: number | null
  /** 两个挂载面的留白差异（邮件面要自己补 composer 的左右内距；通用面由 footer 的 gap 管）。 */
  className?: string
}

export function ThreadRunStatusBar({
  backgroundActive = false,
  backgroundStartedAt = null,
  className
}: ThreadRunStatusBarProps): React.JSX.Element | null {
  const { stage, toolName } = useThreadTurnStage()

  // 🔴 显式 key：后台形态与本地形态由同一个组件承载，不给 key 时 React 会**复用同一个实例**跨过
  // 这条边界，`useRunElapsed` 的 startedAtRef 于是把后台 run 的起点带进紧接着的附着回合（真实次序：
  // store 先翻 running、条子仍显示 background，随后 localRunning 才把 backgroundActive 打假 —— 中间
  // 没有「整条 null」的空档来卸载它）。换 key = 换实例 = 新回合重新起表。本地各阶段之间 key 不变，
  // 所以 connecting→thinking→calling-tool 的读数照常连续。
  if (backgroundActive) {
    return (
      <RunStatusRow
        key="background"
        variant="background"
        anchorMs={backgroundStartedAt}
        className={className}
      />
    )
  }
  if (!isLiveStage(stage)) return null
  return (
    <RunStatusRow
      key="local"
      variant={stage}
      toolName={toolName}
      anchorMs={null}
      className={className}
    />
  )
}

/** 真正的那一行。**只在运行条可见时挂载**，这是回合秒表「不跨回合累计」的实现方式：可见性一断
 *  （回合结束、或中途进审批门）整行就卸载，时钟状态随之消失；再出现时是新实例、从 0 起表（见
 *  useRunElapsed 契约 1）。读数因此是「本段连续可见的运行时长」，审批批准后重新起段。 */
function RunStatusRow({
  variant,
  toolName,
  anchorMs,
  className
}: {
  variant: RunStatusVariant
  toolName?: string | undefined
  anchorMs: number | null
  className?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const elapsed = useRunElapsed(anchorMs)

  const label = useRunStatusLabel(variant, toolName)
  const hint =
    variant === 'background' ? t('chat.runStatus.backgroundHint') : t('chat.runStatus.safeToLeave')

  return (
    <div
      data-run-status-bar={variant}
      className={cn(
        'flex max-w-full shrink-0 items-center gap-1.5 self-start rounded-lg border border-[var(--hairline)] bg-ink-2 px-2.5 py-1 text-aux text-ink-fg-2',
        className
      )}
    >
      <DotMatrix state={DOT_STATE[variant]} className="size-3.5" aria-hidden />
      {/* 窄容器（320px 侧栏）里 label 与 hint 都可收缩截断，秒表恒不缩 —— 「跑了多久」是这条线
          最不该丢的那一格。词表外的裸工具名（mcp__x__y）超长时也在这里被截住，不会撑破药丸。 */}
      <span className="min-w-0 truncate">
        <ShimmerText shiny text={label} />
      </span>
      {elapsed !== null && (
        <>
          <span aria-hidden className="shrink-0 text-ink-fg-3">
            ·
          </span>
          <span
            className="shrink-0 font-mono tabular-nums text-ink-fg-3"
            title={t('chat.runStatus.elapsed')}
          >
            {formatRunElapsed(elapsed)}
          </span>
        </>
      )}
      <span className="ml-1 truncate text-meta text-ink-fg-3">{hint}</span>
    </div>
  )
}

/** 形态 → 一句人话。`calling-tool` 复用工具卡那份标题表（`toolTitleKey`），词表未登记的名字
 *  （connector 的 `mcp__x__y`、新工具）原样落回裸标识符 —— 与 `ToolTraceCard` 逐字同款的降级，
 *  绝不返回缺翻译占位符。 */
function useRunStatusLabel(variant: RunStatusVariant, toolName?: string): string {
  const { t } = useTranslation()
  if (variant === 'calling-tool') {
    const key = toolName == null ? null : toolTitleKey(toolName)
    const tool = key === null ? (toolName ?? '') : t(key)
    // 工具名拿不到（理论上不会：calling-tool 必带 toolName）→ 退回通用「思考中」，不拼半句话。
    if (tool === '') return t('chat.status.thinking')
    return t('chat.runStatus.callingTool', { tool })
  }
  if (variant === 'background') return t('chat.runStatus.background')
  if (variant === 'writing') return t('chat.runStatus.writing')
  if (variant === 'connecting') return t('chat.runStatus.connecting')
  return t('chat.status.thinking')
}
