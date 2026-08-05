// 阶段 0.5-① — `deriveToolPhase` truth table + the two EQUIVALENCE gates that let it replace the
// three hand-rolled "跑没跑完" judgements (toolGroupSummary.toolPartState /
// useTurnStage.toolPartResolved / ToolTraceCard's inline boolean).
//
// 🔴 Why the equivalence tests exist: `toolPartState` feeds `summarizeToolGroup.forceExpand`,
// which is the ONLY thing keeping an approval card from being folded out of sight inside a tool
// group (ToolGroupCard red line ②, a shipped-and-fixed island-less deadlock). Moving that
// judgement is only safe if the new function agrees with the old one on EVERY input shape, so
// the pre-refactor implementations are copied in VERBATIM below and cross-producted against.

import { describe, expect, test } from 'vitest'

import {
  deriveToolPhase,
  isResolutionWithoutDecision,
  isToolCancelled,
  isToolDenied,
  isToolPhaseSettled,
  partAwaitsApproval,
  RESOLUTION_WITHOUT_DECISION,
  type ToolPhaseInput
} from '@shared/assistant/runtime/toolPhase'
import { deriveCardPhase } from '@shared/assistant/tools/_cardShell.lib'
import { formatToolDuration } from '@shared/assistant/tools/generic/useToolElapsed'

// ── verbatim pre-refactor implementations (do NOT "improve" these — they are the reference) ──

type LegacyState = 'awaiting' | 'error' | 'done' | 'running'

/** VERBATIM copy of toolGroupSummary.ts::toolPartState before 阶段 0.5-①. */
function legacyToolPartState(part: ToolPhaseInput): LegacyState {
  if (legacyAwaitsApproval(part)) return 'awaiting'
  if (part.isError === true || part.status?.type === 'incomplete') return 'error'
  if (part.result !== undefined && part.result !== null) return 'done'
  if (part.status?.type === 'complete') return 'done'
  return 'running'
}

/** VERBATIM copy of useTurnStage.ts::partAwaitsApproval before 阶段 0.5-①. */
function legacyAwaitsApproval(part: ToolPhaseInput): boolean {
  const approval = part.approval
  return !!approval && approval.approved === undefined && !approval.resolution
}

/** VERBATIM copy of useTurnStage.ts::toolPartResolved before 阶段 0.5-①. */
function legacyToolPartResolved(part: ToolPhaseInput): boolean {
  if (part.isError === true) return true
  const statusType = part.status?.type
  if (statusType === 'incomplete' || statusType === 'complete') return true
  return part.result !== undefined && part.result !== null
}

/** Every structurally distinct part shape the converter can hand a card. Includes the值-shaped
 *  traps: a falsy-but-present result (0 / ''), a null result, an empty vs truncated argsText. */
function allParts(): ToolPhaseInput[] {
  const errors = [undefined, false, true] as const
  const statuses = [
    undefined,
    { type: 'running' },
    { type: 'complete' },
    { type: 'incomplete' },
    { type: 'requires-action' }
  ] as const
  const results = [undefined, null, { ok: true }, 0, ''] as const
  const approvals = [
    undefined,
    { approved: undefined as boolean | undefined },
    { approved: true },
    { approved: false },
    { resolution: 'expired' },
    { resolution: 'cancelled' }
  ] as const
  const argsTexts = [undefined, '', '{', '{"a":1', '{"a":1}', '{}', 'null', 'not json'] as const

  const out: ToolPhaseInput[] = []
  for (const isError of errors)
    for (const status of statuses)
      for (const result of results)
        for (const approval of approvals)
          for (const argsText of argsTexts)
            out.push({ isError, status, result, approval, argsText })
  return out
}

describe('deriveToolPhase — equivalence with the pre-refactor judgements', () => {
  test('canary: the cross-product is actually populated', () => {
    expect(allParts().length).toBe(3 * 5 * 5 * 6 * 8)
  })

  test('collapsing the two live phases reproduces toolPartState EXACTLY (red line ② carrier)', () => {
    const drift: string[] = []
    for (const part of allParts()) {
      const phase = deriveToolPhase(part)
      const collapsed: LegacyState =
        phase === 'streaming-args' || phase === 'executing' ? 'running' : phase
      const legacy = legacyToolPartState(part)
      if (collapsed !== legacy)
        drift.push(`${JSON.stringify(part)}: new=${collapsed} old=${legacy}`)
    }
    expect(drift, `phase collapse diverged from toolPartState:\n  ${drift.join('\n  ')}`).toEqual(
      []
    )
  })

  test('partAwaitsApproval is byte-for-byte the old predicate', () => {
    const drift = allParts().filter((p) => partAwaitsApproval(p) !== legacyAwaitsApproval(p))
    expect(drift).toEqual([])
  })

  test('isToolPhaseSettled reproduces toolPartResolved over its whole call domain', () => {
    // deriveTurnStage only reaches toolPartResolved AFTER returning for an awaiting part, so the
    // contract is equivalence on `!partAwaitsApproval` — asserted here, plus the disjoint case
    // below so the difference is documented rather than accidental.
    const domain = allParts().filter((p) => !partAwaitsApproval(p))
    expect(domain.length).toBeGreaterThan(0)
    const drift = domain.filter(
      (p) => isToolPhaseSettled(deriveToolPhase(p)) !== legacyToolPartResolved(p)
    )
    expect(drift).toEqual([])
  })

  test('an awaiting part is never "settled" (outside toolPartResolved\'s domain by construction)', () => {
    const awaiting = allParts().filter(partAwaitsApproval)
    expect(awaiting.length).toBeGreaterThan(0)
    expect(awaiting.every((p) => deriveToolPhase(p) === 'awaiting')).toBe(true)
    expect(awaiting.every((p) => !isToolPhaseSettled(deriveToolPhase(p)))).toBe(true)
  })
})

describe('deriveToolPhase — the NEW split: streaming-args vs executing', () => {
  const live = { status: { type: 'running' } } as const

  test('a truncated argsText (mid input-streaming) → streaming-args', () => {
    // react-ai-sdk strips trailing }/]/" ONLY while the part is input-streaming, so a live part's
    // argsText is an unparseable prefix. These are the real shapes it produces.
    expect(deriveToolPhase({ ...live, argsText: '{' })).toBe('streaming-args')
    expect(deriveToolPhase({ ...live, argsText: '{"q":"redis tim' })).toBe('streaming-args')
    expect(deriveToolPhase({ ...live, argsText: '{"a":1' })).toBe('streaming-args')
    expect(deriveToolPhase({ ...live, argsText: '{"a":[1,2' })).toBe('streaming-args')
  })

  test('complete JSON argsText (input-available onward) → executing', () => {
    expect(deriveToolPhase({ ...live, argsText: '{}' })).toBe('executing')
    expect(deriveToolPhase({ ...live, argsText: '{"q":"x"}' })).toBe('executing')
  })

  test('no argsText at all → executing, never a fabricated "streaming"', () => {
    // The stage machine's TurnStagePart shape carries no argsText; neither does a legacy row.
    expect(deriveToolPhase(live)).toBe('executing')
    expect(deriveToolPhase({ ...live, argsText: '' })).toBe('executing')
    expect(deriveToolPhase({ ...live, argsText: '   ' })).toBe('executing')
  })

  test('R5 — a replayed part (result only, no stream seen) is done, whatever argsText says', () => {
    expect(deriveToolPhase({ result: { ok: true } })).toBe('done')
    expect(deriveToolPhase({ result: { ok: true }, argsText: '{"a":1' })).toBe('done')
    expect(deriveToolPhase({ result: '', status: { type: 'complete' } })).toBe('done')
    expect(deriveToolPhase({ status: { type: 'complete' } })).toBe('done')
  })

  test('terminal precedence is unchanged: awaiting > error > result > complete', () => {
    expect(deriveToolPhase({ approval: {}, isError: true, result: { e: 1 } })).toBe('awaiting')
    expect(deriveToolPhase({ isError: true, result: { ok: true } })).toBe('error')
    expect(deriveToolPhase({ status: { type: 'incomplete' } })).toBe('error')
    expect(deriveToolPhase({ result: { ok: true }, status: { type: 'running' } })).toBe('done')
  })
})

describe('isToolDenied — refused, not failed', () => {
  test('a rejected approval (output-denied) is denied', () => {
    expect(isToolDenied({ approval: { approved: false }, isError: true })).toBe(true)
  })
  test('a cancelled / expired gate is denied', () => {
    expect(isToolDenied({ approval: { resolution: 'cancelled' } })).toBe(true)
    expect(isToolDenied({ approval: { resolution: 'expired' } })).toBe(true)
  })
  test('an approved-then-failed tool is NOT denied (the tool ran and broke)', () => {
    expect(isToolDenied({ approval: { approved: true }, isError: true })).toBe(false)
  })
  test('no approval object at all → not denied', () => {
    expect(isToolDenied({ isError: true, result: { error: 'boom' } })).toBe(false)
  })
})

describe('isToolCancelled — nobody decided ≠ somebody refused (R5)', () => {
  test('a cancelled / expired gate is cancelled', () => {
    expect(isToolCancelled({ approval: { resolution: 'cancelled' } })).toBe(true)
    expect(isToolCancelled({ approval: { resolution: 'expired' } })).toBe(true)
  })
  test('🔴 an ACTIVE refusal is NOT cancelled — that is the whole point of the split', () => {
    expect(isToolCancelled({ approval: { approved: false }, isError: true })).toBe(false)
  })
  test('an unknown resolution value is not silently promoted to cancelled', () => {
    expect(isToolCancelled({ approval: { resolution: 'something-new' } })).toBe(false)
  })
  test('no approval / an open gate / an approved call → not cancelled', () => {
    expect(isToolCancelled({ isError: true, result: { error: 'boom' } })).toBe(false)
    expect(isToolCancelled({ approval: {} })).toBe(false)
    expect(isToolCancelled({ approval: { approved: true } })).toBe(false)
  })
  test('🔴 isToolDenied is UNCHANGED — it still covers both halves', () => {
    // 它是「因为闸而没跑成」的判据，调用方依赖这个语义；cancelled 是叠在上面的收窄。
    expect(isToolDenied({ approval: { resolution: 'cancelled' } })).toBe(true)
    expect(isToolDenied({ approval: { approved: false } })).toBe(true)
  })
})

describe('🔴 RESOLUTION_WITHOUT_DECISION 是单一定义点（消灭了 _cardShell.lib 的手抄）', () => {
  // 0805 收尾① —— 这两个字面量此前在 runtime/toolPhase.ts 与 tools/_cardShell.lib.ts 各写一遍。
  // 本组是**变异检验**的形态：期望全部由单源 `RESOLUTION_WITHOUT_DECISION` 生成，测试里一个
  // 字面量都不再抄第三遍。往单源里加一个值，下面的循环自动覆盖它；只更新一侧消费方即红。
  // （值域本身与上游 `@assistant-ui/core` 的 `resolution?: "cancelled" | "expired"` union 之间
  // 另有编译期闸 —— `satisfies Record<ApprovalResolution, true>` 让漏写/多写都过不了 typecheck，
  // 那一半不可能写成运行时断言，故不在这里。）
  const values = Object.keys(RESOLUTION_WITHOUT_DECISION)

  /** deriveCardPhase 的入参是上游 props 的窄类型；这里要喂值域外的字符串，故按 wire 形状转型。 */
  function cardPhaseFor(resolution: string): ReturnType<typeof deriveCardPhase> {
    return deriveCardPhase({ approval: { id: 'ap1', resolution } } as unknown as Parameters<
      typeof deriveCardPhase
    >[0])
  }

  test('canary: 单源非空 —— 清单被清空时下面的循环会退化成零断言', () => {
    expect(values.length).toBeGreaterThanOrEqual(2)
  })

  test('单源里的每个值，两处消费方都判成「没人决定」', () => {
    for (const resolution of values) {
      expect(isResolutionWithoutDecision(resolution), resolution).toBe(true)
      // 消费方 ①：trace 卡的 cancelled tone。
      expect(isToolCancelled({ approval: { resolution } }), resolution).toBe(true)
      // 消费方 ②：审批卡的 expired 相位（此前在 _cardShell.lib.ts 手抄同样的字面量）。
      expect(cardPhaseFor(resolution), resolution).toBe('expired')
    }
  })

  test('值域外的 resolution 两处都不放行（不是 truthy 判定，也不吃原型链上的键）', () => {
    // 'toString' 是 Object.hasOwn 而非 `in` 的判据差 —— 用 `in` 写这个判定就会把它误放行。
    for (const resolution of ['something-new', 'CANCELLED', 'toString', '']) {
      expect(isResolutionWithoutDecision(resolution), resolution).toBe(false)
      expect(isToolCancelled({ approval: { resolution } }), resolution).toBe(false)
      expect(cardPhaseFor(resolution), resolution).not.toBe('expired')
    }
  })

  test('deriveCardPhase 的其余分支一个字节没动（判定链只换了 resolution 的来源）', () => {
    // 优先级 error > expired > rejected > done > pending > authorized，逐条复述。
    expect(deriveCardPhase({ isError: true } as never)).toBe('error')
    expect(deriveCardPhase({ status: { type: 'incomplete', reason: 'error' } } as never)).toBe(
      'error'
    )
    expect(deriveCardPhase({ approval: { id: 'a', approved: false } } as never)).toBe('rejected')
    expect(deriveCardPhase({ result: { ok: true } } as never)).toBe('done')
    expect(deriveCardPhase({ approval: { id: 'a' } } as never)).toBe('pending')
    expect(deriveCardPhase({ approval: { id: 'a', approved: true } } as never)).toBe('authorized')
    expect(deriveCardPhase({} as never)).toBe('done')
    // 🔴 error 仍压过 expired（终态优先级不因单源化而变）。
    expect(
      deriveCardPhase({ isError: true, approval: { id: 'a', resolution: 'expired' } } as never)
    ).toBe('error')
  })
})

describe('formatToolDuration', () => {
  test('sub-minute keeps one decimal second', () => {
    expect(formatToolDuration(0)).toBe('0.0s')
    expect(formatToolDuration(340)).toBe('0.3s')
    expect(formatToolDuration(1500)).toBe('1.5s')
    expect(formatToolDuration(59_940)).toBe('59.9s')
  })
  test('past a minute switches to m/s with a zero-padded second', () => {
    expect(formatToolDuration(60_000)).toBe('1m00s')
    expect(formatToolDuration(63_400)).toBe('1m03s')
    expect(formatToolDuration(605_000)).toBe('10m05s')
  })
  test('nonsense input renders nothing rather than a fake number', () => {
    expect(formatToolDuration(-1)).toBe('')
    expect(formatToolDuration(Number.NaN)).toBe('')
  })
})
