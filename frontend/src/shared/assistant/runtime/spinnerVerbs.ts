import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

export const SPINNER_VERB_INTERVAL_MS = 3200

/**
 * Layer 1 fallback thinking verbs for extended silent model waits (before reasoning headings or
 * tool calls arrive). Calmly rotates across localized pool items while active unless reduced motion
 * is enabled, where it stays static on the first phrase.
 */
export function useSpinnerVerb(active: boolean, reduce: boolean): string | null {
  const { t } = useTranslation()
  const raw = t('chat.spinnerVerbs.pool', { returnObjects: true })
  const pool = Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []

  const [tick, setTick] = useState(0)
  const [prevActive, setPrevActive] = useState(active)
  if (prevActive !== active) {
    setPrevActive(active)
    setTick(0)
  }

  useEffect(() => {
    if (!active || reduce || pool.length <= 1) return undefined
    const id = window.setInterval(() => {
      setTick((n) => (n + 1) % pool.length)
    }, SPINNER_VERB_INTERVAL_MS)
    return (): void => window.clearInterval(id)
  }, [active, reduce, pool.length])

  if (!active || pool.length === 0) return null
  return pool[tick % pool.length] ?? null
}
