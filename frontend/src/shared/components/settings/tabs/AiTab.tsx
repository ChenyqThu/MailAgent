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
import { Loader2, FileText } from 'lucide-react'

import { useMailApi } from '@shared/hooks/useMailApi'
import { Button } from '@shared/components/ui/button'
import { toastError, toastSuccess } from '@shared/state/toast'
import type { PromptInfo, PromptSlot } from '@shared/api/types'

import { PageHeader } from '../parts/PageHeader'
import { Section } from '../parts/Section'
import { Row } from '../parts/Row'
import { EnvField } from '../parts/EnvField'
import { EnvSecretField } from '../parts/EnvSecretField'
import { PromptEditorDialog } from '../parts/PromptEditorDialog'
import { NotionAgentSection } from './NotionAgentSection'

export function AiTab(): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const [testing, setTesting] = React.useState(false)
  const [promptInfo, setPromptInfo] = React.useState<{
    inbox: PromptInfo | null
    sent: PromptInfo | null
  }>({ inbox: null, sent: null })
  const [editorSlot, setEditorSlot] = React.useState<PromptSlot | null>(null)

  React.useEffect(() => {
    let active = true
    api.prompts
      .list()
      .then((r) => {
        if (!active) return
        setPromptInfo({ inbox: r.inbox, sent: r.sent })
      })
      .catch((err: Error) => {
        if (!active) return
        toastError(t('settings.ai.prompts.listFailed'), err.message)
      })
    return () => {
      active = false
    }
  }, [api.prompts, t])

  async function refreshPrompts(): Promise<void> {
    const r = await api.prompts.list()
    setPromptInfo({ inbox: r.inbox, sent: r.sent })
  }

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
          defaultValue: '本地 LLM 网关、模型路由、prompt 配置与邮件翻译。'
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
          placeholder="gpt-5.5,claude-opus-4-7"
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

      <NotionAgentSection />

      <Section title={t('settings.ai.prompts.title')} helper={t('settings.ai.prompts.helper')}>
        <EnvField
          envKey="LLM_INBOX_PROMPT_PATH"
          control="text"
          label={t('settings.ai.prompts.inbox.pathLabel')}
          helper={t('settings.ai.prompts.inbox.pathHelper')}
          placeholder="prompts/email_inbox.md"
        />
        <Row
          label={t('settings.ai.prompts.inbox.editLabel')}
          helper={
            promptInfo.inbox?.exists
              ? t('settings.ai.prompts.editHelperExists', {
                  path: promptInfo.inbox.path
                })
              : t('settings.ai.prompts.editHelperMissing', {
                  path: promptInfo.inbox?.path ?? ''
                })
          }
        >
          <Button
            onClick={() => setEditorSlot('inbox')}
            variant="secondary"
            size="sm"
            disabled={promptInfo.inbox === null}
          >
            <FileText className="size-3.5" />
            {t('settings.ai.prompts.editButton')}
          </Button>
        </Row>
        <EnvField
          envKey="LLM_SENT_PROMPT_PATH"
          control="text"
          label={t('settings.ai.prompts.sent.pathLabel')}
          helper={t('settings.ai.prompts.sent.pathHelper')}
          placeholder="prompts/email_sent.md"
        />
        <Row
          label={t('settings.ai.prompts.sent.editLabel')}
          helper={
            promptInfo.sent?.exists
              ? t('settings.ai.prompts.editHelperExists', {
                  path: promptInfo.sent.path
                })
              : t('settings.ai.prompts.editHelperMissing', {
                  path: promptInfo.sent?.path ?? ''
                })
          }
        >
          <Button
            onClick={() => setEditorSlot('sent')}
            variant="secondary"
            size="sm"
            disabled={promptInfo.sent === null}
          >
            <FileText className="size-3.5" />
            {t('settings.ai.prompts.editButton')}
          </Button>
        </Row>
      </Section>

      <Section title={t('settings.ai.translate.title')} helper={t('settings.ai.translate.helper')}>
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
        <EnvField
          envKey="LLM_TRANSLATE_MODEL"
          control="text"
          label={t('settings.ai.translateModel.label')}
          helper={t('settings.ai.translateModel.helper')}
          placeholder="claude-haiku-4-5"
        />
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

      <PromptEditorDialog
        slot={editorSlot}
        open={editorSlot !== null}
        onClose={() => {
          setEditorSlot(null)
          // Refresh list so the helper text reflects exists=true after the
          // first write turned a missing file into a real one.
          void refreshPrompts()
        }}
      />
    </>
  )
}
