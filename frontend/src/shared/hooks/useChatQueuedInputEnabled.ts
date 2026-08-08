import { useQuery } from '@tanstack/react-query'

import { resolveApiBaseUrl } from '@shared/hooks/useLlmModels'
import { qk } from '@shared/lib/queryKeys'

export function useChatQueuedInputEnabled(): boolean {
  const query = useQuery({
    queryKey: qk.chat.config('chatQueuedInputEnabled'),
    queryFn: async () => {
      try {
        const response = await fetch(`${resolveApiBaseUrl()}/chat/config`, {
          credentials: 'include'
        })
        if (!response.ok) return false
        const body = (await response.json()) as {
          data?: { chatQueuedInputEnabled?: unknown }
        }
        return body.data?.chatQueuedInputEnabled === true
      } catch {
        return false
      }
    },
    staleTime: 30_000,
    retry: false
  })
  return query.data === true
}
