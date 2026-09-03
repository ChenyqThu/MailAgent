// P2-L7 —— 资料库检索面叶子（⌘K 第五 lane 与 /search 页组共用的纯函数）。
import { describe, expect, test, vi } from 'vitest'

import type { LibrarySearchHit } from '../../../src/shared/api/types/library'
import {
  LIBRARY_MAX_HITS,
  libraryAddressableHits,
  libraryFileLinkTarget,
  libraryWarningLabelKey,
  navigateToLibraryFile,
  parseLibrarySnippet
} from '../../../src/shared/components/command/paletteLibrary'

function hit(overrides: Partial<LibrarySearchHit> = {}): LibrarySearchHit {
  return {
    id: 7,
    mount_id: 0,
    rel_path: 'notes/a.md',
    path: 'my-docs/notes/a.md',
    parent_path: 'my-docs/notes',
    filename: 'a.md',
    kind: 'markdown',
    mime: 'text/markdown',
    size_bytes: 120,
    mtime: 1_756_000_000,
    content_hash: 'h',
    source: 'user',
    source_ref: null,
    created_by: 'user',
    status: 'present',
    text_status: 'extracted',
    created_at: 1_756_000_000,
    updated_at: 1_756_000_000,
    snippet: null,
    rank: null,
    match: 'text',
    ...overrides
  }
}

describe('libraryWarningLabelKey', () => {
  test('中文 1 字拦截码 → tooShort 文案键（带 payload 的形状也要认）', () => {
    expect(libraryWarningLabelKey('cjk_too_short:合')).toBe('library.search.tooShort')
    expect(libraryWarningLabelKey('cjk_too_short')).toBe('library.search.tooShort')
  })

  test('未知码 → 通用文案键（不把机器码直接摊给用户）', () => {
    expect(libraryWarningLabelKey('something_new:42')).toBe('library.search.warnGeneric')
  })
})

describe('parseLibrarySnippet', () => {
  test('空 / null snippet → 零段', () => {
    expect(parseLibrarySnippet(null)).toEqual([])
    expect(parseLibrarySnippet('')).toEqual([])
    expect(parseLibrarySnippet(undefined)).toEqual([])
  })

  test('无标记（2 字 LIKE 那条腿）→ 一整段普通文本', () => {
    expect(parseLibrarySnippet('合同草案第三版')).toEqual([{ text: '合同草案第三版', hit: false }])
  })

  test('[…] 标记切成命中段 / 普通段，顺序与原串一致', () => {
    expect(parseLibrarySnippet('…第三版[合同]评审与[合同]归档…')).toEqual([
      { text: '…第三版', hit: false },
      { text: '合同', hit: true },
      { text: '评审与', hit: false },
      { text: '合同', hit: true },
      { text: '归档…', hit: false }
    ])
  })

  test('落单的 [ 当普通文本，不吞后面的字', () => {
    expect(parseLibrarySnippet('见附录 [3 未闭合')).toEqual([
      { text: '见附录 [3 未闭合', hit: false }
    ])
  })

  test('空标记 [] 不产出空段', () => {
    expect(parseLibrarySnippet('a[]b')).toEqual([
      { text: 'a', hit: false },
      { text: 'b', hit: false }
    ])
  })
})

describe('libraryAddressableHits', () => {
  test('滤掉没有 library id 的行（没有 id 就没有深链去处）', () => {
    const rows = [hit({ id: 7 }), hit({ id: null }), hit({ id: 9 })]
    expect(libraryAddressableHits(rows).map((row) => row.id)).toEqual([7, 9])
  })
})

describe('资料库深链（design §9.5）', () => {
  test('目标形状恒 /library?file={id}', () => {
    expect(libraryFileLinkTarget(42)).toEqual({ to: '/library', search: { file: 42 } })
  })

  test('navigateToLibraryFile 把这个形状原样交给 navigate', () => {
    const navigate = vi.fn()
    navigateToLibraryFile(navigate as never, 42)
    expect(navigate).toHaveBeenCalledWith({ to: '/library', search: { file: 42 } })
  })
})

describe('截断口径', () => {
  test('两个入口共享同一个 limit（同 query key 必须同 limit）', () => {
    expect(LIBRARY_MAX_HITS).toBe(8)
  })
})
