import { describe, expect, test } from 'vitest'
import type { Tool } from 'ai'

import { buildGatewayTools } from '../../../src/ai-gateway/tools'
import {
  createArtifactTools,
  GATEWAY_ARTIFACT_TOOL_NAMES,
  lintArtifactHtml,
  normalizeArtifactSlug
} from '../../../src/ai-gateway/tools/artifact'
import { MailAgentDomainClient } from '../../../src/ai-gateway/python/domainClient'
import { ApprovalGuard } from '../../../src/ai-gateway/security/approval'
import { GATEWAY_TOOL_CLASSES } from '../../../src/ai-gateway/tools/policy'
import { CORE_UNGATED_GATEWAY_TOOLS } from '../../../src/ai-gateway/tools/skill_gating'

interface Call {
  method: string
  url: string
  body?: Record<string, unknown>
}

function domainWith(
  responder: (call: Call) => { status?: number; json: unknown },
  calls: Call[]
): MailAgentDomainClient {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    }
    calls.push(call)
    const r = responder(call)
    return new Response(JSON.stringify(r.json), {
      status: r.status ?? 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }) as unknown as typeof fetch
  return new MailAgentDomainClient({
    baseUrl: 'http://127.0.0.1:8200/api',
    localToken: 't',
    fetchImpl
  })
}

async function runWithAuto(tool: Tool, input: unknown, toolCallId = 'tc-art-1'): Promise<unknown> {
  const needsApproval = tool.needsApproval as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[] }
  ) => boolean | Promise<boolean>
  await needsApproval(input, { toolCallId, messages: [] })
  const exec = tool.execute as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[]; abortSignal?: AbortSignal }
  ) => Promise<unknown>
  return exec(input, { toolCallId, messages: [], abortSignal: undefined })
}

const VALID_HTML = '<!doctype html><html><head><title>Q4 Board</title></head><body><main>Hi</main><script>console.log(1)</script></body></html>'

describe('normalizeArtifactSlug', () => {
  test('normalizes spaces, underscores, mixed case, and invalid characters', () => {
    expect(normalizeArtifactSlug(' Q4_Vendor Renewal!! ')).toBe('q4-vendor-renewal')
    expect(normalizeArtifactSlug('---alpha___beta---')).toBe('alpha-beta')
    expect(normalizeArtifactSlug('中文only')).toBe('only')
    expect(normalizeArtifactSlug('中文')).toBe('')
  })
})

describe('lintArtifactHtml', () => {
  test('flags missing HTML document root, unbalanced scripts, and TODO placeholders', () => {
    const res = lintArtifactHtml('# just markdown\n<script>alert(1)\n// TODO finish later')
    expect(res.errors).toHaveLength(3)
  })

  test('warns on bare localStorage/sessionStorage and missing title', () => {
    const res = lintArtifactHtml(
      '<!doctype html><html><body><script>localStorage.setItem("k","v")</script></body></html>'
    )
    expect(res.errors).toEqual([])
    expect(res.warnings).toHaveLength(2)
  })

  test('passes cleanly when localStorage is guarded by try/catch and title is present', () => {
    const res = lintArtifactHtml(
      '<!doctype html><html><head><title>Ok</title></head><body><script>try { localStorage.getItem("k") } catch {}</script></body></html>'
    )
    expect(res.errors).toEqual([])
    expect(res.warnings).toEqual([])
  })
})

describe('artifact_write tool', () => {
  test('registers under approvalGuard as domain_write and CORE_UNGATED', () => {
    expect(GATEWAY_ARTIFACT_TOOL_NAMES).toEqual(['artifact_write', 'artifact_build_omada'])
    expect(GATEWAY_TOOL_CLASSES.artifact_write).toBe('domain_write')
    expect(GATEWAY_TOOL_CLASSES.artifact_build_omada).toBe('domain_write')
    expect(CORE_UNGATED_GATEWAY_TOOLS.has('artifact_write')).toBe(true)
    expect(CORE_UNGATED_GATEWAY_TOOLS.has('artifact_build_omada')).toBe(true)

    const tools = buildGatewayTools({
      domain: domainWith(() => ({ json: { status: 'success', data: {} } }), []),
      approvalGuard: new ApprovalGuard(),
      contextMode: 'manual_chat'
    })
    expect(tools.artifact_write).toBeDefined()
    expect(tools.artifact_build_omada).toBeDefined()
  })

  test('creates v1 when artifact folder does not exist yet (E_NOT_FOUND)', async () => {
    const calls: Call[] = []
    const domain = domainWith((call) => {
      if (call.method === 'GET' && call.url.includes('/library/folder')) {
        return {
          status: 404,
          json: { status: 'error', error: { code: 'E_NOT_FOUND', message: 'folder not found' } }
        }
      }
      if (call.method === 'POST' && call.url.endsWith('/library/files')) {
        return {
          json: {
            status: 'success',
            data: {
              id: 101,
              path: 'agent-docs/artifacts/q4-board/v1/index.html',
              size_bytes: 512,
              content_hash: 'hash-v1'
            }
          }
        }
      }
      if (call.method === 'POST' && call.url.endsWith('/library/artifacts/preview-token')) {
        return {
          json: {
            status: 'success',
            data: {
              ok: true,
              token: 'tok-v1',
              preview_url: 'http://127.0.0.1:8200/api/library/artifacts/preview/tok-v1/index.html'
            }
          }
        }
      }
      throw new Error(`Unexpected call: ${call.method} ${call.url}`)
    }, calls)

    const guard = new ApprovalGuard()
    const { artifact_write } = createArtifactTools(domain, [], guard, {
      contextMode: 'manual_chat',
      toolApprovalPrefs: { artifact_write: { tier: 'auto', source: 'default' } }
    })

    const res = (await runWithAuto(artifact_write, {
      slug: 'Q4 Board',
      title: 'Q4 Vendor Board',
      artifact_type: 'dashboard',
      html: VALID_HTML
    })) as Record<string, unknown>

    expect(res).toMatchObject({
      ok: true,
      slug: 'q4-board',
      title: 'Q4 Vendor Board',
      artifact_type: 'dashboard',
      version: 1,
      file_id: 101,
      path: 'agent-docs/artifacts/q4-board/v1/index.html',
      content_hash: 'hash-v1',
      local_preview_url: 'http://127.0.0.1:8200/api/library/artifacts/preview/tok-v1/index.html',
      warnings: []
    })
    const postCall = calls.find((c) => c.method === 'POST')
    expect(postCall?.body).toMatchObject({
      parent_path: 'agent-docs/artifacts/q4-board/v1',
      filename: 'index.html',
      source: 'agent'
    })
  })

  test('auto-increments version from existing folders and retries once on E_VERSION_CONFLICT', async () => {
    const calls: Call[] = []
    let postAttempt = 0
    const domain = domainWith((call) => {
      if (call.method === 'GET' && call.url.includes('/library/folder')) {
        return {
          json: {
            status: 'success',
            data: {
              path: 'agent-docs/artifacts/q4-board',
              folders: [
                { name: 'v1', path: 'agent-docs/artifacts/q4-board/v1' },
                { name: 'v2', path: 'agent-docs/artifacts/q4-board/v2' }
              ],
              files: [],
              total: 0
            }
          }
        }
      }
      if (call.method === 'POST' && call.url.endsWith('/library/files')) {
        postAttempt += 1
        if (postAttempt === 1) {
          return {
            status: 409,
            json: {
              status: 'error',
              error: { code: 'E_VERSION_CONFLICT', message: 'already exists' }
            }
          }
        }
        return {
          json: {
            status: 'success',
            data: {
              id: 104,
              path: 'agent-docs/artifacts/q4-board/v4/index.html',
              size_bytes: 520,
              content_hash: 'hash-v4'
            }
          }
        }
      }
      throw new Error(`Unexpected call: ${call.method} ${call.url}`)
    }, calls)

    const guard = new ApprovalGuard()
    const { artifact_write } = createArtifactTools(domain, [], guard, {
      contextMode: 'manual_chat',
      toolApprovalPrefs: { artifact_write: { tier: 'auto', source: 'default' } }
    })

    const res = (await runWithAuto(artifact_write, {
      slug: 'q4-board',
      title: 'Q4 Vendor Board',
      artifact_type: 'dashboard',
      html: VALID_HTML,
      change_note: 'Add filter bar'
    })) as Record<string, unknown>

    expect(postAttempt).toBe(2)
    expect(res).toMatchObject({
      ok: true,
      version: 4,
      file_id: 104,
      path: 'agent-docs/artifacts/q4-board/v4/index.html'
    })
  })

  test('returns E_ARTIFACT_LINT without touching library API when lint fails', async () => {
    const calls: Call[] = []
    const domain = domainWith(() => ({ json: { status: 'success', data: {} } }), calls)
    const guard = new ApprovalGuard()
    const { artifact_write } = createArtifactTools(domain, [], guard, {
      contextMode: 'manual_chat',
      toolApprovalPrefs: { artifact_write: { tier: 'auto', source: 'default' } }
    })

    const res = (await runWithAuto(artifact_write, {
      slug: 'broken',
      title: 'Broken',
      artifact_type: 'app',
      html: 'not html // TODO'
    })) as Record<string, unknown>

    expect(res.ok).toBe(false)
    expect(res.error).toBe('E_ARTIFACT_LINT')
    expect(Array.isArray(res.issues)).toBe(true)
    expect(calls).toHaveLength(0)
  })
})

describe('artifact_build_omada tool', () => {
  test('calls POST /library/artifacts/build-omada and returns bundle metadata + local_preview_url', async () => {
    const calls: Call[] = []
    const domain = domainWith((call) => {
      if (call.method === 'POST' && call.url.endsWith('/library/artifacts/build-omada')) {
        return {
          json: {
            status: 'success',
            data: {
              ok: true,
              slug: 'omada-ap-board',
              title: 'Omada AP Monitor',
              artifact_type: 'app',
              version: 1,
              file_id: 301,
              path: 'agent-docs/artifacts/omada-ap-board/v1/index.html',
              folder: 'agent-docs/artifacts/omada-ap-board/v1',
              file_count: 6,
              size_bytes: 1200400,
              build_ms: 820,
              source_demo: 'omada-ui-kit/src/demos/omada-ap-board/Demo.tsx',
              local_preview_url: 'http://127.0.0.1:8200/api/library/artifacts/preview/om1/index.html'
            }
          }
        }
      }
      throw new Error(`Unexpected call: ${call.method} ${call.url}`)
    }, calls)

    const guard = new ApprovalGuard()
    const { artifact_build_omada } = createArtifactTools(domain, [], guard, {
      contextMode: 'manual_chat',
      toolApprovalPrefs: { artifact_build_omada: { tier: 'auto', source: 'default' } }
    })

    const res = (await runWithAuto(artifact_build_omada, {
      slug: 'Omada AP_Board',
      title: 'Omada AP Monitor',
      code: "import { SCard } from '@/omada'; export default function Demo() { return <SCard title='AP' />; }"
    })) as Record<string, unknown>

    expect(res).toMatchObject({
      ok: true,
      slug: 'omada-ap-board',
      artifact_type: 'app',
      version: 1,
      file_id: 301,
      file_count: 6,
      build_ms: 820,
      local_preview_url: 'http://127.0.0.1:8200/api/library/artifacts/preview/om1/index.html'
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body).toMatchObject({
      slug: 'omada-ap-board',
      theme_mode: 'light'
    })
  })

  test('rejects TODO placeholders in Demo.tsx without calling backend build', async () => {
    const calls: Call[] = []
    const domain = domainWith(() => ({ json: { status: 'success', data: {} } }), calls)
    const guard = new ApprovalGuard()
    const { artifact_build_omada } = createArtifactTools(domain, [], guard, {
      contextMode: 'manual_chat',
      toolApprovalPrefs: { artifact_build_omada: { tier: 'auto', source: 'default' } }
    })

    const res = (await runWithAuto(artifact_build_omada, {
      slug: 'omada-todo',
      title: 'Incomplete',
      code: 'export default function Demo() { // TODO implement\n return null; }'
    })) as Record<string, unknown>

    expect(res.ok).toBe(false)
    expect(res.error).toBe('E_ARTIFACT_LINT')
    expect(calls).toHaveLength(0)
  })
})
