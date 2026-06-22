// PR7 (task 06-22) — transparency for @mention skill activation. Shows the skills the
// user has force-activated this session (via `@skill` in a message) as chips above the
// composer, so it's clear which capabilities are pinned on rather than auto-selected.
// Removing a chip deactivates it + invalidates the cached chat engine so the next turn
// rebuilds without it. Self-hides when nothing is activated.

import * as React from 'react'
import { AtSign, X } from 'lucide-react'

import { useMailApi } from '@shared/hooks/useMailApi'
import { useSkillActivation } from '@shared/state/skill-activation'

export function ActiveSkillChips(): React.ReactElement | null {
  const activated = useSkillActivation((s) => s.activated)
  const deactivate = useSkillActivation((s) => s.deactivate)
  const api = useMailApi()

  if (activated.length === 0) return null

  return (
    <ul className="flex flex-wrap items-center gap-1 px-1 pb-1.5">
      {activated.map((name) => (
        <li
          key={name}
          className="inline-flex items-center gap-1 max-w-[160px] px-1.5 py-0.5 rounded bg-coral/10 border border-coral/30 text-micro text-ink-fg"
        >
          <AtSign size={9} strokeWidth={2} className="text-coral shrink-0" />
          <span className="truncate" title={name}>
            {name}
          </span>
          <button
            type="button"
            onClick={() => {
              deactivate(name)
              api.chat.invalidateConfig()
            }}
            aria-label={`deactivate ${name}`}
            className="shrink-0 text-ink-fg-3 hover:text-ink-fg"
          >
            <X size={9} strokeWidth={2} />
          </button>
        </li>
      ))}
    </ul>
  )
}
