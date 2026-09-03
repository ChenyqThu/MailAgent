// task 09-02 — the「图像生成模型」candidate filter: only enabled models of ENABLED providers whose
// protocol the AI SDK ships an image model for (openai / openai-compatible), by the gateway's own
// list — Settings can never offer a ref the resolver would refuse.

import { describe, expect, test } from 'vitest'

import { imageModelCandidates } from '@shared/components/settings/custom-ai/imageModelCandidates'
import { IMAGE_MODEL_PROTOCOLS } from '../../src/ai-gateway/providerRef'

const PROVIDERS = [
  { id: 'default', protocol: 'anthropic', enabled: true },
  { id: 'oai', protocol: 'openai', enabled: true },
  { id: 'relay', protocol: 'openai-compatible', enabled: true },
  { id: 'off', protocol: 'openai', enabled: false },
  { id: 'gem', protocol: 'google', enabled: true }
]

describe('imageModelCandidates', () => {
  test('keeps openai / openai-compatible refs of enabled providers only, in input order', () => {
    expect(
      imageModelCandidates(
        [
          'claude-sonnet-4-6', // bare id → default (anthropic) → out
          'oai:gpt-image-1',
          'gem:imagen-3', // google → out
          'relay:gpt-image-1',
          'off:gpt-image-1', // provider disabled → out
          'oai:gpt-4o'
        ],
        PROVIDERS
      )
    ).toEqual(['oai:gpt-image-1', 'relay:gpt-image-1', 'oai:gpt-4o'])
  })

  test('unknown provider id → out; empty inputs → []', () => {
    expect(imageModelCandidates(['ghost:gpt-image-1'], PROVIDERS)).toEqual([])
    expect(imageModelCandidates([], PROVIDERS)).toEqual([])
    expect(imageModelCandidates(['oai:gpt-image-1'], [])).toEqual([])
  })

  test('the protocol list is the gateway resolver list itself (single source)', () => {
    expect([...IMAGE_MODEL_PROTOCOLS].sort()).toEqual(['openai', 'openai-compatible'])
  })
})
