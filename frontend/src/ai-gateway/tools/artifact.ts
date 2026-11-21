// Versioned interactive HTML5 artifact write tool (`artifact_write`).
//
// Stores each deliverable as an immutable snapshot under `agent-docs/artifacts/<slug>/vN/index.html`
// via LibraryService (`domain.libraryCreateFile`), allowing `libpreview://` interactive rendering
// without inheriting renderer CSP and keeping a clean layout for multi-file Vite bundles.

import type { Tool } from 'ai'
import { z } from 'zod'

import {
  DomainError,
  type DomainLibraryActor,
  type MailAgentDomainClient
} from '../python/domainClient'
import type { ApprovalGuard } from '../security/approval'
import type { AgentContextMode, AgentRunContext } from './policy'
import {
  auditedReadTool,
  auditedWriteTool,
  type GatewayApprovalMode,
  type GatewayToolApprovalPrefs,
  type GatewayToolAuditCollector
} from './types'
// Relative import (not @shared alias) so pure-Node eval harnesses without tsconfig path resolution
// can load this module directly (library.ts precedent).
import { AGENT_DOCS_SLUG, TEXT_WRITE_MAX_BYTES } from '../../shared/libraryConstants'

export const GATEWAY_ARTIFACT_TOOL_NAMES = [
  'omada_catalog_query',
  'artifact_write',
  'artifact_build_omada',
  'artifact_publish_bundle'
] as const

const omadaCatalogQuerySchema = z.object({
  action: z
    .enum([
      'info',
      'list_components',
      'component',
      'search_icons',
      'search_assets',
      'tokens',
      'recipes'
    ])
    .describe(
      'Catalog lookup mode: info (package & CDN URLs), list_components, component (exact props), search_icons (SIcon slugs), search_assets (products/illustrations/clients/brand), tokens (Light/Dark CSS vars & chartPalette), recipes (starter templates).'
    ),
  query: z
    .string()
    .trim()
    .max(120)
    .optional()
    .describe('Optional filter keyword, category name, or exact component name (required for action="component").'),
  asset_group: z
    .enum(['products', 'illustrations', 'clients', 'brand'])
    .optional()
    .describe('Asset collection when action="search_assets" (default: "products").'),
  theme: z
    .enum(['light', 'dark'])
    .optional()
    .describe('Theme mode when action="tokens" (default: "light").'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Maximum items returned for search_icons / search_assets (default: 25).')
})

export const ARTIFACT_TYPES = ['dashboard', 'slides', 'report', 'diagram', 'app'] as const
export type ArtifactType = (typeof ARTIFACT_TYPES)[number]

const artifactPublishBundleSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .describe('Existing local artifact slug under agent-docs/artifacts/<slug>.'),
  version: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Optional local version number (vN) to publish; defaults to latest saved version.'),
  title: z.string().trim().min(1).max(160).optional().describe('Optional title shown on Canvas Artifact Server.'),
  artifact_type: z
    .enum(ARTIFACT_TYPES)
    .optional()
    .describe('Deliverable archetype (default: "app").'),
  project: z.string().trim().min(1).max(80).optional().describe('Optional project/workspace grouping label.'),
  visibility: z
    .enum(['private', 'unlisted', 'public'])
    .optional()
    .describe('Sharing mode: "unlisted" (link token, recommended), "private", or "public".'),
  change_note: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe('Short summary of what changed in this published version.')
})

const artifactBuildOmadaSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .describe(
      'Short ASCII kebab-case identifier (e.g. "omada-ap-health-monitor"). Reusing the same slug creates v2, v3, ...'
    ),
  title: z.string().trim().min(1).max(160).describe('Human-readable title of the Omada prototype.'),
  code: z
    .string()
    .min(1)
    .max(TEXT_WRITE_MAX_BYTES)
    .describe(
      'Complete React + TypeScript TSX component file saved as src/demos/<slug>/Demo.tsx inside omada-ui-kit. Must default-export (or export `Demo`) a React component using `@/omada` components.'
    ),
  theme_mode: z
    .enum(['light', 'dark'])
    .optional()
    .describe('Default theme mode passed to OmadaProvider (default: "light").'),
  change_note: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe('Short summary of what changed in this prototype build.')
})
const VERSION_CONFLICT = 'E_VERSION_CONFLICT'
const ARTIFACT_ROOT = `${AGENT_DOCS_SLUG}/artifacts`
const SLUG_MAX_LEN = 64

export interface ArtifactLintResult {
  errors: string[]
  warnings: string[]
}

/** Normalize an arbitrary identifier into a clean kebab-case slug safe for Library folders. */
export function normalizeArtifactSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LEN)
}

/** Zero-LLM static sanity check before persisting an HTML artifact. */
export function lintArtifactHtml(html: string): ArtifactLintResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (!/<!doctype\s+html|<html\b|<body\b/i.test(html)) {
    errors.push('HTML must include a full document structure (<!doctype html>, <html>, or <body>).')
  }

  const openScripts = (html.match(/<script\b[^>]*>/gi) ?? []).filter(
    (tag) => !/\/\s*>$/.test(tag)
  ).length
  const closeScripts = (html.match(/<\/script\s*>/gi) ?? []).length
  if (openScripts !== closeScripts) {
    errors.push(`Unbalanced <script> (${openScripts}) and </script> (${closeScripts}) tags.`)
  }

  if (/\/\/\s*TODO\b|\/\*\s*TODO\b|<!--\s*TODO\b/i.test(html)) {
    errors.push('Remove TODO placeholders and ship complete working code.')
  }

  if (
    /\b(?:localStorage|sessionStorage)\b/.test(html) &&
    !/try\s*\{[\s\S]*?\b(?:localStorage|sessionStorage)\b/i.test(html)
  ) {
    warnings.push(
      'Bare localStorage/sessionStorage inside a sandboxed iframe throws SecurityError; wrap in try/catch with an in-memory fallback.'
    )
  }

  if (!/<title\b[^>]*>[^<]+<\/title>/i.test(html)) {
    warnings.push('Consider adding a descriptive <title> tag.')
  }

  return { errors, warnings }
}

const artifactWriteSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .describe(
      'Short ASCII kebab-case identifier (e.g. "q4-renewal-dashboard"). Reuse the same slug on revisions to create v2, v3, ...'
    ),
  title: z.string().trim().min(1).max(160).describe('Human-readable title of the artifact.'),
  artifact_type: z
    .enum(ARTIFACT_TYPES)
    .describe('Deliverable archetype: dashboard, slides, report, diagram, or app.'),
  html: z
    .string()
    .min(1)
    .max(TEXT_WRITE_MAX_BYTES)
    .describe('Complete self-contained HTML5 document (<!doctype html> ... </html>).'),
  change_note: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe('Short summary of what changed in this version.')
})

function surfaced<T>(p: Promise<T>): Promise<T> {
  return p.catch((e: unknown) => {
    if (e instanceof DomainError && e.hint) {
      throw new DomainError(e.code, `${e.message} (${e.hint})`, {
        httpStatus: e.httpStatus,
        data: e.data
      })
    }
    throw e
  })
}

function parseMaxVersion(listing: { folders?: unknown }): number {
  const folders = Array.isArray(listing.folders) ? listing.folders : []
  let maxVersion = 0
  for (const raw of folders) {
    const row = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
    if (!row) continue
    const folderName =
      typeof row.name === 'string'
        ? row.name
        : typeof row.path === 'string'
          ? (row.path.split('/').pop() ?? '')
          : ''
    const match = /^v(\d+)$/.exec(folderName)
    if (!match) continue
    const parsed = Number(match[1])
    if (Number.isInteger(parsed) && parsed > maxVersion) {
      maxVersion = parsed
    }
  }
  return maxVersion
}

export function createArtifactTools(
  domain: MailAgentDomainClient,
  collector: GatewayToolAuditCollector = [],
  guard: ApprovalGuard,
  opts: {
    a2uiEnabled?: boolean
    approvalMode?: GatewayApprovalMode
    toolApprovalPrefs?: GatewayToolApprovalPrefs['tools']
    oneShot?: boolean
    contextMode?: AgentContextMode
    agentRunContext?: AgentRunContext
  } = {}
): Record<(typeof GATEWAY_ARTIFACT_TOOL_NAMES)[number], Tool> {
  const agentId = opts.agentRunContext?.agentId
  const actor: DomainLibraryActor =
    typeof agentId === 'string' && agentId.length > 0
      ? { kind: 'custom_agent', agentId }
      : { kind: 'main_agent' }

  const omada_catalog_query = auditedReadTool(
    {
      name: 'omada_catalog_query',
      description:
        'Query verified @chenyqthu/omada-ui-kit exports, component Props, Figma icon/product/illustration slugs, ' +
        'Light/Dark tokens & chartPalette, CDN URLs (dist/style.css + dist/standalone.js), and starter recipes. ' +
        'Call this before writing Omada UI prototypes so component props and asset slugs never rely on guesswork. Silent read.',
      inputSchema: omadaCatalogQuerySchema,
      run: async (input, signal) =>
        surfaced(
          domain.libraryQueryOmadaCatalog(
            {
              action: input.action,
              query: input.query,
              assetGroup: input.asset_group,
              theme: input.theme,
              limit: input.limit
            },
            signal
          )
        )
    },
    collector
  )

  const artifact_write = auditedWriteTool(
    {
      a2uiEnabled: opts.a2uiEnabled,
      approvalMode: opts.approvalMode,
      toolApprovalPrefs: opts.toolApprovalPrefs,
      oneShot: opts.oneShot,
      contextMode: opts.contextMode,
      name: 'artifact_write',
      description:
        'Create or revise a versioned, self-contained HTML5 interactive artifact (dashboard, slides, ' +
        'report, diagram, or app) saved under agent-docs/artifacts/<slug>/vN/index.html for live ' +
        'interactive preview. Reuse the same `slug` when iterating so each edit creates an immutable ' +
        'next version (v1 -> v2 -> ...). Runs static HTML checks before saving. Edit tier.',
      inputSchema: artifactWriteSchema,
      risk: 'edit',
      editableFields: ['title', 'html'],
      run: async (input, { userEdited, signal }) => {
        const slug = normalizeArtifactSlug(input.slug)
        if (!slug) {
          throw new DomainError(
            'E_INVALID_ARG',
            'slug must contain ASCII letters or digits (e.g. "q4-renewal-dashboard")'
          )
        }

        const lint = lintArtifactHtml(input.html)
        if (lint.errors.length > 0) {
          return {
            ok: false,
            error: 'E_ARTIFACT_LINT',
            slug,
            issues: lint.errors,
            warnings: lint.warnings,
            hint: 'Fix the listed HTML issues and call artifact_write again.'
          }
        }

        const artifactFolder = `${ARTIFACT_ROOT}/${slug}`
        let maxVersion = 0
        try {
          const listing = await surfaced(
            domain.libraryFolder({ path: artifactFolder, limit: 200, offset: 0 }, signal)
          )
          maxVersion = parseMaxVersion(listing)
        } catch (e) {
          if (!(e instanceof DomainError && e.code === 'E_NOT_FOUND')) {
            throw e
          }
        }

        const changeNote =
          input.change_note || `${input.artifact_type}: ${input.title}`.slice(0, 200)
        let version = maxVersion + 1
        let row: Record<string, unknown>
        try {
          row = await surfaced(
            domain.libraryCreateFile(
              {
                parentPath: `${artifactFolder}/v${version}`,
                filename: 'index.html',
                content: input.html,
                changeNote
              },
              actor,
              signal
            )
          )
        } catch (e) {
          if (!(e instanceof DomainError && e.code === VERSION_CONFLICT)) {
            throw e
          }
          version += 1
          row = await surfaced(
            domain.libraryCreateFile(
              {
                parentPath: `${artifactFolder}/v${version}`,
                filename: 'index.html',
                content: input.html,
                changeNote
              },
              actor,
              signal
            )
          )
        }

        const fallbackPath = `${artifactFolder}/v${version}/index.html`
        let localPreviewUrl: string | null = null
        if (typeof domain.libraryIssueArtifactPreviewToken === 'function') {
          try {
            const preview = await domain.libraryIssueArtifactPreviewToken(
              { slug, version, entryPath: 'index.html' },
              signal
            )
            if (typeof preview.preview_url === 'string' && preview.preview_url) {
              localPreviewUrl = preview.preview_url
            }
          } catch {
            // Non-fatal in minimal test/mock environments
          }
        }
        return {
          ok: true,
          slug,
          title: input.title,
          artifact_type: input.artifact_type,
          version,
          file_id: typeof row.id === 'number' ? row.id : null,
          path: typeof row.path === 'string' ? row.path : fallbackPath,
          size: typeof row.size_bytes === 'number' ? row.size_bytes : null,
          content_hash: typeof row.content_hash === 'string' ? row.content_hash : null,
          local_preview_url: localPreviewUrl,
          warnings: lint.warnings,
          user_edited: userEdited
        }
      }
    },
    collector,
    guard
  )

  const artifact_build_omada = auditedWriteTool(
    {
      a2uiEnabled: opts.a2uiEnabled,
      approvalMode: opts.approvalMode,
      toolApprovalPrefs: opts.toolApprovalPrefs,
      oneShot: opts.oneShot,
      contextMode: opts.contextMode,
      name: 'artifact_build_omada',
      description:
        'Mode B fallback: compile a React + TypeScript prototype (src/demos/<slug>/Demo.tsx) with local ' +
        'omada-ui-kit + Vite when offline/no-CDN bundling or custom Tailwind JIT classes are required. Prefer ' +
        'omada_catalog_query + artifact_write with @chenyqthu/omada-ui-kit standalone CDN for normal prototypes. Edit tier.',
      inputSchema: artifactBuildOmadaSchema,
      risk: 'edit',
      editableFields: ['title', 'code'],
      run: async (input, { userEdited, signal }) => {
        const slug = normalizeArtifactSlug(input.slug)
        if (!slug) {
          throw new DomainError(
            'E_INVALID_ARG',
            'slug must contain ASCII letters or digits (e.g. "omada-ap-health-monitor")'
          )
        }
        if (/\/\/\s*TODO\b|\/\*\s*TODO\b/i.test(input.code)) {
          return {
            ok: false,
            error: 'E_ARTIFACT_LINT',
            slug,
            issues: ['Remove TODO placeholders and ship complete interactive React components.'],
            hint: 'Complete the Demo.tsx code and call artifact_build_omada again.'
          }
        }

        const built = await surfaced(
          domain.libraryBuildOmadaDemo(
            {
              slug,
              title: input.title,
              code: input.code,
              themeMode: input.theme_mode ?? 'light',
              changeNote: input.change_note
            },
            actor,
            signal
          )
        )

        return {
          ...built,
          ok: true,
          slug: typeof built.slug === 'string' ? built.slug : slug,
          title: typeof built.title === 'string' ? built.title : input.title,
          artifact_type: 'app',
          user_edited: userEdited
        }
      }
    },
    collector,
    guard
  )

  const artifact_publish_bundle = auditedWriteTool(
    {
      a2uiEnabled: opts.a2uiEnabled,
      approvalMode: opts.approvalMode,
      toolApprovalPrefs: opts.toolApprovalPrefs,
      oneShot: opts.oneShot,
      contextMode: opts.contextMode,
      name: 'artifact_publish_bundle',
      description:
        'Read an existing local artifact or Omada prototype bundle from agent-docs/artifacts/<slug>/vN/ ' +
        'and upload the full versioned deliverable to Canvas Artifact Server via the artifact_server MCP ' +
        'connector without pasting bundle source into chat tool arguments. Returns review_url and share_url. Edit tier.',
      inputSchema: artifactPublishBundleSchema,
      risk: 'edit',
      editableFields: ['title', 'visibility'],
      run: async (input, { userEdited, signal }) => {
        const slug = normalizeArtifactSlug(input.slug)
        if (!slug) {
          throw new DomainError(
            'E_INVALID_ARG',
            'slug must contain ASCII letters or digits (e.g. "omada-ap-health-monitor")'
          )
        }
        const res = await surfaced(
          domain.libraryPublishArtifactBundle(
            {
              slug,
              version: input.version,
              title: input.title,
              artifactType: input.artifact_type ?? 'app',
              project: input.project,
              visibility: input.visibility,
              changeNote: input.change_note
            },
            signal
          )
        )
        return {
          ...res,
          ok: true,
          slug: typeof res.slug === 'string' ? res.slug : slug,
          user_edited: userEdited
        }
      }
    },
    collector,
    guard
  )

  return { omada_catalog_query, artifact_write, artifact_build_omada, artifact_publish_bundle }
}
