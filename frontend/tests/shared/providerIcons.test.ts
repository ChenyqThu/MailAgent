// 厂商 logo 解析（08-05 dogfood-3：mono → color）。
//
// 这里盯的是**逐级回退**这一条：三家（openai / openrouter / kimi）有意没有可用的 color 资产
// （理由见 brandIcons.tsx 文件头 —— 上游没出 / 柠檬黄白底不可读 / 主字形是为深色底衬挖的白），
// 它们在彩色语境下必须落回自己的 mono logo，而**不是**掉成 lucide Cpu 通用芯片兜底。
// 这个失败模式在界面上长得像「OpenAI 没有图标」，很容易被当成映射漏了。

import { describe, expect, test } from 'vitest'

import {
  AnthropicColorIcon,
  AnthropicIcon,
  KimiIcon,
  OpenAiIcon,
  OpenRouterIcon
} from '@shared/components/icons/providers/brandIcons'
import {
  PROVIDER_COLOR_ICONS,
  PROVIDER_ICONS,
  resolveProviderIcon
} from '@shared/components/icons/providers/providerIconMap'

describe('resolveProviderIcon — variant 逐级回退', () => {
  test('有 color 资产的家：color 语境拿 color，mono 语境仍拿 mono', () => {
    expect(resolveProviderIcon('anthropic', null, 'color')).toBe(AnthropicColorIcon)
    expect(resolveProviderIcon('anthropic', null, 'mono')).toBe(AnthropicIcon)
  })

  test('🔴 没有 color 资产的三家：落回自己的 mono，不掉成 Cpu 兜底', () => {
    expect(resolveProviderIcon('openai', null, 'color')).toBe(OpenAiIcon)
    expect(resolveProviderIcon('openrouter', null, 'color')).toBe(OpenRouterIcon)
    expect(resolveProviderIcon('kimi', null, 'color')).toBe(KimiIcon)
    expect(resolveProviderIcon('moonshot', null, 'color')).toBe(KimiIcon)
  })

  test('默认 variant 是 mono（旧调用点行为不变）', () => {
    expect(resolveProviderIcon('anthropic', null)).toBe(AnthropicIcon)
  })

  test('providerId 不认识时退到 protocol；两级都不中返回 null（调用方渲染 Cpu）', () => {
    expect(resolveProviderIcon('my-relay', 'anthropic', 'color')).toBe(AnthropicColorIcon)
    // `openai-compatible` 有意在 protocol 表里留空：贴 OpenAI 的 logo 会撒谎。
    expect(resolveProviderIcon('my-relay', 'openai-compatible', 'color')).toBeNull()
    expect(resolveProviderIcon(null, null, 'color')).toBeNull()
  })
})

describe('PROVIDER_COLOR_ICONS 与 mono 表的关系', () => {
  test('color 表的 key 必须是 mono 表 key 的子集（否则 color 语境有、mono 语境没有，很怪）', () => {
    const monoKeys = new Set(Object.keys(PROVIDER_ICONS))
    for (const k of Object.keys(PROVIDER_COLOR_ICONS)) {
      expect(monoKeys.has(k), `color 表多出一个 mono 表没有的 key: ${k}`).toBe(true)
    }
  })
})
