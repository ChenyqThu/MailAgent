// ImageModelSection — 图像生成模型（IMAGE_GEN_MODEL，task 09-02）
//
// chat 里 generate_image 工具生成 / 编辑图片所用的模型。值是 providerRef（`providerId:modelId`），
// 写入面与其它功能位选择器相同（EnvField select → env:set → .env）。与 MemoryCaptureModelSection
// 的两点不同：① 候选集不是全部 enabledModels，而是经 imageModelCandidates 按 provider protocol 过滤
// 后的子集（只有 openai / openai-compatible 家有 imageModel）；② hotReload —— gateway 每次装配工具
// 时从 .env 热读这个键（ai_gateway_lifecycle readImageGenModelRef），保存即生效，不拉重启横幅。
// provider registry 关（显式 false 回退）时整区不渲染：没有 registry 就没有 protocol 事实可过滤。

import * as React from 'react'
import { useTranslation } from 'react-i18next'

import { useEnabledModels } from '@shared/hooks/useLlmModels'
import { useLlmProviders, useProviderRegistryEnabled } from '@shared/hooks/useLlmProviders'
import { useEnvStore } from '@shared/state/env'

import { Section } from '../parts/Section'
import { EnvField } from '../parts/EnvField'
import { buildModelOptionGroups } from '../providers/modelOptionGroups'
import { imageModelCandidates } from './imageModelCandidates'

export function ImageModelSection(): React.ReactElement | null {
  const { t } = useTranslation()
  const registryEnabled = useProviderRegistryEnabled()
  const { providers } = useLlmProviders(registryEnabled)
  const { rawEnabled } = useEnabledModels()
  const currentModel = useEnvStore((s) =>
    s.state.status === 'ready' ? (s.state.snapshot.values['IMAGE_GEN_MODEL'] ?? '') : ''
  )

  const { optionGroups, empty } = React.useMemo(() => {
    const candidates = imageModelCandidates(rawEnabled, providers)
    // The current .env value stays selectable as an orphan (provider renamed / disabled) so the
    // select never blanks out what is actually configured — mirrors AiTab's LLM_MODEL handling.
    const withOrphan =
      currentModel && !candidates.includes(currentModel)
        ? [...candidates, currentModel]
        : candidates
    return { optionGroups: buildModelOptionGroups(withOrphan, t), empty: candidates.length === 0 }
  }, [rawEnabled, providers, currentModel, t])

  if (!registryEnabled) return null

  return (
    <Section title={t('settings.imageGenModel.title')} helper={t('settings.imageGenModel.desc')}>
      <EnvField
        envKey="IMAGE_GEN_MODEL"
        control="select"
        label={t('settings.imageGenModel.label')}
        helper={
          empty ? t('settings.imageGenModel.noCandidates') : t('settings.imageGenModel.helper')
        }
        optionGroups={optionGroups}
        placeholder={t('settings.imageGenModel.placeholder')}
        placeholderOnEmpty
        hotReload
      />
    </Section>
  )
}
