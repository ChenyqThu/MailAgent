// shadcn-style cn() — Tailwind class merger that survives conflicts (e.g.
// `cn('px-2', 'px-4')` → 'px-4', not 'px-2 px-4'). Standard primitive used by
// every shadcn-ui component; lives at @shared/lib/cn so renderer + web share.
//
// Sprint 0 = helper only. Sprint 1 (or first primitive add) will run
// `pnpm dlx shadcn@latest init` to drop components.json + first primitives
// under src/shared/components/ui/.

import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
