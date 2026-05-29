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

import { useDeferredValue } from 'react'
import { Streamdown, type StreamdownTranslations } from 'streamdown'

interface Props {
  text: string
  /** True 表示消息仍在流式输出。流式期间走降级渲染 (见函数内注释) 以消除
   *  重复 / 错漏; 省略或 false 时按完整内容一次性渲染 (历史消息 / 草稿预览)。 */
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
  // 流式重复 / 错漏修复:
  // ① parseIncompleteMarkdown 在流式中途会把未闭合标记 (**/```/#) 逐帧在
  //    "字面量" 与 "补全渲染" 间反复横跳, 叠加 Streamdown 的 block memo,
  //    令新旧两帧 DOM 并存 —— 即截图里 "带** / 不带** 两版本交错重复" 的
  //    直接成因。流式期间关掉它 (未闭合标记稳定显示为字面量), 内容定终态
  //    (done → streaming=false) 后再开: 此时已无未闭合标记, 补全无副作用,
  //    且该 prop 由 false→true 触发 Streamdown 整体重渲染, 把流式中途残留的
  //    stale block 一次性替换 —— 同时根治 "done 后仍有错漏"。
  // ② 中文逐字流每秒触发数十次整段重 parse; useDeferredValue 把这些高频更新
  //    降为可中断 / 可合并的低优先级渲染, 既降本 (Streamdown 重渲染昂贵) 又
  //    减少 "渲染追不上 token" 的中间态撕裂。非流式 (text 稳定) 时立即追平。
  const deferred = useDeferredValue(text)
  const shown = streaming ? deferred : text
  return (
    <div className="mail-body break-words">
      <Streamdown parseIncompleteMarkdown={!streaming} translations={STREAMDOWN_ZH_TRANSLATIONS}>
        {shown}
      </Streamdown>
    </div>
  )
}
