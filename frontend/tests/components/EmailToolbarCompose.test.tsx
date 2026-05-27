// @vitest-environment happy-dom
//
// Compose — EmailToolbar primary CTA becomes a reply/reply-all/forward split
// button when `onOpenCompose` is wired. The legacy `onCreateDraft` PrimaryBtn
// path stays (covered by EmailToolbar.test.tsx) for backward compat.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import i18n from '@shared/i18n'
import { EmailToolbar } from '../../src/shared/components/email/EmailToolbar'

await i18n.changeLanguage('zh-CN')

beforeEach(() => {
  cleanup()
})

afterEach(() => {
  cleanup()
})

describe('EmailToolbar — compose split button', () => {
  test('primary action fires onOpenCompose("reply")', () => {
    const onOpenCompose = vi.fn()
    render(<EmailToolbar onOpenCompose={onOpenCompose} />)
    fireEvent.click(screen.getByRole('button', { name: '回复' }))
    expect(onOpenCompose).toHaveBeenCalledWith('reply')
  })

  test('chevron menu exposes reply-all + forward', () => {
    const onOpenCompose = vi.fn()
    render(<EmailToolbar onOpenCompose={onOpenCompose} />)
    fireEvent.click(screen.getByRole('button', { name: '撰写方式' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /回复所有/ }))
    expect(onOpenCompose).toHaveBeenCalledWith('reply-all')

    fireEvent.click(screen.getByRole('button', { name: '撰写方式' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /转发/ }))
    expect(onOpenCompose).toHaveBeenCalledWith('forward')
  })

  test('without onOpenCompose, legacy 起草回复 CTA still renders', () => {
    const onCreateDraft = vi.fn()
    render(<EmailToolbar onCreateDraft={onCreateDraft} />)
    fireEvent.click(screen.getByRole('button', { name: /起草回复/ }))
    expect(onCreateDraft).toHaveBeenCalledTimes(1)
  })
})
