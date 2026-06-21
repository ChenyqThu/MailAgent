// notion_agent_chat tool (P2g) — let the Custom AI delegate a sub-question to the
// notion-agent CLI (a separate agent with native Notion access) and get its answer
// back, with thread_id continuity for follow-ups. Backed by serve-api
// /chat/notion-agent-once (reuses the serial gate + idle timeout). The legacy
// notion-agent BACKEND (backend_kind='notion-agent') is untouched — Phase 3 retires
// the selector UI, not this tool.

import type { ToolDef, ToolResult, ToolExecCtx } from '../registry'
import type { ChatToolPlatform } from '../../platform'

function ok<O>(output: O, start: number): ToolResult<O> {
  return { ok: true, output, durationMs: Date.now() - start }
}
function err(code: string, message: string, start: number): ToolResult {
  return { ok: false, code, message, durationMs: Date.now() - start }
}
function asStr(x: unknown): string | undefined {
  return typeof x === 'string' && x.length > 0 ? x : undefined
}
function effective(input: unknown, ctx: ToolExecCtx): { resolved: unknown; userEdited: boolean } {
  if (ctx.userEditedInput !== undefined) return { resolved: ctx.userEditedInput, userEdited: true }
  return { resolved: input, userEdited: false }
}

export function createNotionAgentTools(platform: ChatToolPlatform): ToolDef[] {
  const notionAgentChat: ToolDef = {
    name: 'notion_agent_chat',
    description:
      "Ask the notion-agent (a separate agent with native access to the user's Notion " +
      'workspace) a question or task and get its answer. Use when the user needs something ' +
      "that lives in Notion (a page's content, a database query, creating/updating a Notion " +
      'page) that the email tools cannot reach. Pass thread_id from a previous notion_agent_chat ' +
      'result to continue the SAME Notion conversation (keeps its context). The user confirms ' +
      'before it runs (it can modify Notion and takes tens of seconds).',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The question / task to send to the notion-agent.'
        },
        thread_id: {
          type: 'string',
          description: 'Optional — continue a prior notion_agent_chat thread (from its result).'
        },
        model: { type: 'string', description: 'Optional model override for the notion-agent.' },
        agent_page_id: { type: 'string', description: 'Optional Notion agent page id.' }
      },
      required: ['message']
    },
    confirmationTier: 'preview',
    category: 'notion',
    surface: 'cli',
    // notion-agent spawns a subprocess + hits Notion — generous budget (matches the
    // serve-api idle watchdog). throttle so a loop can't hammer the serial gate.
    timeoutMs: 120_000,
    throttlePerMinute: 6,
    handler: async (input, ctx): Promise<ToolResult> => {
      const start = Date.now()
      const { resolved, userEdited } = effective(input, ctx)
      const i = (resolved ?? {}) as Record<string, unknown>
      const message = asStr(i.message)
      if (!message) return err('E_INVALID_ARG', 'message is required (non-empty string)', start)
      try {
        const result = await platform.notionAgentChat(
          {
            message,
            threadId: asStr(i.thread_id) ?? null,
            model: asStr(i.model) ?? null,
            agentPageId: asStr(i.agent_page_id) ?? null
          },
          // codex review — thread the harness signal so the declared timeoutMs /
          // user cancel actually aborts the fetch (else it hangs to the server idle TO).
          ctx.signal
        )
        if (result.status === 'error') {
          return err(
            result.errorCode ?? 'E_NOTION_AGENT_FAIL',
            result.errorMessage ?? 'notion-agent failed',
            start
          )
        }
        // codex review LOW — surface status + metadata (thread_id lives in both
        // thread_id and metadata.thread_id for the model to continue the thread).
        return ok(
          {
            text: result.text,
            thread_id: result.threadId,
            status: result.status,
            metadata: result.metadata,
            user_edited: userEdited
          },
          start
        )
      } catch (e) {
        return err(
          (e as { code?: string }).code ?? 'E_INTERNAL',
          e instanceof Error ? e.message : String(e),
          start
        )
      }
    }
  }
  return [notionAgentChat]
}
