import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'

import { createMattersApi } from '@shared/api/matters'
import type { MattersApi } from '@shared/api/types/matter'
import { resolveApiBaseUrl } from '@shared/components/settings/custom-ai/shared'
import { qk } from '@shared/lib/queryKeys'

export function useMattersApi(): MattersApi {
  return useMemo(() => createMattersApi(resolveApiBaseUrl()), [])
}

export function useMattersEnabled(): boolean {
  const query = useQuery({
    queryKey: qk.matters.config(),
    queryFn: async (): Promise<boolean> => {
      try {
        const response = await fetch(`${resolveApiBaseUrl()}/chat/config`, {
          credentials: 'include'
        })
        if (!response.ok) return false
        const body = (await response.json()) as { data?: { mattersEnabled?: unknown } }
        return body.data?.mattersEnabled === true
      } catch {
        return false
      }
    },
    staleTime: 30_000,
    retry: false
  })
  return query.data === true
}
