#!/usr/bin/env node
// 拉 pqoqubbw/icons（lucide-animated）源码，辅助**人工**新增动画图标。
//   用法: node scripts/fetch-animated-icon.mjs <icon-name>     （或 pnpm icon:fetch <icon-name>）
//   输出: pqoqubbw 原始源码 + 套 IconShell 的改造 checklist。
//
// 🔴 先看 `pnpm icon:vendor`（scripts/vendor-animated-icons.mjs）：上游 467 个里 460 个
// 已经批量 vendor 进仓，正常情况下**不需要**再单个拉。本脚本只服务批量转换转不了的那几个
// （上游用 useState / AnimatePresence / <defs>、或多阶段序列压不成关键帧），报告里会点名。
// 人工套壳后记得重跑一次 `pnpm icon:vendor` 刷新 barrel（它按目录扫，不会覆盖人工版）。

const name = process.argv[2]
if (!name) {
  console.error('用法: node scripts/fetch-animated-icon.mjs <icon-name>')
  process.exit(1)
}

const toPascal = (s) => s.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join('')

const url = `https://api.github.com/repos/pqoqubbw/icons/contents/icons/${name}.tsx`
const res = await fetch(url)
if (!res.ok) {
  console.error(
    `✗ pqoqubbw 无此图标: ${name}（HTTP ${res.status}）。\n` +
      `  → 该图标无动画版，改用静态 lucide-react（import { ${toPascal(name)} } from 'lucide-react'）。`
  )
  process.exit(1)
}
const json = await res.json()
const src = Buffer.from(json.content, 'base64').toString('utf8')

console.log(`===== pqoqubbw 原始源码（${name}.tsx）=====\n`)
console.log(src)
console.log(`\n===== 套 IconShell 改造 checklist =====
范例: src/shared/components/icons/animated/{feather,settings,folders,grip}.tsx
      + 壳契约 src/shared/components/icons/AnimatedIcon.tsx

1. 新建 src/shared/components/icons/animated/${name}.tsx，导出 ${toPascal(name)}Icon
2. import 仅: React + (有 motion 元素时) { motion, type Variants } from 'motion/react'
   + { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'
3. 删 pqoqubbw 的: "use client" / forwardRef / useAnimation / useImperativeHandle
   / handleMouseEnter/Leave / 最外层 <div> / cn / HTMLAttributes / XxxIconHandle
4. 🔴 spring 必改: { type: 'spring', stiffness, damping } → { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
   ease: 'easeInOut' 等 → ICON_EASE；duration > 0.8s 收敛到 0.4–0.6s
5. 整体变换(原 motion.svg animate) → svgVariants + svgTransition；局部 → children motion.* + variants
6. 颜色 currentColor；custom stagger（(custom)=>({...}) + custom={i}）保留
7. 跑 pnpm icon:vendor 刷新 barrel（src/shared/components/icons/animated/index.ts 是生成的；
   人工版不带「机器生成」标记，脚本不会覆盖）
8. 引用处整行/整 tab hover 驱动: 用 <AnimatedIconActiveProvider active={hovered}> 包裹（见 Sidebar NavRow）
9. 自检: pnpm vitest run tests/shared/animatedIconsDiscipline.test.ts（三道红线闸）
`)
