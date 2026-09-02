// Labs 收编纪律：只收默认 OFF 的灰度 flag **或** owner_settings 型实验开关；cutover 恒启用后
// 从此处撤条目。
//
// 两种形态、两条写路径，UI 上刻意长得不一样：
//   • env 型（`MAILAGENT_*`）—— ExperimentalFlagRow：写 .env，多数要重启后端 / 重开 App 才生效，
//     所以带 restartHint 与「重启后端」按钮，且 web 构建下不可写（没有本机 .env）。
//   • owner_settings 型 —— OwnerSettingRow：写 agent_config.db 的一行 owner setting，热读生效，
//     **没有重启提示**，桌面与远程 web 共享同一个值（照 chat_approval_mode 的先例）。
//     新实验一律走这条（红线 6：不新增 MAILAGENT_* 变量）。

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'

import { useOpennessFlags } from '@shared/components/agents/hooks'
import { navigateToGroupSession } from '@shared/components/agents/groups/navigation'
import { Button } from '@shared/components/ui/button'
import { Switch } from '@shared/components/ui/switch'
import {
  createWerewolfGame,
  setLabs,
  type LabsFlagValue,
  type WerewolfGameInput
} from '@shared/api/groupSettings'
import { useLabsFlags } from '@shared/hooks/useLabsFlags'
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

/** owner_settings 型实验行：热读生效 → 无 restartHint、无「重启后端」按钮；写走 serve-api
 *  （不是 .env），所以远程 web 上同样可写，不带 ExperimentalFlagRow 的 isWeb 禁用。 */
function OwnerSettingRow({
  label,
  helper,
  checked,
  busy,
  onToggle
}: {
  label: string
  helper: React.ReactNode
  checked: boolean
  busy: boolean
  onToggle: (checked: boolean) => void
}): React.ReactElement {
  return (
    <Row label={label} helper={helper}>
      <Switch checked={checked} disabled={busy} onCheckedChange={onToggle} aria-label={label} />
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
  const labs = useLabsFlags()
  const navigate = useNavigate()
  // 一键建局：三群 + 七个 agent 行都在服务端一次建完，成功后直接落到主群。
  // 🔴 应答里的 roles / players 是身份事实，只留在应答里 —— 不进 toast、不进日志。
  const newGame = useMutation({
    mutationFn: (input: WerewolfGameInput) => createWerewolfGame(input),
    onSuccess: (payload) => {
      if (!payload.configApplied) {
        // 群建出来了但设置没写全：跳过去只会看到一个没有法官位的群，说清楚再让 owner 决定。
        toastError(t('settings.labs.werewolf.partial'))
        return
      }
      toastSuccess(t('settings.labs.werewolf.created', { title: payload.title }))
      navigateToGroupSession(navigate, payload.mainSessionId)
    },
    onError: (err) => toastError(t('settings.labs.werewolf.failed'), errorMessage(err))
  })
  const saveLabs = useMutation({
    mutationFn: (next: LabsFlagValue) => setLabs({ groupAgents: next }),
    // 服务端回的是**落库后的**值（pessimistic）：直接写进缓存，群聊视图的下一次渲染就是新模态。
    onSuccess: (flags) => {
      queryClient.setQueryData(qk.labsFlags(), flags)
      toastSuccess(t('settings.labs.saved'))
    },
    onError: (err) => toastError(t('settings.labs.saveFailed'), errorMessage(err))
  })

  const ready = envState.status === 'ready'
  const values = ready ? envState.snapshot.values : {}
  const mcpConnectors = isEnabled(values['MAILAGENT_MCP_CONNECTORS'] ?? '')
  const skillCatalog = isEnabled(values['MAILAGENT_SKILL_CATALOG_PROMPT'] ?? '')
  const memoryLayers = isEnabled(values['MAILAGENT_MEMORY_LAYERS'] ?? '')
  const agUiMirror = isEnabled(values['MAILAGENT_AG_UI_MIRROR'] ?? '')
  const connectorRuntime = runtimeFlags.connectorToolsEnabled

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

      <Section title={t('settings.labs.groupAgents.label')}>
        <OwnerSettingRow
          label={t('settings.labs.groupAgents.label')}
          helper={t('settings.labs.groupAgents.helper')}
          checked={labs.groupAgents}
          busy={labs.loading || saveLabs.isPending}
          onToggle={(checked) => saveLabs.mutate(checked ? 'on' : 'off')}
        />
        {/* 狼人杀是这套群聊机制的集成验收，不是产品功能：开关关着时连入口都不该在。 */}
        {labs.groupAgents === true && (
          <Row
            label={t('settings.labs.werewolf.label')}
            helper={t('settings.labs.werewolf.helper')}
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={newGame.isPending}
              onClick={() => newGame.mutate({})}
            >
              {newGame.isPending
                ? t('settings.labs.werewolf.creating')
                : t('settings.labs.werewolf.cta')}
            </Button>
          </Row>
        )}
      </Section>

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
