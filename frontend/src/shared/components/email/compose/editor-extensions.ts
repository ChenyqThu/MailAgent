// Compose editor 扩展装配 — buildComposeExtensions 工厂（epic T2，契约 D4）。
//
// 生产装配点：T5 把 ComposePanel 的 useEditor extensions 切到这里。在那之前
// ComposePanel 保持自己的旧装配（本文件不被它引用也要独立可用）。
//
// 相对 ComposePanel 旧装配（StarterKit + TextStyle 族 + Image）新增：
//   - Highlight(multicolor)   → 工具栏高亮 swatch
//   - Mention(@联系人)        → 数据源复用 email.contactSuggest（RecipientField 同通道）
//   - composeSlash("/" 块菜单) → @tiptap/suggestion 自定义扩展
//   - composeLinkPaste        → 选区 + 剪贴板是 URL → 套 link 不替换文本
//   - composeInlineImage      → 剪贴板图片粘贴 / 图片文件拖放 → data URL 内联插入
//   - Placeholder（可选）      → 仅传入 placeholder 时挂载；生产 ComposeEditor 仍用
//     自绘空态浮层（Placeholder 的 data-placeholder 需配套 CSS 才可见），两者二选一。
//
// TipTap 铁律：所有 @tiptap/* 同版本（3.23.6）；TextStyle 必须在 Color/FontFamily/
// FontSize/BackgroundColor 之前（它们扩展 textStyle mark 的属性）。

import StarterKit from '@tiptap/starter-kit'
import {
  TextStyle,
  Color,
  FontFamily,
  FontSize,
  BackgroundColor
} from '@tiptap/extension-text-style'
import Image from '@tiptap/extension-image'
import Highlight from '@tiptap/extension-highlight'
import Mention, { type MentionNodeAttrs } from '@tiptap/extension-mention'
import { TableKit } from '@tiptap/extension-table'
import { Placeholder } from '@tiptap/extensions'
import { Extension, ReactRenderer } from '@tiptap/react'
import type { Editor, Extensions, Range } from '@tiptap/react'
import { Suggestion } from '@tiptap/suggestion'
import type { SuggestionKeyDownProps, SuggestionOptions, SuggestionProps } from '@tiptap/suggestion'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import {
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Minus,
  SquareCode,
  TextQuote,
  type LucideIcon
} from 'lucide-react'

import i18n from '@shared/i18n'
import { makeMailApi } from '@shared/api/factory'
import type { ContactSuggestion } from '@shared/api/types'
import { normalizeEditableEmailHtml } from '@shared/lib/emailComposerHtml'
import { toastError } from '@shared/state/toast'

import { MentionMenu, SlashMenu, type SuggestMenuHandle } from './editor-suggest'

// ── Suggestion render 桥（ReactRenderer） ─────────────────────────────

interface SuggestRenderBaseProps<I, S> {
  items: I[]
  command: (props: S) => void
  query?: string
}

/**
 * Suggestion render() 工厂 — ReactRenderer 挂 body + fixed 定位（视口边缘
 * clamp）+ 键盘转发（↑/↓/Enter 走组件句柄，Escape 直接销毁浮层）。契约 D4：
 * 不用 demo 的 window.__ttSuggest 全局桥、不引 tippy.js。
 * `staticProps` 在整个 suggestion 生命周期不变（如 MentionMenu 的 onPick）。
 * `guards.isStale`（codex F2）：suggestion 插件的 update 是 async 的（await
 * items()），两次 update 可交错乱序到达 —— 迟到回调携带的 items 可能不是最新一次
 * items() 的结果（未 await 完的占位 [] / exit 后残留的旧代际数组），只在 items()
 * 里去重挡不住这些 stale 回调。isStale 返回 true 时丢弃整个更新（不是只丢
 * items），配合 create() 幂等化（见下），最终安装的 command/items 恒为最新代际。
 */
export function createSuggestionRender<I, S, P extends SuggestRenderBaseProps<I, S>>(
  Component: React.ComponentType<P>,
  staticProps?: Omit<P, keyof SuggestRenderBaseProps<I, S>>,
  guards?: { isStale?: (props: SuggestionProps<I, S>) => boolean }
): NonNullable<SuggestionOptions<I, S>['render']> {
  return () => {
    let renderer: ReactRenderer<SuggestMenuHandle, Record<string, unknown>> | null = null

    const position = (clientRect: SuggestionProps<I, S>['clientRect']): void => {
      const el = renderer?.element
      if (!el || !clientRect) return
      const rect = clientRect()
      if (!rect) return
      el.style.position = 'fixed'
      el.style.zIndex = '60'
      el.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 300)}px`
      el.style.left = `${Math.min(rect.left, window.innerWidth - 280)}px`
    }

    const create = (props: SuggestionProps<I, S>): void => {
      // Suggestion 插件的 update 是 async 的（await items()）：composer 关闭后
      // pending 请求回来仍会走到 onStart/onUpdate —— 已销毁的 editor 上不再挂
      // 浮层（ReactRenderer 走 editor.contentComponent portal，销毁后只会往
      // body 泄一个永远没人收的空壳 div）。
      if (props.editor.isDestroyed) return
      // 幂等化（codex F2）：A 慢 B 快时，B 的 onUpdate 已先建了浮层，A 的 onStart
      // 迟到再 create 会覆盖 renderer 引用 —— 旧浮层永远没人销毁（泄漏 + 双菜单）。
      // 已有浮层时收敛为 updateProps（此时 props 是插件闭包共享变量，恒为最新
      // update 的对象，装的仍是最新 command/items）。
      if (renderer) {
        renderer.updateProps({ items: props.items, command: props.command, query: props.query })
        position(props.clientRect)
        return
      }
      renderer = new ReactRenderer<SuggestMenuHandle, Record<string, unknown>>(
        Component as unknown as React.FunctionComponent<Record<string, unknown>>,
        {
          editor: props.editor,
          props: {
            ...(staticProps ?? {}),
            items: props.items,
            command: props.command,
            query: props.query
          }
        }
      )
      document.body.appendChild(renderer.element)
      position(props.clientRect)
    }

    const destroy = (): void => {
      renderer?.destroy()
      renderer = null
    }

    return {
      onStart: (props: SuggestionProps<I, S>): void => {
        // stale 回调整体丢弃 (不是只丢 items) — 携带占位 []/旧代际 items 的迟到
        // onStart 不得建浮层 (exit 后菜单复活 / 空菜单闪烁)。
        if (guards?.isStale?.(props)) return
        create(props)
      },
      onUpdate: (props: SuggestionProps<I, S>): void => {
        if (props.editor.isDestroyed) {
          destroy()
          return
        }
        // 丢弃整个 stale 更新 (items/command/query 全套), 不只是 items。
        if (guards?.isStale?.(props)) return
        create(props)
      },
      onKeyDown: (props: SuggestionKeyDownProps): boolean => {
        if (props.event.key === 'Escape') {
          destroy()
          return true
        }
        return renderer?.ref?.onKeyDown(props) ?? false
      },
      onExit: destroy
    }
  }
}

// ── slash 块菜单 ──────────────────────────────────────────────────────

/** slash 菜单项 — label/subtitle 走 i18n key（compose.editor.*），kw 为拉丁/拼音关键字。 */
export interface SlashItem {
  id: string
  labelKey: string
  subtitleKey: string
  icon: LucideIcon
  kw: readonly string[]
  run: (editor: Editor, range: Range) => void
}

export const SLASH_ITEMS: readonly SlashItem[] = [
  {
    id: 'h1',
    labelKey: 'heading1',
    subtitleKey: 'slashH1Sub',
    icon: Heading1,
    kw: ['h1', 'title', 'heading', 'biaoti'],
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setNode('heading', { level: 1 }).run()
  },
  {
    id: 'h2',
    labelKey: 'heading2',
    subtitleKey: 'slashH2Sub',
    icon: Heading2,
    kw: ['h2', 'heading', 'biaoti'],
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setNode('heading', { level: 2 }).run()
  },
  {
    id: 'h3',
    labelKey: 'heading3',
    subtitleKey: 'slashH3Sub',
    icon: Heading3,
    kw: ['h3', 'heading', 'biaoti'],
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setNode('heading', { level: 3 }).run()
  },
  {
    id: 'ul',
    labelKey: 'bulletList',
    subtitleKey: 'slashUlSub',
    icon: List,
    kw: ['ul', 'bullet', 'list', 'liebiao'],
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBulletList().run()
  },
  {
    id: 'ol',
    labelKey: 'orderedList',
    subtitleKey: 'slashOlSub',
    icon: ListOrdered,
    kw: ['ol', 'number', 'numbered', 'list'],
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleOrderedList().run()
  },
  {
    id: 'quote',
    labelKey: 'blockquote',
    subtitleKey: 'slashQuoteSub',
    icon: TextQuote,
    kw: ['quote', 'blockquote', 'yinyong'],
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBlockquote().run()
  },
  {
    id: 'code',
    labelKey: 'codeBlock',
    subtitleKey: 'slashCodeSub',
    icon: SquareCode,
    kw: ['code', 'codeblock', 'daima'],
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleCodeBlock().run()
  },
  {
    id: 'hr',
    labelKey: 'divider',
    subtitleKey: 'slashHrSub',
    icon: Minus,
    kw: ['hr', 'divider', 'line', 'fenge'],
    run: (editor, range) => editor.chain().focus().deleteRange(range).setHorizontalRule().run()
  }
]

/** slash 过滤 — 匹配本地化标题（i18n 单例，插件回调里无 hook 可用）或 kw。 */
export function filterSlashItems(query: string): SlashItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...SLASH_ITEMS]
  return SLASH_ITEMS.filter((it) => {
    const label = i18n.t(`compose.editor.${it.labelKey}`).toLowerCase()
    return label.includes(q) || it.kw.some((k) => k.includes(q))
  })
}

/** "/" 触发的 slash 命令扩展 — 独立 PluginKey，避免与 Mention 的 suggestion 冲突。 */
function createSlashExtension(): Extension {
  return Extension.create({
    name: 'composeSlash',
    addProseMirrorPlugins() {
      return [
        Suggestion<SlashItem, SlashItem>({
          editor: this.editor,
          pluginKey: new PluginKey('composeSlashSuggestion'),
          char: '/',
          allowSpaces: false,
          startOfLine: false,
          command: ({ editor, range, props }) => props.run(editor, range),
          items: ({ query }) => filterSlashItems(query),
          render: createSuggestionRender(SlashMenu)
        })
      ]
    }
  })
}

// ── table paste ──────────────────────────────────────────────────────

/** Parse the rectangular TSV shape emitted by Excel/Sheets clipboard copy. */
export function parseTsvTable(text: string): string[][] | null {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\n$/, '')
  if (!normalized.includes('\t')) return null
  const rows = normalized.split('\n').map((line) => line.split('\t'))
  const columnCount = rows[0]?.length ?? 0
  if (columnCount < 2 || rows.some((row) => row.length !== columnCount)) return null
  return rows
}

function createTableContent(rows: readonly (readonly string[])[]): Record<string, unknown> {
  return {
    type: 'table',
    content: rows.map((row) => ({
      type: 'tableRow',
      content: row.map((cell) => ({
        type: 'tableCell',
        content: [
          {
            type: 'paragraph',
            ...(cell.length > 0 ? { content: [{ type: 'text', text: cell }] } : {})
          }
        ]
      }))
    }))
  }
}

/** Office HTML cleanup + TSV fallback before ProseMirror builds the slice. */
function createTablePasteExtension(): Extension {
  return Extension.create({
    name: 'composeTablePaste',
    addProseMirrorPlugins() {
      const editor = this.editor
      return [
        new Plugin({
          props: {
            transformPastedHTML: normalizeEditableEmailHtml,
            handlePaste: (_view, event) => {
              const clipboard = event.clipboardData
              if (!clipboard) return false
              // Let ProseMirror's HTML parser handle real HTML tables after
              // transformPastedHTML has removed Office-only markup.
              if (/<table[\s>]/i.test(clipboard.getData('text/html'))) return false
              const rows = parseTsvTable(clipboard.getData('text/plain'))
              if (!rows) return false
              event.preventDefault()
              return editor.chain().focus().insertContent(createTableContent(rows)).run()
            }
          }
        })
      ]
    }
  })
}

// ── link paste onto selection ────────────────────────────────────────

/** 选区非空 + 剪贴板是单个带 scheme 的 URL → 给选中文本套 link（不把 URL 文本
 *  替换进去）。StarterKit Link 的 linkOnPaste 也做这件事，但它要求 linkify 的解析
 *  值与剪贴板逐字相等——含尾括号等特殊字符的 URL（wiki 页那类）会失配、回落成
 *  替换粘贴。本扩展 priority 1001（> Link 的 1000）先拿 handlePaste：判据只看
 *  scheme，href = 剪贴板原文不做 linkify 归一。无 scheme 的裸域名（example.com）
 *  仍交给 linkOnPaste 的启发式，无选区时一律不抢（现状行为不变）。 */
function createLinkPasteExtension(): Extension {
  return Extension.create({
    name: 'composeLinkPaste',
    priority: 1001,
    addProseMirrorPlugins() {
      const editor = this.editor
      return [
        new Plugin({
          props: {
            handlePaste: (view, event) => {
              if (view.state.selection.empty) return false
              const text = (event.clipboardData?.getData('text/plain') ?? '').trim()
              if (!text || /\s/.test(text)) return false
              if (!/^(?:https?|mailto):/i.test(text)) return false
              return editor.commands.setMark('link', { href: text })
            }
          }
        })
      ]
    }
  })
}

// ── inline image paste / drop ────────────────────────────────────────

/** 内联图片(data URL 直嵌正文)的单张上限 — data URL 会把字节膨胀 ~1.37×,
 *  大图该走附件而不是正文内联。工具栏「从文件选图」/ 粘贴 / 拖放三条入口同一口径。 */
export const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024

/** ComposePanel `<main>` onDrop 的对账标记：composeInlineImage 插件消费了这次
 *  drop 时挂在原生事件上（同一个事件对象一路冒泡），面板据此只收尾拖拽提示层、
 *  不再把文件当附件重复添加。 */
export const COMPOSE_INLINE_IMAGE_DROP_FLAG = 'maComposeInlineImageDrop'

/** 内联图片插件的 PluginKey — 测试用它精确定位插件（tiptap core 自带的 Drop 事件
 *  转发插件也有 handleDrop，按 prop 存在性找会撞）。 */
export const COMPOSE_INLINE_IMAGE_PLUGIN_KEY = new PluginKey('composeInlineImage')

function readImageAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => resolve('')
    reader.readAsDataURL(file)
  })
}

/** 读文件 → data URL → 插入正文；超限逐张 toast（与工具栏「从文件选图」同文案）。
 *  `pos` = null 时插在当前光标（粘贴路径），否则插在 drop 坐标换算的位置。 */
async function insertInlineImages(
  editor: Editor,
  files: File[],
  pos: number | null
): Promise<void> {
  const within: File[] = []
  for (const file of files) {
    if (file.size > MAX_INLINE_IMAGE_BYTES) {
      toastError(i18n.t('compose.editor.imageTooLarge', { name: file.name, max: 4 }))
    } else {
      within.push(file)
    }
  }
  if (within.length === 0) return
  const srcs = await Promise.all(within.map(readImageAsDataUrl))
  const nodes = srcs.filter((s) => s.length > 0).map((src) => ({ type: 'image', attrs: { src } }))
  if (nodes.length === 0 || editor.isDestroyed) return
  if (pos === null) {
    editor.chain().focus().insertContent(nodes).run()
  } else {
    // FileReader 是异步的, 完成时文档可能已变 → 位置钳制到当前文档边界。
    const clamped = Math.max(0, Math.min(pos, editor.state.doc.content.size))
    editor.chain().focus().insertContentAt(clamped, nodes).run()
  }
}

/** 剪贴板图片（截图 / Finder 拷贝）粘贴 + 图片文件拖放 → data URL 内联插入。
 *  与工具栏「从文件选图」同一下游（data: 直嵌正文 HTML，随邮件发出）。 */
function createInlineImageExtension(): Extension {
  return Extension.create({
    name: 'composeInlineImage',
    addProseMirrorPlugins() {
      const editor = this.editor
      return [
        new Plugin({
          key: COMPOSE_INLINE_IMAGE_PLUGIN_KEY,
          props: {
            // 只接「剪贴板只有图片文件、没有 HTML」的粘贴（截图 / Finder 拷贝的
            // 典型形状）。带 HTML 的粘贴（网页图文 / Office）仍走默认解析，不抢。
            handlePaste: (_view, event) => {
              const clipboard = event.clipboardData
              if (!clipboard) return false
              const images = Array.from(clipboard.files ?? []).filter((f) =>
                f.type.startsWith('image/')
              )
              if (images.length === 0) return false
              if ((clipboard.getData('text/html') ?? '').trim().length > 0) return false
              event.preventDefault()
              void insertInlineImages(editor, images, null)
              return true
            },
            // 拖放：整批都是 ≤4MB 的图片才内联插到 drop cursor 位置；混入非图片
            // 或超限图 → 返回 false，整批交还 ComposePanel 的附件拖放链（一次
            // drop 语义单一，不拆成内联 + 附件两半）。
            handleDrop: (view, event) => {
              const files = Array.from(event.dataTransfer?.files ?? [])
              if (files.length === 0) return false
              const allInline = files.every(
                (f) => f.type.startsWith('image/') && f.size <= MAX_INLINE_IMAGE_BYTES
              )
              if (!allInline) return false
              event.preventDefault()
              ;(event as unknown as Record<string, unknown>)[COMPOSE_INLINE_IMAGE_DROP_FLAG] = true
              let pos: number | null = null
              try {
                pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null
              } catch {
                pos = null // 无布局环境（测试）拿不到坐标 → 回落当前光标位置
              }
              void insertInlineImages(editor, files, pos)
              return true
            }
          }
        })
      ]
    }
  })
}

// ── @mention ─────────────────────────────────────────────────────────

/** mention 下拉最多显示的联系人数（对齐 demo MENTION_POOL slice 6）。 */
export const MENTION_CONTACT_LIMIT = 6

export interface ComposeMentionOptions {
  /** 联系人数据源；缺省 = mailApi.email.contactSuggest（RecipientField 同通道）。 */
  fetchContacts?: (query: string) => Promise<ContactSuggestion[]>
  /** T5 接线点：mention 选中联系人时回调（自动加进收件人）。 */
  onMentionPick?: (contact: ContactSuggestion) => void
}

/**
 * Mention suggestion 配置 — 不覆写 command（沿用 Mention 内置插入：mention
 * 节点 + 尾随空格 + overrideSpace 处理），onMentionPick 在菜单选中时机触发。
 */
export function createMentionSuggestion(
  options: ComposeMentionOptions = {}
): Omit<SuggestionOptions<ContactSuggestion, MentionNodeAttrs>, 'editor'> {
  const fetchContacts =
    options.fetchContacts ??
    ((query: string): Promise<ContactSuggestion[]> =>
      makeMailApi().email.contactSuggest(query, MENTION_CONTACT_LIMIT))
  // 查询代际守卫（codex F2）：suggestion 插件的 update 是 async 的（await items()），
  // 两次 update 可交错乱序 —— 实测 v3.23.6 的 props 是插件闭包共享变量（每次 update
  // 整体覆写），迟到回调拿到的对象本身是最新的，但危害有二：① 迟到 onStart 在
  // onUpdate 已建浮层后二次 create（旧浮层泄漏 + 双菜单，Enter 语义分裂）；② 回调
  // 携带的 items 可能是未 await 完的占位 [] / exit 后残留的旧代际数组（菜单复活/
  // 闪烁）。只在 items() 里去重返回最新结果挡不住这些 stale 回调。修法：items()
  // 每次调用领取递增代际并把返回数组登记进 WeakMap；render 桥（guards.isStale）在
  // onStart/onUpdate 比对 props.items 的代际，非最新则丢弃整个更新（不是只丢
  // items），配合 create() 幂等化 —— 最终安装的 command/items 恒为最新代际。
  let generation = 0
  const itemsGeneration = new WeakMap<ContactSuggestion[], number>()
  return {
    char: '@',
    items: async ({ query }): Promise<ContactSuggestion[]> => {
      const gen = ++generation
      // 数据源失败（离线/后端异常）不能炸编辑器 → 静默空列表（菜单隐藏）。
      let result: ContactSuggestion[]
      try {
        result = (await fetchContacts(query)).slice(0, MENTION_CONTACT_LIMIT)
      } catch {
        result = []
      }
      itemsGeneration.set(result, gen)
      return result
    },
    render: createSuggestionRender(
      MentionMenu,
      { onPick: options.onMentionPick },
      { isStale: (props) => itemsGeneration.get(props.items) !== generation }
    )
  }
}

// ── 装配工厂 ─────────────────────────────────────────────────────────

export interface ComposeExtensionsOptions extends ComposeMentionOptions {
  /**
   * 可选 Placeholder 扩展文案。注意生产 ComposeEditor 自绘空态浮层已覆盖
   * placeholder 展示；传入本项需配套 `[data-placeholder]` CSS 才可见。
   */
  placeholder?: string
}

/**
 * Compose 编辑器扩展装配工厂（T5 把 ComposePanel 的 useEditor 切到这里）。
 * mention 节点 label=姓名 id=email，发送序列化为可读 `@姓名` 文本。
 */
export function buildComposeExtensions(options: ComposeExtensionsOptions = {}): Extensions {
  const extensions: Extensions = [
    // heading 收敛 H1-H3（工具栏/slash 同款位阶）；link 行为与旧装配一致。
    // dropcursor: 拖图片进正文时的插入位置指示（accent 色 2px, 默认 currentColor
    // 1px 在深底上几乎不可见）。
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: { openOnClick: false },
      dropcursor: { color: 'rgb(var(--c-accent))', width: 2 }
    }),
    TextStyle,
    Color,
    FontFamily,
    FontSize,
    BackgroundColor,
    Image.configure({ inline: true, allowBase64: true }),
    TableKit.configure({
      table: {
        resizable: false,
        allowTableNodeSelection: true,
        HTMLAttributes: { class: 'compose-email-table' }
      }
    }),
    createTablePasteExtension(),
    Highlight.configure({ multicolor: true }),
    Mention.configure({
      // Tailwind utility 类直接进节点（编辑态内联着色）；发送后收件方按纯文本
      // `@姓名` 呈现（默认 renderText/renderHTML 已含 @ 前缀文案）。
      HTMLAttributes: { class: 'compose-mention text-coral font-medium' },
      suggestion: createMentionSuggestion(options)
    }),
    createSlashExtension(),
    createLinkPasteExtension(),
    createInlineImageExtension()
  ]
  if (options.placeholder) {
    extensions.push(Placeholder.configure({ placeholder: options.placeholder }))
  }
  return extensions
}
