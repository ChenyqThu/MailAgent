// Matters MVP P3 (lane ③) — the Matter Chat surface context.
//
// A zero-dependency leaf (react + one type-only import) so BOTH sides can read it without a cycle:
// the panel (components/matters) provides it, the tool card (assistant/tools/matters) consumes it.
//
// It is what makes 「写入回执卡只在事项对话里」 structural rather than a copy of the card: the same
// registered component renders the receipt when this context is present and falls through to the
// generic ToolTraceCard everywhere else (普通 chat) — D9 / 交付物 D.

import { createContext, useContext } from 'react'

import type { MatterUndoDescriptor } from '@shared/api/matters'

/** Per-tool-call undo state. `done` is terminal for the card (the write was reversed). */
export type MatterUndoState = 'idle' | 'busy' | 'done'

export interface MatterChatSurface {
  /** The matter this conversation is anchored on (MAT-xxxx). */
  publicId: string
  /** Fire the undo for one tool call — renderer-direct REST, no LLM, no new chat message (D9). */
  runUndo(toolCallId: string, descriptor: MatterUndoDescriptor): void
  /** toolCallId → state; absent = 'idle'. A new object identity per change drives the re-render. */
  undoStates: Readonly<Record<string, MatterUndoState>>
}

export const MatterChatSurfaceContext = createContext<MatterChatSurface | null>(null)

/** null → this tool part is NOT rendering inside a Matter Chat panel. */
export function useMatterChatSurface(): MatterChatSurface | null {
  return useContext(MatterChatSurfaceContext)
}

/** Read the `undo` descriptor off a matter write tool's result. The gateway passes the Python
 *  mutation response through verbatim, so `result.undo` is either the descriptor or null (an
 *  irreversible / unsupported write). Anything else → null (never guess a write's inverse). */
export function readUndoDescriptor(result: unknown): MatterUndoDescriptor | null {
  if (result == null || typeof result !== 'object' || Array.isArray(result)) return null
  const undo = (result as { undo?: unknown }).undo
  if (undo == null || typeof undo !== 'object' || Array.isArray(undo)) return null
  const candidate = undo as { tool?: unknown; input?: unknown; label?: unknown }
  if (typeof candidate.tool !== 'string' || candidate.tool.length === 0) return null
  if (typeof candidate.label !== 'string') return null
  if (candidate.input == null || typeof candidate.input !== 'object') return null
  return {
    tool: candidate.tool,
    input: candidate.input as Record<string, unknown>,
    label: candidate.label
  }
}
