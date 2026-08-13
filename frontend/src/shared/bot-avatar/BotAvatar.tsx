// 灵动 bot 头像 —— 唯一 React 绑定（engine/ticker/states/shapes/colors 全部无 React）。
// 双档设计（prd §4.5/§4.6）：
//   静态档（默认）= 渲染 state 池首表情的一帧 SVG，零引擎、零 ticker、零定时器 ——
//     列表位点（数百个 22px 实例同屏）与 reduced-motion 回退都走这里；
//   动画档（animated）= 引擎 + 共享 ticker + IntersectionObserver 可见性裁剪，
//     位点按设计只有 2-4 个同屏（chat 回合头 / 面板头 / 抽屉预览）。
// reduced-motion 必须 JS 层短路（本组件动画帧经 setAttribute 直写 DOM，CSS media
// 管不到 —— motion-gsap.md §3 同款结论），恒回静态档：身份/状态仍可读，动画整个不出现。

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'

import { useReducedMotion } from '../hooks/useReducedMotion'
import { COLORS } from './colors'
import { BotFaceEngine } from './engine'
import { staticFrame } from './engine'
import { BOT_BODY_SPAN, BOT_VIEW_BOX, SHAPES } from './shapes'
import { POOLS } from './states'
import { registerTicker, unregisterTicker } from './ticker'
import type { BotColor, BotShape, BotState, EngineFrame } from './types'

export interface BotAvatarProps {
  /** 缺省 blob / orange（官方助手形象，prd §6.3 Q4） */
  config?: { shape?: BotShape; color?: BotColor }
  state?: BotState
  size?: number
  title?: string
  className?: string
  /** 显式声明才动 —— 新增 animated 位点须过性能评估（prd §4.6-3） */
  animated?: boolean
  flipX?: boolean
}

// 主题信号 = documentElement 的 data-theme attribute（appearance.ts applyResolvedTheme
// 的唯一 DOM 落点）。不订阅 useAppearance store：本模块域无关，远程 web 与任何
// 未挂 zustand 的宿主里也要能跟主题。缺席（boot 前/测试）按 dark —— index.css
// :root 默认即暗色。只有 body fill 需要 JS 侧分主题；eye fill 是 CSS 变量回退串，
// 浏览器在 paint 时自行解析，无需 JS 参与。
function subscribeTheme(onChange: () => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => observer.disconnect()
}

function getThemeSnapshot(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'dark'
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
}

export function BotAvatar({
  config,
  state = 'idle',
  size = 40,
  title,
  className,
  animated = false,
  flipX = false
}: BotAvatarProps): React.JSX.Element {
  const reducedMotion = useReducedMotion()
  const isAnimated = animated && !reducedMotion
  const theme = useSyncExternalStore(subscribeTheme, getThemeSnapshot, () => 'dark' as const)

  const shape: BotShape = config?.shape ?? 'blob'
  const color: BotColor = config?.color ?? 'orange'
  const shapeDef = SHAPES[shape]
  const palette = COLORS[color][theme]

  // clipPath id 每实例唯一：多实例同屏时 url(#…) 按文档序解析到第一个同名节点，
  // 共享 id 会让所有实例吃同一个（可能已卸载的）裁剪形状。useId 的冒号在
  // url(#…) 引用里部分环境解析不稳，剥掉。
  const rawId = useId()
  const clipId = useMemo(() => `bot-clip-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`, [rawId])

  // 静态档的那一帧；动画档也用它作 SSR/首帧基线（= 引擎初始快照：池首、morph=1）
  const frame = useMemo(
    () => staticFrame(POOLS[state][0], shapeDef.eyeAnchor.eyeScale),
    [state, shapeDef]
  )

  const svgRef = useRef<SVGSVGElement | null>(null)
  const eyeRefs = useRef<Array<SVGPathElement | null>>([])
  const engineRef = useRef<BotFaceEngine | null>(null)
  // 引擎创建 effect 不依赖 state（换状态不得重建引擎），经 ref 取创建时刻的最新值
  const stateRef = useRef(state)

  // 每次 render 后：把 state prop 灌进引擎（内部同值 no-op），并用引擎快照回写
  // DOM —— React 刚按静态 frame 写过 eye 属性，若不回写，动画中的重渲染会把眼睛
  // 瞬间打回池首帧。layout 时机保证发生在 paint 前，肉眼无闪烁。
  useLayoutEffect(() => {
    stateRef.current = state
    const engine = engineRef.current
    if (!engine) return
    engine.setState(state)
    writeFrame(eyeRefs.current, engine.snapshot())
  })

  useEffect(() => {
    if (!isAnimated) return
    const engine = new BotFaceEngine({
      initialState: stateRef.current,
      eyeScale: shapeDef.eyeAnchor.eyeScale
    })
    engineRef.current = engine
    const client = (now: number): void => {
      const next = engine.tick(now)
      if (next) writeFrame(eyeRefs.current, next)
    }

    // 可见性裁剪（prd §4.6-2）：不可见即从共享 ticker 注销。环境无 IO（happy-dom/
    // 老 WebView）时按恒可见处理 —— 宁可多画不可不画。
    let registered = false
    const setRegistered = (want: boolean): void => {
      if (want === registered) return
      registered = want
      if (want) registerTicker(client)
      else unregisterTicker(client)
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
  }, [isAnimated, shapeDef])

  return (
    <svg
      ref={svgRef}
      viewBox={BOT_VIEW_BOX}
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      <defs>
        <clipPath id={clipId}>
          <path d={shapeDef.path} />
        </clipPath>
      </defs>
      {/* flipX = 原型的整体镜像串 translate(228.541 0) scale(-1 1)（analysis §4.4 配套） */}
      <g transform={flipX ? `translate(${BOT_BODY_SPAN} 0) scale(-1 1)` : undefined}>
        <path d={shapeDef.path} fill={palette.body} />
        <g clipPath={`url(#${clipId})`}>
          {frame.eyes.map((eye, i) => (
            <path
              key={i}
              ref={(node) => {
                eyeRefs.current[i] = node
              }}
              data-bot-eye={i}
              d={eye.d}
              transform={eye.transform}
              visibility={eye.hidden ? 'hidden' : 'visible'}
              fill={palette.eye}
            />
          ))}
        </g>
      </g>
    </svg>
  )
}

function writeFrame(nodes: ReadonlyArray<SVGPathElement | null>, frame: EngineFrame): void {
  frame.eyes.forEach((eye, i) => {
    const node = nodes[i]
    if (!node) return
    node.setAttribute('d', eye.d)
    node.setAttribute('transform', eye.transform)
    node.setAttribute('visibility', eye.hidden ? 'hidden' : 'visible')
  })
}
