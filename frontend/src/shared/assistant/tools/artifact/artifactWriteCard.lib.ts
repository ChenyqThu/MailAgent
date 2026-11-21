// Pure argument / result readers for ArtifactWriteCard (react-refresh/only-export-components).

import type { WorkspaceArtifactType } from '../../inspector/deriveSessionWorkspace'

const ARTIFACT_TYPES = new Set<WorkspaceArtifactType>([
  'dashboard',
  'slides',
  'report',
  'diagram',
  'app'
])

export interface ArtifactWriteInput {
  slug: string | null
  title: string | null
  artifactType: WorkspaceArtifactType | null
  html: string | null
  code: string | null
  changeNote: string | null
}

export interface ArtifactWriteOutput {
  ok: boolean
  error: string | null
  slug: string | null
  title: string | null
  artifactType: WorkspaceArtifactType | null
  version: number | null
  fileId: number | null
  path: string | null
  fileCount: number | null
  buildMs: number | null
  sourceDemo: string | null
  issues: string[]
  warnings: string[]
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null
}

function positiveInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null
}

function nonNegInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null
}

function asArtifactType(v: unknown): WorkspaceArtifactType | null {
  return typeof v === 'string' && ARTIFACT_TYPES.has(v as WorkspaceArtifactType)
    ? (v as WorkspaceArtifactType)
    : null
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
}

export function readArtifactWriteInput(
  args: unknown,
  argsText: string | undefined
): ArtifactWriteInput {
  let obj = asRecord(args)
  if (!obj && argsText) {
    try {
      obj = asRecord(JSON.parse(argsText))
    } catch {
      obj = null
    }
  }
  const code = typeof obj?.code === 'string' && obj.code.length > 0 ? obj.code : null
  return {
    slug: str(obj?.slug),
    title: str(obj?.title),
    artifactType: asArtifactType(obj?.artifact_type) ?? (code ? 'app' : null),
    html: typeof obj?.html === 'string' && obj.html.length > 0 ? obj.html : null,
    code,
    changeNote: str(obj?.change_note)
  }
}

export function readArtifactWriteOutput(result: unknown): ArtifactWriteOutput | null {
  const obj = asRecord(result)
  if (!obj) return null
  return {
    ok: obj.ok !== false,
    error: str(obj.error),
    slug: str(obj.slug),
    title: str(obj.title),
    artifactType: asArtifactType(obj.artifact_type),
    version: positiveInt(obj.version),
    fileId: positiveInt(obj.file_id) ?? positiveInt(obj.id),
    path: str(obj.path),
    fileCount: positiveInt(obj.file_count),
    buildMs: nonNegInt(obj.build_ms),
    sourceDemo: str(obj.source_demo),
    issues: strList(obj.issues),
    warnings: strList(obj.warnings)
  }
}
