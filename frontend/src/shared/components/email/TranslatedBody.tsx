// Sprint 19 Todo 2 — markdown 渲染层换 Vercel Streamdown.
//
// 之前是自写 regex + DOMPurify + auto-balance preprocess (150 LOC), 不
// 支持 nested list / table / triple ``` / single * italic, 也不处理流式
// unterminated block 视觉跳动. 调研结论 (docs/chat-markdown-streaming-
// research.md): Streamdown v2.5 — Vercel 2026 业界 de facto, drop-in
// 替代 react-markdown, 内置 GFM + unterminated block styling + rehype-
// harden + Tailwind typography + 代码块自带复制按钮.
//
// 调用方零改动: 两处用 site (MessageList.tsx:260 邮件草稿 read-only
// preview + MessageList.tsx:733 chat AssistantBubble) props 接口
// `{ text: string }` 不变.
//
// 命名沿用 TranslatedBody 是因为重命名/搬位置会牵连一连串 import,
// 收益不大; 等下次清理 chat 渲染层时再统一.
//
// 不加 plugin (code / math / mermaid / cjk): 邮件 + chat 场景一期都
// 不需要 — Streamdown 核心已自带 shiki 代码高亮 + mermaid lazy chunk
// (chunk 内置见 node_modules/streamdown/dist/), plugin 包是给定制
// theme / 离线 lang pack 用的增强项. 想加后续 `import code from
// '@streamdown/code'` 再传 plugins 即可.

import { useState } from 'react'
import { Streamdown, type StreamdownTranslations } from 'streamdown'
// Streamdown 的 caret + 控件样式需要它的 keyframes/样式。一次性全局引入 (Vite 去重)。
import 'streamdown/styles.css'

import { createStreamRevealBlock } from './streamWipe'
import { createStreamRevealController } from './streamWipePlugin'

interface Props {
  text: string
  /** True = 消息仍在流式输出。驱动 Streamdown 的 `isAnimating` + 单推进头 reveal
   *  （createStreamRevealBlock）; 流式期走 streaming 模式, 定稿后切 static 让历史
   *  消息走稳定的整段渲染。省略 / false = 静态完整渲染。 */
  streaming?: boolean
}

// Streamdown defaultTranslations 是英文; UI 是中文环境就 override 复制
// / 下载 / 全屏 等 UI 字符串. 这里 hardcode 中文不接 i18next 是因为这套
// 19 个 string 跟应用其他文案语义独立 (是 markdown 控件 chrome, 不是
// 业务文案), 接 i18next 反而引入 zh-CN / en-US 两边各加 19 个 key 的
// 维护开销而无用户可见收益 (Streamdown 控件中文已能正确表达).
const STREAMDOWN_ZH_TRANSLATIONS: Partial<StreamdownTranslations> = {
  copyCode: '复制',
  copied: '已复制',
  copyLink: '复制链接',
  copyTable: '复制表格',
  copyTableAsCsv: '复制为 CSV',
  copyTableAsMarkdown: '复制为 Markdown',
  copyTableAsTsv: '复制为 TSV',
  downloadDiagram: '下载图表',
  downloadDiagramAsMmd: '下载 .mmd',
  downloadDiagramAsPng: '下载 PNG',
  downloadDiagramAsSvg: '下载 SVG',
  downloadFile: '下载',
  downloadImage: '下载图片',
  downloadTable: '下载表格',
  downloadTableAsCsv: '下载为 CSV',
  downloadTableAsMarkdown: '下载为 Markdown',
  viewFullscreen: '全屏查看',
  exitFullscreen: '退出全屏',
  externalLinkWarning: '即将打开外部链接',
  openExternalLink: '打开外部链接',
  openLink: '打开链接',
  imageNotAvailable: '图片不可用',
  close: '关闭',
  mermaidFormatMmd: 'Mermaid 源码',
  mermaidFormatPng: 'PNG',
  mermaidFormatSvg: 'SVG',
  tableFormatCsv: 'CSV',
  tableFormatMarkdown: 'Markdown',
  tableFormatTsv: 'TSV'
}

// ── 质感层 —— 单推进头 reveal（0804 dogfood 1c 方案 C 质感 · 0805 换驱动为单调游标）──
//
// 分工不变: **节奏**由网关 smoothStream 的句级分块给（ai-gateway/chatRun.ts「W1 节奏层」，
// SENTENCE_CHUNKING_REGEX 常量），**质感**由 streamWipe.tsx + streamWipePlugin.ts 给。
// 0805 重写: 不再「每个新 chunk 起一个 380ms 动画」（380ms 与 chunk 到达间隔无耦合，
// 40-80 tok/s 下必然 2 个动画并发 —— owner 报的「2 句话同时渲染淡出」），改为消息级
// controller 维护**一个**单调前进的揭示游标: 已定稿部分永远静止，任意时刻只有一个
// 推进头在做 mask 左→右扫过。机制/常量/边界全在 streamWipePlugin.ts 头注释；台账见
// motion-gsap.md §9.2；不变量测试 tests/shared/streamRevealInvariant.test.tsx。

export function TranslatedBody({ text, streaming = false }: Props): React.ReactElement {
  // 流式体验: parseIncompleteMarkdown 让未闭合标记 (**/```/#) 中途自动补全 (闭合
  // 即定稿, 无字面量闪烁); streaming 期由绑定本消息 controller 的 BlockComponent
  // 做单推进头 reveal, 定稿后切 static 让历史消息走稳定整段渲染。
  //
  // 🔴 static 分支不受 BlockComponent 影响: Streamdown mode='static' 走单次全文渲染,
  // 根本不挂 Block 组件（dist: static 分支直接 jsx(Ct,…)），历史消息零 span 零 mask
  // 零动画残留 —— 行为与旧版 static 分支逐字节一致。`caret` prop 本组件一直没传,
  // 本轮不动。controller 每实例一个、创建零成本（静态消息不挂 Block → 恒 inert）。
  //
  // 注: 此前"流式整段重复/交错"并非渲染层问题 —— 根因是 ElectronApi.subscribe()
  // 反订阅失效致 `chat:stream` listener 泄漏 → 每 chunk 投递两次 → 渲染层
  // `content += delta` 追加两次 (详见 ElectronApi.ts 注释)。订阅修好后内容单份,
  // 这里的动效是纯视觉增强, 不影响正确性。
  // controller / BlockComponent / 容器 ref 三者一次性建好（useState initializer）：
  // BlockComponent 身份必须稳定（不稳定会让 React 每轮 remount 全部 block），
  // setContainer 是稳定的普通函数（controller 方法不依赖 this）。
  const [{ BlockComponent, setContainer }] = useState(() => {
    const controller = createStreamRevealController()
    return {
      BlockComponent: createStreamRevealBlock(controller),
      setContainer: controller.setContainer
    }
  })
  return (
    <div className="mail-body break-words" ref={setContainer}>
      <Streamdown
        mode={streaming ? 'streaming' : 'static'}
        parseIncompleteMarkdown
        isAnimating={streaming}
        BlockComponent={BlockComponent}
        translations={STREAMDOWN_ZH_TRANSLATIONS}
      >
        {text}
      </Streamdown>
    </div>
  )
}
