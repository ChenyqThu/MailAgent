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
  /** True = 消息仍在流式输出。驱动 Streamdown 的 `isAnimating` + streaming 模式,
   *  定稿后切 static 让历史消息走稳定的整段渲染。省略 / false = 静态完整渲染。 */
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

export function TranslatedBody({ text, streaming = false }: Props): React.ReactElement {
  // 流式体验: parseIncompleteMarkdown 让未闭合标记 (**/```/#) 中途自动补全 (闭合
  // 即定稿, 无字面量闪烁); 定稿后切 static 让历史消息走稳定整段渲染。
  //
  // 🔴 这一层**没有**任何流式动效, 正文就是 Streamdown 的默认渲染 —— 对齐 beUI
  // streaming-response（其正文是一行裸的 `{children}`）。0805 整体退役了 0804 引入的
  // 单推进头 mask reveal: 补偿层在 Streamdown 每轮重解析时会把已显示的文本重新裹回
  // visibility:hidden 再扫一遍, 正是 owner 报的「重复刷文字」。观感责任全部落在网关
  // 的到达节奏上（ai-gateway/chatRun.ts 的 smoothStream）。红线见 motion-gsap.md
  // §9.2: 不要再往这一层加逐字/逐块动画。
  //
  // 注: 此前"流式整段重复/交错"并非渲染层问题 —— 根因是 ElectronApi.subscribe()
  // 反订阅失效致 `chat:stream` listener 泄漏 → 每 chunk 投递两次 → 渲染层
  // `content += delta` 追加两次 (详见 ElectronApi.ts 注释)。
  return (
    <div className="mail-body break-words">
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
