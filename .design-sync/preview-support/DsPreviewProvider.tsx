// design-sync preview support — context wrapper for authored previews that
// read a TanStack Query client (email/calendar/settings data components).
// Exposed on the bundle global via cfg.extraEntries; NOT set as a global
// cfg.provider, so unauthored data components keep their honest floor card
// instead of degrading to an empty skeleton. Authored previews import it and
// wrap explicitly only where needed.
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
    mutations: { retry: false }
  }
})

export function DsPreviewProvider({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}
