/**
 * Wave 4B OpenAPI -> TS codegen pilot verifier.
 *
 * Exports OpenAPI component schemas from FastAPI `app.openapi()` for all
 * `SuccessEnvelope[T]`-typed routes (`contacts`, `ai`, `notifications`,
 * `folder`, `history_sync`), compiles them with `json-schema-to-typescript`,
 * and runs `tsc --noEmit` in a temp file to prove zero manual fixups needed.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from 'json-schema-to-typescript'

const HERE = dirname(fileURLToPath(import.meta.url))
const FRONTEND_ROOT = resolve(HERE, '..')
const REPO_ROOT = resolve(FRONTEND_ROOT, '..')
const PYTHON_BIN = resolve(REPO_ROOT, 'venv/bin/python')

async function main(): Promise<void> {
  const rawJson = execFileSync(
    PYTHON_BIN,
    [resolve(REPO_ROOT, 'scripts/export_openapi_subset.py'), '-'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
  )
  const exported = JSON.parse(rawJson) as {
    typed_envelope_count: number
    typed_roots: string[]
    components: { schemas: Record<string, Record<string, unknown>> }
  }

  if (exported.typed_envelope_count < 40) {
    throw new Error(`Expected >= 40 typed SuccessEnvelope_* roots, got ${exported.typed_envelope_count}`)
  }

  // Synthesize a single JSON Schema with `$defs` from OpenAPI components and a root
  // union/record referencing all `SuccessEnvelope_*` schemas so $refs resolve once cleanly.
  const properties: Record<string, unknown> = {}
  for (const name of exported.typed_roots) {
    properties[name] = { $ref: `#/components/schemas/${name}` }
  }
  const bundleSchema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'TypedEnvelopeRegistry',
    type: 'object',
    additionalProperties: false,
    required: exported.typed_roots,
    properties,
    components: exported.components
  }

  const tsOut = await compile(bundleSchema as never, 'TypedEnvelopeRegistry', {
    bannerComment: '// Auto-generated OpenAPI pilot check',
    unreachableDefinitions: false,
    style: { singleQuote: true, semi: false }
  })

  const tempDir = mkdtempSync(join(tmpdir(), 'mailagent-openapi-pilot-'))
  try {
    const dtsPath = join(tempDir, 'openapi-pilot.ts')
    writeFileSync(dtsPath, tsOut, 'utf8')
    execFileSync(
      resolve(FRONTEND_ROOT, 'node_modules/.bin/tsc'),
      ['--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'ESNext', dtsPath],
      { cwd: FRONTEND_ROOT, stdio: 'pipe', encoding: 'utf8' }
    )
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }

  console.log(
    `[openapi-pilot] OK: ${exported.typed_envelope_count} SuccessEnvelope_* models compiled & tsc-verified (${tsOut.split('\n').length} lines).`
  )
}

main().catch((err) => {
  console.error('[openapi-pilot] FAILED:', err)
  process.exit(1)
})
