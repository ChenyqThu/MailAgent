import type { Tool } from 'ai'
import { z } from 'zod'

import type { MailAgentDomainClient } from '../python/domainClient'
import { auditedReadTool, type GatewayToolAuditCollector } from './types'

export const GATEWAY_AGENT_CATALOG_TOOL_NAMES = ['agent_catalog_list', 'agent_catalog_get'] as const

function triggerSummary(trigger: unknown): Record<string, unknown> | null {
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) return null
  const value = trigger as Record<string, unknown>
  return {
    kind: typeof value.kind === 'string' ? value.kind : null,
    timezone: typeof value.timezone === 'string' ? value.timezone : null,
    cron: typeof value.cron === 'string' ? value.cron : null
  }
}

async function catalogRow(
  domain: MailAgentDomainClient,
  agent: {
    id: string
    title: string
    description?: string | null
    enabled: boolean
    trigger?: unknown
  },
  signal?: AbortSignal
) {
  const runs = await domain.listAgentRuns(agent.id, 1, signal)
  const latest = runs[0]
  return {
    id: agent.id,
    title: agent.title,
    description: agent.description ?? null,
    enabled: agent.enabled === true,
    trigger: triggerSummary(agent.trigger),
    latestRun: latest ? { finishedAt: latest.finishedAt, state: latest.state } : null
  }
}

export function createAgentCatalogTools(
  domain: MailAgentDomainClient,
  collector: GatewayToolAuditCollector = []
): Record<string, Tool> {
  return {
    agent_catalog_list: auditedReadTool({
      name: 'agent_catalog_list',
      description: 'List available custom agents using only non-sensitive catalog metadata.',
      inputSchema: z.object({}),
      run: async (_input, signal) => {
        const agents = (await domain.listReportAgents(signal)).filter((agent) => agent.type === 'custom')
        return { agents: await Promise.all(agents.map((agent) => catalogRow(domain, agent, signal))) }
      }
    }, collector),
    agent_catalog_get: auditedReadTool({
      name: 'agent_catalog_get',
      description: 'Read non-sensitive catalog metadata for one custom agent.',
      inputSchema: z.object({ agent_id: z.string().min(1) }),
      run: async (input, signal) => {
        const agent = await domain.getReportAgent(input.agent_id, signal)
        if (!agent || agent.type !== 'custom') return { found: false, agent: null }
        return { found: true, agent: await catalogRow(domain, agent, signal) }
      }
    }, collector)
  }
}
