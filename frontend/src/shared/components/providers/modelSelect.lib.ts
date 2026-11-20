import {
  composeComposerModelOption,
  type ComposerModelOption
} from '@shared/hooks/useComposerModels'
import {
  DEFAULT_PROVIDER_ID,
  refProviderId,
  stripProviderPrefix,
  type LlmProviderModel,
  type LlmProviderSummary
} from '@shared/hooks/useLlmProviders'

export const PROVIDER_ICON_PRESETS: readonly string[] = [
  'anthropic',
  'openai',
  'google',
  'deepseek',
  'qwen',
  'zhipu',
  'kimi',
  'doubao',
  'minimax',
  'siliconflow',
  'openrouter',
  'ollama',
  'lmstudio',
  'opencode',
  'groq',
  'mistral',
  'xai',
  'azure',
  'bedrock',
  'github',
  'nvidia'
]

export function indexProvidersById(
  providers: readonly LlmProviderSummary[] | undefined
): ReadonlyMap<string, LlmProviderSummary> {
  const map = new Map<string, LlmProviderSummary>()
  for (const p of providers ?? []) map.set(p.id, p)
  return map
}

export function resolveProviderGroupLabel(
  providerId: string,
  providersById: ReadonlyMap<string, LlmProviderSummary> | undefined,
  defaultLabel: string
): string {
  const row = providersById?.get(providerId)
  if (row?.displayName?.trim()) return row.displayName.trim()
  return providerId === DEFAULT_PROVIDER_ID ? defaultLabel : providerId
}

export function buildRichModelOption(
  ref: string,
  providersById: ReadonlyMap<string, LlmProviderSummary>,
  dbModel?: LlmProviderModel | null
): ComposerModelOption {
  const providerId = refProviderId(ref)
  const provider = providersById.get(providerId)
  const modelId = stripProviderPrefix(ref)
  return composeComposerModelOption({
    ref,
    providerId,
    providerLabel: provider?.displayName?.trim() || null,
    protocol: provider?.protocol ?? null,
    modelId,
    rowDisplayName: dbModel?.displayName?.trim() || null,
    rowCapabilities: dbModel?.capabilities ?? null,
    rowMaxOutput: dbModel?.maxOutput ?? null,
    rowContextWindow: dbModel?.contextWindow ?? null
  })
}

export function filterRichModelOptions(
  options: readonly ComposerModelOption[],
  query: string
): ComposerModelOption[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...options]
  return options.filter((opt) => {
    return (
      opt.displayName.toLowerCase().includes(q) ||
      opt.modelId.toLowerCase().includes(q) ||
      opt.ref.toLowerCase().includes(q) ||
      (opt.providerLabel ?? opt.providerId).toLowerCase().includes(q)
    )
  })
}

export function inferModelFamily(modelId: string, groupName?: string | null): string {
  if (groupName?.trim()) return groupName.trim()
  const s = modelId.trim()
  const slash = s.indexOf('/')
  if (slash > 0) return s.slice(0, slash)
  const lower = s.toLowerCase()
  if (lower.startsWith('claude')) return 'Claude'
  if (lower.startsWith('gpt-') || /^o[1-9]($|-)/.test(lower)) return 'OpenAI / GPT'
  if (lower.startsWith('gemini')) return 'Gemini'
  if (lower.startsWith('deepseek')) return 'DeepSeek'
  if (lower.startsWith('qwen')) return 'Qwen'
  if (lower.startsWith('glm')) return 'GLM'
  if (lower.startsWith('kimi') || lower.startsWith('moonshot')) return 'Kimi'
  if (lower.startsWith('doubao')) return 'Doubao'
  if (lower.startsWith('minimax')) return 'MiniMax'
  if (lower.startsWith('llama')) return 'Llama'
  if (lower.startsWith('mistral') || lower.startsWith('mixtral')) return 'Mistral'
  return ''
}

