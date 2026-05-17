// Vitest config — node env (no jsdom). Handler tests build an in-memory
// sqlite fixture against the real cli-schema JSON files; cli_runner tests
// mock execa; ESLint rule tests run RuleTester against the local plugin.

import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.cjs'],
    environment: 'node',
    pool: 'forks' // better-sqlite3 + native bindings prefer process isolation
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared')
    }
  }
})
