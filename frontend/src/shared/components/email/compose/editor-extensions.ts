// Compose editor 扩展装配 — buildComposeExtensions 工厂（epic T2，契约 D4）。
//
// 生产装配点：T5 把 ComposePanel 的 useEditor extensions 切到这里。在那之前
// ComposePanel 保持自己的旧装配（本文件不被它引用也要独立可用）。
//
// 相对 ComposePanel 旧装配（StarterKit + TextStyle 族 + Image）新增：
//   - Highlight(multicolor)   → 工具栏高亮 swatch
//   - Mention(@联系人)        → 数据源复用 email.contactSuggest（RecipientField 同通道）
//   - composeSlash("/" 块菜单) → @tiptap/suggestion 自定义扩展
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
import { Placeholder } from '@tiptap/extensions'
import { Extension, ReactRenderer } from '@tiptap/react'
import type { Editor, Extensions, Range } from '@tiptap/react'
import { Suggestion } from '@tiptap/suggestion'
import type { SuggestionKeyDownProps, SuggestionOptions, SuggestionProps } from '@tiptap/suggestion'
import { PluginKey } from '@tiptap/pm/state'
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
 */
export function createSuggestionRender<I, S, P extends SuggestRenderBaseProps<I, S>>(
  Component: React.ComponentType<P>,
  staticProps?: Omit<P, keyof SuggestRenderBaseProps<I, S>>
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
      onStart: create,
      onUpdate: (props: SuggestionProps<I, S>): void => {
        if (props.editor.isDestroyed) {
          destroy()
          return
        }
        if (!renderer) {
          create(props)
          return
        }
        renderer.updateProps({ items: props.items, command: props.command, query: props.query })
        position(props.clientRect)
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
  // 查询代际守卫：suggestion 插件的 update 是 async 的，两次 update 可交错 ——
  // 慢的旧请求（@ali）后到会把旧结果交给 onUpdate 覆盖新菜单（@bob），Enter 选错人。
  // 每次调用领取递增代际；await 回来若已有更新代际发出，丢弃自己的结果、返回当前
  // 已知的最新结果（最终渲染由最新在途请求负责），旧包永远覆盖不了新菜单。
  let generation = 0
  let latestItems: ContactSuggestion[] = []
  return {
    char: '@',
    items: async ({ query }): Promise<ContactSuggestion[]> => {
      const gen = ++generation
      // 数据源失败（离线/后端异常）不能炸编辑器 → 静默空列表（菜单隐藏）。
      try {
        const result = (await fetchContacts(query)).slice(0, MENTION_CONTACT_LIMIT)
        if (gen === generation) latestItems = result
      } catch {
        if (gen === generation) latestItems = []
      }
      return latestItems
    },
    render: createSuggestionRender(MentionMenu, { onPick: options.onMentionPick })
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
    StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false } }),
    TextStyle,
    Color,
    FontFamily,
    FontSize,
    BackgroundColor,
    Image.configure({ inline: true, allowBase64: true }),
    Highlight.configure({ multicolor: true }),
    Mention.configure({
      // Tailwind utility 类直接进节点（编辑态内联着色）；发送后收件方按纯文本
      // `@姓名` 呈现（默认 renderText/renderHTML 已含 @ 前缀文案）。
      HTMLAttributes: { class: 'compose-mention text-coral font-medium' },
      suggestion: createMentionSuggestion(options)
    }),
    createSlashExtension()
  ]
  if (options.placeholder) {
    extensions.push(Placeholder.configure({ placeholder: options.placeholder }))
  }
  return extensions
}
