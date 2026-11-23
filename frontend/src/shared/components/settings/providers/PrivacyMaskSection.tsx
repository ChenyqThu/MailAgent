import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus, ShieldCheck, Trash2 } from 'lucide-react'

import { Button } from '@shared/components/ui/button'
import { Input } from '@shared/components/ui/input'
import { Switch } from '@shared/components/ui/switch'
import {
  clearPrivacyMaskHits,
  savePrivacyMaskConfig,
  usePrivacyMaskConfig,
  type PrivacyBuiltinCategory,
  type PrivacyMaskConfigWire,
  type PrivacyMaskCustomRuleWire
} from '@shared/hooks/useLlmProviders'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { toastError, toastSuccess } from '@shared/state/toast'

import { Row } from '../parts/Row'
import { Section } from '../parts/Section'

const BUILTIN_CATEGORIES: readonly PrivacyBuiltinCategory[] = [
  'secret',
  'id_card',
  'phone',
  'email',
  'bank_card'
]

const SAMPLE_DEFAULTS: Record<string, string> = {
  secret: 'sk-ant-api03-1234567890abcdefghijklmnop',
  phone: '13800138000',
  email: 'alice.chen@example.com'
}

function previewMaskLocal(input: string, config: PrivacyMaskConfigWire): string {
  if (!input) return ''
  let out = input
  let seq = 1
  const maskMatch = (tag: string, re: RegExp): void => {
    out = out.replace(re, () => `[[PII_${tag}_${seq++}]]`)
  }
  if (config.builtIn.secret) {
    maskMatch(
      'SECRET',
      /\b(?:sk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{16,}|mak_[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/g
    )
  }
  if (config.builtIn.email) {
    maskMatch('EMAIL', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)
  }
  if (config.builtIn.phone) {
    maskMatch('PHONE', /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g)
  }
  for (const rule of config.customRules) {
    if (!rule.enabled || !rule.pattern) continue
    try {
      const re = new RegExp(rule.pattern, 'g')
      if (re.test('')) continue
      maskMatch(rule.tag || 'CUSTOM', new RegExp(rule.pattern, 'g'))
    } catch {
      /* invalid custom regex is flagged cleanly below */
    }
  }
  return out
}

export function PrivacyMaskSection(): React.ReactElement {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const isWeb =
    (import.meta as unknown as { env?: { VITE_BUILD_TARGET?: string } }).env?.VITE_BUILD_TARGET ===
    'web'

  const query = usePrivacyMaskConfig(true)
  const config: PrivacyMaskConfigWire = React.useMemo(
    () =>
      query.data?.config ?? {
        builtIn: { secret: true, id_card: true, phone: true, email: true, bank_card: true },
        customRules: []
      },
    [query.data?.config]
  )
  const hits = query.data?.hits ?? { total: 0, byCategory: [] }

  const [saving, setSaving] = React.useState(false)
  const [clearingHits, setClearingHits] = React.useState(false)
  const [ruleName, setRuleName] = React.useState('')
  const [ruleTag, setRuleTag] = React.useState('')
  const [rulePattern, setRulePattern] = React.useState('')
  const [sampleInput, setSampleInput] = React.useState(
    `${SAMPLE_DEFAULTS.email} / ${SAMPLE_DEFAULTS.phone} / ${SAMPLE_DEFAULTS.secret}`
  )

  async function persistConfig(next: PrivacyMaskConfigWire): Promise<void> {
    setSaving(true)
    try {
      const updated = await savePrivacyMaskConfig(next)
      qc.setQueryData(qk.llm.privacyConfig(), updated)
      toastSuccess(t('settings.privacyMask.saved'))
    } catch (err) {
      toastError(t('settings.privacyMask.saveFailed'), errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  function handleToggleBuiltin(cat: PrivacyBuiltinCategory, checked: boolean): void {
    void persistConfig({
      ...config,
      builtIn: {
        ...config.builtIn,
        [cat]: checked
      }
    })
  }

  function handleToggleCustom(ruleId: string, checked: boolean): void {
    void persistConfig({
      ...config,
      customRules: config.customRules.map((r) =>
        r.id === ruleId ? { ...r, enabled: checked } : r
      )
    })
  }

  function handleDeleteCustom(ruleId: string): void {
    void persistConfig({
      ...config,
      customRules: config.customRules.filter((r) => r.id !== ruleId)
    })
  }

  function handleAddCustom(e: React.FormEvent): void {
    e.preventDefault()
    const name = ruleName.trim()
    const pattern = rulePattern.trim()
    const rawTag = ruleTag.trim().toUpperCase() || 'CUSTOM'
    if (!name || !pattern) return
    const nextRule: PrivacyMaskCustomRuleWire = {
      id: `rule_${Date.now().toString(36)}`,
      name,
      pattern,
      tag: rawTag,
      enabled: true
    }
    void persistConfig({
      ...config,
      customRules: [...config.customRules, nextRule]
    }).then(() => {
      setRuleName('')
      setRuleTag('')
      setRulePattern('')
    })
  }

  async function handleClearHits(): Promise<void> {
    setClearingHits(true)
    try {
      await clearPrivacyMaskHits()
      await qc.invalidateQueries({ queryKey: qk.llm.privacyConfig() })
      toastSuccess(t('settings.privacyMask.hitsCleared'))
    } catch (err) {
      toastError(t('settings.privacyMask.hitsClearFailed'), errorMessage(err))
    } finally {
      setClearingHits(false)
    }
  }

  const previewOutput = React.useMemo(
    () => previewMaskLocal(sampleInput, config),
    [sampleInput, config]
  )

  return (
    <Section
      title={t('settings.privacyMask.title')}
      helper={t('settings.privacyMask.helper')}
      meta={
        <span className="inline-flex items-center gap-1.5 font-mono text-meta text-ink-fg-2">
          <ShieldCheck className="size-3.5 text-ok" />
          {hits.total}
        </span>
      }
    >
      {query.isPending ? (
        <Row label={t('settings.privacyMask.loading')}>
          <Loader2 className="size-4 animate-spin text-ink-fg-3" />
        </Row>
      ) : query.isError ? (
        <Row
          label={t('settings.privacyMask.loadFailed')}
          helper={<span className="text-fail">{errorMessage(query.error)}</span>}
        >
          <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
            {t('settings.privacyMask.retry')}
          </Button>
        </Row>
      ) : (
        <>
          {BUILTIN_CATEGORIES.map((cat) => (
            <Row
              key={cat}
              label={t(`settings.privacyMask.builtin.${cat}.label`)}
              helper={t(`settings.privacyMask.builtin.${cat}.helper`)}
            >
              <Switch
                checked={config.builtIn[cat] !== false}
                disabled={isWeb || saving}
                onCheckedChange={(checked) => handleToggleBuiltin(cat, checked)}
                aria-label={t(`settings.privacyMask.builtin.${cat}.label`)}
              />
            </Row>
          ))}

          <Row
            label={t('settings.privacyMask.customRules.title')}
            helper={t('settings.privacyMask.customRules.helper')}
          >
            <span className="font-mono text-meta text-ink-fg-2">
              {config.customRules.length}
            </span>
          </Row>

          <div className="flex flex-col gap-2.5 px-[var(--settings-tile-px,1rem)] py-3">
            {config.customRules.length > 0 && (
              <div className="divide-y divide-ink-border-soft rounded-md border border-ink-border-soft">
                {config.customRules.map((rule) => (
                  <div
                    key={rule.id}
                    className="flex items-center justify-between gap-3 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-aux font-medium text-ink-fg">{rule.name}</span>
                        <span className="rounded bg-ink-3 px-1.5 py-0.5 font-mono text-meta text-ink-fg-2">
                          {rule.tag}
                        </span>
                      </div>
                      <div className="mt-0.5 truncate font-mono text-meta text-ink-fg-3">
                        {rule.pattern}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={rule.enabled}
                        disabled={isWeb || saving}
                        onCheckedChange={(checked) => handleToggleCustom(rule.id, checked)}
                        aria-label={rule.name}
                      />
                      {!isWeb && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={saving}
                          onClick={() => handleDeleteCustom(rule.id)}
                          aria-label={t('settings.privacyMask.customRules.deleteAria', {
                            name: rule.name
                          })}
                        >
                          <Trash2 className="size-3.5 text-ink-fg-2 hover:text-fail" />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {!isWeb && (
              <form onSubmit={handleAddCustom} className="flex flex-wrap items-center gap-2">
                <Input
                  value={ruleName}
                  onChange={(e) => setRuleName(e.target.value)}
                  placeholder={t('settings.privacyMask.customRules.namePlaceholder')}
                  className="h-8 w-[140px] text-aux"
                />
                <Input
                  value={ruleTag}
                  onChange={(e) => setRuleTag(e.target.value)}
                  placeholder="INTERNAL_ID"
                  className="h-8 w-[120px] font-mono text-aux"
                />
                <Input
                  value={rulePattern}
                  onChange={(e) => setRulePattern(e.target.value)}
                  placeholder="EMP-\d{6}"
                  className="h-8 min-w-[180px] flex-1 font-mono text-aux"
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="secondary"
                  disabled={saving || !ruleName.trim() || !rulePattern.trim()}
                >
                  <Plus className="size-3.5" />
                  {t('settings.privacyMask.customRules.add')}
                </Button>
              </form>
            )}
          </div>

          <div className="flex flex-col gap-2 px-[var(--settings-tile-px,1rem)] py-3">
            <div className="text-aux font-medium text-ink-fg">
              {t('settings.privacyMask.preview.title')}
            </div>
            <Input
              value={sampleInput}
              onChange={(e) => setSampleInput(e.target.value)}
              className="h-8 font-mono text-aux"
            />
            <div className="rounded-md border border-ink-border-soft bg-ink-2 px-3 py-2 font-mono text-aux text-ink-fg-1 break-all">
              {previewOutput}
            </div>
          </div>

          <Row
            label={t('settings.privacyMask.hits.title')}
            helper={
              hits.byCategory.length === 0
                ? t('settings.privacyMask.hits.empty')
                : hits.byCategory.map((item) => `${item.category}: ${item.count}`).join(' · ')
            }
          >
            <Button
              size="sm"
              variant="outline"
              disabled={isWeb || clearingHits || hits.total === 0}
              onClick={() => void handleClearHits()}
            >
              {clearingHits ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t('settings.privacyMask.hits.clear')}
            </Button>
          </Row>
        </>
      )}
    </Section>
  )
}
