// 0804 dogfood 1c — chat 流式正文「chunk 内左→右 reveal」（owner 选型方案 C）的组件层。
//
// 流式期间，rehype 插件（./streamWipePlugin.ts，机制/边界语义/上游坑全在那边头注释）
// 把「这一轮 render 新流入的文本尾巴」包进 `<span class="stream-wipe stream-wipe-a|b">`，
// index.css 的 keyframes 对它做一次 mask-position 左→右扫过（380ms）。动画结束 mask
// 整个消失（mask 只写在 keyframes 里，fill 默认 none），零常驻 mask 层。
//
// 旧 span 的去向分两种（复核实测，tests/shared/streamWipe.test.tsx 钉住）：
// - 生长中的段落：下一轮 render 其 hast 变成纯文本 → span 被解包，段落里任何时刻
//   只有最新 chunk 的 1-3 个 span。
// - 表格单元格 / 已完成的列表项：Streamdown 的 td/th/li 子组件按「className+position」
//   memo（比较器不看 children），位置不再变化的旧节点跳过重渲 → 其 span **惰性留存**
//   （动画已放完、无 mask、类名不变故不重放、textContent 不受影响），每个已完成节点
//   至多 1 个，settle（mode='static' 整树换渲染路径）全部清空。有界且仅存在于流式期。
//
// 本组件经 Streamdown 的 `BlockComponent` prop 挂载（TranslatedBody streaming 时传入）：
// mode='static' 根本不挂 Block 组件，历史/已完成消息零 span 零动画残留。
// 组件 remount（切走再切回一条仍在流式的消息）时边界归零 → 已有正文整体 wipe 一次，
// 与上游 animate 插件的 remount 行为同款，接受。

import { useEffect, useMemo, useState } from 'react'
import { Block, type BlockProps } from 'streamdown'

import { createStreamWipePlugin, type RehypePlugins } from './streamWipePlugin'

/** Streamdown `BlockComponent`：给每个流式 block 挂上自己的 wipe 插件实例。
 *  内部仍渲染 Streamdown 原生 Block（memo/dir/isIncomplete 语义全保留），只是把
 *  插件追加进该 block 的 rehypePlugins 末尾（在 raw/sanitize/harden 之后跑，注入的
 *  span 不会被 sanitize 剥掉）。beginRender 在 render body 调用是有意的 —— 这是
 *  Streamdown Block 自家 animate 协议的同款位置（处理器在子组件 render 期同步跑，
 *  边界必须在那之前钉好），且 beginRender 幂等，useTransition 中断重放安全。 */
export function StreamWipeBlock(props: BlockProps): React.JSX.Element {
  const [plugin] = useState(createStreamWipePlugin)
  plugin.beginRender()
  useEffect(() => {
    plugin.commit()
  })
  const rehypePlugins = useMemo<RehypePlugins>(
    () => [...(props.rehypePlugins ?? []), plugin.rehypePlugin],
    [props.rehypePlugins, plugin]
  )
  return <Block {...props} rehypePlugins={rehypePlugins} />
}
