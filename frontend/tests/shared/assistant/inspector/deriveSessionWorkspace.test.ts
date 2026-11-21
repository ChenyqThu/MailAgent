import { describe, expect, test } from 'vitest'

import {
  deriveSessionWorkspace,
  sanitizeExternalUrl,
  toSafeVirtualPath
} from '@shared/assistant/inspector/deriveSessionWorkspace'

describe('deriveSessionWorkspace', () => {
  test('returns empty snapshot when no messages, anchors, or mentions exist', () => {
    const snap = deriveSessionWorkspace({ messages: [] })
    expect(snap.totalItems).toBe(0)
    expect(snap.artifacts).toEqual([])
    expect(snap.sources.explicit).toEqual([])
    expect(snap.sources.consulted).toEqual([])
    expect(snap.links).toEqual([])
    expect(snap.skills).toEqual([])
    expect(snap.connectorsUsed).toEqual([])
  })

  test('sanitizes host paths and unsafe URLs', () => {
    expect(toSafeVirtualPath('/Users/alice/secret/doc.md')).toBe('doc.md')
    expect(toSafeVirtualPath('C:\\Users\\alice\\doc.md')).toBe('doc.md')
    expect(toSafeVirtualPath('notes/q4-summary.md')).toBe('notes/q4-summary.md')
    expect(toSafeVirtualPath('/reports/q4-summary.md')).toBe('reports/q4-summary.md')

    expect(sanitizeExternalUrl('javascript:alert(1)')).toBeNull()
    expect(sanitizeExternalUrl('libpreview://file/12')).toBeNull()
    expect(sanitizeExternalUrl('file:///etc/passwd')).toBeNull()
    expect(sanitizeExternalUrl('https://docs.example.com/guide.')).toEqual({
      url: 'https://docs.example.com/guide',
      hostname: 'docs.example.com'
    })
  })

  test('deduplicates explicit anchors/mentions ahead of consulted tool calls', () => {
    const snap = deriveSessionWorkspace({
      anchors: {
        email: { internalId: 42, subject: 'Q4 Renewal Terms' },
        matter: { publicId: 'MAT-0012', title: 'Renewal Negotiation' }
      },
      mentions: {
        libraryFiles: [{ file_id: 9, path: 'contracts/msa.md', name: 'MSA.md' }],
        attachments: [{ id: 'a1', name: 'draft.pdf' }]
      },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Check this' },
            {
              type: 'data',
              name: 'library',
              data: { fileId: 101, name: 'draft.pdf', path: 'chat-attachments/2026-11/draft.pdf' }
            }
          ]
        },
        {
          role: 'assistant',
          parts: [
            {
              type: 'tool-email_get',
              toolCallId: 'tc1',
              state: 'output-available',
              input: { internal_id: 42 },
              output: { internal_id: 42, subject: 'Q4 Renewal Terms', sender: 'legal@acme.com' }
            },
            {
              type: 'tool-email_search_fulltext',
              toolCallId: 'tc2',
              state: 'output-available',
              input: { query: 'discount' },
              output: {
                items: [
                  { internal_id: 42, subject: 'Q4 Renewal Terms' },
                  { internal_id: 88, subject: 'Previous Discount Thread', sender: 'sales@acme.com' }
                ]
              }
            },
            {
              type: 'tool-library_read',
              toolCallId: 'tc3',
              state: 'output-available',
              input: { file_id: 9, path: '/Users/dev/local/secret.md' },
              output: { id: 9, path: 'contracts/msa.md' }
            },
            {
              type: 'tool-kos_search',
              toolCallId: 'tc4',
              state: 'output-available',
              input: { query: 'enterprise sla' },
              output: { title: 'Enterprise SLA KB' }
            }
          ]
        }
      ]
    })

    // email:42, matter:MAT-0012, library:9 explicit; draft.pdf promoted from attachment-local to library:101
    expect(snap.sources.explicit.map((s) => s.key)).toEqual([
      'email:42',
      'matter:MAT-0012',
      'library:9',
      'library:101'
    ])
    // email:42 and library:9 must NOT repeat under consulted
    expect(snap.sources.consulted.map((s) => s.key)).toEqual([
      'email:88',
      'kos:Enterprise SLA KB'
    ])
    expect(snap.sources.explicit.find((s) => s.key === 'library:9')?.virtualPath).toBe(
      'contracts/msa.md'
    )
  })

  test('merges repeated library writes, keeps latest plan snapshot, and extracts all artifact kinds', () => {
    const snap = deriveSessionWorkspace({
      messages: [
        {
          role: 'assistant',
          // ThreadMessage format (content array with type: 'tool-call')
          content: [
            {
              type: 'tool-call',
              toolCallId: 'lw1',
              toolName: 'library_write',
              args: { path: 'notes/brief.md', content: '# V1', change_note: 'initial' },
              result: { file_id: 77, path: 'notes/brief.md' }
            },
            {
              type: 'tool-call',
              toolCallId: 'lw2',
              toolName: 'library_append',
              args: { file_id: 77, content: '## Section 2', change_note: 'added section 2' },
              result: { file_id: 77, path: 'notes/brief.md' }
            },
            {
              type: 'tool-call',
              toolCallId: 'img1',
              toolName: 'generate_image',
              args: { prompt: 'Clean architecture diagram', size: '1024x1024' },
              result: { images: [{ file_id: 'gen-1', url: '/library/files/raw/gen-1' }] }
            },
            {
              type: 'tool-call',
              toolCallId: 'draft1',
              toolName: 'email_draft_reply',
              args: {
                subject: 'Re: Contract',
                to: 'alice@example.com',
                body_markdown: 'Hi Alice,\nApproved.'
              },
              result: { ok: true }
            },
            {
              type: 'tool-call',
              toolCallId: 'rep1',
              toolName: 'report_write',
              args: { title: 'Weekly Digest', content: 'Summary body' },
              result: { id: 'r9', title: 'Weekly Digest' }
            },
            {
              type: 'tool-call',
              toolCallId: 'mat1',
              toolName: 'matter_create',
              args: { title: 'Vendor Audit', summary: 'Track SOC2 deliverables' },
              result: { public_id: 'MAT-0901', status: 'open' }
            },
            {
              type: 'tool-call',
              toolCallId: 'plan1',
              toolName: 'plan_update',
              args: {
                goal: 'Audit docs',
                steps: [{ id: 's1', title: 'Read MSA', status: 'in_progress' }]
              },
              result: {
                goal: 'Audit docs',
                steps: [{ id: 's1', title: 'Read MSA', status: 'in_progress' }]
              }
            },
            {
              type: 'tool-call',
              toolCallId: 'plan2',
              toolName: 'plan_update',
              args: {
                goal: 'Audit docs v2',
                steps: [{ id: 's1', title: 'Read MSA', status: 'done' }]
              },
              result: {
                goal: 'Audit docs v2',
                steps: [{ id: 's1', title: 'Read MSA', status: 'done' }]
              }
            }
          ]
        }
      ]
    })

    expect(snap.artifacts.map((a) => [a.kind, a.title])).toEqual([
      ['library', 'brief.md'],
      ['image', 'Clean architecture diagram'],
      ['draft', 'Re: Contract'],
      ['report', 'Weekly Digest'],
      ['matter', 'Vendor Audit'],
      ['plan', 'Audit docs v2']
    ])

    const lib = snap.artifacts[0]
    expect(lib?.writeCount).toBe(2)
    expect(lib?.fileId).toBe(77)
    expect(lib?.content).toBe('## Section 2')
    expect(lib?.subtitle).toBe('added section 2')

    const plan = snap.artifacts.find((a) => a.kind === 'plan')
    expect(plan?.plan?.steps[0]?.status).toBe('done')
  })

  test('ignores rejected/errored artifacts and gathers links, skills, and grouped connectors', () => {
    const snap = deriveSessionWorkspace({
      messages: [
        {
          role: 'assistant',
          parts: [
            { type: 'source-url', url: 'https://ai.sdk.dev/docs', title: 'AI SDK Docs' },
            {
              type: 'text',
              text: 'Check [Spec](https://example.org/spec), unsafe [JS](javascript:void(0)), [Internal](libpreview://1) and https://example.org/spec.'
            },
            {
              type: 'tool-library_write',
              toolCallId: 'err1',
              state: 'output-error',
              input: { path: 'bad/fail.md', content: 'oops' },
              errorText: 'Permission denied'
            },
            {
              type: 'tool-web_search',
              toolCallId: 'ws1',
              state: 'output-available',
              input: { q: 'rag' },
              output: {
                results: [
                  { url: 'https://rag.dev/paper', title: 'RAG Survey' },
                  { url: 'https://ai.sdk.dev/docs', title: 'Duplicate URL' }
                ]
              }
            },
            {
              type: 'tool-skill_read',
              toolCallId: 'sk1',
              state: 'output-available',
              input: { name: 'deploy-checklist' },
              output: { name: 'deploy-checklist' }
            },
            {
              type: 'tool-tool_search',
              toolCallId: 'ts1',
              state: 'output-available',
              input: { q: 'notion' },
              output: { activated_tools: ['notion_search', { name: 'notion_fetch' }] }
            },
            {
              type: 'dynamic-tool',
              toolName: 'mcp__notion__search',
              toolCallId: 'mcp1',
              state: 'output-available',
              input: { query: 'roadmap' },
              output: { results: [] }
            },
            {
              type: 'dynamic-tool',
              toolName: 'mcp__notion__fetch',
              toolCallId: 'mcp2',
              state: 'output-available',
              input: { id: 'p1' },
              output: { title: 'Roadmap' }
            }
          ]
        }
      ]
    })

    expect(snap.artifacts).toEqual([])
    expect(snap.links.map((l) => l.url)).toEqual([
      'https://ai.sdk.dev/docs',
      'https://example.org/spec',
      'https://rag.dev/paper'
    ])
    expect(snap.skills.map((s) => `${s.kind}:${s.name}`)).toEqual([
      'skill:deploy-checklist',
      'tool-activated:notion_search',
      'tool-activated:notion_fetch'
    ])
    expect(snap.connectorsUsed).toEqual([
      {
        connectorId: 'notion',
        displayName: 'Notion',
        callCount: 2,
        actions: ['search', 'fetch']
      }
    ])
  })
})
