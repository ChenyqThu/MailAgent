#!/usr/bin/env node
// 拉 pqoqubbw/icons（lucide-animated）源码，辅助新增动画图标。
//   用法: node scripts/fetch-animated-icon.mjs <icon-name>     （或 pnpm icon:fetch <icon-name>）
//   输出: pqoqubbw 原始源码 + 套 IconShell 的改造 checklist。
//
// 为什么不全自动生成：每个图标的动画结构不同（svg 级整体变换 vs 局部 motion.path/circle、
// custom stagger、pathLength 描入…），机械转换易出错。脚本只省去「手动 curl + base64 解码」
// 这步，改造仍按 checklist 人工套（对照现有范例），保证守 §8（spring→tween）红线。

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
7. 在 src/shared/components/icons/index.ts 加: export { ${toPascal(name)}Icon } from './animated/${name}'
8. 引用处整行/整 tab hover 驱动: 用 <AnimatedIconActiveProvider active={hovered}> 包裹（见 Sidebar NavRow）
9. 自检: grep -nE "spring|stiffness|damping|forwardRef|useAnimation|easeInOut" 该文件应为空
`)
