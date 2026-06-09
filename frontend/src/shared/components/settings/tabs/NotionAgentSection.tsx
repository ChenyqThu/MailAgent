// Settings → AI: Notion Agent (notion-agent-cli) config panel.
//
// Reads the CLI's account.json via mailApi.notionAgent.* and lets the user:
//   - see the bound account / workspace / Custom Agent / default model
//   - run `doctor` for a live connectivity + auth readout
//   - switch the bound Custom Agent (agents list → setAgent writes account.json)
//   - change the default model
//
// token_v2 auth is NOT editable here — that lives with the CLI
// (`notion-agent init`). We only report whether a token is present; when it
// isn't, the panel points the user at the terminal command.
//
// setAgent / setModel invalidate ['notionAgent','config'], which the chat
// panel also subscribes to, so a binding change reflects in the AI panel's
// header without a remount.

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, Loader2, X } from 'lucide-react'

import { useMailApi } from '@shared/hooks/useMailApi'
import { Button } from '@shared/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shared/components/ui/select'
import { toastError, toastSuccess } from '@shared/state/toast'
import type { NotionAgentDoctorCheck } from '@shared/api/types'

import { Section } from '../parts/Section'
import { Row } from '../parts/Row'

function errLabel(err: unknown): string {
  const e = err as { code?: string; message?: string }
  return e.code ? `${e.code} · ${e.message ?? ''}`.trim() : (e.message ?? String(err))
}

const PRIMARY_AGENT_KEY = 'mailagent.notionAgent.primary'

interface PrimaryAgent {
  name: string
  pageId: string
}

// The "main" agent (personal persona, e.g. Jarvis) is what Notion uses when
// no custom agent is bound — it is NOT returned by getCustomAgents. We
// remember it in localStorage once identified (the account binding that
// isn't a known custom agent) so the picker can always offer it + switch
// back to it after the user picks a custom agent.
function readPrimaryAgent(): PrimaryAgent | null {
  try {
    const v = localStorage.getItem(PRIMARY_AGENT_KEY)
    if (!v) return null
    const p = JSON.parse(v) as PrimaryAgent
    return p && p.pageId && p.name ? p : null
  } catch {
    return null
  }
}
function writePrimaryAgent(p: PrimaryAgent): void {
  try {
    localStorage.setItem(PRIMARY_AGENT_KEY, JSON.stringify(p))
  } catch {
    /* localStorage 不可写时主 Agent 仅当次会话有效 */
  }
}

interface AgentOption {
  agent_page_id: string
  name: string
  primary: boolean
}

export function NotionAgentSection(): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const qc = useQueryClient()

  const configQ = useQuery({
    queryKey: ['notionAgent', 'config'],
    queryFn: () => api.notionAgent.getConfig(),
    staleTime: 30_000
  })
  const config = configQ.data ?? null
  const ready = config?.configured === true

  const modelsQ = useQuery({
    queryKey: ['notionAgent', 'models'],
    queryFn: () => api.notionAgent.listModels(),
    staleTime: 60_000
  })
  // Custom Agents only load once the account is usable — listing them spawns
  // the CLI + hits Notion, pointless when there's no token.
  const agentsQ = useQuery({
    queryKey: ['notionAgent', 'agents'],
    queryFn: () => api.notionAgent.listAgents(),
    enabled: ready,
    staleTime: 5 * 60_000,
    retry: false
  })

  const [doctorChecks, setDoctorChecks] = React.useState<NotionAgentDoctorCheck[] | null>(null)
  const [doctorRunning, setDoctorRunning] = React.useState(false)
  const [savingAgent, setSavingAgent] = React.useState(false)
  const [savingModel, setSavingModel] = React.useState(false)

  // Custom agents from getCustomAgents (drop ones with no instructions page —
  // they can't be bound).
  const customAgents = React.useMemo(
    () => (agentsQ.data ?? []).filter((a) => a.agent_page_id),
    [agentsQ.data]
  )
  const customPageIds = React.useMemo(
    () => new Set(customAgents.map((a) => a.agent_page_id)),
    [customAgents]
  )

  // Identify + remember the main agent: when the account's current binding is
  // NOT in the custom list, that binding is the personal/main agent (Jarvis).
  const [primary, setPrimary] = React.useState<PrimaryAgent | null>(() => readPrimaryAgent())
  React.useEffect(() => {
    // Only judge once the custom list has loaded (size>0), else a custom
    // binding would be misread as the main agent.
    if (
      config?.agentPageId &&
      config.agentName &&
      customPageIds.size > 0 &&
      !customPageIds.has(config.agentPageId)
    ) {
      const p: PrimaryAgent = { name: config.agentName, pageId: config.agentPageId }
      writePrimaryAgent(p)
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 检测到 config 绑定的是 main agent 时记住它（writePrimaryAgent 写 localStorage + setPrimary）。带 localStorage 副作用 + 需 customPageIds 加载后判定，effect 合理。React Compiler 迁移债。
      setPrimary(p)
    }
  }, [config?.agentPageId, config?.agentName, customPageIds])

  // Picker options = main agent (pinned top) + custom agents. Fall back to the
  // current non-custom binding when localStorage hasn't recorded one yet.
  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- React Compiler 无法保留此手动 useMemo（依赖 config 可选链 + customPageIds Set）。现状 memo 正确，迁移 Compiler 时再处理。React Compiler 迁移债。
  const primaryOption = React.useMemo<PrimaryAgent | null>(() => {
    if (primary) return primary
    if (config?.agentPageId && config.agentName && !customPageIds.has(config.agentPageId)) {
      return { name: config.agentName, pageId: config.agentPageId }
    }
    return null
  }, [primary, config?.agentPageId, config?.agentName, customPageIds])

  const agentOptions = React.useMemo<AgentOption[]>(() => {
    const opts: AgentOption[] = []
    if (primaryOption) {
      opts.push({ agent_page_id: primaryOption.pageId, name: primaryOption.name, primary: true })
    }
    for (const a of customAgents) {
      if (primaryOption && a.agent_page_id === primaryOption.pageId) continue
      opts.push({ agent_page_id: a.agent_page_id, name: a.name, primary: false })
    }
    return opts
  }, [primaryOption, customAgents])

  async function handleDoctor(): Promise<void> {
    setDoctorRunning(true)
    try {
      const checks = await api.notionAgent.doctor()
      setDoctorChecks(checks)
    } catch (err) {
      setDoctorChecks(null)
      toastError(
        t('settings.ai.notionAgent.doctor.fail', { defaultValue: 'doctor 检查失败' }),
        errLabel(err)
      )
    } finally {
      setDoctorRunning(false)
    }
  }

  async function handleSetAgent(pageId: string): Promise<void> {
    const item = agentOptions.find((a) => a.agent_page_id === pageId)
    if (!item) return
    setSavingAgent(true)
    try {
      await api.notionAgent.setAgent(item.agent_page_id, item.name)
      await qc.invalidateQueries({ queryKey: ['notionAgent', 'config'] })
      toastSuccess(
        t('settings.ai.notionAgent.toast.agentSet', { defaultValue: '已切换绑定 Agent' }),
        item.name
      )
    } catch (err) {
      toastError(
        t('settings.ai.notionAgent.toast.fail', { defaultValue: '操作失败' }),
        errLabel(err)
      )
    } finally {
      setSavingAgent(false)
    }
  }

  async function handleSetModel(alias: string): Promise<void> {
    setSavingModel(true)
    try {
      await api.notionAgent.setModel(alias)
      await qc.invalidateQueries({ queryKey: ['notionAgent', 'config'] })
      toastSuccess(
        t('settings.ai.notionAgent.toast.modelSet', { defaultValue: '已设默认模型' }),
        alias
      )
    } catch (err) {
      toastError(
        t('settings.ai.notionAgent.toast.fail', { defaultValue: '操作失败' }),
        errLabel(err)
      )
    } finally {
      setSavingModel(false)
    }
  }

  const cliMissing = config !== null && !config.cliFound
  const needsAuth = config !== null && config.cliFound && !config.tokenPresent

  return (
    <Section
      title={t('settings.ai.notionAgent.title', {
        defaultValue: 'Notion Agent (notion-agent-cli)'
      })}
      helper={t('settings.ai.notionAgent.helper', {
        defaultValue:
          '读取本机 notion-agent-cli 的账号配置。Notion Agent 后端以下方绑定的 Custom Agent 人格回复；认证（token_v2）由 CLI 管理。'
      })}
    >
      {cliMissing && (
        <div className="px-4 py-3 flex items-start gap-2 text-aux text-fail">
          <AlertTriangle className="size-4 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <div>
              {t('settings.ai.notionAgent.cliMissing', {
                defaultValue: '未找到 notion-agent 命令行工具'
              })}
            </div>
            <div className="text-meta font-mono text-ink-fg-2 mt-0.5 break-all">
              {config?.cliPath}
            </div>
          </div>
        </div>
      )}

      {needsAuth && (
        <div className="px-4 py-3 flex items-start gap-2 text-aux text-urg">
          <AlertTriangle className="size-4 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <div>
              {t('settings.ai.notionAgent.needsAuth', {
                defaultValue: 'notion-agent 尚未认证（缺少 token_v2）'
              })}
            </div>
            <div className="text-meta font-mono text-ink-fg-2 mt-0.5">
              notion-agent init --token-v2 &lt;cookie&gt;
            </div>
          </div>
        </div>
      )}

      <Row
        label={t('settings.ai.notionAgent.account', { defaultValue: '账号' })}
        helper={
          config?.spaceName
            ? t('settings.ai.notionAgent.workspace', {
                defaultValue: '工作区 {space}',
                space: config.spaceName
              })
            : undefined
        }
      >
        <span className="text-aux text-ink-fg-1">{config?.userEmail ?? '—'}</span>
      </Row>

      <Row
        label={t('settings.ai.notionAgent.agent', { defaultValue: '绑定 Agent' })}
        helper={t('settings.ai.notionAgent.agentHelper', {
          defaultValue: '主 Agent（个人 persona）+ 工作区 Custom Agent，切换即写入 account.json'
        })}
        trailing={agentsQ.isLoading ? <Loader2 className="size-3.5 animate-spin" /> : undefined}
      >
        <Select
          value={config?.agentPageId ?? ''}
          onValueChange={(v) => void handleSetAgent(v)}
          disabled={!ready || savingAgent}
        >
          <SelectTrigger className="w-[220px]">
            <SelectValue
              placeholder={
                config?.agentName ??
                t('settings.ai.notionAgent.agentPlaceholder', { defaultValue: '选择 Agent' })
              }
            />
          </SelectTrigger>
          <SelectContent>
            {agentOptions.map((a) => (
              <SelectItem key={a.agent_page_id} value={a.agent_page_id}>
                {a.primary
                  ? `${a.name} · ${t('settings.ai.notionAgent.primaryTag', { defaultValue: '主 Agent' })}`
                  : a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>

      <Row
        label={t('settings.ai.notionAgent.instructionPage', { defaultValue: 'Instruction Page' })}
        helper={t('settings.ai.notionAgent.instructionPageHelper', {
          defaultValue: '当前绑定 agent 的指令页 ID（切换后自动更新）'
        })}
      >
        <span className="text-meta font-mono text-ink-fg-2 break-all max-w-[220px] text-right">
          {config?.agentPageId ?? '—'}
        </span>
      </Row>

      <Row
        label={t('settings.ai.notionAgent.model', { defaultValue: '默认模型' })}
        helper={t('settings.ai.notionAgent.modelHelper', {
          defaultValue: 'chat 未指定模型时使用'
        })}
      >
        <Select
          value={config?.defaultModel ?? ''}
          onValueChange={(v) => void handleSetModel(v)}
          disabled={!ready || savingModel}
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue
              placeholder={
                config?.defaultModel ??
                t('settings.ai.notionAgent.modelPlaceholder', { defaultValue: '选择模型' })
              }
            />
          </SelectTrigger>
          <SelectContent>
            {(modelsQ.data ?? []).map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>

      <Row
        label={t('settings.ai.notionAgent.doctor.label', { defaultValue: '连接检查' })}
        helper={t('settings.ai.notionAgent.doctor.helper', {
          defaultValue: '运行 notion-agent doctor 验证账号与 token'
        })}
      >
        <Button onClick={handleDoctor} disabled={doctorRunning} variant="secondary" size="sm">
          {doctorRunning ? (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              {t('settings.ai.notionAgent.doctor.running', { defaultValue: '检查中' })}
            </>
          ) : (
            t('settings.ai.notionAgent.doctor.button', { defaultValue: '检查' })
          )}
        </Button>
      </Row>

      {doctorChecks && doctorChecks.length > 0 && (
        <div className="px-4 py-3 space-y-1.5">
          {doctorChecks.map((c, i) => {
            const ok = c.status === 'ok'
            return (
              <div key={`${c.check}-${i}`} className="flex items-start gap-2 text-meta">
                {ok ? (
                  <Check className="size-3.5 shrink-0 mt-0.5 text-ok" />
                ) : (
                  <X className="size-3.5 shrink-0 mt-0.5 text-fail" />
                )}
                <div className="min-w-0">
                  <span className="text-ink-fg-1">{c.check}</span>
                  {c.detail ? (
                    <span className="text-ink-fg-2 font-mono ml-1.5 break-all">{c.detail}</span>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Section>
  )
}
