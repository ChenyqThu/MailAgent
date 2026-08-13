// @vitest-environment happy-dom

// 批次 4 —— G-32 / G-33 的两道闸。
//
// G-33：`readMatterUndoDescriptor` 是「要不要给这次操作配撤销按钮」的**唯一判据**。它一旦放松
// （比如只判 `undo != null`），界面上就会出现点了才报错的假撤销 —— 那正是本条要防的失败模式。
//
// G-32：浮层入场动效的可观测签名取「退场期间仍在 DOM」（抄 composer_plus_menu.test.tsx 的判据）：
// `{open && …}` 硬切实现下，关闭的同一拍元素就没了，这条必红。全局 setup 强制 reduced-motion
// （那时 useExitAnimation 直切、与硬切不可分辨），所以这里必须自己把 matchMedia 换成「不 reduce」。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import i18n from '@shared/i18n'
import { readMatterUndoDescriptor } from '@shared/api/matters'
import { AddItemModal } from '@shared/components/matters/AddItemModal'

await i18n.changeLanguage('zh-CN')

describe('G-33 — readMatterUndoDescriptor（撤销按钮的准入判据）', () => {
  const archiveUndo = {
    tool: 'matter_update',
    label: '撤销archive',
    input: {
      public_id: 'MAT-0042',
      operation: 'reopen',
      expected_version: 7,
      reverses_event_id: 12
    }
  }

  test('归档 / 移入回收站这类有反向操作的写入 → 交出 descriptor', () => {
    expect(readMatterUndoDescriptor({ matter: null, undo: archiveUndo })).toMatchObject({
      tool: 'matter_update'
    })
    expect(
      readMatterUndoDescriptor({
        undo: {
          tool: 'matter_resource_mutate',
          label: '撤销资料解除关联',
          input: { public_id: 'MAT-0042', operation: 'restore', resource_id: 9 }
        }
      })
    ).not.toBeNull()
  })

  test('后端没给反向操作（接受提案 / 删除标签那一类）→ null，界面不出现撤销按钮', () => {
    expect(readMatterUndoDescriptor({ matter: null, undo: null })).toBeNull()
    expect(readMatterUndoDescriptor({ matter: null })).toBeNull()
    expect(readMatterUndoDescriptor(undefined)).toBeNull()
  })

  test('结构不对的 descriptor 一律拒（宁可没有按钮，也不发半懂的写请求）', () => {
    expect(readMatterUndoDescriptor({ undo: { tool: '', label: 'x', input: {} } })).toBeNull()
    expect(
      readMatterUndoDescriptor({ undo: { tool: 'matter_update', label: '', input: {} } })
    ).toBeNull()
    expect(readMatterUndoDescriptor({ undo: { tool: 'matter_update', label: 'x' } })).toBeNull()
    expect(
      readMatterUndoDescriptor({ undo: { tool: 'matter_update', label: 'x', input: [] } })
    ).toBeNull()
  })

  test('🔴 本客户端执行不了的 descriptor 也要拒 —— 有 undo ≠ 点得动', () => {
    // 未知 tool。
    expect(
      readMatterUndoDescriptor({
        undo: { tool: 'matter_unknown_mutate', label: 'x', input: { public_id: 'MAT-0042' } }
      })
    ).toBeNull()
    // 认得 tool，但 operation 不在 tool→REST 表里。
    expect(
      readMatterUndoDescriptor({
        undo: {
          tool: 'matter_update',
          label: 'x',
          input: { public_id: 'MAT-0042', operation: 'nope' }
        }
      })
    ).toBeNull()
    // public_id 缺失 —— 路径都拼不出来。
    expect(
      readMatterUndoDescriptor({
        undo: { tool: 'matter_update', label: 'x', input: { operation: 'reopen' } }
      })
    ).toBeNull()
  })
})

describe('G-32 — matters 浮层退场播完才卸载', () => {
  // 🔴 判据必须是「在不在 DOM 里」，不能用 `queryByRole`：进场首帧 autoAlpha:0 会写
  // `visibility:hidden`，那一帧元素不在无障碍树里，role 查询会把"正常工作的动效"读成"没渲染"。
  // 同 composer_plus_menu.test.tsx 用 querySelector 的理由。
  const dialog = (): Element | null => document.querySelector('[role="dialog"]')

  beforeEach(() => {
    vi.stubGlobal(
      'matchMedia',
      (query: string) =>
        ({
          matches: false,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
          onchange: null
        }) as unknown as MediaQueryList
    )
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  test('AddItemModal：open 转 false 后先留在 DOM 播退场，再卸载', async () => {
    const view = render(<AddItemModal open onClose={vi.fn()} onAdd={vi.fn()} />)
    expect(dialog()).not.toBeNull()

    view.rerender(<AddItemModal open={false} onClose={vi.fn()} onAdd={vi.fn()} />)
    // 硬切实现在这一行就已经是 null（本闸的失败模式）。
    expect(dialog()).not.toBeNull()
    // DUR.fast=120ms 的退场播完后才真正卸载。
    await waitFor(() => expect(dialog()).toBeNull(), { timeout: 2000 })
  })

  test('reduced-motion：open 转 false 立刻卸载，不留一个看不见还挡点击的壳', async () => {
    vi.stubGlobal(
      'matchMedia',
      (query: string) =>
        ({
          matches: true,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
          onchange: null
        }) as unknown as MediaQueryList
    )
    const view = render(<AddItemModal open onClose={vi.fn()} onAdd={vi.fn()} />)
    expect(dialog()).not.toBeNull()
    view.rerender(<AddItemModal open={false} onClose={vi.fn()} onAdd={vi.fn()} />)
    await waitFor(() => expect(dialog()).toBeNull())
  })

  // 🔴 进场用的是 `fromTo`（终点显式 autoAlpha:1），不是 `gsap.from`：后者在快速开-关-开时
  // 会把元素停在起始的隐藏态 —— 面板在 DOM 里、却永远 `visibility:hidden`，用户看得见"什么都
  // 没发生"。判据取「进场播完后面板进得了无障碍树、表单点得动」（getByRole 默认排除隐藏元素，
  // 停在隐藏态的实现这条必红）。
  test('进场播完后面板可见且可交互，没有停在隐藏态', async () => {
    const onAdd = vi.fn()
    render(<AddItemModal open onClose={vi.fn()} onAdd={onAdd} />)
    const submit = await screen.findByRole('button', { name: '添加' }, { timeout: 2000 })
    const input = document.querySelector('input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '联系供应商' } })
    fireEvent.click(submit)
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'action', title: '联系供应商' })
    )
  })
})
