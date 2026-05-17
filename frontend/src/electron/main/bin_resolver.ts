// `mailagent` binary lookup. Isolated so two callers can use it:
//   - cli_runner.ts (production main process)
//   - vitest cli_runner.test.ts (mocks this whole module via vi.mock)
//
// The reason it's its own file: `which@7` is CJS-only (no exports.import),
// so an ESM `import { sync } from 'which'` blows up at app boot with
//   SyntaxError: Named export 'sync' not found.
// createRequire is the canonical Node ESM ↔ CJS interop bridge — but vi.mock
// can only intercept ESM `import` graph nodes, not Node's createRequire().
// Putting the createRequire call here gives vitest a clean ESM seam it can
// replace with a stub.

import { createRequire } from 'node:module'

const requireFn = createRequire(import.meta.url)

interface WhichExports {
  sync(cmd: string, opts?: { nothrow?: boolean }): string | null
}

const whichModule = requireFn('which') as WhichExports

export function whichSync(cmd: string, opts?: { nothrow?: boolean }): string | null {
  return whichModule.sync(cmd, opts)
}
