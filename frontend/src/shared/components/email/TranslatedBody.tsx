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

import { Streamdown, type StreamdownTranslations } from 'streamdown'
// Streamdown 的 caret + 控件样式需要它的 keyframes/样式。一次性全局引入 (Vite 去重)。
import 'streamdown/styles.css'

interface Props {
  text: string
  /** True = 消息仍在流式输出。驱动 Streamdown 的 `isAnimating` + 本组件的尾部渐变 mask;
   *  流式期走 streaming 模式, 定稿后切 static 让历史消息走稳定的整段渲染。
   *  省略 / false = 静态完整渲染。 */
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

// ── W1 质感层 —— 流式尾部渐变 mask（chat UI 优化 epic，2026-08）─────────────────────
//
// 取代 Streamdown 的 per-token `animated` fadeIn。删它的理由不是审美, 是它在中文下**根本
// 没生效**: Streamdown 的 `sep:'word'` 切分器按「当前字符是否空白」布尔翻转来切段, 中文
// 无空格 → 恒不翻转 → 纯中文整段只切出 1 个 token; 再叠加它的增量机制（已渲染部分 duration
// 置 0）, 结果就是纯中文零动效。另一档 `sep:'char'` 中文逐字会爆 DOM（大量 span + 动画）,
// 且 owner 明确否掉逐字（「逐字太跳跃」）—— 两个粒度都不合用, 故整个 per-token 层退役。
//
// 现在的分工: **节奏**由网关 smoothStream 的句级分块给（ai-gateway/chatRun.ts「W1 节奏层」），
// **质感**由这里的尾部渐变 mask 给 —— 正文最后 1.5em 渐隐, 新句子从这条渐变带里「擦」出来。
// 零 filter / 零 JS 逐帧（§8 红线）: 单条静态 CSS mask, 不随时间动, 只在 streaming 期挂载。
// mask 不参与布局 → 挂载/摘除都不引起重排。
//
// 模块常量 —— 稳定引用, 否则内联对象每次 render 都是新引用（style 每帧新对象会让 React 每次
// 都重写 DOM style）。
//
// 用 CSS 关键字 `black` 而非 `#000`: mask 里只有 **alpha** 有意义（不透明处保留、透明处擦除），
// 这不是一个主题色, 不该走 token —— 同 chatAttachmentAdapter 的 canvas matte 先例, 也让
// mailagent/no-raw-hex 保持干净（无需 eslint-disable）。
const STREAMING_TAIL_MASK: React.CSSProperties = {
  WebkitMaskImage: 'linear-gradient(to bottom, black calc(100% - 1.5em), transparent)',
  maskImage: 'linear-gradient(to bottom, black calc(100% - 1.5em), transparent)'
}

export function TranslatedBody({ text, streaming = false }: Props): React.ReactElement {
  // 流式体验: parseIncompleteMarkdown 让未闭合标记 (**/```/#) 中途自动补全 (闭合
  // 即定稿, 无字面量闪烁); streaming 期挂尾部渐变 mask, 定稿后切 static 让历史消息走
  // 稳定整段渲染。
  //
  // 🔴 static 分支与 W1 之前**逐字节一致**: Streamdown 的 animate rehype plugin 只在
  // `animated && isAnimating` 同时为真时才装（dist: `ge&&m&&(k=[...k,ge.rehypePlugin])`），
  // 而历史消息的 isAnimating=false —— 即改动前它对 static 也从未生效, 删 animated 不改
  // 历史渲染。`caret` prop 本组件一直没传（Streamdown caret 现状=不显示）, 本轮不动。
  //
  // 注: 此前"流式整段重复/交错"并非渲染层问题 —— 根因是 ElectronApi.subscribe()
  // 反订阅失效致 `chat:stream` listener 泄漏 → 每 chunk 投递两次 → 渲染层
  // `content += delta` 追加两次 (详见 ElectronApi.ts 注释)。订阅修好后内容单份,
  // 这里的动效是纯视觉增强, 不影响正确性。
  return (
    <div className="mail-body break-words" style={streaming ? STREAMING_TAIL_MASK : undefined}>
      <Streamdown
        mode={streaming ? 'streaming' : 'static'}
        parseIncompleteMarkdown
        isAnimating={streaming}
        translations={STREAMDOWN_ZH_TRANSLATIONS}
      >
        {text}
      </Streamdown>
    </div>
  )
}
