// 0805 流式动效重写（方案 B）— 单推进头 reveal 的组件层。
//
// 流式期间，rehype 插件（./streamWipePlugin.ts，机制/边界语义/节奏常量全在那边头注释）
// 把「unwrap 边界之后」的文本包进 `.stream-reveal` span（默认 visibility:hidden）；
// controller 在每次 commit 后（pre-paint）扫容器对账状态，并用 rAF 推一个单调前进的
// 字符游标 —— 任意时刻只有一个 span 是推进头（mask 左→右扫过，--sw-p 驱动），扫过的
// 段固化为可见纯文本形态。已定稿消息（mode='static'）根本不挂 Block 组件，零 span
// 零动画残留。
//
// 旧 span 的去向分两种（沿旧版实测结论，streamWipe.test.tsx 钉住）：
// - 生长中的段落：段完成推高 doneFloor，下一轮 render 其 hast 变回纯文本 → span 解包。
// - 表格单元格 / 已完成列表项：Streamdown 的 td/th/li 子组件按「className+position」
//   memo（比较器不看 children），位置不变的旧节点跳过重渲 → 其 span **惰性留存**
//   （已是 done 态：可见、无 mask、无动画、textContent/复制不受影响），settle
//   （mode='static' 整树换渲染路径）全部清空。有界且仅存在于流式期。
//
// 组件 remount（切走再切回一条仍在流式的消息）时游标归零 → 已有正文从头重扫一次，
// 与旧版（及上游 animate 插件）的 remount 行为同款，接受。

import { useLayoutEffect, useMemo, useState } from 'react'
import { Block, type BlockProps } from 'streamdown'

import { type RehypePlugins, type StreamRevealController } from './streamWipePlugin'

/** 造一个绑定到指定 controller 的 Streamdown `BlockComponent`。
 *  TranslatedBody 每实例各造一次（useMemo 稳定身份），块与消息级 controller 由闭包
 *  接线 —— Streamdown 的 memo 比较器不看 BlockComponent，身份必须稳定。 */
export function createStreamRevealBlock(
  controller: StreamRevealController
): (props: BlockProps) => React.JSX.Element {
  return function StreamRevealBlock(props: BlockProps): React.JSX.Element {
    const [plugin] = useState(() => controller.createBlockPlugin())
    // 注册放 layoutEffect（不在 createBlockPlugin 时）：StrictMode 双 mount 会先跑
    // 一次 cleanup，注册必须可重入；layout 阶段子先于父 → 父 div ref 的首扫（
    // setContainer→scanNow）跑到时插件已就位。
    useLayoutEffect(() => {
      controller.attachPlugin(plugin)
      return () => controller.detachPlugin(plugin)
    }, [plugin])
    // 每次 commit 后对账一次（同 commit 内多 Block 的调用合并成一次扫）。Block 的
    // markdown 处理是同步的（dist runSync），本轮新产 span 与本 effect 落在同一个
    // commit —— pre-paint 扫描不漏帧、不闪。
    useLayoutEffect(() => {
      controller.sync()
    })
    const rehypePlugins = useMemo<RehypePlugins>(
      () => [...(props.rehypePlugins ?? []), plugin.rehypePlugin],
      [props.rehypePlugins, plugin]
    )
    return <Block {...props} rehypePlugins={rehypePlugins} />
  }
}
