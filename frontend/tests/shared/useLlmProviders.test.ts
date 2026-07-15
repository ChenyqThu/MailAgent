// useLlmProviders — providerRef 分组纯函数（task 07-12 P3）。
//
// 分组规则 = prd §4.3b providerRef 解析的显示面镜像：按**第一个** ':' 切分，无 ':' →
// default 组；default 恒排最前，其余按首现顺序；model id 内含 ':' 合法（只认第一个）。

import { describe, expect, test } from 'vitest'

import {
  DEFAULT_PROVIDER_ID,
  groupModelRefs,
  stripProviderPrefix
} from '../../src/shared/hooks/useLlmProviders'

describe('groupModelRefs', () => {
  test('裸 id 全落 default 组（legacy 兼容）', () => {
    expect(groupModelRefs(['claude-sonnet-4-6', 'gpt-5.5'])).toEqual([
      { providerId: DEFAULT_PROVIDER_ID, refs: ['claude-sonnet-4-6', 'gpt-5.5'] }
    ])
  })

  test('providerRef 按第一个冒号切分；default 恒最前，其余按首现顺序', () => {
    const groups = groupModelRefs([
      'kimi:kimi-k2',
      'claude-sonnet-4-6',
      'dash:qwen-max',
      'kimi:kimi-k2-thinking'
    ])
    expect(groups).toEqual([
      { providerId: DEFAULT_PROVIDER_ID, refs: ['claude-sonnet-4-6'] },
      { providerId: 'kimi', refs: ['kimi-k2', 'kimi-k2-thinking'].map((m) => `kimi:${m}`) },
      { providerId: 'dash', refs: ['dash:qwen-max'] }
    ])
  })

  test('model id 内含冒号只认第一个（OpenRouter 式 id 不被二次切）', () => {
    expect(groupModelRefs(['or:openai/gpt-4o:free'])).toEqual([
      { providerId: 'or', refs: ['or:openai/gpt-4o:free'] }
    ])
    expect(stripProviderPrefix('or:openai/gpt-4o:free')).toBe('openai/gpt-4o:free')
  })

  test('stripProviderPrefix 对裸 id 恒等', () => {
    expect(stripProviderPrefix('claude-sonnet-4-6')).toBe('claude-sonnet-4-6')
  })

  test('空列表 → 空组', () => {
    expect(groupModelRefs([])).toEqual([])
  })
})
