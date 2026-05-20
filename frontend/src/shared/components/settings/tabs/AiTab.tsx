// Sprint 18 §PR D — AI Agent tab. 本地 LLM (CRS 网关) + cache 配置 + test
// gateway button (settings:test:llm IPC).
//
// LLM_API_KEY 走 <EnvSecretField> 双写 (keytar + .env): main 进程的
// translate + Custom-API chat backend 从 keytar 读, Python LLM agent 从
// .env 读. 其他 secret (NOTION_TOKEN / FEISHU_APP_SECRET) 只 Python 用,
// EnvField password 单写 .env 即可.

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'

import { useMailApi } from '@shared/hooks/useMailApi'
import { Button } from '@shared/components/ui/button'
import { toastError, toastSuccess } from '@shared/state/toast'

import { PageHeader } from '../parts/PageHeader'
import { Section } from '../parts/Section'
import { Row } from '../parts/Row'
import { EnvField } from '../parts/EnvField'
import { EnvSecretField } from '../parts/EnvSecretField'

export function AiTab(): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const [testing, setTesting] = React.useState(false)

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
      toastError(t('settings.ai.testGateway.fail'), (err as Error).message)
    } finally {
      setTesting(false)
    }
  }

  return (
    <>
      <PageHeader
        eyebrow={t('settings.ai.page.eyebrow', { defaultValue: 'AI AGENT' })}
        title={t('settings.ai.page.title', { defaultValue: 'AI Agent' })}
        description={t('settings.ai.page.intro', {
          defaultValue: '本地 LLM 网关、模型路由与 prompt cache 配置。'
        })}
      />
      <Section title={t('settings.ai.title')} helper={t('settings.ai.helper')}>
        <EnvField
          envKey="LLM_AGENT_ENABLED"
          control="toggle"
          label={t('settings.ai.enabled.label')}
          helper={t('settings.ai.enabled.helper')}
        />
        <EnvField
          envKey="LLM_API_BASE"
          control="text"
          label={t('settings.ai.apiBase.label')}
          helper={t('settings.ai.apiBase.helper')}
          placeholder="https://crs.chenge.ink/api"
        />
        <EnvSecretField
          envKey="LLM_API_KEY"
          keytarSlot="llmApiKey"
          label={t('settings.ai.apiKey.label')}
          helper={t('settings.ai.apiKey.helper')}
        />
        <EnvField
          envKey="LLM_MODEL"
          control="text"
          label={t('settings.ai.model.label')}
          helper={t('settings.ai.model.helper')}
          placeholder="claude-sonnet-4-6"
        />
        <EnvField
          envKey="LLM_FALLBACK_MODELS"
          control="tag-list"
          label={t('settings.ai.fallbacks.label')}
          helper={t('settings.ai.fallbacks.helper')}
          placeholder="gpt-5.4,claude-opus-4-7"
        />
        <EnvField
          envKey="LLM_CONTEXT_PAGE_ID"
          control="text"
          label={t('settings.ai.contextPageId.label')}
          helper={t('settings.ai.contextPageId.helper')}
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
    </>
  )
}
