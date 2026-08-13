// AI FAB 的「主 agent 头像 + 轮廓光环」（0813 追加，取代 sparkles 圆钮 + `.rb-star-border` conic 环）。
//
// 三件事挤在同一个组件里不是偷懒，是因为它们必须共用同一份几何：
//   ① 头像本体 —— 主 agent 身份（assistantIdentity）→ bot 配置 / 上传图；
//   ② 光环 —— 沿**同一帧的真实剪影**（head + 背层）描边（见下「同源」）；
//   ③ 低频随机换表情 —— 静态档离散换帧。
//
// 🔴 同源（本组件存在的理由）：表情索引与形状由这里唯一决定，`staticFrame(expr, surface)`
//    的产物一边喂给光环的 `<path d>`、一边经 `expressionIndex` prop 让 `BotAvatar` 走**同一次**
//    staticFrame 调用 —— 该函数带模块级 WeakMap 缓存，同参恒返回**同一个对象**（实测
//    `staticFrame(0, SHAPES.sphere) === staticFrame(0, SHAPES.sphere)`），故两处拿到的是同一个
//    `head` 字符串。光环绝不另画一条近似轮廓：换形状/换表情时结构上不可能错位（测试直接断言
//    `[data-fab-halo]` 的 d === `[data-bot-head]` 的 d）。
//
// 🔴 性能（渲染档位纪律，`frontend/docs/bot-avatar.md`）：光环是**纯 CSS 动画**
//    （`stroke-dashoffset`，见 index.css `.chat-fab-halo-arc`）—— 不注册 bot-avatar 的共享 rAF
//    ticker、不让常驻的 FAB 变成第 4 个 animated 位点。头像本体恒静态档（零引擎零 ticker），
//    唯一的定时器是 45s 换脸的单个 interval。
//
// 🔴 裁切口径：光环 SVG 与 BotAvatar 用**同一个 viewBox、同一个像素尺寸** ⇒ 被同一个 SVG
//    viewport 裁。cube/cylinder/cone 的头部本来就冲出 viewBox（研究 §2.3），此时光环与被裁的
//    头部在同一处断开，不会出现「环飘在头像外面」。代价：cursor 形在极点会被裁掉不到 1px 的
//    弧宽（本文件表情池实测 maxCoord=142.2，+ 弧半宽 12 = 154 > 150）——比错位可接受得多。
//
// 🔴 上传图没有轮廓 path ⇒ 回落**圆角方形**（跟批 Z 的头像容器口径，见下面 ratio 常量的红标）：
//    喂一条圆角方形 path 给同一套描边（不另起一套 CSS 光圈），且照片自己的圆角与它同一个来源。
//
// 🔴 **有意不套 `avatarShellClass` 那种 `overflow-hidden` 裁切壳**：bot 分支在这里根本没有
//    「承载容器」—— 轮廓本身就是边界，光环还要贴着它往外描。套上裁切壳(a) 拆不掉真正的截断
//    （那是 SVG viewBox 自己那层，avatarShell.ts 头注释也写明了），(b) 反而会在四角多切掉一段
//    光环。chat 侧 TurnPresence 的 bot 同样无壳，本位点与它同档。
//
// 视觉选型（截图逐档比过，56px 实尺 + 明暗双主题 + 7 组形状×配色）：
//   · 底环描**整个剪影**（head + mickey 耳 / cursor 锥的背层），否则耳朵/锥体裸着没环；
//     亮弧**只跑主轮廓**一条 —— 背层各跑各的会变成三盏灯各转各的，常驻元素太吵。
//   · 亮弧用字面 `white` 而非提亮的 accent：沿用旧环那次 dogfood 的结论（accent 高光贴着
//     accent 系的身体看不出旋转）。官方默认形象正是 orange，是最容易踩中的那一档。

import { useEffect, useState } from 'react'

import { useAssistantIdentity } from '@shared/assistant/assistantIdentity'
import { BotAvatar } from '@shared/bot-avatar/BotAvatar'
import { staticFrame } from '@shared/bot-avatar/engine'
import { BACK_PATH_COUNT, BOT_VIEW_BOX, SHAPES } from '@shared/bot-avatar/shapes'
import { POOLS, type BotState } from '@shared/bot-avatar/states'
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
/** viewBox 半宽（`BOT_VIEW_BOX` = '-150 -150 300 300'）—— 用于 px ↔ 用户单位换算。 */
const VIEW_BOX_HALF = 150

/** 头像容器口径单源（批 Z 的 `avatarShell.ts`）——FAB 的 bot 分支**没有**承载容器
 *  （轮廓即边界，见文件头），但上传图必须跟同一档，否则用户的照片在别处是圆角方、
 *  在 FAB 是正圆。这里要的是那个比例的**数值**形态：光环得沿同一条边界描 path，
 *  纯 CSS 圆角交不出 path。`min()` 的另一支在本位点恒不生效：44×22%=9.68px < --r-card 12px。 */
/** 上传图圆角（px）与光环回落轮廓的圆角（用户单位）—— 后者由前者换算，二者不可能各调各的。 */
const FAB_IMAGE_RADIUS_PX = FAB_IMAGE_PX * AVATAR_SHELL_RADIUS_RATIO

/** 底环描边宽度（viewBox 用户单位）。描边**居中**在轮廓上、整层画在头像**之下** ⇒ 内半被不
 *  透明的头像盖住，露在外面的是 STROKE/2（56px 渲染下 1px = 300/56 ≈ 5.36 单位）。 */
const HALO_RIM_STROKE = 18
/** 亮弧比底环**更宽**：颜色对比在浅色主题下会被背景吃掉一部分，宽度差是那时唯一还在的判据。 */
const HALO_ARC_STROKE = 24
/** 亮弧占周长的百分比。`pathLength=100` 把周长归一之后，dasharray 的单位就是「百分点」——
 *  于是绕圈速度与形状/表情的实际周长**无关**（不必 getTotalLength 归一）。 */
const HALO_ARC_PERCENT = 16

/** 常驻头像的表情池：只从这几个「友好、不惊扰」的状态取池。表情索引的语义单源仍是
 *  `states.POOLS`（本文件不手抄任何表情号）。实测本池在 8 形上的 head 最大坐标 ≤142.2
 *  （viewBox 半宽 150），即恰好避开了 mickey 转头那些冲出画布的极端帧。 */
const FAB_FACE_STATES: readonly BotState[] = ['idle', 'happy', 'curious', 'playful', 'proud']
const FAB_FACES: readonly number[] = Array.from(
  new Set(FAB_FACE_STATES.flatMap((state) => POOLS[state]))
)
/** 首帧 = idle 池首（与不传 expressionIndex 时 BotAvatar 的默认完全一致，挂载不跳脸）。 */
const FAB_FACE_DEFAULT = POOLS.idle[0]
/** hover 反馈用的确定性表情（happy 池首）——取代已退役的 sparkles 图标 hover 动画。 */
const FAB_FACE_HOVER = POOLS.happy[0]

/** 换脸节拍。依据：引擎自己的池内轮换 idle 档是 9–16s（`EXPR_CADENCE.idle`，且只在 animated
 *  档发生）、showcase 巡演是 2.4s —— 那两个都有人正盯着看。FAB 是常驻元素、没人盯着它，取
 *  45s ≈ idle cadence 的 3–5 倍：读一封邮件大概换 1 次脸（够「活着」），远低于会分心的频率。 */
export const FAB_FACE_INTERVAL_MS = 45_000

/** 上传图回落的圆角方形轮廓（居中于原点，用户单位）。写成 `<path>` 而非 `<rect>`：亮弧的匀速
 *  绕圈靠 `pathLength` 归一，而 `pathLength` 在 `<path>` 上的支持最保险，且这样两条分支共用
 *  同一套描边/动画代码。 */
function roundedSquareOutline(half: number, radius: number): string {
  const inner = half - radius
  const arc = `A ${radius} ${radius} 0 0 1`
  return [
    `M ${-inner} ${-half}`,
    `H ${inner}`,
    `${arc} ${half} ${-inner}`,
    `V ${inner}`,
    `${arc} ${inner} ${half}`,
    `H ${-inner}`,
    `${arc} ${-half} ${inner}`,
    `V ${-inner}`,
    `${arc} ${-inner} ${-half}`,
    'Z'
  ].join(' ')
}

/** px → viewBox 用户单位（两个 SVG 的 viewBox 与像素尺寸都相同，一个换算常量够用）。 */
function toUnits(px: number): number {
  return (px * VIEW_BOX_HALF * 2) / FAB_AVATAR_PX
}

/** 低频随机换脸（静态档离散换帧，零引擎）。`enabled=false`（reduced-motion / 上传图）时
 *  连 interval 都不挂，恒返回首帧。 */
function useFabFace(enabled: boolean): number {
  const [face, setFace] = useState(FAB_FACE_DEFAULT)

  useEffect(() => {
    if (!enabled) return
    let current = FAB_FACE_DEFAULT
    const advance = (): void => {
      // 永不连续重复（同 useShowcaseState 的取法）
      const pool = FAB_FACES.filter((candidate) => candidate !== current)
      current = pool[Math.floor(Math.random() * pool.length)]
      setFace(current)
    }
    // 有意**不**做 0ms kickoff（那是 showcase 巡演的语义）：FAB 从默认脸起步，挂载不跳。
    const timer = window.setInterval(advance, FAB_FACE_INTERVAL_MS)
    return (): void => {
      window.clearInterval(timer)
    }
  }, [enabled])

  return enabled ? face : FAB_FACE_DEFAULT
}

export interface ChatFabAvatarProps {
  /** 整钮 hover（由 FAB 的 group 传入）——驱动确定性 hover 表情 + 光环提亮。 */
  hovered?: boolean
}

export function ChatFabAvatar({ hovered = false }: ChatFabAvatarProps): React.JSX.Element {
  const reduce = useReducedMotion()
  const identity = useAssistantIdentity()
  const avatar = identity.avatar
  // 与 TurnPresence 同一条投影：bot 配置直接用；上传图走静态 img（表情对图片无意义）；
  // 未配置 / legacy = 官方形象 sphere/orange。
  const imageSrc = isAgentAvatarImage(avatar) ? avatar.data : undefined
  const config = avatar?.type === 'bot' ? avatar : OFFICIAL_ASSISTANT_AVATAR

  const idleFace = useFabFace(!reduce && imageSrc === undefined)
  const expressionIndex = hovered && !reduce ? FAB_FACE_HOVER : idleFace

  // 🔴 同源锚点：这一帧既喂给光环的 d，也（经 expressionIndex）是 BotAvatar 的 head path。
  const frame = imageSrc ? null : staticFrame(expressionIndex, SHAPES[config.shape])
  // 底环描**整个剪影** = head + BotAvatar 实际会画的那几条背层（mickey 双耳 / cursor 锥体）；
  // 条数取 BACK_PATH_COUNT，与 BotAvatar 的取法逐字一致，不会描出一条它不画的路径。
  const rimOutlines = frame
    ? [
        frame.head,
        ...Array.from(
          { length: BACK_PATH_COUNT[config.shape] },
          (_, i) => frame.back[i] ?? ''
        ).filter(Boolean)
      ]
    : [roundedSquareOutline(toUnits(FAB_IMAGE_PX) / 2, toUnits(FAB_IMAGE_RADIUS_PX))]
  // 亮弧只跑主轮廓一条：背层各跑各的 = 三盏灯各转各的，常驻元素太吵。
  const arcOutline = rimOutlines[0]

  return (
    <span
      className={cn(
        'relative grid shrink-0 place-items-center',
        'transition-transform duration-fast ease-standard group-hover:scale-105',
        'motion-reduce:transition-none'
      )}
      style={{ width: FAB_AVATAR_PX, height: FAB_AVATAR_PX }}
    >
      {/* 光环层（在头像**之下** —— DOM 序即绘制序，描边内半被头像盖住只露外沿） */}
      <svg
        viewBox={BOT_VIEW_BOX}
        width={FAB_AVATAR_PX}
        height={FAB_AVATAR_PX}
        aria-hidden="true"
        data-testid="chat-fab-halo"
        className={cn(
          'pointer-events-none absolute inset-0 opacity-90',
          'transition-opacity duration-base ease-standard group-hover:opacity-100',
          'motion-reduce:transition-none'
        )}
      >
        {/* 底环 + 外发光（静态：不随帧重算，drop-shadow 只在换脸那一帧重绘） */}
        {rimOutlines.map((d, i) => (
          <path
            key={i}
            data-fab-halo="rim"
            className="chat-fab-halo-glow"
            d={d}
            fill="none"
            stroke="rgb(var(--c-accent) / 0.5)"
            strokeWidth={HALO_RIM_STROKE}
          />
        ))}
        {/* 亮弧：pathLength 归一 → dasharray 是「百分点」，绕圈速度与周长无关。
            白色不是随手挑的 —— 沿用旧环那次 dogfood 的结论（accent 高光贴着 accent 系身体
            看不出旋转），且官方默认形象正是 orange。固定 white 不随主题翻转。 */}
        <path
          data-fab-halo="arc"
          className={reduce ? undefined : 'chat-fab-halo-arc'}
          d={arcOutline}
          fill="none"
          stroke="white"
          strokeWidth={HALO_ARC_STROKE}
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={`${HALO_ARC_PERCENT} ${100 - HALO_ARC_PERCENT}`}
        />
      </svg>
      {imageSrc ? (
        <img
          src={imageSrc}
          alt=""
          data-testid="chat-fab-avatar-image"
          className="relative object-cover"
          style={{
            width: FAB_IMAGE_PX,
            height: FAB_IMAGE_PX,
            borderRadius: FAB_IMAGE_RADIUS_PX
          }}
        />
      ) : (
        <BotAvatar
          config={config}
          expressionIndex={expressionIndex}
          size={FAB_AVATAR_PX}
          className="relative"
        />
      )}
    </span>
  )
}
