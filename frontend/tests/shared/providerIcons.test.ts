// 厂商 logo 解析（08-05 dogfood-3：mono → color；dogfood-4：三级解析，目录厂商优先）。
//
// 两条盯的东西：
//
// ① **逐级变体回退**：三家（openai / openrouter / kimi）有意没有可用的 color 资产
//    （理由见 brandIcons.tsx 文件头 —— 上游没出 / 柠檬黄白底不可读 / 主字形是为深色底衬挖的白），
//    它们在彩色语境下必须落回自己的 mono logo，而**不是**掉成 lucide Cpu 通用芯片兜底。
//    这个失败模式在界面上长得像「OpenAI 没有图标」，很容易被当成映射漏了。
//
// ② **中转 provider 下的厂商归属**（08-05 dogfood-4 的真 bug）：owner 的 `default`
//    （protocol=anthropic，「Anthropic-crs」）下同时挂着 claude 与 19 个 gpt-5.x，`gpt`
//    （protocol=openai-compatible）指向同一个中转 —— 只看 providerId/protocol 会给 GPT 打
//    Anthropic 彩标（错的信息比没有更糟）。故厂商归属以**模型目录命中的那家**为准。
//    下面这组用例**必须能分辨改动前后**：改动前第一条拿到的是 AnthropicColorIcon。

import { describe, expect, test } from 'vitest'

import {
  AnthropicColorIcon,
  AnthropicIcon,
  DeepSeekColorIcon,
  KimiIcon,
  OpenAiIcon,
  OpenRouterIcon,
  QwenColorIcon,
  ZhipuColorIcon
} from '@shared/components/icons/providers/brandIcons'
import {
  PROVIDER_COLOR_ICONS,
  PROVIDER_ICONS,
  resolveProviderIcon
} from '@shared/components/icons/providers/providerIconMap'
import catalog from '@shared/modelCatalog/catalog.json'
import { lookupModelMeta } from '@shared/modelCatalog/lookup'
import type { LlmProviderProtocol } from '@shared/hooks/useLlmProviders'

describe('resolveProviderIcon — variant 逐级回退', () => {
  test('有 color 资产的家：color 语境拿 color，mono 语境仍拿 mono', () => {
    expect(resolveProviderIcon({ providerId: 'anthropic' }, 'color')).toBe(AnthropicColorIcon)
    expect(resolveProviderIcon({ providerId: 'anthropic' }, 'mono')).toBe(AnthropicIcon)
  })

  test('🔴 没有 color 资产的三家：落回自己的 mono，不掉成 Cpu 兜底', () => {
    expect(resolveProviderIcon({ providerId: 'openai' }, 'color')).toBe(OpenAiIcon)
    expect(resolveProviderIcon({ providerId: 'openrouter' }, 'color')).toBe(OpenRouterIcon)
    expect(resolveProviderIcon({ providerId: 'kimi' }, 'color')).toBe(KimiIcon)
    expect(resolveProviderIcon({ providerId: 'moonshot' }, 'color')).toBe(KimiIcon)
  })

  test('默认 variant 是 mono（旧调用点行为不变）', () => {
    expect(resolveProviderIcon({ providerId: 'anthropic' })).toBe(AnthropicIcon)
  })

  test('providerId 不认识时退到 protocol；三级都不中返回 null（调用方渲染 Cpu）', () => {
    expect(resolveProviderIcon({ providerId: 'my-relay', protocol: 'anthropic' }, 'color')).toBe(
      AnthropicColorIcon
    )
    // `openai-compatible` 有意在 protocol 表里留空：贴 OpenAI 的 logo 会撒谎。
    expect(
      resolveProviderIcon({ providerId: 'my-relay', protocol: 'openai-compatible' }, 'color')
    ).toBeNull()
    expect(resolveProviderIcon({ providerId: null, protocol: null }, 'color')).toBeNull()
    expect(resolveProviderIcon({}, 'color')).toBeNull()
  })
})

// ── 🔴 中转 provider：厂商归属以目录为准 ────────────────────────────────────────────
//
// 这里**不桩 lookupModelMeta**，走真快照 —— 要验的正是「provider 配置 + model id → 图标」
// 这条端到端链（ModelPicker 里 composeComposerModelOption 产出的 catalogMeta 就喂到这里）。
// 快照变动导致某条前提不成立时，用例里的 `lookupModelMeta` 断言会指出是哪一条。

/** 复刻 ModelPicker 里一行的解析：provider 行（id + protocol）× model id。 */
function iconForRow(
  provider: { id: string; protocol: LlmProviderProtocol | null },
  modelId: string
): unknown {
  return resolveProviderIcon(
    {
      catalogProviderId: lookupModelMeta(modelId, provider.protocol)?.catalogProviderId,
      providerId: provider.id,
      protocol: provider.protocol
    },
    'color'
  )
}

/** owner 机器上的两个中转 provider（都指向 crs.chenge.ink），逐字照抄 `llm_provider` 行。 */
const RELAY_ANTHROPIC = { id: 'default', protocol: 'anthropic' as LlmProviderProtocol }
const RELAY_OPENAI = { id: 'gpt', protocol: 'openai-compatible' as LlmProviderProtocol }
const DEEPSEEK = { id: 'deepseek', protocol: 'deepseek' as LlmProviderProtocol }

describe('resolveProviderIcon — 🔴 目录厂商优先于 providerId/protocol（中转场景）', () => {
  test('protocol=anthropic 的中转下挂 gpt-5.5 → OpenAI，**不是** Anthropic', () => {
    const icon = iconForRow(RELAY_ANTHROPIC, 'gpt-5.5')
    expect(icon).toBe(OpenAiIcon)
    expect(icon).not.toBe(AnthropicColorIcon)
  })

  test('protocol=openai-compatible（有意无 protocol 图标）下的 gpt-5 → OpenAI，不再掉成 Cpu', () => {
    // 改动前这一条返回 null（调用方画灰 Cpu）——「OpenAI-crs」整组模型都是灰芯片。
    expect(iconForRow(RELAY_OPENAI, 'gpt-5')).toBe(OpenAiIcon)
    expect(iconForRow(RELAY_OPENAI, 'gpt-5.6-sol')).toBe(OpenAiIcon)
  })

  test('同一个中转下的 claude 仍是 Anthropic（目录与 protocol 一致时不该有任何变化）', () => {
    expect(iconForRow(RELAY_ANTHROPIC, 'claude-opus-5[1m]')).toBe(AnthropicColorIcon)
    expect(iconForRow(RELAY_ANTHROPIC, 'claude-haiku-4-5-20251001')).toBe(AnthropicColorIcon)
  })

  test('目录未命中的裸 id → 降级链没断，仍回落到 providerId', () => {
    expect(lookupModelMeta('my-local-model', 'deepseek')).toBeNull()
    expect(iconForRow(DEEPSEEK, 'my-local-model')).toBe(DeepSeekColorIcon)
    // 目录未命中 + providerId 也不认识 → 最后一级 protocol。
    expect(iconForRow({ id: 'my-relay', protocol: 'anthropic' }, 'my-local-model')).toBe(
      AnthropicColorIcon
    )
  })

  test('🔴 歧义 id（多家都有）→ 目录判 MISS，不采纳，落回 providerId', () => {
    // `qwen-max` 在 alibaba 与 alibaba-cn 两家都有；protocol=deepseek 的有序链里都没有
    // → 全局回退看到两个拥有者 → 宁可不显示（lookup 的既有纪律，本次不动）。
    expect(lookupModelMeta('qwen-max', 'deepseek')).toBeNull()
    expect(iconForRow(DEEPSEEK, 'qwen-max')).toBe(DeepSeekColorIcon)
  })

  test('目录厂商的 slug 与我们的历史 key 不同名的几家也要能中（别名补齐了才算数）', () => {
    // alibaba → Qwen · zhipuai/zai → 智谱 · moonshotai → Kimi
    expect(resolveProviderIcon({ catalogProviderId: 'alibaba' }, 'color')).toBe(QwenColorIcon)
    expect(resolveProviderIcon({ catalogProviderId: 'alibaba-cn' }, 'color')).toBe(QwenColorIcon)
    expect(resolveProviderIcon({ catalogProviderId: 'zhipuai' }, 'color')).toBe(ZhipuColorIcon)
    expect(resolveProviderIcon({ catalogProviderId: 'zai' }, 'color')).toBe(ZhipuColorIcon)
    expect(resolveProviderIcon({ catalogProviderId: 'moonshotai' }, 'color')).toBe(KimiIcon)
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

/** 目录里有条目、但本仓**有意**没有 logo 资产的家。解析对它们会降级到 providerId/protocol
 *  （= 与引入目录之前逐字一样），不是 bug。要加资产就从这里删一行。 */
const CATALOG_PROVIDERS_WITHOUT_ICON = new Set([
  'cohere',
  'fireworks-ai',
  'groq',
  'mistral',
  'perplexity',
  'togetherai',
  'xai'
])

describe('目录厂商 × 图标表的覆盖闸', () => {
  test('🔴 catalog.json 的每个 provider 要么有 logo，要么显式登记在「无资产」名单里', () => {
    const missing = Object.keys(catalog.providers).filter(
      (pid) => !PROVIDER_ICONS[pid] && !CATALOG_PROVIDERS_WITHOUT_ICON.has(pid)
    )
    // 快照是 `pnpm catalog:models` 的生成物 —— 新厂商进来时这道闸红，逼一次「补别名还是
    // 登记无资产」的决定，而不是静默降级成上游 provider 的 logo（那正是本次修的 bug）。
    expect(missing, `目录厂商没有 logo 也没登记: ${missing.join(', ')}`).toEqual([])
  })

  test('「无资产」名单不许留过期项（真加了资产要同步删）', () => {
    for (const pid of CATALOG_PROVIDERS_WITHOUT_ICON) {
      expect(PROVIDER_ICONS[pid], `${pid} 已有 logo，应从无资产名单里删掉`).toBeUndefined()
    }
  })
})
