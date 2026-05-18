// Sprint 10 follow-on — Tier 1 Playwright Electron smoke gate.
// Drives the packaged .app in dist/mac-arm64 so we catch packaged-only bugs
// that dev/vitest miss (router file:// NotFound, native ABI mismatch).
// SPRINT10-HANDOFF §2.1 (1) covers the rationale; bumped from Sprint 11 Day 1
// into Sprint 10 acceptance because the smoke runs are the only way Claude
// can self-verify §6.3.

import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  // Serial: Electron launches the .app, only one instance at a time.
  fullyParallel: false,
  workers: 1,
  // First-run flakiness usually means the .app cold-started slowly. Retry
  // once locally; CI should override with --retries=0 to fail loud.
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  }
})
