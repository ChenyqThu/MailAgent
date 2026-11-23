import { useLayoutEffect, useState } from 'react'

/**
 * Mutable value container synced in `useLayoutEffect`.
 *
 * Singletons created once in `useState` / `useMemo` (e.g. AI SDK transports and
 * attachment adapters) can read `.value` inside async/event callbacks without
 * reading or mutating a React ref during render.
 */
export class LiveBox<T> {
  private _value: T

  constructor(initial: T) {
    this._value = initial
  }

  get(): T {
    return this._value
  }

  set(next: T): void {
    this._value = next
  }
}

export function useLiveBox<T>(value: T): LiveBox<T> {
  const [box] = useState(() => new LiveBox(value))
  useLayoutEffect(() => {
    box.set(value)
  }, [box, value])
  return box
}
