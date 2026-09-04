// 报告 → Markdown 序列化（「导出到资料库」的正文来源）。
//
// 🔴 **零依赖叶子**：只有 `import type`，运行时不拉 React / api client / i18n。两条理由：
//   ① 19 种块要逐块盯住，纯函数才测得动 —— 挂上组件依赖就得先搭一整套渲染环境；
//   ② 序列化与「谁在调它」无关。第一个调用点是 React 组件（ReportsPage 的导出按钮），
//      不该因此把整棵 UI 依赖树焊进来。
//
// 形态判据是 `BlockRenderer.tsx` 里**界面上实际长成什么**，不是块名的字面猜测：
// stat_row 在界面上是一排小 chip（不是表格）→ 一行 ` · ` 串；section.summary 有一条左侧
// 竖条 → blockquote；trend 是柱/折线图 → 标签行 + 数值行的转置表。
//
// 三处有意的信息损失（都是「界面上有、markdown 里没有对应物」的东西）：
//   · tone（callout / stat / timeline 的颜色）—— 纯样式，不进正文；
//   · matter_item 的 status / health / priority 是 matter 域**原始枚举字面量**，界面上由
//     i18n 翻译，这里没有 i18n 可用，故原样输出；
//   · 需要文案标签才说得清的字段（matter 的 waiting_on / next_action / signal_count）用
//     字段名当键 —— 造一份写死中文的标签表会让这个模块不再是 locale 无关的叶子。
// 反过来，`progress` / `metric_delta` 的 `title` 渲染器当前没画，导出**保留**它：导出件
// 里丢内容不可逆，多一行标题的代价小得多。

import type {
  ReportActionSuggestionBlock,
  ReportBlock,
  ReportCalloutBlock,
  ReportChecklistBlock,
  ReportDoc,
  ReportEmailItemBlock,
  ReportHeaderBlock,
  ReportImageBlock,
  ReportKeyPointsBlock,
  ReportKosContextBlock,
  ReportMarkdownBlock,
  ReportMatterItemBlock,
  ReportMetricDeltaBlock,
  ReportOverviewBlock,
  ReportProgressBlock,
  ReportQuoteBlock,
  ReportSectionBlock,
  ReportStatRowBlock,
  ReportTimelineBlock,
  ReportTrendBlock
} from '@shared/api/types'

// ─── 基础工具（全部对野值免疫：块来自 LLM，字段可能缺、可能是别的类型）───────────
function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
/** 非空片段用 ` · ` 串成一行（界面上那种「元信息一行排开」的形态）。 */
function inlineMeta(parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => !!p).join(' · ')
}
function paragraphs(parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => !!p).join('\n\n')
}
/** 整段转 blockquote（多行逐行加 `> `，空行给裸 `>` 以免引用被截断）。 */
function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n')
}
/** 列表项的续行缩进（`- ` 用 2 格，`1. ` 用 3 格）。 */
function indent(text: string, spaces = 2): string {
  const pad = ' '.repeat(spaces)
  return text
    .split('\n')
    .map((line) => (line ? `${pad}${line}` : ''))
    .join('\n')
}
/** 表格单元：`|` 会截断列，换行会截断整表。 */
function cell(value: unknown): string {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ')
}
/** 链接文字里的方括号会提前闭合 label。 */
function linkLabel(text: string): string {
  return text.replace(/[[\]]/g, '\\$&')
}
/** 带空格 / 括号的 URL 要用尖括号形式，否则 destination 在第一个空格处断掉。 */
function linkTarget(url: string): string {
  return /[\s()<>]/.test(url) ? `<${url.replace(/[<>]/g, '')}>` : url
}
function link(text: string, url: string): string {
  return url ? `[${linkLabel(text)}](${linkTarget(url)})` : text
}
function signed(value: number): string {
  return `${value >= 0 ? '+' : '-'}${Math.abs(value)}`
}
/** ISO 串 / epoch 毫秒 → `YYYY-MM-DD`；认不出就返空串（宁可少一段也不写错日期）。 */
function isoDate(value: unknown): string {
  if (typeof value === 'string') {
    const head = value.slice(0, 10)
    if (/^\d{4}-\d{2}-\d{2}$/.test(head)) return head
  }
  const at = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
  if (!Number.isFinite(at)) return ''
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// ─── 逐块序列化 ──────────────────────────────────────────────────────────────
function header(block: ReportHeaderBlock): string {
  const title = str(block.title)
  return paragraphs([
    title ? `# ${title}` : '',
    str(block.date_label) ? `_${str(block.date_label)}_` : '',
    str(block.subtitle)
  ])
}

function statRow(block: ReportStatRowBlock): string {
  // 界面是一排 chip「19 待回复 · 3 紧急」——不是表格，也没有可用作表头的文案
  // （表头要文案就得有 i18n，这个模块有意不引）。
  return inlineMeta(
    list(block.stats).map((raw) => {
      const stat = raw as { label?: unknown; value?: unknown }
      const value = num(stat.value)
      const label = str(stat.label)
      if (value === null) return label
      return label ? `**${value}** ${label}` : `**${value}**`
    })
  )
}

function section(block: ReportSectionBlock): string {
  const title = str(block.title)
  return paragraphs([
    title ? `## ${title}` : '',
    str(block.intro) ? `_${str(block.intro)}_` : '',
    // summary 在界面上带一条左侧竖条 = 引用块。里面的 `[文本](#email-<id>)` 锚点原样保留：
    // 导出件里点不动，但它标着「这句话说的是哪封」，删掉等于丢引用。
    str(block.summary) ? quote(str(block.summary)) : ''
  ])
}

function emailItem(block: ReportEmailItemBlock): string {
  const subject = str(block.subject)
  const deeplink = str((block.source as { app_deeplink?: unknown } | undefined)?.app_deeplink)
  const heading = subject ? `**${link(subject, deeplink)}**` : ''
  const addr = str(block.sender_addr)
  const head = inlineMeta([
    inlineMeta([heading, str(block.sender_name)]) || null,
    addr ? `<${addr}>` : null,
    str(block.time) || null
  ])
  const meta = inlineMeta([
    str(block.priority),
    str(block.category),
    str(block.ai_action),
    ...list(block.badges).map((b) => str(b))
  ])
  const body = [meta, str(block.ai_summary)].filter(Boolean).map((t) => indent(t))
  return [`- ${head || String(block.internal_id ?? '')}`, ...body].join('\n')
}

function keyPoints(block: ReportKeyPointsBlock): string {
  const items = list(block.items)
    .map((item, i) => {
      const text = str(item)
      return text ? `${i + 1}. ${indent(text, 3).trimStart()}` : ''
    })
    .filter(Boolean)
  return paragraphs([str(block.title) ? `#### ${str(block.title)}` : '', items.join('\n')])
}

function callout(block: ReportCalloutBlock): string {
  const inner = paragraphs([str(block.title) ? `**${str(block.title)}**` : '', str(block.body)])
  return inner ? quote(inner) : ''
}

function kosContext(block: ReportKosContextBlock): string {
  const head = inlineMeta([
    str(block.title) ? `**${str(block.title)}**` : '',
    str(block.source) ? `\`${str(block.source)}\`` : ''
  ])
  const inner = paragraphs([
    head,
    str(block.snippet),
    str(block.entity_slug) ? `\`${str(block.entity_slug)}\`` : ''
  ])
  return inner ? quote(inner) : ''
}

function actionSuggestion(block: ReportActionSuggestionBlock): string {
  // 界面上是「建议但当前不可执行」的虚线卡 → 未勾选的任务项（不发明「不可执行」的文案）。
  const title = str(block.title)
  const detail = str(block.detail)
  return [`- [ ] ${title ? `**${title}**` : String(block.id ?? '')}`, detail ? indent(detail) : '']
    .filter(Boolean)
    .join('\n')
}

function trend(block: ReportTrendBlock): string {
  const compare = block.compare as { label?: unknown; delta?: unknown } | undefined
  const delta = num(compare?.delta)
  const head = inlineMeta([
    str(block.metric) ? `**${str(block.metric)}**` : '',
    delta === null ? '' : inlineMeta([`${signed(delta)}%`, str(compare?.label)])
  ])
  const points = list(block.points).map((raw) => raw as { label?: unknown; value?: unknown })
  if (points.length === 0) return head
  // 柱 / 折线图的转置：标签一行、数值一行 —— 与图上「一列一根柱」一一对应。
  const table = [
    `| ${points.map((p) => cell(str(p.label))).join(' | ')} |`,
    `| ${points.map(() => '---:').join(' | ')} |`,
    `| ${points.map((p) => cell(num(p.value) ?? '')).join(' | ')} |`
  ].join('\n')
  return paragraphs([head, table])
}

function timeline(block: ReportTimelineBlock): string {
  const rows = list(block.events)
    .map((raw) => {
      const event = raw as { time?: unknown; title?: unknown; detail?: unknown }
      const time = str(event.time)
      const head = inlineMeta([
        time ? `\`${time}\`` : '',
        str(event.title) ? `**${str(event.title)}**` : ''
      ])
      if (!head) return ''
      const detail = str(event.detail)
      return detail ? `- ${head}\n${indent(detail)}` : `- ${head}`
    })
    .filter(Boolean)
  return paragraphs([str(block.title) ? `#### ${str(block.title)}` : '', rows.join('\n')])
}

function checklist(block: ReportChecklistBlock): string {
  // done/total 计数不写：它是 `- [x]` 的派生量，读的人自己数得出来，写死一句「2/5」
  // 反倒在编辑后变成谎话。
  const rows = list(block.items)
    .map((raw) => {
      const item = raw as { text?: unknown; done?: unknown }
      const text = str(item.text)
      return text ? `- [${item.done ? 'x' : ' '}] ${text}` : ''
    })
    .filter(Boolean)
  return paragraphs([str(block.title) ? `#### ${str(block.title)}` : '', rows.join('\n')])
}

function progress(block: ReportProgressBlock): string {
  const value = num(block.value) ?? 0
  const max = num(block.max) ?? 100
  const pct = max > 0 ? Math.round(Math.max(0, Math.min(100, (value / max) * 100))) : 0
  return paragraphs([
    str(block.title) ? `#### ${str(block.title)}` : '',
    inlineMeta([str(block.label) ? `**${str(block.label)}**` : '', `${value}/${max}（${pct}%）`]),
    str(block.caption)
  ])
}

function quoteBlock(block: ReportQuoteBlock): string {
  const cite = str(block.cite)
  const inner = paragraphs([str(block.text), cite ? `— ${link(cite, str(block.url))}` : ''])
  return inner ? quote(inner) : ''
}

function metricDelta(block: ReportMetricDeltaBlock): string {
  const delta = num(block.delta)
  const tail = delta === null ? '' : `（${signed(delta)}%${str(block.deltaLabel)}）`
  return paragraphs([
    str(block.title) ? `#### ${str(block.title)}` : '',
    inlineMeta([
      str(block.label) ? `**${str(block.label)}**` : '',
      `${str(block.value)}${tail}` || null
    ])
  ])
}

function image(block: ReportImageBlock): string {
  const src = str(block.src)
  if (!src) return ''
  // src 是 `/api/…` / `mailagent://` / `app://` / `data:` 的应用内引用（models.py
  // is_internal_image_src）——原样保留：在应用里打开这份导出仍然能显示，搬到别处显示不出来
  // 也好过把引用抹掉。
  return paragraphs([
    str(block.title) ? `#### ${str(block.title)}` : '',
    `![${linkLabel(str(block.alt))}](${linkTarget(src)})`,
    str(block.caption) ? `_${str(block.caption)}_` : ''
  ])
}

function matterItem(block: ReportMatterItemBlock): string {
  const title = str(block.title)
  const publicId = str(block.public_id)
  const head = inlineMeta([
    title ? `**${link(title, str(block.deeplink))}**` : '',
    publicId ? `\`${publicId}\`` : ''
  ])
  const progressPair = block.progress as { done?: unknown; total?: unknown } | undefined
  const done = num(progressPair?.done)
  const total = num(progressPair?.total)
  const due = isoDate(block.due_at)
  const state = inlineMeta([
    str(block.status),
    str(block.health) && str(block.health) !== 'unknown' ? str(block.health) : '',
    str(block.priority),
    done !== null && total !== null ? `${done}/${total}` : '',
    due ? `due ${due}` : ''
  ])
  const waiting = list(block.waiting_on)
    .map((n) => str(n))
    .filter(Boolean)
  const signals = num(block.signal_count)
  const extra = inlineMeta([
    waiting.length ? `waiting_on: ${waiting.join(', ')}` : '',
    str(block.next_action) ? `next_action: ${str(block.next_action)}` : '',
    signals ? `signal_count: ${signals}` : ''
  ])
  const body = [state, extra, str(block.summary)].filter(Boolean).map((t) => indent(t))
  return [`- ${head || publicId}`, ...body].join('\n')
}

/** 未来新增的块类型：把 type 与能认出来的文字原样留下，**绝不抛异常** ——
 *  一个没见过的块不该让整份导出消失。 */
function unknownBlock(block: ReportBlock): string {
  const b = block as { type?: unknown; title?: unknown; text?: unknown }
  const inner = paragraphs([`\`${str(b.type) || 'unknown'}\``, str(b.title), str(b.text)])
  return quote(inner)
}

/** 单块 → markdown 片段（空串 = 这块没有可导出的内容，调用方会丢掉）。 */
export function reportBlockToMarkdown(block: ReportBlock): string {
  if (!block || typeof block !== 'object') return ''
  try {
    switch (block.type) {
      case 'header':
        return header(block as ReportHeaderBlock)
      case 'overview':
        return str((block as ReportOverviewBlock).text)
      case 'stat_row':
        return statRow(block as ReportStatRowBlock)
      case 'section':
        return section(block as ReportSectionBlock)
      case 'email_item':
        return emailItem(block as ReportEmailItemBlock)
      case 'key_points':
        return keyPoints(block as ReportKeyPointsBlock)
      case 'callout':
        return callout(block as ReportCalloutBlock)
      case 'kos_context':
        return kosContext(block as ReportKosContextBlock)
      case 'action_suggestion':
        return actionSuggestion(block as ReportActionSuggestionBlock)
      case 'trend':
        return trend(block as ReportTrendBlock)
      case 'divider':
        return '---'
      case 'markdown':
        return paragraphs([
          str((block as ReportMarkdownBlock).title)
            ? `#### ${str((block as ReportMarkdownBlock).title)}`
            : '',
          str((block as ReportMarkdownBlock).text)
        ])
      case 'timeline':
        return timeline(block as ReportTimelineBlock)
      case 'checklist':
        return checklist(block as ReportChecklistBlock)
      case 'progress':
        return progress(block as ReportProgressBlock)
      case 'quote':
        return quoteBlock(block as ReportQuoteBlock)
      case 'metric_delta':
        return metricDelta(block as ReportMetricDeltaBlock)
      case 'image':
        return image(block as ReportImageBlock)
      case 'matter_item':
        return matterItem(block as ReportMatterItemBlock)
      default:
        return unknownBlock(block)
    }
  } catch {
    // 单块炸掉只丢这一块（同 BlockRenderer 的 ErrorBoundary 姿态：一份报告不因一个
    // 畸形块整个导不出来）。
    return ''
  }
}

/** 整份报告 → markdown 正文。只序列化 `blocks`：cadence / model / generated_at 是
 *  这份文件的元数据，进文件名，不进正文。 */
export function reportDocToMarkdown(doc: ReportDoc | null | undefined): string {
  const parts = list(doc?.blocks)
    .map((block) => reportBlockToMarkdown(block as ReportBlock))
    .filter(Boolean)
  return parts.length === 0 ? '' : `${parts.join('\n\n')}\n`
}

/** 文件名里非法 / 会被当成路径分隔的字符。`/` `\` 在服务端 `normalize_rel` 里就是分隔符，
 *  留着会把「导出到 A 文件夹」变成「在 A 下再建一层」。 */
const UNSAFE_FILENAME = /[\\/:*?"<>|]/g
const MAX_BASE_LEN = 80

/** 控制字符（含 NUL）在服务端 `normalize_rel` 里是硬拒（400），报告标题是 LLM 写的，
 *  真可能带进来。按码位滤而不是写个 `\x00-\x1f` 字符类：那种正则里的裸控制字符在源码里
 *  看不见，改的人无从判断它到底匹配了什么。 */
function stripControl(raw: string): string {
  return Array.from(raw)
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0
      // 换成空格而不是删掉：标题里的换行是词的边界，删了会把两个词粘成一个。
      return code >= 32 && code !== 127 ? ch : ' '
    })
    .join('')
}

/** 标题 → 安全的文件名主干（空 → `report`，调用方不必再兜一次）。 */
export function sanitizeFilenamePart(raw: string): string {
  const cleaned = stripControl(raw)
    .replace(UNSAFE_FILENAME, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, MAX_BASE_LEN)
    .trim()
  return cleaned || 'report'
}

/** 导出文件名：报告标题（首个 header 块，没有就用调用方给的 fallback）+ 生成日期 + `.md`。 */
export function reportExportFilename(doc: ReportDoc | null | undefined, fallback = ''): string {
  const headerBlock = list(doc?.blocks).find(
    (b) => (b as ReportBlock | undefined)?.type === 'header'
  ) as ReportHeaderBlock | undefined
  const title = str(headerBlock?.title) || str(fallback)
  const date = isoDate(doc?.generated_at) || isoDate(doc?.report_date)
  return `${sanitizeFilenamePart([title, date].filter(Boolean).join(' '))}.md`
}

/** 重名时的下一个候选：`报告.md` → `报告 (2).md` → `报告 (3).md`（服务端对同路径恒
 *  409，客户端按序号往后让）。 */
export function nextFilenameCandidate(filename: string, attempt: number): string {
  const dot = filename.lastIndexOf('.')
  const base = dot > 0 ? filename.slice(0, dot) : filename
  const ext = dot > 0 ? filename.slice(dot) : ''
  return attempt <= 1 ? filename : `${base} (${attempt})${ext}`
}
