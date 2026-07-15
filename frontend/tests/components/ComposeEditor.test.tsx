// @vitest-environment happy-dom
//
// Compose 编辑器（epic T2）— classic 分组工具栏命令接线 + slash 菜单项过滤 +
// @mention 数据源/选中回调。真实 TipTap Editor（buildComposeExtensions 装配）
// 驱动，不 mock 编辑器内核；mention 数据源注入 stub（不打真实 IPC/HTTP）。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { useEditor, type Editor, type Extensions } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import {
  TextStyle,
  Color,
  FontFamily,
  FontSize,
  BackgroundColor
} from '@tiptap/extension-text-style'
import Image from '@tiptap/extension-image'

import i18n from '@shared/i18n'
import type { ContactSuggestion } from '@shared/api/types'
import {
  ComposeEditor,
  ComposeFormatToolbar
} from '../../src/shared/components/email/compose/ComposeEditor'
import {
  SLASH_ITEMS,
  buildComposeExtensions,
  createMentionSuggestion,
  filterSlashItems,
  type ComposeExtensionsOptions
} from '../../src/shared/components/email/compose/editor-extensions'
import {
  MentionMenu,
  type SuggestMenuHandle
} from '../../src/shared/components/email/compose/editor-suggest'

await i18n.changeLanguage('zh-CN')

const CONTACTS: ContactSuggestion[] = [
  { email: 'alice@acme.test', name: 'Alice Chen', score: 9 },
  { email: 'bob@acme.test', name: 'Bob Li', score: 8 },
  { email: 'noname@acme.test', score: 1 }
]

const stubFetch = (): ((q: string) => Promise<ContactSuggestion[]>) => vi.fn(async () => CONTACTS)

function Harness({
  onEditor,
  options,
  extensions,
  content = '<p>hello world</p>'
}: {
  onEditor: (e: Editor) => void
  options?: ComposeExtensionsOptions
  /** 传入 = 用旧 ComposePanel 装配（兼容回退路径测试）。 */
  extensions?: Extensions
  content?: string
}): React.ReactElement | null {
  const editor = useEditor({
    extensions: extensions ?? buildComposeExtensions({ fetchContacts: stubFetch(), ...options }),
    content,
    immediatelyRender: true
  })
  useEffect(() => {
    if (editor) onEditor(editor)
  }, [editor, onEditor])
  if (!editor) return null
  return (
    <>
      <ComposeFormatToolbar editor={editor} />
      <ComposeEditor editor={editor} />
    </>
  )
}

function renderEditor(opts?: {
  options?: ComposeExtensionsOptions
  extensions?: Extensions
  content?: string
}): Editor {
  let editor: Editor | null = null
  render(
    <Harness
      options={opts?.options}
      extensions={opts?.extensions}
      content={opts?.content}
      onEditor={(e) => {
        editor = e
      }}
    />
  )
  if (!editor) throw new Error('editor not initialized')
  return editor
}

/** ComposePanel 现行（未切工厂前）的旧装配 — 高亮回退路径用。 */
function legacyPanelExtensions(): Extensions {
  return [
    StarterKit.configure({ link: { openOnClick: false } }),
    TextStyle,
    Color,
    FontFamily,
    FontSize,
    BackgroundColor,
    Image.configure({ inline: true, allowBase64: true })
  ]
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ComposeFormatToolbar — 命令接线（新装配）', () => {
  test('B/I/U/S 按钮 toggle 对应 mark', () => {
    const editor = renderEditor()
    act(() => {
      editor.commands.selectAll()
    })
    for (const [label, mark] of [
      ['加粗', 'bold'],
      ['斜体', 'italic'],
      ['下划线', 'underline'],
      ['删除线', 'strike']
    ] as const) {
      fireEvent.click(screen.getByLabelText(label))
      expect(editor.isActive(mark)).toBe(true)
    }
  })

  test('正文/标题下拉切换 heading level', async () => {
    const editor = renderEditor()
    act(() => {
      editor.commands.selectAll()
    })
    fireEvent.click(screen.getByLabelText('标题格式'))
    fireEvent.click(await screen.findByRole('option', { name: '标题 1' }))
    // 断言按文档状态（setNode 后选区落尾部空段, isActive 读的是光标处）。
    expect(editor.getHTML()).toContain('<h1>hello world</h1>')
  })

  // radix Popover 在 happy-dom 下同一测试内二次打开会立刻卸载内容（真机 Chromium
  // 无此问题）→ 「切回正文」拆独立测试：前置态直接命令铺设，UI 只做一次交互。
  test('正文/标题下拉：标题切回正文', async () => {
    const editor = renderEditor({ content: '<h1>hello world</h1>' })
    act(() => {
      editor.commands.selectAll()
    })
    fireEvent.click(screen.getByLabelText('标题格式'))
    fireEvent.click(await screen.findByRole('option', { name: '正文' }))
    expect(editor.getHTML()).not.toContain('<h1')
    expect(editor.getHTML()).toContain('hello world')
  })

  test('字号下拉写 textStyle fontSize（12-30px 档位）', async () => {
    const editor = renderEditor()
    act(() => {
      editor.commands.selectAll()
    })
    fireEvent.click(screen.getByLabelText('字号'))
    fireEvent.click(await screen.findByRole('option', { name: '18' }))
    expect(editor.getAttributes('textStyle').fontSize).toBe('18px')
  })

  test('文字颜色 swatch 应用 setColor + 清除档还原', async () => {
    const editor = renderEditor()
    act(() => {
      editor.commands.selectAll()
    })
    fireEvent.click(screen.getByLabelText('字体颜色'))
    fireEvent.click(await screen.findByTitle('#E5654B'))
    // 断言按文档状态（swatch 应用后选区可能落到空段, getAttributes 读光标处）。
    expect(editor.getHTML()).toContain('#E5654B')
  })

  // 同 heading：happy-dom 下 radix Popover 二次打开即卸载 → 清除档拆独立测试。
  test('文字颜色 swatch：清除档还原默认色', async () => {
    const editor = renderEditor()
    act(() => {
      editor.chain().selectAll().setColor('#E5654B').run()
    })
    expect(editor.getHTML()).toContain('#E5654B')
    act(() => {
      editor.commands.selectAll()
    })
    fireEvent.click(screen.getByLabelText('字体颜色'))
    fireEvent.click(await screen.findByLabelText('默认'))
    expect(editor.getHTML()).not.toContain('#E5654B')
  })

  test('高亮 swatch（新装配）走 Highlight multicolor mark', async () => {
    const editor = renderEditor()
    act(() => {
      editor.commands.selectAll()
    })
    fireEvent.click(screen.getByLabelText('高亮'))
    fireEvent.click(await screen.findByTitle('#FCE7A2'))
    expect(editor.isActive('highlight')).toBe(true)
    expect(editor.getAttributes('highlight').color).toBe('#FCE7A2')
  })

  test('高亮 swatch（旧 ComposePanel 装配，无 Highlight 扩展）回退 backgroundColor', async () => {
    const editor = renderEditor({ extensions: legacyPanelExtensions() })
    act(() => {
      editor.commands.selectAll()
    })
    fireEvent.click(screen.getByLabelText('高亮'))
    fireEvent.click(await screen.findByTitle('#FCE7A2'))
    expect(editor.getAttributes('textStyle').backgroundColor).toBe('#FCE7A2')
    expect(editor.isActive('highlight')).toBe(false)
  })

  test('列表/引用块/代码块按钮 toggle 块级节点', () => {
    const editor = renderEditor()
    fireEvent.click(screen.getByLabelText('无序列表'))
    expect(editor.isActive('bulletList')).toBe(true)
    fireEvent.click(screen.getByLabelText('无序列表'))
    fireEvent.click(screen.getByLabelText('有序列表'))
    expect(editor.isActive('orderedList')).toBe(true)
    fireEvent.click(screen.getByLabelText('有序列表'))
    fireEvent.click(screen.getByLabelText('引用块'))
    expect(editor.isActive('blockquote')).toBe(true)
    fireEvent.click(screen.getByLabelText('引用块'))
    fireEvent.click(screen.getByLabelText('代码块'))
    expect(editor.isActive('codeBlock')).toBe(true)
  })

  test('链接弹框：输入 URL 应用 → link mark 带 href', () => {
    const editor = renderEditor()
    act(() => {
      editor.commands.selectAll()
    })
    fireEvent.click(screen.getByLabelText('链接'))
    const input = screen.getByPlaceholderText('链接地址')
    fireEvent.change(input, { target: { value: 'https://example.test/x' } })
    fireEvent.click(screen.getByLabelText('应用'))
    expect(editor.isActive('link')).toBe(true)
    expect(editor.getAttributes('link').href).toBe('https://example.test/x')
  })

  test('图片弹框：输入 URL 插入 <img>', () => {
    const editor = renderEditor()
    fireEvent.click(screen.getByLabelText('插入图片'))
    const input = screen.getByPlaceholderText('图片地址')
    fireEvent.change(input, { target: { value: 'https://example.test/pic.png' } })
    fireEvent.click(screen.getByLabelText('插入'))
    expect(editor.getHTML()).toContain('<img')
    expect(editor.getHTML()).toContain('https://example.test/pic.png')
  })

  test('分割线按钮插入 <hr>', () => {
    const editor = renderEditor()
    fireEvent.click(screen.getByLabelText('分割线'))
    expect(editor.getHTML()).toContain('<hr')
  })

  test('@ 按钮：词尾插入补空格触发（" @"）', () => {
    const editor = renderEditor()
    act(() => {
      editor.commands.focus('end')
    })
    fireEvent.click(screen.getByLabelText('提及某人 @'))
    expect(editor.getText()).toContain('hello world @')
  })

  test('撤销/重做：初始禁用 → 有编辑后可撤销', () => {
    const editor = renderEditor()
    expect(screen.getByLabelText('撤销')).toHaveProperty('disabled', true)
    act(() => {
      editor.commands.selectAll()
    })
    fireEvent.click(screen.getByLabelText('加粗'))
    expect(editor.isActive('bold')).toBe(true)
    expect(screen.getByLabelText('撤销')).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByLabelText('撤销'))
    expect(editor.isActive('bold')).toBe(false)
  })
})

describe('slash 块菜单', () => {
  test('filterSlashItems：空查询返回全部 8 项', () => {
    expect(filterSlashItems('')).toHaveLength(SLASH_ITEMS.length)
    expect(SLASH_ITEMS).toHaveLength(8)
  })

  test('filterSlashItems：kw / 本地化标题 / 拼音均可过滤', () => {
    expect(filterSlashItems('h1').map((i) => i.id)).toEqual(['h1'])
    expect(filterSlashItems('引用').map((i) => i.id)).toEqual(['quote'])
    expect(filterSlashItems('daima').map((i) => i.id)).toEqual(['code'])
    expect(filterSlashItems('zzz-no-match')).toHaveLength(0)
  })

  test('slash 项 run：删除触发文本并应用块（h1 / hr）', () => {
    const editor = renderEditor({ content: '<p>/</p>' })
    const h1 = SLASH_ITEMS.find((i) => i.id === 'h1')!
    act(() => {
      h1.run(editor, { from: 1, to: 2 })
    })
    expect(editor.getHTML()).toContain('<h1')
    expect(editor.getText()).not.toContain('/')

    const editor2 = renderEditor({ content: '<p>/</p>' })
    const hr = SLASH_ITEMS.find((i) => i.id === 'hr')!
    act(() => {
      hr.run(editor2, { from: 1, to: 2 })
    })
    expect(editor2.getHTML()).toContain('<hr')
  })
})

describe('@mention', () => {
  test('createMentionSuggestion.items：走注入的数据源并截断到 6 条', async () => {
    const many: ContactSuggestion[] = Array.from({ length: 9 }, (_, i) => ({
      email: `u${i}@acme.test`,
      score: i
    }))
    const fetchContacts = vi.fn(async (q: string) => many.filter((c) => c.email.includes(q)))
    const sugg = createMentionSuggestion({ fetchContacts })
    const items = await sugg.items!({ query: 'u', editor: null as never })
    expect(fetchContacts).toHaveBeenCalledWith('u')
    expect(items).toHaveLength(6)
  })

  test('createMentionSuggestion.items：数据源抛错 → 静默空列表', async () => {
    const sugg = createMentionSuggestion({
      fetchContacts: vi.fn(async () => {
        throw new Error('offline')
      })
    })
    await expect(sugg.items!({ query: 'x', editor: null as never })).resolves.toEqual([])
  })

  test('MentionMenu：点击项 → onPick(contact) + command({id,label})；无姓名回退邮箱', () => {
    const command = vi.fn()
    const onPick = vi.fn()
    render(<MentionMenu items={CONTACTS} command={command} onPick={onPick} />)
    fireEvent.click(screen.getByText('alice@acme.test'))
    expect(onPick).toHaveBeenCalledWith(CONTACTS[0])
    expect(command).toHaveBeenCalledWith({ id: 'alice@acme.test', label: 'Alice Chen' })
    // 无姓名联系人的姓名行回退显示邮箱 → 该文本出现两次（姓名行 + 邮箱行）。
    fireEvent.click(screen.getAllByText('noname@acme.test')[0])
    expect(command).toHaveBeenLastCalledWith({
      id: 'noname@acme.test',
      label: 'noname@acme.test'
    })
  })

  test('MentionMenu：↑/↓/Enter 键盘导航经 ref 句柄', () => {
    const command = vi.fn()
    const ref = { current: null as SuggestMenuHandle | null }
    render(<MentionMenu items={CONTACTS} command={command} ref={ref} />)
    const key = (k: string): boolean =>
      ref.current!.onKeyDown({ event: new KeyboardEvent('keydown', { key: k }) } as never)
    act(() => {
      expect(key('ArrowDown')).toBe(true)
    })
    act(() => {
      expect(key('Enter')).toBe(true)
    })
    expect(command).toHaveBeenCalledWith({ id: 'bob@acme.test', label: 'Bob Li' })
  })

  test('mention 节点插入：label=姓名 id=email，序列化为 @姓名', () => {
    const editor = renderEditor()
    act(() => {
      editor.commands.insertContent({
        type: 'mention',
        attrs: { id: 'alice@acme.test', label: 'Alice Chen' }
      })
    })
    const html = editor.getHTML()
    expect(html).toContain('data-id="alice@acme.test"')
    expect(html).toContain('@Alice Chen')
  })
})
