// AI Agent tab. Split into three Sections so the visual grouping mirrors
// the actual feature boundaries:
//   1. 本地 LLM Agent     — gateway + main model + cache (Python-side LLM agent)
//   2. Prompt 配置         — paths + edit-in-place for the inbox / sent
//                            markdown prompts the Python agent loads
//   3. 翻译                 — Electron-main translation flow (independent
//                            gateway/key/model + bilingual toggle)
//
// LLM_API_KEY 走 <EnvSecretField> 双写 (keytar + .env): main 进程的
// translate + Custom-API chat backend 从 keytar 读, Python LLM agent 从
// .env 读. 其他 secret (NOTION_TOKEN / FEISHU_APP_SECRET) 只 Python 用,
// EnvField password 单写 .env 即可.

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, RefreshCw, ChevronDown } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'

import { useMailApi } from '@shared/hooks/useMailApi'
import { useUpstreamModels, useEnabledModels, FALLBACK_MODELS } from '@shared/hooks/useLlmModels'
import { useProviderRegistryEnabled } from '@shared/hooks/useLlmProviders'
import { applyEnvPatch, useEnvStore } from '@shared/state/env'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { Button } from '@shared/components/ui/button'
import { Checkbox } from '@shared/components/ui/checkbox'
import { Loader } from '@shared/components/ui/loader'
import { Popover, PopoverTrigger, PopoverContent } from '@shared/components/ui/popover'
import { Switch } from '@shared/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shared/components/ui/select'
import { toastError, toastSuccess } from '@shared/state/toast'
import {
  readAutoTitleSettings,
  writeAutoTitleMode,
  writeAutoTitleModel,
  type AutoTitleMode
} from '@shared/lib/autoTitle'
import { readApprovalMode, writeApprovalMode, type ApprovalMode } from '@shared/lib/approvalMode'
import { useGlobalApprovalMode } from '@shared/lib/globalApprovalMode'

import { SectionAnchorNav } from '@shared/components/ui/section-anchor-nav'

import { PageHeader } from '../parts/PageHeader'
import { Section } from '../parts/Section'
import { Row } from '../parts/Row'
import { EnvField } from '../parts/EnvField'
import { EnvSecretField } from '../parts/EnvSecretField'
import { ModelServicesSection } from '../providers/ModelServicesSection'
import { buildModelOptionGroups } from '../providers/modelOptionGroups'
import { CustomAiSection } from '../CustomAiSection'
import { ToolApprovalSection } from '../custom-ai/ToolApprovalSection'
import { AI_TAB_ANCHOR_IDS, AI_TAB_ANCHOR_SCROLL_MT, useAiTabAnchorItems } from '../aiTabAnchors'
import { useSettingsScrollRef } from '../settingsScrollContext'

export function AiTab(): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const qc = useQueryClient()
  const [testing, setTesting] = React.useState(false)

  // 08-01 PR4 — 右侧区块锚点导航。items 是静态候选（受 flag 门控的区块照常列，
  // SectionAnchorNav 运行时按「目标存在且有高度」过滤）；滚动容器是 SettingsShell 的
  // 内容 <section>，经 context 拿到。
  const anchorItems = useAiTabAnchorItems()
  const settingsScrollRef = useSettingsScrollRef()

  // Phase 10b — configurable LLM auto-title (renderer-local localStorage; default off = first-message
  // preview). Seeded once from storage; each change writes through immediately (the agent view reads
  // the same keys at turn-complete). Only the desktop ai-sdk gateway path acts on it.
  const [autoTitleMode, setAutoTitleMode] = React.useState<AutoTitleMode>(
    () => readAutoTitleSettings().mode
  )
  const [autoTitleModel, setAutoTitleModel] = React.useState<string>(
    () => readAutoTitleSettings().model
  )

  // PART 2 — auto-approval mode (renderer-local localStorage; default 'always' = every write asks).
  // 'auto-reversible' lets reversible preview-tier writes (flag/archive/pin/resync/memory) run without
  // a confirmation card; edit-tier (draft reply) + the irreversible send ALWAYS ask. Only the desktop
  // ai-sdk gateway path acts on it (rides the chat body).
  const [approvalMode, setApprovalMode] = React.useState<ApprovalMode>(() => readApprovalMode())
  // 07-16 — owner-global 授权模式（backend 持久化）：非 Manual 时上面的旧 Switch 被接管（置灰）。
  const { mode: globalApprovalMode } = useGlobalApprovalMode()

  // dynamic-models (main provider — for enabled list / model popover)
  const {
    models: upstreamModels,
    isLoading: upstreamLoading,
    refresh: refreshUpstream
  } = useUpstreamModels('main')
  const { models: enabledModels, rawEnabled } = useEnabledModels()
  const [refreshing, setRefreshing] = React.useState(false)

  // dynamic-models (translate provider — for LLM_TRANSLATE_MODEL select)
  const {
    models: translateModels,
    isLoading: translateModelsLoading,
    refresh: refreshTranslateUpstream
  } = useUpstreamModels('translate')
  const [translateRefreshing, setTranslateRefreshing] = React.useState(false)

  // Current .env values for orphan detection on model selects.
  const currentLlmModel = useEnvStore((s) =>
    s.state.status === 'ready' ? (s.state.snapshot.values['LLM_MODEL'] ?? '') : ''
  )
  const currentLlmFallback = useEnvStore((s) =>
    s.state.status === 'ready' ? (s.state.snapshot.values['LLM_FALLBACK_MODELS'] ?? '') : ''
  )
  const currentTranslateModel = useEnvStore((s) =>
    s.state.status === 'ready' ? (s.state.snapshot.values['LLM_TRANSLATE_MODEL'] ?? '') : ''
  )

  // Remote web is read-only for env writes (matches EnvField.isWeb logic).
  const isWeb =
    (import.meta as unknown as { env?: { VITE_BUILD_TARGET?: string } }).env?.VITE_BUILD_TARGET ===
    'web'

  // task 07-12 P3 — provider registry 门控（/chat/config.providerRegistryEnabled，与后端
  // enabledModels 聚合投影同源）。off（默认/加载中/不可达）→ 下方旧「LLM 网关」区字节级
  // 不变；on → LLM_API_BASE/KEY + 启用模型勾选区被「模型服务」section 取代，模型下拉
  // 选项按 provider 分组（值仍写原 env 键——providerRef 向后兼容由 P1/P2 消化）。
  const providerRegistryEnabled = useProviderRegistryEnabled()

  // flag on 时三个功能位下拉的分组选项（flag off 恒 undefined → EnvField 走旧扁平渲染）。
  const notEnabledSuffix = t('settings.ai.enabledModels.notEnabled')
  const llmModelGroups = React.useMemo(() => {
    if (!providerRegistryEnabled) return undefined
    const base = enabledModels.length > 0 ? enabledModels : FALLBACK_MODELS
    const withOrphan =
      currentLlmModel && !base.includes(currentLlmModel) ? [...base, currentLlmModel] : base
    return buildModelOptionGroups(withOrphan, t, (id, display) =>
      id === currentLlmModel && !base.includes(id) ? `${display} ${notEnabledSuffix}` : display
    )
  }, [providerRegistryEnabled, enabledModels, currentLlmModel, t, notEnabledSuffix])
  const llmFallbackGroups = React.useMemo(() => {
    if (!providerRegistryEnabled) return undefined
    const base = enabledModels.length > 0 ? enabledModels : FALLBACK_MODELS
    const withOrphan =
      currentLlmFallback && !base.includes(currentLlmFallback)
        ? [...base, currentLlmFallback]
        : base
    return buildModelOptionGroups(withOrphan, t, (id, display) =>
      id === currentLlmFallback && !base.includes(id) ? `${display} ${notEnabledSuffix}` : display
    )
  }, [providerRegistryEnabled, enabledModels, currentLlmFallback, t, notEnabledSuffix])
  // 翻译模型：flag on 选项源从 translate 上游列表升级为聚合 enabledModels（跨 provider）。
  const translateModelGroups = React.useMemo(() => {
    if (!providerRegistryEnabled) return undefined
    const base = enabledModels.length > 0 ? enabledModels : FALLBACK_MODELS
    const withOrphan =
      currentTranslateModel && !base.includes(currentTranslateModel)
        ? [...base, currentTranslateModel]
        : base
    const notInList = t('settings.ai.translateModel.notInList', { defaultValue: '（不在列表）' })
    return buildModelOptionGroups(withOrphan, t, (id, display) =>
      id === currentTranslateModel && !base.includes(id) ? `${display} ${notInList}` : display
    )
  }, [providerRegistryEnabled, enabledModels, currentTranslateModel, t])

  async function handleRefreshUpstream(): Promise<void> {
    setRefreshing(true)
    try {
      await refreshUpstream()
    } finally {
      setRefreshing(false)
    }
  }

  async function handleRefreshTranslate(): Promise<void> {
    setTranslateRefreshing(true)
    try {
      await refreshTranslateUpstream()
    } finally {
      setTranslateRefreshing(false)
    }
  }

  async function handleToggleModel(modelId: string, checked: boolean): Promise<void> {
    const next = checked
      ? [...rawEnabled.filter((m) => m !== modelId), modelId]
      : rawEnabled.filter((m) => m !== modelId)
    const result = await applyEnvPatch({ LLM_ENABLED_MODELS: next.join(',') })
    if (result.ok) {
      // LLM_ENABLED_MODELS is hot-read by serve-api dotenv_values — no restart needed.
      // Invalidate so chat picker and AgentsTab ConfigDrawer immediately reflect the change.
      // No success toast: checkbox state is immediate visual feedback; toasting every
      // checkbox click causes toast storms when enabling multiple models in a row.
      await qc.invalidateQueries({ queryKey: qk.chat.config('enabledModels') })
    } else {
      toastError(
        t('settings.ai.enabledModels.saveFailed', { defaultValue: '保存失败' }),
        result.error?.message ?? ''
      )
    }
  }
  // task 07-21 —— 收/发分类 prompt 的路径展示 + 编辑入口已从设置-AI 移除；唯一编辑入口
  // 收敛到 Custom AI「AI 邮件预处理」抽屉（PreprocessConfigDrawer 内联 textarea，走
  // 同一 mailApi.prompts 读写）。context page ID 亦随之搬进该抽屉。
  async function handleTestGateway(): Promise<void> {
    setTesting(true)
    try {
      const r = await api.settings.testLlm()
      if (r.ok) {
        toastSuccess(t('settings.ai.testGateway.ok'), r.detail)
      } else {
        toastError(t('settings.ai.testGateway.fail'), `${r.code ?? ''} ${r.detail ?? ''}`.trim())
      }
    } catch (err) {
      toastError(t('settings.ai.testGateway.fail'), errorMessage(err))
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="relative">
      {/* 锚点导航挂在 760px 内容列**外侧右方**（absolute left-full），不挤压正文。
          断点 min-[1500px]：内容列右侧的空余 = (视口 - 侧边栏240 - 设置 rail 200 - 760)/2，
          1500px 起才够放下 ml-4 + w-148（含列内 px-10 的 40px 让位），再窄整块隐藏 ——
          宁可没有导航，也不让它溢出到 section 的横向滚动条里。
          pointer-events 只在 nav 本体打开：外层撑满高度的空壳不该吃掉正文右侧的点击。 */}
      <div className="pointer-events-none absolute left-full top-0 ml-4 hidden h-full w-[148px] min-[1500px]:block">
        <div className="pointer-events-auto sticky top-6">
          <SectionAnchorNav
            items={anchorItems}
            scrollContainerRef={settingsScrollRef}
            ariaLabel={t('settings.anchorNav.ariaLabel')}
          />
        </div>
      </div>

      <PageHeader
        eyebrow={t('settings.ai.page.eyebrow', { defaultValue: 'AI AGENT' })}
        title={t('settings.ai.page.title', { defaultValue: 'AI Agent' })}
        description={t('settings.ai.page.intro', {
          defaultValue: '本地 LLM 网关、模型路由、prompt 配置与邮件翻译。'
        })}
      />

      {/* task 07-12 P3 — provider registry on 时「模型服务」区取代下方 LLM_API_BASE/KEY +
          启用模型勾选（prd §4.5.6）；off（默认）字节级现状。
          外裹 id wrapper 供锚点导航跳转：flag off 时 wrapper 空高 0 → 导航自动过滤掉这条。 */}
      <div id={AI_TAB_ANCHOR_IDS.modelServices} className={AI_TAB_ANCHOR_SCROLL_MT}>
        {providerRegistryEnabled && <ModelServicesSection />}
      </div>

      {/* LLM_AGENT_ENABLED 已收敛到 Agents 页预处理 Agent 配置抽屉（不再两处）。LLM_MODEL /
          LLM_FALLBACK_MODELS 保留在此作全局语义——chat gateway 默认模型 + 后台 AI 任务兜底/
          兜底链（R2 #2：预处理的模型与 fallback 均已拆到行级列，默认跟随这里的全局值）。
          其余为网关基建（API base/key、启用模型列表、test gateway），translate 等沿用不变。 */}
      <div id={AI_TAB_ANCHOR_IDS.gateway} className={AI_TAB_ANCHOR_SCROLL_MT}>
        <Section title={t('settings.ai.title')} helper={t('settings.ai.helper')}>
          {!providerRegistryEnabled && (
            <EnvField
              envKey="LLM_API_BASE"
              control="text"
              label={t('settings.ai.apiBase.label')}
              helper={t('settings.ai.apiBase.helper')}
              placeholder="https://crs.chenge.ink/api"
            />
          )}
          {!providerRegistryEnabled && (
            <EnvSecretField
              envKey="LLM_API_KEY"
              keytarSlot="llmApiKey"
              label={t('settings.ai.apiKey.label')}
              helper={t('settings.ai.apiKey.helper')}
            />
          )}
          {/* 启用模型列表 — LLM_ENABLED_MODELS (comma-separated). Serve-api hot-reads
            this key via dotenv_values; no restart needed after changes. This is an
            intentional departure from other EnvField rows that call markRestartRequired
            on write — see comment in handleToggleModel above.
            UI = popover multi-select: trigger shows a summary badge, content has a
            refresh button + scrollable checkbox list. Width matches SelectTrigger (w-[200px]).
            registry on 时该区被「模型服务」per-provider 启用勾选取代（P3）。 */}
          {!providerRegistryEnabled && (
            <Row
              label={t('settings.ai.enabledModels.label', { defaultValue: '启用模型列表' })}
              helper={t('settings.ai.enabledModels.helper', {
                defaultValue:
                  '勾选后三处模型选项（chat picker / 报告 agent / 主备模型下拉）同步显示已启用集合；未勾选时自动 fallback 到默认四模型。'
              })}
            >
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    disabled={isWeb}
                    className={[
                      'flex h-8 w-[200px] items-center justify-between gap-2 rounded-md border border-ink-border bg-ink-2 px-3',
                      'text-aux text-ink-fg',
                      'transition-colors duration-fast ease-standard',
                      'focus:outline-none focus:ring-2 focus:ring-coral/70 focus:border-coral/60',
                      'disabled:cursor-not-allowed disabled:opacity-50'
                    ].join(' ')}
                  >
                    <span className="line-clamp-1">
                      {upstreamLoading ? (
                        <span className="flex items-center gap-1">
                          <Loader size={12} label={t('settings.ai.enabledModels.loading')} />
                          {t('settings.ai.enabledModels.loading', { defaultValue: '加载中…' })}
                        </span>
                      ) : rawEnabled.length === 0 ? (
                        t('settings.ai.enabledModels.allDefault', { defaultValue: '全部默认' })
                      ) : (
                        t('settings.ai.enabledModels.countEnabled', {
                          count: rawEnabled.length,
                          defaultValue: '已启用 {count} 个模型'
                        })
                      )}
                    </span>
                    <ChevronDown className="size-4 opacity-60 shrink-0" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-[280px] p-2">
                  {/* Refresh row */}
                  <div className="flex items-center justify-between mb-2 pb-2 border-b border-ink-border-soft">
                    <span className="text-meta text-ink-fg-2 uppercase tracking-wider font-mono">
                      {t('settings.ai.enabledModels.label', { defaultValue: '启用模型列表' })}
                    </span>
                    <button
                      onClick={() => void handleRefreshUpstream()}
                      disabled={refreshing || upstreamLoading || isWeb}
                      className="flex items-center gap-1 text-xs text-ink-fg-2 hover:text-ink-fg disabled:opacity-40 transition-colors"
                    >
                      {refreshing || upstreamLoading ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <RefreshCw className="size-3" />
                      )}
                      {refreshing
                        ? t('settings.ai.enabledModels.refreshing', { defaultValue: '刷新中…' })
                        : t('settings.ai.enabledModels.refresh', { defaultValue: '刷新模型列表' })}
                    </button>
                  </div>
                  {/* Model list */}
                  <div className="max-h-[240px] overflow-y-auto flex flex-col gap-0.5">
                    {upstreamModels.length === 0 ? (
                      <span className="px-1 py-2 text-xs text-ink-fg-3">
                        {t('settings.ai.enabledModels.noModels', {
                          defaultValue: '未拉取到模型列表，请检查 API Base / Key 后刷新。'
                        })}
                      </span>
                    ) : (
                      upstreamModels.map((id) => (
                        <label
                          key={id}
                          className={[
                            'flex items-center gap-2 px-1 py-1 rounded-sm text-aux text-ink-fg',
                            'hover:bg-ink-3 cursor-pointer select-none',
                            isWeb ? 'opacity-50 pointer-events-none' : ''
                          ]
                            .join(' ')
                            .trim()}
                        >
                          <Checkbox
                            disabled={isWeb}
                            checked={rawEnabled.includes(id)}
                            onCheckedChange={(checked) => void handleToggleModel(id, checked)}
                          />
                          <span className="font-mono text-[12px] truncate">{id}</span>
                        </label>
                      ))
                    )}
                  </div>
                </PopoverContent>
              </Popover>
            </Row>
          )}
          {/* LLM_MODEL: 全局默认模型（chat gateway 默认 + 后台任务兜底）。single-select from
            enabled list (+ current value if orphan) —— 保存值不在启用列表时追加显示，避免下拉空白。
            registry on → optionGroups 分组（值仍写 LLM_MODEL env 键）。 */}
          <EnvField
            envKey="LLM_MODEL"
            control="select"
            label={t('settings.ai.model.label')}
            helper={t('settings.ai.model.helper')}
            options={
              providerRegistryEnabled
                ? undefined
                : (() => {
                    const base = enabledModels.length > 0 ? enabledModels : FALLBACK_MODELS
                    const withOrphan =
                      currentLlmModel && !base.includes(currentLlmModel)
                        ? [...base, currentLlmModel]
                        : base
                    return withOrphan.map((id) => ({
                      value: id,
                      label:
                        id === currentLlmModel && !base.includes(id)
                          ? `${id} ${t('settings.ai.enabledModels.notEnabled')}`
                          : id
                    }))
                  })()
            }
            optionGroups={llmModelGroups}
          />
          {/* LLM_FALLBACK_MODELS: single-select (user decided no multi-select ranking).
            Python reads it as comma-separated fallback chain; single value works fine.
            Same orphan handling: if the saved value is not in the enabled list, append it.
            全局兜底链——邮件预处理可在其 Agent 卡单独设置行级 fallback（默认跟随这里）。
            registry on →「不设」空值哨兵留在未分组区、模型按 provider 分组。 */}
          <EnvField
            envKey="LLM_FALLBACK_MODELS"
            control="select"
            label={t('settings.ai.fallbacks.label')}
            helper={t('settings.ai.fallbacks.helper')}
            options={
              providerRegistryEnabled
                ? [
                    {
                      value: '',
                      label: t('settings.ai.fallbacks.none', { defaultValue: '（不设备模型）' })
                    }
                  ]
                : (() => {
                    const base = enabledModels.length > 0 ? enabledModels : FALLBACK_MODELS
                    const withOrphan =
                      currentLlmFallback && !base.includes(currentLlmFallback)
                        ? [...base, currentLlmFallback]
                        : base
                    return [
                      {
                        value: '',
                        label: t('settings.ai.fallbacks.none', { defaultValue: '（不设备模型）' })
                      },
                      ...withOrphan.map((id) => ({
                        value: id,
                        label:
                          id === currentLlmFallback && !base.includes(id)
                            ? `${id} ${t('settings.ai.enabledModels.notEnabled')}`
                            : id
                      }))
                    ]
                  })()
            }
            optionGroups={llmFallbackGroups}
          />
          <Row
            label={t('settings.ai.testGateway.label')}
            helper={t('settings.ai.testGateway.helper')}
          >
            <Button onClick={handleTestGateway} disabled={testing} variant="secondary" size="sm">
              {testing ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  {t('settings.ai.testGateway.running')}
                </>
              ) : (
                t('settings.ai.testGateway.button')
              )}
            </Button>
          </Row>
        </Section>
      </div>

      {/* task 07-21 — Notion Agent 配置已从此处摘除，归位到 设置 → Custom AI → Skills 的
          notion_agent skill 条目展开区（NotionAgentSkillConfig）。 */}

      <div id={AI_TAB_ANCHOR_IDS.translate} className={AI_TAB_ANCHOR_SCROLL_MT}>
        <Section
          title={t('settings.ai.translate.title')}
          helper={t('settings.ai.translate.helper')}
        >
          <EnvField
            envKey="LLM_TRANSLATE_BASE_URL"
            control="text"
            label={t('settings.ai.translateBaseUrl.label')}
            helper={t('settings.ai.translateBaseUrl.helper')}
            placeholder={t('settings.ai.translateBaseUrl.placeholder', {
              defaultValue: '留空 = 跟随主网关'
            })}
          />
          <EnvSecretField
            envKey="LLM_TRANSLATE_API_KEY"
            keytarSlot="llmTranslateApiKey"
            label={t('settings.ai.translateApiKey.label')}
            helper={t('settings.ai.translateApiKey.helper')}
          />
          {/* LLM_TRANSLATE_MODEL: single-select from translate provider's upstream list.
            Falls back to showing the current value if not in the list (orphan).
            Refresh button pulls fresh list from the translate provider endpoint.
            registry on → 选项源升级为聚合 enabledModels 分组（P3 §4.5.4），translate
            上游拉取列表不再喂本下拉 → 刷新行一并隐藏（避免误导性的死按钮）。 */}
          <EnvField
            envKey="LLM_TRANSLATE_MODEL"
            control="select"
            label={t('settings.ai.translateModel.label')}
            helper={t('settings.ai.translateModel.helper')}
            options={
              providerRegistryEnabled
                ? undefined
                : (() => {
                    const base = translateModels.length > 0 ? translateModels : []
                    const withOrphan =
                      currentTranslateModel && !base.includes(currentTranslateModel)
                        ? [...base, currentTranslateModel]
                        : base.length > 0
                          ? base
                          : currentTranslateModel
                            ? [currentTranslateModel]
                            : ['claude-haiku-4-5']
                    return withOrphan.map((id) => ({
                      value: id,
                      label:
                        id === currentTranslateModel && base.length > 0 && !base.includes(id)
                          ? `${id} ${t('settings.ai.translateModel.notInList', { defaultValue: '（不在列表）' })}`
                          : id
                    }))
                  })()
            }
            optionGroups={translateModelGroups}
            placeholder="claude-haiku-4-5"
          />
          {!providerRegistryEnabled && (
            <Row
              label=""
              helper={t('settings.ai.translateModel.refreshHelper', {
                defaultValue: '从翻译 provider 拉取最新模型列表'
              })}
            >
              <button
                onClick={() => void handleRefreshTranslate()}
                disabled={translateRefreshing || translateModelsLoading || isWeb}
                className="flex items-center gap-1.5 text-xs text-ink-fg-2 hover:text-ink-fg disabled:opacity-40 transition-colors"
              >
                {translateRefreshing || translateModelsLoading ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <RefreshCw className="size-3" />
                )}
                {translateRefreshing
                  ? t('settings.ai.translateModel.refreshing', { defaultValue: '刷新中…' })
                  : t('settings.ai.translateModel.refresh', { defaultValue: '刷新模型列表' })}
              </button>
            </Row>
          )}
        </Section>
      </div>

      <div id={AI_TAB_ANCHOR_IDS.cache} className={AI_TAB_ANCHOR_SCROLL_MT}>
        <Section title={t('settings.ai.cache.title')} helper={t('settings.ai.cache.helper')}>
          <EnvField
            envKey="LLM_CACHE_ENABLED"
            control="toggle"
            label={t('settings.ai.cache.enabled.label')}
            helper={t('settings.ai.cache.enabled.helper')}
          />
          <EnvField
            envKey="LLM_CACHE_TTL"
            control="select"
            label={t('settings.ai.cache.ttl.label')}
            helper={t('settings.ai.cache.ttl.helper')}
            options={[
              { value: '5m', label: t('settings.ai.cache.ttl.5m') },
              { value: '1h', label: t('settings.ai.cache.ttl.1h') }
            ]}
          />
        </Section>
      </div>

      <div id={AI_TAB_ANCHOR_IDS.autoTitle} className={AI_TAB_ANCHOR_SCROLL_MT}>
        <Section
          title={t('settings.ai.autoTitle.title', { defaultValue: '会话自动标题' })}
          helper={t('settings.ai.autoTitle.helper', {
            defaultValue: '为通用 Agent 会话自动生成标题；关闭时用首条消息摘要作标题。'
          })}
        >
          <Row
            label={t('settings.ai.autoTitle.enabledLabel', { defaultValue: 'AI 自动标题' })}
            helper={t('settings.ai.autoTitle.enabledHelper', {
              defaultValue: '开启后首轮对话结束，用所选模型生成标题并写入；手动改名始终优先保留。'
            })}
          >
            <Switch
              checked={autoTitleMode === 'llm'}
              onCheckedChange={(checked) => {
                const next: AutoTitleMode = checked ? 'llm' : 'off'
                setAutoTitleMode(next)
                writeAutoTitleMode(next)
              }}
            />
          </Row>
          {autoTitleMode === 'llm' && (
            <Row
              label={t('settings.ai.autoTitle.modelLabel', { defaultValue: '标题模型' })}
              helper={t('settings.ai.autoTitle.modelHelper', {
                defaultValue: '生成标题用的模型，建议用快速便宜的小模型（如 haiku）。'
              })}
            >
              <Select
                value={autoTitleModel}
                onValueChange={(v) => {
                  setAutoTitleModel(v)
                  writeAutoTitleModel(v)
                }}
              >
                <SelectTrigger className="w-[200px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(() => {
                    const base = enabledModels.length > 0 ? enabledModels : FALLBACK_MODELS
                    const withOrphan = base.includes(autoTitleModel)
                      ? base
                      : [...base, autoTitleModel]
                    return withOrphan.map((id) => (
                      <SelectItem key={id} value={id}>
                        {id}
                      </SelectItem>
                    ))
                  })()}
                </SelectContent>
              </Select>
            </Row>
          )}
        </Section>
      </div>

      <div id={AI_TAB_ANCHOR_IDS.approval} className={AI_TAB_ANCHOR_SCROLL_MT}>
        <Section
          title={t('settings.ai.approval.title', { defaultValue: 'Agent 操作审批' })}
          helper={t('settings.ai.approval.helper', {
            defaultValue: 'Agent 执行写操作前是否需要逐个确认。发送邮件等不可逆操作始终需要确认。'
          })}
        >
          <Row
            label={t('settings.ai.approval.autoReversibleLabel', {
              defaultValue: '可逆操作免确认'
            })}
            helper={
              // 07-16 approval-mode switcher — 全局授权模式非 Manual 时，本开关被模式接管
              //（gateway 在 acceptEdits/bypass 下不再走 auto-reversible 分支）：置灰 + 注明来源。
              // codex r1 P1-1 — null = 服务端模式未知（读失败/未返回）：同样置灰（fail-safe，
              // 真实模式可能是 bypass），但注明「未知」而非冒充某个模式。
              globalApprovalMode === null
                ? t('settings.ai.approval.modeUnknown', {
                    defaultValue:
                      '无法读取当前授权模式（后端暂不可达，聚焦窗口时自动重试）；确认为「手动授权」后此开关生效。'
                  })
                : globalApprovalMode !== 'manual'
                  ? t('settings.ai.approval.managedByMode', {
                      mode: t(`chat.approvalMode.${globalApprovalMode}.title`),
                      defaultValue:
                        '当前授权模式为「{mode}」（对话框左下角可切换），已接管审批放行；切回「手动授权」后此开关生效。'
                    })
                  : t('settings.ai.approval.autoReversibleHelper', {
                      defaultValue:
                        '开启后，标记 / 归档 / 置顶 / 重传 Notion / 记忆读写等可逆操作直接执行，无需确认卡片；起草回复仍需确认，发送邮件（不可逆）始终需要确认。'
                    })
            }
          >
            <Switch
              checked={approvalMode === 'auto-reversible'}
              disabled={globalApprovalMode !== 'manual'}
              onCheckedChange={(checked) => {
                const next: ApprovalMode = checked ? 'auto-reversible' : 'always'
                setApprovalMode(next)
                writeApprovalMode(next)
              }}
            />
          </Row>
        </Section>

        {/* 08-05 WP-11 — per-tool 审批档（acceptEdits 模式退役后的数据归宿）：每工具
            ask/auto/deny + 组级批量 + 编辑放行预设 + Reset + send 收件人白名单。 */}
        <Section
          title={t('settings.ai.toolPrefs.title', { defaultValue: '工具审批档' })}
          helper={t('settings.ai.toolPrefs.helper')}
        >
          <ToolApprovalSection />
        </Section>
      </div>

      <CustomAiSection />
    </div>
  )
}
