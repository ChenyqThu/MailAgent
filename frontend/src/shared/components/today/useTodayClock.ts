import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { qk } from '@shared/lib/queryKeys'

/** Wall clock advances independently of network success, including after sleep. */
export function useTodayClock(): number {
  const [nowMs, setNowMs] = useState(() => Date.now())
  const client = useQueryClient()
  useEffect(() => {
    const tick = (): void => {
      if (!document.hidden) setNowMs(Date.now())
    }
    const resume = (): void => {
      if (document.hidden) return
      tick()
      void client.invalidateQueries({ queryKey: qk.today.all() })
    }
    const timer = window.setInterval(tick, 60_000)
    window.addEventListener('focus', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', resume)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [client])
  return nowMs
}
