// MemoryCaptureModelSection — 记忆抽取模型（MEMORY_CAPTURE_MODEL，task 07-01 #1）
//
// auto-capture 每轮把持久事实合并进 memory.md 时用的 LLM 模型。这是 config.py 的 pydantic
// 字段（singleton，非热读）→ 改动写 .env 后需重启 serve-api 生效；EnvField 的 markRestartRequired
// 会拉起全局重启横幅（与 LLM_MODEL 同款机制）。.env 未设时后端默认 = claude-haiku-4-5（便宜快，
// 每被捕获的对话轮跑一次，成本敏感）。

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { qk } from '@shared/lib/queryKeys'

import { useEnabledModels, FALLBACK_MODELS } from '@shared/hooks/useLlmModels'
import { useEnvStore } from '@shared/state/env'

import { Section } from '../parts/Section'
import { EnvField } from '../parts/EnvField'
import { fetchStandingDocsEditorEnabled } from './shared'

const MEMORY_CAPTURE_DEFAULT_MODEL = 'claude-haiku-4-5'

export function MemoryCaptureModelSection(): React.ReactElement | null {
  const { t } = useTranslation()
  const { models: enabledModels } = useEnabledModels()
  const currentModel = useEnvStore((s) =>
    s.state.status === 'ready' ? (s.state.snapshot.values['MEMORY_CAPTURE_MODEL'] ?? '') : ''
  )
  // Gate on the SAME flag as the identity/memory doc editor (no new flag): the memory
  // capture model is part of the same advanced agent-config surface (task 07-01 step 3).
  // flag-off → return null (no DOM), like StandingDocsSection.
  const { data: editorEnabled } = useQuery<boolean>({
    queryKey: qk.chat.config('standingDocsEditorEnabled'),
    queryFn: fetchStandingDocsEditorEnabled,
    staleTime: 30_000,
    retry: false
  })

  const options = React.useMemo(() => {
    const base = enabledModels.length > 0 ? enabledModels : FALLBACK_MODELS
    // Always offer the recommended haiku default (it isn't in FALLBACK_MODELS), then append
    // the current .env value as an orphan if it's set and not already listed (mirrors AiTab
    // LLM_MODEL orphan handling so a narrowed enabled-list never blanks the select).
    const withDefault = base.includes(MEMORY_CAPTURE_DEFAULT_MODEL)
      ? base
      : [MEMORY_CAPTURE_DEFAULT_MODEL, ...base]
    const withOrphan =
      currentModel && !withDefault.includes(currentModel)
        ? [...withDefault, currentModel]
        : withDefault
    return withOrphan.map((id) => ({ value: id, label: id }))
  }, [enabledModels, currentModel])

  if (!editorEnabled) return null

  return (
    <Section
      title={t('settings.memoryCaptureModel.title')}
      helper={t('settings.memoryCaptureModel.desc')}
    >
      <EnvField
        envKey="MEMORY_CAPTURE_MODEL"
        control="select"
        label={t('settings.memoryCaptureModel.label')}
        helper={t('settings.memoryCaptureModel.helper')}
        options={options}
        placeholder={MEMORY_CAPTURE_DEFAULT_MODEL}
      />
    </Section>
  )
}
