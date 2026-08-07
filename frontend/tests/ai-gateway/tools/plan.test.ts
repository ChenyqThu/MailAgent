import { describe, expect, test } from 'vitest'

import {
  buildGatewayTools,
  GATEWAY_PLAN_TOOL_OFF_NAMES
} from '../../../src/ai-gateway/tools'
import { createPlanTools } from '../../../src/ai-gateway/tools/plan'
import { planUpdateSchema } from '../../../src/ai-gateway/tools/schemas'
import { mockDomain, okEnvelope, runTool } from './_helpers'

describe('plan_update schema', () => {
  test('accepts every contract status and trims model-authored strings', () => {
    const parsed = planUpdateSchema.parse({
      goal: '  Ship P0  ',
      steps: [
        { id: ' s1 ', title: ' Read mail ', status: 'pending' },
        { id: 's2', title: ' Query Notion', status: 'in_progress', note: ' working ' },
        { id: 's3', title: 'Summarize', status: 'done' },
        { id: 's4', title: 'Wait', status: 'blocked' },
        { id: 's5', title: 'Write calendar', status: 'unavailable' }
      ]
    })
    expect(parsed.goal).toBe('Ship P0')
    expect(parsed.steps[0]).toMatchObject({ id: 's1', title: 'Read mail', status: 'pending' })
    expect(parsed.steps[1].note).toBe('working')
  })

  test('rejects more than 12 steps and duplicate ids after trimming', () => {
    expect(() =>
      planUpdateSchema.parse({
        goal: 'too many',
        steps: Array.from({ length: 13 }, (_, index) => ({
          id: `s${index}`,
          title: `Step ${index}`,
          status: 'pending'
        }))
      })
    ).toThrow()
    expect(() =>
      planUpdateSchema.parse({
        goal: 'duplicate',
        steps: [
          { id: 'same', title: 'One', status: 'pending' },
          { id: ' same ', title: 'Two', status: 'done' }
        ]
      })
    ).toThrow(/unique/i)
  })
})

describe('plan_update execution and registration', () => {
  test('returns only the normalized input and omits an empty note', async () => {
    const tool = createPlanTools().plan_update
    const input = planUpdateSchema.parse({
      goal: '  Cross-domain review ',
      steps: [{ id: ' mail ', title: ' Read email ', status: 'unavailable', note: '   ' }]
    })
    await expect(runTool(tool, input)).resolves.toEqual({
      goal: 'Cross-domain review',
      steps: [{ id: 'mail', title: 'Read email', status: 'unavailable' }]
    })
  })

  test('default-on registers in manual and every headless context mode', () => {
    for (const contextMode of [
      'manual_chat',
      'cron_headless',
      'untrusted_trigger',
      'im_chat'
    ] as const) {
      const tools = buildGatewayTools({
        domain: mockDomain(() => okEnvelope([])),
        contextMode
      })
      expect(tools.plan_update, contextMode).toBeDefined()
      expect((tools.plan_update as { needsApproval?: unknown }).needsApproval, contextMode).toBeUndefined()
    }
  })

  test('explicit flag false restores the exact pre-P0 manual ToolSet', () => {
    const tools = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      contextMode: 'manual_chat',
      planToolsEnabled: false
    })
    expect(Object.keys(tools).sort()).toEqual([...GATEWAY_PLAN_TOOL_OFF_NAMES].sort())
  })
})
