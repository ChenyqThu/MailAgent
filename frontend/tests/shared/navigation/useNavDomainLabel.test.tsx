// @vitest-environment happy-dom
//
// task 09-02 misc10a — AI Chat 域格显示主 agent 名，取不到回落 i18n `nav.domain.chats`
// （「AI Chat」）。三处渲染点（IconRail / DomainPanel / TabStrip）共用这个 hook，这里只测
// hook 本身的两种形态；接线到三处渲染点是否漏由既有 sidebar-contract 等测试钉住。
//
// 变异验证目标：把 `useNavDomainLabel.ts` 的 `'assistantIdentity' in label` 分支删掉
//（永远走 i18nKey 分支）——下面「有名字」用例必红。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

import i18n from '@shared/i18n'
import {
  __resetAssistantIdentity,
  primeAssistantIdentity
} from '@shared/assistant/assistantIdentity'
import { useNavDomainLabel } from '@shared/navigation/useNavDomainLabel'

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({ chat: {} })
}))

beforeEach(() => {
  __resetAssistantIdentity()
})

afterEach(() => {
  __resetAssistantIdentity()
})

describe('useNavDomainLabel', () => {
  test('无名字回落 AI Chat（i18n nav.domain.chats）', async () => {
    await i18n.changeLanguage('zh-CN')
    const { result } = renderHook(() => useNavDomainLabel('chats'))
    expect(result.current).toBe('AI Chat')
  })

  test('有名字显示名字', async () => {
    await i18n.changeLanguage('zh-CN')
    primeAssistantIdentity({ name: '小助手', avatar: null })
    const { result } = renderHook(() => useNavDomainLabel('chats'))
    expect(result.current).toBe('小助手')
  })

  test('空白名字（纯空格）视同无名字，回落 AI Chat', async () => {
    await i18n.changeLanguage('zh-CN')
    primeAssistantIdentity({ name: '   ', avatar: null })
    const { result } = renderHook(() => useNavDomainLabel('chats'))
    expect(result.current).toBe('AI Chat')
  })

  test('非 assistantIdentity 形态的域不受影响（如 today 走普通 i18nKey）', async () => {
    await i18n.changeLanguage('zh-CN')
    primeAssistantIdentity({ name: '小助手', avatar: null })
    const { result } = renderHook(() => useNavDomainLabel('today'))
    expect(result.current).toBe('今日')
  })
})
