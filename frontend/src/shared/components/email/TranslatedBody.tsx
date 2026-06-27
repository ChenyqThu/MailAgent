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
// Streamdown 的逐 token fade-in 动效 + caret 需要它的 keyframes/样式 (sd-fadeIn
// 等)。一次性全局引入 (Vite 去重), 否则 animated 不生效。
import 'streamdown/styles.css'

interface Props {
  text: string
  /** True = 消息仍在流式输出。驱动 Streamdown 的 caret + 逐 token 入场动效
   *  (isAnimating/animated 都依赖它); 流式期走 streaming 模式, 定稿后切 static
   *  让历史消息走稳定的整段渲染。省略 / false = 静态完整渲染。 */
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

// 模块常量 —— 稳定引用, 否则内联对象每次 render 都是新引用, 击穿 Streamdown 的
// `animated===` memo 比较, 令定稿(static)消息在父级重渲时白白整段重 parse。
// sep:'word' 而非 'char': 中文逐字会生成大量 span + 动画, DOM/性能开销大。
const STREAMDOWN_ANIMATED = {
  animation: 'fadeIn',
  // dogfood — 用户要「稍微加一些淡出, 更流畅」: 90→170ms 让逐 token 淡入更柔和 (配合网关 smoothStream
  // 的平滑分块, 整体不再突兀地一段段蹦出)。sep 仍 'word' (中文逐字会爆 DOM)。
  duration: 170,
  easing: 'ease-out',
  sep: 'word',
  stagger: 6
} as const

export function TranslatedBody({ text, streaming = false }: Props): React.ReactElement {
  // 流式体验: parseIncompleteMarkdown 让未闭合标记 (**/```/#) 中途自动补全 (闭合
  // 即定稿, 无字面量闪烁); streaming 期开 caret + 逐 token fade-in, 定稿后切
  // static 让历史消息走稳定整段渲染。
  //
  // 注: 此前"流式整段重复/交错"并非渲染层问题 —— 根因是 ElectronApi.subscribe()
  // 反订阅失效致 `chat:stream` listener 泄漏 → 每 chunk 投递两次 → 渲染层
  // `content += delta` 追加两次 (详见 ElectronApi.ts 注释)。订阅修好后内容单份,
  // 这里的动效是纯视觉增强, 不影响正确性; 若觉得高频 chunk 下卡顿, 把 animated
  // 调成 false 或 sep 维持 'word' 即可 (不要用 'char', 中文逐字 DOM 开销大)。
  return (
    <div className="mail-body break-words">
      <Streamdown
        mode={streaming ? 'streaming' : 'static'}
        parseIncompleteMarkdown
        isAnimating={streaming}
        animated={STREAMDOWN_ANIMATED}
        translations={STREAMDOWN_ZH_TRANSLATIONS}
      >
        {text}
      </Streamdown>
    </div>
  )
}
