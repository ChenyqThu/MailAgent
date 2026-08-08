import { useQuery } from '@tanstack/react-query'

import { resolveApiBaseUrl } from '@shared/hooks/useLlmModels'
import { qk } from '@shared/lib/queryKeys'

interface ChatCompactFlags {
  chatCompactEnabled: boolean
  chatAutoCompactEnabled: boolean
}

export function useChatCompactFlags(): ChatCompactFlags {
  const query = useQuery({
    queryKey: qk.chat.config('chatCompactFlags'),
    queryFn: async () => {
      try {
        const response = await fetch(`${resolveApiBaseUrl()}/chat/config`, {
          credentials: 'include'
        })
        if (!response.ok) return { chatCompactEnabled: false, chatAutoCompactEnabled: false }
        const body = (await response.json()) as {
          data?: { chatCompactEnabled?: unknown; chatAutoCompactEnabled?: unknown }
        }
        return {
          chatCompactEnabled: body.data?.chatCompactEnabled === true,
          chatAutoCompactEnabled: body.data?.chatAutoCompactEnabled === true
        }
      } catch {
        return { chatCompactEnabled: false, chatAutoCompactEnabled: false }
      }
    },
    staleTime: 30_000,
    retry: false
  })
  return query.data ?? { chatCompactEnabled: false, chatAutoCompactEnabled: false }
}

export function useChatCompactEnabled(): boolean {
  return useChatCompactFlags().chatCompactEnabled
}

export function useChatAutoCompactEnabled(): boolean {
  return useChatCompactFlags().chatAutoCompactEnabled
}
