// 灵动 bot 头像 —— 唯一 React 绑定（engine/ticker/states/shapes/colors/geometry 全部无 React）。
// 双档设计（v1 纪律不变）：
//   静态档（默认）= 渲染 state 池首表情的一帧 SVG，零引擎、零 ticker、零定时器 ——
//     列表位点（数百个 22px 实例同屏）与 reduced-motion 回退都走这里，且静态帧有
//     模块级缓存（engine.staticFrame）：同 shape×表情只算一次几何；
//   动画档（animated）= 引擎 + 共享 ticker + IntersectionObserver 可见性裁剪，
//     位点按设计只有 2-4 个同屏（chat 回合头 / 面板头 / 抽屉预览）。v2 起动画档在
//     ambient 活跃状态下不 settle（30fps 限频常驻重绘）——新增 animated 位点须过性能评估。
// reduced-motion 必须 JS 层短路（动画帧经 setAttribute 直写 DOM，CSS media 管不到），
// 恒回静态档：身份/状态仍可读，动画整个不出现。
// v2 渲染结构（镜像 avatar-lab standalone runtime）：
//   defs/clipPath(head) → g[flip] → g[motion: ambient 平移] →
//     back×N(mickey 耳/cursor 锥/头后附属曲面) → head path → g[clip] → eye×2 →
//     front×M(转到头前的附属曲面)
// 头部 path 每帧都会变（3D 转头），所以 head 与 clipPath 都由 writeFrame 直写。
// svg overflow: visible 镜像 lab（studio 画布与 standalone 导出都设了）——组合身体
// 的附属曲面（Sunee 太阳芒等）会略超出 viewBox，不设则被 SVG 自身裁掉；外层是否再
// 套裁剪壳（圆/方）由消费点决定（AgentAvatar 的外壳归它自己管）。

import { useEffect, useId, useLayoutEffect, useMemo, useRef } from 'react'

import { useReducedMotion } from '../hooks/useReducedMotion'
import { COLORS } from './colors'
import { BotFaceEngine, staticFrame } from './engine'
import { BACK_PATH_COUNT, BOT_VIEW_BOX, FRONT_PATH_COUNT, SHAPES } from './shapes'
import { BLINK, POOLS } from './states'
import { registerStaticBlink, unregisterStaticBlink } from './staticBlink'
import type { StaticBlinkClient } from './staticBlink'
import { registerTicker, unregisterTicker } from './ticker'
import type { BotColor, BotShape, BotState, EngineFrame } from './types'
import { useBotAvatarTheme } from './useBotAvatarTheme'

export interface BotAvatarProps {
  /** 缺省 sphere / orange（官方助手形象） */
  config?: { shape?: BotShape; color?: BotColor }
  state?: BotState
  /** 静态档指定表情索引（缺省 = `POOLS[state]` 池首）。索引语义单源是 `states.POOLS` /
   *  `expressions.ts`，越域 = 调用方 bug（与 `POOLS[state][0]` 同样不做防御）。animated 档
   *  忽略它 —— 那一档的表情由引擎按 cadence 调度。 */
  expressionIndex?: number
  size?: number
  title?: string
  className?: string
  /** 显式声明才动 —— 新增 animated 位点须过性能评估 */
  animated?: boolean
  flipX?: boolean
  /** 眼睛/头部跟随**全局**指针（组件可见时监听，不是 hover 才动）。仅 animated 档
   *  生效；不可见时随 ticker 一起停监听；reduced-motion 恒不激活。 */
  mouseInteractive?: boolean
}

/** 指针位置 → 归一 gaze（clamp(±0.6) 后归一到 [-1,1]；分母用视窗尺寸 ——
 *  语义是「跟随全局指针」，眼睛随指针横穿整屏渐进转动）。 */
function pointerGaze(pointer: number, center: number, extent: number): number {
  if (!(extent > 0)) return 0
  const clamped = Math.max(-0.6, Math.min(0.6, (pointer - center) / extent))
  return clamped / 0.6
}

interface FrameRefs {
  motion: SVGGElement | null
  clip: SVGPathElement | null
  head: SVGPathElement | null
  back: Array<SVGPathElement | null>
  front: Array<SVGPathElement | null>
  eyes: Array<SVGPathElement | null>
}

export function BotAvatar({
  config,
  state = 'idle',
  expressionIndex,
  size = 40,
  title,
  className,
  animated = false,
  flipX = false,
  mouseInteractive = false
}: BotAvatarProps): React.JSX.Element {
  const reducedMotion = useReducedMotion()
  const isAnimated = animated && !reducedMotion
  const theme = useBotAvatarTheme()

  const shape: BotShape = config?.shape ?? 'sphere'
  const color: BotColor = config?.color ?? 'orange'
  const shapeDef = SHAPES[shape]
  const palette = COLORS[color][theme]
  const backCount = BACK_PATH_COUNT[shape]
  const frontCount = FRONT_PATH_COUNT[shape]

  // clipPath id 每实例唯一：多实例同屏时 url(#…) 按文档序解析到第一个同名节点，
  // 共享 id 会让所有实例吃同一个（可能已卸载的）裁剪形状。useId 的冒号在
  // url(#…) 引用里部分环境解析不稳，剥掉。
  const rawId = useId()
  const clipId = useMemo(() => `bot-clip-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`, [rawId])

  // 静态档的那一帧（模块级缓存）；动画档也用它作 SSR/首帧基线（= 引擎初始快照：池首）
  const frame = useMemo(
    () => staticFrame(expressionIndex ?? POOLS[state][0], shapeDef),
    [expressionIndex, state, shapeDef]
  )

  const svgRef = useRef<SVGSVGElement | null>(null)
  const refs = useRef<FrameRefs>({
    motion: null,
    clip: null,
    head: null,
    back: [],
    front: [],
    eyes: []
  })
  const engineRef = useRef<BotFaceEngine | null>(null)
  // 引擎创建 effect 不依赖 state（换状态不得重建引擎），经 ref 取创建时刻的最新值
  const stateRef = useRef(state)

  // 每次 render 后：把 state prop 灌进引擎（内部同值 no-op），并用引擎快照回写
  // DOM —— React 刚按静态 frame 写过几何属性，若不回写，动画中的重渲染会把画面
  // 瞬间打回池首帧。layout 时机保证发生在 paint 前，肉眼无闪烁。
  useLayoutEffect(() => {
    stateRef.current = state
    const engine = engineRef.current
    if (!engine) return
    engine.setState(state)
    writeFrame(refs.current, engine.snapshot())
  })

  // 静态档眨眼（0813）：不建引擎不进共享 rAF ticker —— 挂模块级 blink registry
  // （单例低频调度 + 并发上限，见 staticBlink.ts 纪律注释），仅眨眼窗口内有帧
  // 活动，间隙真 idle。reduced-motion 不注册；BLINK=null 的闭眼/机械态不注册。
  // layout 时机：state 变更时 React 同一 commit 已重写基线帧，注销须在 paint 前
  // 生效，晚到的眨眼帧才不会盖掉新表情。
  useLayoutEffect(() => {
    if (isAnimated || reducedMotion || BLINK[state] === null) return
    const client: StaticBlinkClient = {
      state,
      surface: shapeDef,
      // 🔴 必须与上面 `frame` 用的是同一个索引：眨眼窗口内 registry 会按这个索引重算
      // 眼 path，取池首就会在 FAB（批 X 用 expressionIndex 低频换脸）眨眼的那一刻把脸
      // 跳回池首。合并 W(眨眼) × X(expressionIndex) 时发现，两批各自都对。
      expressionIndex: expressionIndex ?? POOLS[state][0],
      eyes: () => refs.current.eyes
    }
    registerStaticBlink(client)
    return () => unregisterStaticBlink(client)
  }, [isAnimated, reducedMotion, state, shapeDef, expressionIndex])

  useEffect(() => {
    if (!isAnimated) return
    const engine = new BotFaceEngine({ surface: shapeDef, initialState: stateRef.current })
    engineRef.current = engine
    const client = (now: number): void => {
      const next = engine.tick(now)
      if (next) writeFrame(refs.current, next)
    }

    // mouseInteractive：可见时监听**全局** pointermove，把指针相对组件中心的位置
    // 折算成归一 gaze 交给引擎（v2 引擎内部转成头部朝向 + 眼睛偏移叠加）。
    const onPointerMove = (event: PointerEvent): void => {
      const node = svgRef.current
      if (!node) return
      const rect = node.getBoundingClientRect()
      engine.setGaze(
        pointerGaze(event.clientX, rect.left + rect.width / 2, window.innerWidth),
        pointerGaze(event.clientY, rect.top + rect.height / 2, window.innerHeight)
      )
    }

    // 可见性裁剪：不可见即从共享 ticker 注销。环境无 IO（happy-dom/老 WebView）时
    // 按恒可见处理 —— 宁可多画不可不画。指针监听与 ticker 同生命周期。
    let registered = false
    const setRegistered = (want: boolean): void => {
      if (want === registered) return
      registered = want
      if (want) {
        registerTicker(client)
        if (mouseInteractive) window.addEventListener('pointermove', onPointerMove)
      } else {
        unregisterTicker(client)
        if (mouseInteractive) window.removeEventListener('pointermove', onPointerMove)
      }
    }
    let observer: IntersectionObserver | null = null
    const el = svgRef.current
    if (el && typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver((entries) => {
        setRegistered(entries.some((entry) => entry.isIntersecting))
      })
      observer.observe(el)
    } else {
      setRegistered(true)
    }

    return () => {
      observer?.disconnect()
      setRegistered(false)
      engineRef.current = null
    }
  }, [isAnimated, shapeDef, mouseInteractive])

  return (
    <svg
      ref={svgRef}
      viewBox={BOT_VIEW_BOX}
      width={size}
      height={size}
      className={className}
      style={{ overflow: 'visible' }}
      role="img"
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      <defs>
        <clipPath id={clipId}>
          <path
            ref={(node) => {
              refs.current.clip = node
            }}
            d={frame.head}
          />
        </clipPath>
      </defs>
      {/* v2 坐标系画布中心 (0,0)：flipX 即绕原点镜像 */}
      <g transform={flipX ? 'scale(-1 1)' : undefined}>
        <g
          ref={(node) => {
            refs.current.motion = node
          }}
          data-bot-motion=""
        >
          {Array.from({ length: backCount }, (_, i) => (
            <path
              key={`back-${i}`}
              ref={(node) => {
                refs.current.back[i] = node
              }}
              data-bot-back={i}
              d={frame.back[i] ?? ''}
              fill={palette.body}
            />
          ))}
          <path
            ref={(node) => {
              refs.current.head = node
            }}
            data-bot-head=""
            d={frame.head}
            fill={palette.body}
          />
          <g clipPath={`url(#${clipId})`}>
            {frame.eyes.map((eye, i) => (
              <path
                key={i}
                ref={(node) => {
                  refs.current.eyes[i] = node
                }}
                data-bot-eye={i}
                d={eye.d}
                visibility={eye.visible ? 'visible' : 'hidden'}
                fill={palette.eye}
              />
            ))}
          </g>
          {Array.from({ length: frontCount }, (_, i) => (
            <path
              key={`front-${i}`}
              ref={(node) => {
                refs.current.front[i] = node
              }}
              data-bot-front={i}
              d={frame.front[i] ?? ''}
              fill={palette.body}
            />
          ))}
        </g>
      </g>
    </svg>
  )
}

function writeFrame(refs: FrameRefs, frame: EngineFrame): void {
  refs.motion?.setAttribute(
    'transform',
    `translate(${frame.offsetX.toFixed(2)} ${frame.offsetY.toFixed(2)})`
  )
  refs.clip?.setAttribute('d', frame.head)
  refs.head?.setAttribute('d', frame.head)
  refs.back.forEach((node, i) => {
    node?.setAttribute('d', frame.back[i] ?? '')
  })
  refs.front.forEach((node, i) => {
    node?.setAttribute('d', frame.front[i] ?? '')
  })
  frame.eyes.forEach((eye, i) => {
    const node = refs.eyes[i]
    if (!node) return
    node.setAttribute('d', eye.d)
    node.setAttribute('visibility', eye.visible ? 'visible' : 'hidden')
  })
}
