// AI FAB 的钮面 = **主 agent 头像**（0813 起，取代 sparkles 圆钮 + `.rb-star-border` conic 环）。
//
// 组件只剩两件事：
//   ① 头像本体 —— 主 agent 身份（assistantIdentity）→ bot 配置 / 上传图；
//   ② 低频随机换表情 —— 静态档离散换帧。
//
// 🔴 **轮廓光环整层已删**（0813 dogfood，owner：「右下角那个环绕轮廓的白色亮弧，太丑了去掉吧。
//    默认加点外阴影，不然看不出来区分」）。删的是**两层一起**，不是只删亮弧：
//    · 亮弧（沿 path 跑的 `stroke-dashoffset` 白弧）—— owner 直接点名。
//    · 底环（accent 半透描整个剪影 + `drop-shadow(0 0 2px accent)`）—— 单独留着没有意义：
//      它与身体同属 accent 色系（官方形象正是 orange），本来就交不出「钮 vs 背景」的边界，
//      而那正是 owner 反馈的病根；且它那圈 accent 微光与下面新加的中性外投影是**两个色相
//      的影子叠在一个 56px 的钮上**，只会更浑。目标是「干净的头像钮」不是「留一半装饰」。
//    连带死掉的：`staticFrame` 同源锚点、`BACK_PATH_COUNT` 背层枚举、`roundedSquareOutline()`
//    回落轮廓、`toUnits()` 换算、三个 HALO_* 常量、index.css 的 `.chat-fab-halo-*` 与
//    `@keyframes chat-fab-halo-travel`（全仓无第二处消费点）。
//
// 🔴 外投影用 `filter: drop-shadow`（`.chat-fab-avatar`，index.css）而非 `box-shadow`：钮面是
//    **异形剪影**（bot 轮廓 / 上传图的圆角方），box-shadow 画的是 56px 方盒的影子、与形状对不上。
//    数值取 DESIGN.md §4.3 level-1「raised」既有档，理由与明暗两档的实测见 index.css 那段注释。
//
// 🔴 性能（渲染档位纪律，`frontend/docs/bot-avatar.md`）：0814 起本位点是 **animated 档**
//    （引擎 + 共享 ticker + IntersectionObserver 可见性裁剪），不再是静态档。
//    owner 拍板依据：官方形象是 sphere，实测 `renderAvatar` 0.077ms/帧 → 30fps 常驻仅
//    **0.2% 单核**；且 FAB **只挂在邮件页**（其他页没有这个钮），不构成全局常驻。
//    ⚠️ 但这个结论跟着**用户选的形状**走：组合身体最重的 sunee 是 2.26ms/帧 → 6.8% 单核
//    （形状之间差 29 倍）。若将来把 FAB 铺到更多页面，或 AMBIENT 表加重，须重新评估。
//    投影仍是静态 CSS filter，不进 bot-avatar 的共享 rAF。
//
// 🔴 上传图圆角跟批 Z 的头像容器口径（`AVATAR_SHELL_RADIUS_RATIO`），别处是圆角方、这里也是。

import { useEffect, useState } from 'react'

import { useAssistantIdentity } from '@shared/assistant/assistantIdentity'
import { BotAvatar } from '@shared/bot-avatar/BotAvatar'
import { EXPR_CADENCE, type BotState } from '@shared/bot-avatar/states'
import {
  isAgentAvatarImage,
  OFFICIAL_ASSISTANT_AVATAR
} from '@shared/components/agents/agentAvatarIdentity'
import { AVATAR_SHELL_RADIUS_RATIO } from '@shared/components/agents/avatarShell'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'
import { cn } from '@shared/lib/cn'

/** 头像盒（px）。旧的实心圆钮是 48px，但 bot 头像在 viewBox 里只占 ~81%（sphere 轮廓
 *  maxCoord=122 / 半宽 150），渲到 56 才与旧圆钮视觉等重。 */
export const FAB_AVATAR_PX = 56
/** 上传图边长（px）。 */
const FAB_IMAGE_PX = 44
/** 上传图圆角（px）—— 口径单源是批 Z 的 `avatarShell.ts`：用户的照片在别处是圆角方，
 *  在 FAB 也必须是同一档，不能变成正圆。`min()` 的另一支在本位点恒不生效
 *  （44×22%=9.68px < --r-card 12px），故这里只要那个比例的数值形态。 */
export const FAB_IMAGE_RADIUS_PX = FAB_IMAGE_PX * AVATAR_SHELL_RADIUS_RATIO

/** 常驻头像的状态池：只从这几个「友好、不惊扰」的状态里轮换。表情索引的语义单源仍是
 *  `states.POOLS`（本文件不手抄任何表情号）—— 0814 起轮换的是**状态**而不是表情索引，
 *  见下面 `useFabState` 的注释。 */
const FAB_FACE_STATES: readonly BotState[] = ['idle', 'happy', 'curious', 'playful', 'proud']
/** 首帧状态（= BotAvatar 不传 state 时的默认，挂载不跳脸）。 */
const FAB_STATE_DEFAULT: BotState = 'idle'

/** 换脸节拍 = **引擎自己的 idle 档**（`EXPR_CADENCE.idle`，9–16s）。
 *
 *  0813 dogfood（owner：「切换时间也太长了，感觉很久才会动一下」）把原来的固定 45s 撤了。45s
 *  当初正是从这个区间推出来的（「idle cadence 的 3–5 倍」），既然那个推导被实测否掉，就回到源头
 *  的区间本身，而不是再拍一个新魔数 —— 顺带消灭一处手抄：FAB 与引擎共用同一份节拍词表，改一处
 *  即两处。
 *
 *  🔴 是**区间**不是固定间隔：每次在 [min, max] 内均匀随机取下一次延迟（与 engine.ts 的
 *  `scheduleExpression` 逐字同款取法），所以它是「活的」而不是节拍器。故实现用自排的 timeout，
 *  不是 setInterval。 */
export const FAB_FACE_CADENCE_MS = EXPR_CADENCE.idle

/** 低频随机换**状态**。`enabled=false`（reduced-motion / 上传图）时连 timer 都不排，
 *  恒返回首帧状态。
 *
 *  🔴 0814 dogfood（owner：「表情/状态切换明显很快、很突然，我想在现在的表情切换基础上
 *  加鼠标跟随」）之前，这里换的是 `expressionIndex`，而**静态档**的 `expressionIndex` 走
 *  `staticFrame` —— 离散换帧、**零过渡**，那正是「很突然」的成因；且静态档结构上拿不到 gaze
 *  （`mouseInteractive` 只在 animated 档生效）。改成换 `state` 之后，过渡 / 状态内的表情轮换 /
 *  眨眼节奏 / 空闲微动全部交回引擎，轮换语义不变（仍是这五个友好状态），但每次换脸带
 *  600ms spring 过渡。 */
function useFabState(enabled: boolean): BotState {
  const [state, setState] = useState<BotState>(FAB_STATE_DEFAULT)

  useEffect(() => {
    if (!enabled) return
    let current = FAB_STATE_DEFAULT
    let timer = 0
    const [min, max] = FAB_FACE_CADENCE_MS
    const arm = (): void => {
      timer = window.setTimeout(
        () => {
          // 永不连续重复（同 useShowcaseState 的取法）
          const pool = FAB_FACE_STATES.filter((candidate) => candidate !== current)
          current = pool[Math.floor(Math.random() * pool.length)]
          setState(current)
          arm()
        },
        min + Math.random() * (max - min)
      )
    }
    // 有意**不**做 0ms kickoff（那是 showcase 巡演的语义）：FAB 从默认脸起步，挂载不跳。
    arm()
    return (): void => {
      window.clearTimeout(timer)
    }
  }, [enabled])

  return enabled ? state : FAB_STATE_DEFAULT
}

export function ChatFabAvatar(): React.JSX.Element {
  const reduce = useReducedMotion()
  const identity = useAssistantIdentity()
  const avatar = identity.avatar
  // 与 TurnPresence 同一条投影：bot 配置直接用；上传图走静态 img（表情对图片无意义）；
  // 未配置 / legacy = 官方形象 sphere/orange。
  const imageSrc = isAgentAvatarImage(avatar) ? avatar.data : undefined
  const config = avatar?.type === 'bot' ? avatar : OFFICIAL_ASSISTANT_AVATAR

  // 🔴 表情**只由低频 interval 驱动**：hover 不换脸（0813 dogfood owner：「hover 不要改表情啊，
  //    只是头像放大 + tips」）。故本组件不再收 `hovered` —— 没有输入就不可能有第二条驱动路径。
  //    0814 加的 `mouseInteractive` **不违反**这一条：gaze 动的是头部朝向与眼睛偏移，
  //    表情（状态与索引）不受指针影响；「hover 不改表情」与「眼睛跟着鼠标」是两回事。
  //    ⚠️ Agents 页那六张卡 hover 换表情（`useAvatarHoverShowcase`）是另一条链、另一次 dogfood
  //    通过的行为，本文件从未 import 它，删这里不影响那里。
  const animated = !reduce && imageSrc === undefined
  const state = useFabState(animated)

  return (
    <span
      className={cn(
        // 外投影（异形剪影 → drop-shadow）；hover 放大跟随 FAB 按钮的 `group`。
        'chat-fab-avatar grid shrink-0 place-items-center',
        'transition-transform duration-fast ease-standard group-hover:scale-110',
        'motion-reduce:transition-none'
      )}
      style={{ width: FAB_AVATAR_PX, height: FAB_AVATAR_PX }}
    >
      {imageSrc ? (
        <img
          src={imageSrc}
          alt=""
          data-testid="chat-fab-avatar-image"
          className="object-cover"
          style={{
            width: FAB_IMAGE_PX,
            height: FAB_IMAGE_PX,
            borderRadius: FAB_IMAGE_RADIUS_PX
          }}
        />
      ) : (
        <BotAvatar
          config={config}
          state={state}
          size={FAB_AVATAR_PX}
          animated={animated}
          mouseInteractive
        />
      )}
    </span>
  )
}
