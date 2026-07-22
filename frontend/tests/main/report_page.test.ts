// codex LOW-1 — report:list IPC pagination clamp parity with serve-api GET /api/reports
// (limit Query(50, ge=1, le=200); offset Query(0, ge=0)). Pure helper → no better-sqlite3 import.
import { describe, expect, test } from 'vitest'

import { clampReportPage } from '../../src/electron/main/handlers/reportPage'

describe('clampReportPage — bounds match serve-api', () => {
  test('defaults when absent / non-integer (limit 50, offset 0)', () => {
    expect(clampReportPage(undefined)).toEqual({ limit: 50, offset: 0 })
    expect(clampReportPage({})).toEqual({ limit: 50, offset: 0 })
    expect(clampReportPage({ limit: 3.5, offset: 1.2 })).toEqual({ limit: 50, offset: 0 })
    expect(clampReportPage({ limit: NaN, offset: NaN })).toEqual({ limit: 50, offset: 0 })
  })

  test('limit clamps into [1, 200]', () => {
    expect(clampReportPage({ limit: 0 }).limit).toBe(1)
    expect(clampReportPage({ limit: -5 }).limit).toBe(1)
    expect(clampReportPage({ limit: 1 }).limit).toBe(1)
    expect(clampReportPage({ limit: 200 }).limit).toBe(200)
    expect(clampReportPage({ limit: 5000 }).limit).toBe(200)
  })

  test('offset floors at 0 (no upper bound, matching FastAPI ge=0)', () => {
    expect(clampReportPage({ offset: -1 }).offset).toBe(0)
    expect(clampReportPage({ offset: 0 }).offset).toBe(0)
    expect(clampReportPage({ offset: 100 }).offset).toBe(100)
  })

  test('valid in-range values pass through', () => {
    expect(clampReportPage({ limit: 25, offset: 50 })).toEqual({ limit: 25, offset: 50 })
  })
})
