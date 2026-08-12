// Labs 收编纪律：只收默认 OFF 的灰度 flag；cutover 默认 ON 后从此处撤条目。
//
// 🔴 一处**有意的例外**（0812）：`MAILAGENT_MATTERS_ENABLED` 已 cutover 默认 ON，但**仍留在
// 这里** —— 它没有第二个关它的界面（IM_FEISHU 之类 cutover 后能撤，是因为设置里另有专属区）。
// 照字面执行「cutover 后撤条目」会把唯一的应急回退开关删掉。撤之前先给它一个正式落点。
// 例外的代价：它是本页唯一缺省渲染为 on 的行（见下方 `?? 'true'`）。

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'

import { useOpennessFlags } from '@shared/components/agents/hooks'
import { Button } from '@shared/components/ui/button'
import { Switch } from '@shared/components/ui/switch'
import { useMailApi } from '@shared/hooks/useMailApi'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { applyEnvPatch, useEnvStore } from '@shared/state/env'
import { toastError, toastSuccess } from '@shared/state/toast'

import { AdvancedDisclosure } from '../parts/AdvancedDisclosure'
import { PageHeader } from '../parts/PageHeader'
import { Row } from '../parts/Row'
import { Section } from '../parts/Section'

type LabFlag =
  | 'MAILAGENT_MCP_CONNECTORS'
  | 'MAILAGENT_SKILL_CATALOG_PROMPT'
  | 'MAILAGENT_MEMORY_LAYERS'
  | 'MAILAGENT_AG_UI_MIRROR'
  | 'MAILAGENT_MATTERS_ENABLED'
  | 'MAILAGENT_MATTER_AGENT_ENABLED'

interface ExperimentalFlagRowProps {
  envKey: LabFlag
  checked: boolean
  ready: boolean
  saving: boolean
  restarting: boolean
  label: React.ReactNode
  helper: React.ReactNode
  restartHint: React.ReactNode
  waitingForRestart?: boolean
  /** 依赖别的 flag 才有意义时置真（开关变灰，但 helper 仍解释原因）。 */
  dependencyUnmet?: boolean
  onToggle: (checked: boolean) => void
  onRestartBackend?: () => void
}

function ExperimentalFlagRow({
  envKey,
  checked,
  ready,
  saving,
  restarting,
  label,
  helper,
  restartHint,
  waitingForRestart = false,
  dependencyUnmet = false,
  onToggle,
  onRestartBackend
}: ExperimentalFlagRowProps): React.ReactElement {
  const { t } = useTranslation()
  const isWeb =
    (import.meta as unknown as { env?: { VITE_BUILD_TARGET?: string } }).env?.VITE_BUILD_TARGET ===
    'web'

  return (
    <Row
      label={label}
      helper={
        <span className="flex flex-col gap-0.5">
          <span>{helper}</span>
          <span className="text-ink-fg-3">{restartHint}</span>
        </span>
      }
      trailing={
        waitingForRestart ? (
          <span className="inline-flex items-center rounded-full border border-warn/30 bg-warn/10 px-1.5 py-0.5 text-micro font-mono text-warn">
            {t('settings.labs.waitingForRestart')}
          </span>
        ) : undefined
      }
    >
      <div className="flex items-center gap-2">
        {onRestartBackend ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onRestartBackend}
            disabled={!ready || isWeb || restarting || saving}
          >
            {restarting ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw aria-hidden="true" />
            )}
            {restarting ? t('settings.labs.restart.busy') : t('settings.labs.restart.backendCta')}
          </Button>
        ) : null}
        <Switch
          checked={checked}
          disabled={!ready || isWeb || saving || restarting || dependencyUnmet}
          onCheckedChange={onToggle}
          aria-label={typeof label === 'string' ? label : envKey}
        />
      </div>
    </Row>
  )
}

function isEnabled(raw: string): boolean {
  return ['1', 'true'].includes(raw.trim().toLowerCase())
}

export function LabsTab(): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const queryClient = useQueryClient()
  const envState = useEnvStore((s) => s.state)
  const runtimeFlags = useOpennessFlags(true)
  const [savingKey, setSavingKey] = React.useState<LabFlag | null>(null)
  const [restartingKey, setRestartingKey] = React.useState<LabFlag | null>(null)

  const ready = envState.status === 'ready'
  const values = ready ? envState.snapshot.values : {}
  const mcpConnectors = isEnabled(values['MAILAGENT_MCP_CONNECTORS'] ?? '')
  const skillCatalog = isEnabled(values['MAILAGENT_SKILL_CATALOG_PROMPT'] ?? '')
  const memoryLayers = isEnabled(values['MAILAGENT_MEMORY_LAYERS'] ?? '')
  const agUiMirror = isEnabled(values['MAILAGENT_AG_UI_MIRROR'] ?? '')
  // 🔴 唯一一个**默认 on** 的 Labs flag（cutover 2026-08-12：事项为核心功能）。其余五行的
  // `?? ''`（缺键 ⇒ off）在这里会撒谎：升级用户的 .env 里根本没有这个键，后端已经开着，开关却
  // 渲染成关 —— 连带把下面的跟进 Agent 行也误锁成 dependencyUnmet。缺省值必须跟着 pydantic 走。
  const matters = isEnabled(values['MAILAGENT_MATTERS_ENABLED'] ?? 'true')
  const matterAgent = isEnabled(values['MAILAGENT_MATTER_AGENT_ENABLED'] ?? '')
  const connectorRuntime = runtimeFlags.connectorToolsEnabled
  // 跟进 Agent 只在「事项」开着时有意义（后端 worker 的 schedule 段与 gateway venue 都叠这两个
  // 条件）。关掉事项时把它一并关掉并禁用开关，免得留一个开着却毫无作用的行。
  const matterAgentDisabled = !matters

  async function saveFlag(flag: LabFlag, patch: Record<string, string>): Promise<void> {
    setSavingKey(flag)
    try {
      const result = await applyEnvPatch(patch)
      if (result.ok) {
        toastSuccess(t('settings.labs.saved'))
      } else {
        toastError(t('settings.labs.saveFailed'), `${result.error.code}: ${result.error.message}`)
      }
    } finally {
      setSavingKey(null)
    }
  }

  async function restartBackend(flag: LabFlag): Promise<void> {
    setRestartingKey(flag)
    try {
      const serve = await api.services.restart('mail-sync')
      if (!serve.ok) {
        throw new Error(
          serve.error?.fallbackCommand ??
            serve.error?.message ??
            serve.stderr ??
            'serve restart failed'
        )
      }
      const serveApi = await api.services.restart('serve-api')
      if (!serveApi.ok) {
        throw new Error(
          serveApi.error?.fallbackCommand ??
            serveApi.error?.message ??
            serveApi.stderr ??
            'serve-api restart failed'
        )
      }
      toastSuccess(t('settings.labs.restart.success'))
      if (flag === 'MAILAGENT_MCP_CONNECTORS') {
        await new Promise<void>((resolve) => setTimeout(resolve, 1200))
        await queryClient.invalidateQueries({ queryKey: qk.chat.config('opennessFlags') })
      }
    } catch (err) {
      toastError(t('settings.labs.restart.failed'), errorMessage(err))
    } finally {
      setRestartingKey(null)
    }
  }

  return (
    <>
      <PageHeader
        eyebrow={t('settings.labs.page.eyebrow')}
        title={t('settings.labs.page.title')}
        description={t('settings.labs.page.intro')}
      />

      <div
        role="status"
        className="mb-[var(--settings-block-gap,1.75rem)] flex items-start gap-2.5 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2.5"
      >
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
        <p className="text-aux leading-relaxed text-ink-fg-1">{t('settings.labs.warning')}</p>
      </div>

      <Section title={t('settings.labs.mcpConnectors.label')}>
        <ExperimentalFlagRow
          envKey="MAILAGENT_MCP_CONNECTORS"
          checked={mcpConnectors}
          ready={ready}
          saving={savingKey === 'MAILAGENT_MCP_CONNECTORS'}
          restarting={restartingKey === 'MAILAGENT_MCP_CONNECTORS'}
          label="MAILAGENT_MCP_CONNECTORS"
          helper={t('settings.labs.mcpConnectors.helper')}
          restartHint={t('settings.labs.mcpConnectors.restartHint')}
          waitingForRestart={
            typeof connectorRuntime === 'boolean' && connectorRuntime !== mcpConnectors
          }
          onToggle={(checked) =>
            void saveFlag('MAILAGENT_MCP_CONNECTORS', {
              MAILAGENT_MCP_CONNECTORS: checked ? 'true' : 'false'
            })
          }
          onRestartBackend={() => void restartBackend('MAILAGENT_MCP_CONNECTORS')}
        />
      </Section>

      <Section title={t('settings.labs.skillCatalogPrompt.label')}>
        <ExperimentalFlagRow
          envKey="MAILAGENT_SKILL_CATALOG_PROMPT"
          checked={skillCatalog}
          ready={ready}
          saving={savingKey === 'MAILAGENT_SKILL_CATALOG_PROMPT'}
          restarting={false}
          label="MAILAGENT_SKILL_CATALOG_PROMPT"
          helper={t('settings.labs.skillCatalogPrompt.helper')}
          restartHint={t('settings.labs.skillCatalogPrompt.restartHint')}
          onToggle={(checked) =>
            void saveFlag('MAILAGENT_SKILL_CATALOG_PROMPT', {
              MAILAGENT_SKILL_CATALOG_PROMPT: checked ? 'true' : 'false'
            })
          }
        />
      </Section>

      <Section title={t('settings.labs.memoryLayers.label')}>
        <ExperimentalFlagRow
          envKey="MAILAGENT_MEMORY_LAYERS"
          checked={memoryLayers}
          ready={ready}
          saving={savingKey === 'MAILAGENT_MEMORY_LAYERS'}
          restarting={restartingKey === 'MAILAGENT_MEMORY_LAYERS'}
          label="MAILAGENT_MEMORY_LAYERS"
          helper={t('settings.labs.memoryLayers.helper')}
          restartHint={t('settings.labs.memoryLayers.restartHint')}
          onToggle={(checked) =>
            void saveFlag('MAILAGENT_MEMORY_LAYERS', {
              MAILAGENT_MEMORY_LAYERS: checked ? 'true' : 'false'
            })
          }
          onRestartBackend={() => void restartBackend('MAILAGENT_MEMORY_LAYERS')}
        />
      </Section>

      <Section title={t('settings.labs.matters.label')}>
        <ExperimentalFlagRow
          envKey="MAILAGENT_MATTERS_ENABLED"
          checked={matters}
          ready={ready}
          saving={savingKey === 'MAILAGENT_MATTERS_ENABLED'}
          restarting={restartingKey === 'MAILAGENT_MATTERS_ENABLED'}
          label="MAILAGENT_MATTERS_ENABLED"
          helper={t('settings.labs.matters.helper')}
          restartHint={t('settings.labs.matters.restartHint')}
          onToggle={(checked) =>
            void saveFlag(
              'MAILAGENT_MATTERS_ENABLED',
              // 关掉「事项」时把跟进 Agent 一并关掉——留一个开着却毫无作用的键只会误导下次阅读。
              checked
                ? { MAILAGENT_MATTERS_ENABLED: 'true' }
                : { MAILAGENT_MATTERS_ENABLED: 'false', MAILAGENT_MATTER_AGENT_ENABLED: 'false' }
            )
          }
          onRestartBackend={() => void restartBackend('MAILAGENT_MATTERS_ENABLED')}
        />
        <ExperimentalFlagRow
          envKey="MAILAGENT_MATTER_AGENT_ENABLED"
          checked={matterAgent}
          ready={ready}
          saving={savingKey === 'MAILAGENT_MATTER_AGENT_ENABLED'}
          restarting={restartingKey === 'MAILAGENT_MATTER_AGENT_ENABLED'}
          label="MAILAGENT_MATTER_AGENT_ENABLED"
          helper={t('settings.labs.matterAgent.helper')}
          restartHint={t('settings.labs.matterAgent.restartHint')}
          dependencyUnmet={matterAgentDisabled}
          onToggle={(checked) =>
            void saveFlag('MAILAGENT_MATTER_AGENT_ENABLED', {
              MAILAGENT_MATTER_AGENT_ENABLED: checked ? 'true' : 'false'
            })
          }
          onRestartBackend={() => void restartBackend('MAILAGENT_MATTER_AGENT_ENABLED')}
        />
      </Section>

      <Section title={t('settings.labs.agUiMirror.label')}>
        <AdvancedDisclosure
          label={t('settings.labs.advanced.label')}
          helper={t('settings.labs.advanced.helper')}
          className="rounded-none border-0"
        >
          <ExperimentalFlagRow
            envKey="MAILAGENT_AG_UI_MIRROR"
            checked={agUiMirror}
            ready={ready}
            saving={savingKey === 'MAILAGENT_AG_UI_MIRROR'}
            restarting={false}
            label="MAILAGENT_AG_UI_MIRROR"
            helper={t('settings.labs.agUiMirror.helper')}
            restartHint={t('settings.labs.agUiMirror.restartHint')}
            onToggle={(checked) =>
              void saveFlag('MAILAGENT_AG_UI_MIRROR', {
                MAILAGENT_AG_UI_MIRROR: checked ? 'true' : 'false'
              })
            }
          />
        </AdvancedDisclosure>
      </Section>
    </>
  )
}
