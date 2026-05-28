// GSAP 初始化层 — 全项目动效的唯一入口（DESIGN.md §8 Motion system 收口点）。
//
// 红线：只用一条 standard 曲线 + 三档时长 120/220/380ms。禁止在各组件里散落
// registerPlugin / 重复定义曲线 / 发明第四档时长。所有动画 import 自此层。
// 详见 docs/motion-gsap.md。

import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import { Flip } from 'gsap/Flip'
import { CustomEase } from 'gsap/CustomEase'
import { ScrollToPlugin } from 'gsap/ScrollToPlugin'

gsap.registerPlugin(useGSAP, Flip, CustomEase, ScrollToPlugin)

// §8 唯一曲线 cubic-bezier(0.4,0,0.2,1)（Material standard）。精确复刻而非
// power2.out 近似。曲线收口裁决 = 全回归单 standard 曲线（不引入第二曲线）。
CustomEase.create('standard', '0.4,0,0.2,1')

// §8 三档时长（秒）。fast=hover/micro，base=面板/视图切换，slow=罕见 toast/批量。
export const DUR = { fast: 0.12, base: 0.22, slow: 0.38 } as const

// 项目级默认：锁死 one-curve + base 时长，组件不传 ease/duration 时自动合规。
gsap.defaults({ ease: 'standard', duration: DUR.base })

export { gsap, useGSAP, Flip }
