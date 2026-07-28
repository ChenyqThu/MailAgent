// task 07-12 P3 — 单个 provider 行（prd §4.5.1/.2）。
//
// 折叠头 = displayName + protocol 徽标 + baseUrl 摘要 + 启停 Switch + 删除（default 禁删，
// 后端 400 双保险）；展开 = 编辑面（displayName / baseUrl / apiKey 掩码轮换 / 自定义
// headers（write-only 草稿 + 显式保存，见 HeadersEditor）/ 连通性测试）+ 模型管理面板。
// 普通字段 blur → PATCH（EnvField 同款心智）；secret 永不回显明文——apiKey 只给
// hasKey + keyLast4，header 只给名（headerNames）。

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { ChevronDown, Loader2, Plug, Trash2, X } from 'lucide-react'

import {
  deleteLlmProvider,
  testLlmProvider,
  updateLlmProvider,
  type LlmProviderSummary,
  type LlmProviderTestResult
} from '@shared/hooks/useLlmProviders'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { toastError, toastSuccess } from '@shared/state/toast'
import { Button } from '@shared/components/ui/button'
import { Input } from '@shared/components/ui/input'
import { Switch } from '@shared/components/ui/switch'

import { ProviderModelsPanel } from './ProviderModelsPanel'

/** 编辑面里的一行（label 左 / 控件右）——Settings Row 的窄版（嵌在 provider 卡内）。 */
function FieldRow({
  label,
  children
}: {
  label: React.ReactNode
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="shrink-0 text-aux text-ink-fg-1">{label}</span>
      {children}
    </div>
  )
}

/** headers 编辑器（write-only，批 2 review HIGH-1）：服务端只回 header 名不回值——
 *  已存行显示名 + '••••' 占位，值永不回显。任何改动（改值/增/删）进入草稿态，「保存」=
 *  PATCH 完整明文 map 全量替换（后端契约：省略 = 不改，{} = 清空）。因为服务端不回值，
 *  提交前所有保留的 header 都必须重新输入值（hint 提示），否则构不出完整 map。 */
function HeadersEditor({
  headerNames,
  readOnly,
  onCommit
}: {
  headerNames: string[]
  readOnly: boolean
  /** 返回是否成功；成功才清明文草稿（失败保留输入让用户改后重试）。 */
  onCommit: (next: Record<string, string>) => Promise<boolean>
}): React.ReactElement {
  const { t } = useTranslation()
  // 草稿态（本 session 输入的明文；保存/取消后即清）。名集变化时的复位由调用方
  // key={headerNames.join('\n')} 触发 remount 完成（不在 effect 里 setState）。
  const [values, setValues] = React.useState<Record<string, string>>({})
  const [removed, setRemoved] = React.useState<ReadonlySet<string>>(new Set())
  // 不变式：added 只含 headerNames 之外的新名（addDraft 分支保证）。
  const [added, setAdded] = React.useState<string[]>([])
  const [draftKey, setDraftKey] = React.useState('')
  const [draftValue, setDraftValue] = React.useState('')

  const keptExisting = headerNames.filter((n) => !removed.has(n))
  const keptAll = [...keptExisting, ...added]
  const dirty =
    removed.size > 0 || added.length > 0 || keptExisting.some((n) => (values[n] ?? '').length > 0)
  const missingValue = keptAll.filter((n) => (values[n] ?? '').length === 0)
  const canCommit = dirty && missingValue.length === 0

  function addDraft(): void {
    const k = draftKey.trim()
    if (!k || draftValue.length === 0) return
    if (headerNames.includes(k)) {
      // 同名已存在：视作为该行填值（若曾标删则恢复）。
      setRemoved((r) => {
        const next = new Set(r)
        next.delete(k)
        return next
      })
    } else if (!added.includes(k)) {
      setAdded((a) => [...a, k])
    }
    setValues((v) => ({ ...v, [k]: draftValue }))
    setDraftKey('')
    setDraftValue('')
  }

  function removeName(k: string): void {
    if (headerNames.includes(k)) {
      setRemoved((r) => new Set(r).add(k))
    } else {
      setAdded((a) => a.filter((n) => n !== k))
    }
    setValues((v) => {
      const next = { ...v }
      delete next[k]
      return next
    })
  }

  function reset(): void {
    setValues({})
    setRemoved(new Set())
    setAdded([])
    setDraftKey('')
    setDraftValue('')
  }

  function commit(): void {
    if (!canCommit) return
    void onCommit(Object.fromEntries(keptAll.map((n) => [n, values[n]]))).then((ok) => {
      // 同名集不变时 namesSignature 不动、复位 effect 不触发 → 成功后在这里清草稿。
      if (ok) reset()
    })
  }

  const rowFor = (k: string): React.ReactElement => (
    <div key={k} className="flex items-center gap-1.5">
      <span className="w-[140px] truncate font-mono text-[12px] text-ink-fg-2">{k}</span>
      <Input
        type="password"
        disabled={readOnly}
        value={values[k] ?? ''}
        placeholder="••••"
        onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))}
        className="h-6 flex-1 font-mono text-[12px]"
        aria-label={k}
      />
      {!readOnly && (
        <button
          onClick={() => removeName(k)}
          aria-label={t('settings.providers.headers.deleteAria', { name: k })}
          className="rounded p-0.5 text-ink-fg-3 transition-colors hover:bg-ink-3 hover:text-ink-fg"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )

  return (
    <div className="flex flex-col gap-1">
      {keptExisting.map(rowFor)}
      {added.map(rowFor)}
      {!readOnly && (
        <div className="flex items-center gap-1.5">
          <Input
            value={draftKey}
            onChange={(e) => setDraftKey(e.target.value)}
            placeholder={t('settings.providers.headers.keyPlaceholder')}
            className="h-6 w-[140px] font-mono text-[12px]"
          />
          <Input
            type="password"
            value={draftValue}
            onChange={(e) => setDraftValue(e.target.value)}
            placeholder={t('settings.providers.headers.valuePlaceholder')}
            className="h-6 flex-1 font-mono text-[12px]"
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={draftKey.trim().length === 0 || draftValue.length === 0}
            onClick={addDraft}
          >
            {t('settings.providers.headers.add')}
          </Button>
        </div>
      )}
      {dirty && !readOnly && (
        <div className="flex items-center gap-1.5 pt-0.5">
          <Button variant="secondary" size="sm" disabled={!canCommit} onClick={commit}>
            {t('settings.providers.headers.save')}
          </Button>
          <Button variant="ghost" size="sm" onClick={reset}>
            {t('settings.providers.headers.cancel')}
          </Button>
          {missingValue.length > 0 && (
            <span className="text-aux text-ink-fg-3">
              {t('settings.providers.headers.reenterHint')}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

export function ProviderCard({
  provider,
  readOnly,
  expanded,
  onToggleExpand
}: {
  provider: LlmProviderSummary
  readOnly: boolean
  expanded: boolean
  onToggleExpand: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [busy, setBusy] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  const [testResult, setTestResult] = React.useState<LlmProviderTestResult | null>(null)
  // apiKey 输入：write-only（明文只在本地 state 到 blur 为止，PATCH 后即清）。
  const [keyDraft, setKeyDraft] = React.useState('')

  const invalidate = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: qk.llm.providers() })
    await qc.invalidateQueries({ queryKey: qk.chat.config('enabledModels') })
  }

  /** 返回是否成功（HeadersEditor 据此决定要不要清明文草稿：失败保留已输值让用户重试）。 */
  async function patch(patchBody: Parameters<typeof updateLlmProvider>[1]): Promise<boolean> {
    setBusy(true)
    try {
      await updateLlmProvider(provider.id, patchBody)
      await invalidate()
      return true
    } catch (err) {
      toastError(provider.displayName || provider.id, errorMessage(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(): Promise<void> {
    setBusy(true)
    try {
      await deleteLlmProvider(provider.id)
      toastSuccess(t('settings.providers.deleted', { name: provider.displayName || provider.id }))
      await invalidate()
    } catch (err) {
      toastError(provider.displayName || provider.id, errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleTest(): Promise<void> {
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await testLlmProvider(provider.id))
    } catch (err) {
      setTestResult({ ok: false, latencyMs: 0, error: errorMessage(err) })
    } finally {
      setTesting(false)
    }
  }

  const keyPlaceholder = provider.hasKey
    ? t('settings.providers.apiKey.set', { last4: provider.keyLast4 ?? '····' })
    : t('settings.providers.apiKey.unset')

  return (
    <div className="px-4 py-3">
      {/* 折叠头 */}
      <div className="flex items-center gap-2.5">
        <button
          onClick={onToggleExpand}
          aria-expanded={expanded}
          aria-label={t('settings.providers.expandAria', {
            name: provider.displayName || provider.id
          })}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        >
          <ChevronDown
            className={cn(
              'size-4 shrink-0 text-ink-fg-3 transition-transform duration-fast ease-standard',
              expanded ? '' : '-rotate-90'
            )}
          />
          <span className="truncate text-aux font-medium text-ink-fg">
            {provider.displayName || provider.id}
          </span>
          <span className="rounded bg-ink-3 px-1.5 py-0.5 font-mono text-meta text-ink-fg-2">
            {provider.protocol}
          </span>
          {provider.isDefault && (
            <span className="rounded bg-ink-3 px-1.5 py-0.5 text-meta text-ink-fg-3">
              {t('settings.providers.defaultBadge')}
            </span>
          )}
          {provider.baseUrl && (
            <span className="hidden truncate font-mono text-meta text-ink-fg-3 sm:inline">
              {provider.baseUrl}
            </span>
          )}
        </button>
        <Switch
          checked={provider.enabled}
          disabled={readOnly || busy}
          onCheckedChange={(v: boolean) => void patch({ enabled: v })}
          aria-label={t('settings.providers.enabledAria', {
            name: provider.displayName || provider.id
          })}
        />
        {!provider.isDefault && !readOnly && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void handleDelete()}
            aria-label={t('settings.providers.deleteAria', {
              name: provider.displayName || provider.id
            })}
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>

      {/* 展开编辑面 */}
      {expanded && (
        <div className="mt-2 border-t border-ink-border-soft pl-6 pt-1">
          <FieldRow label={t('settings.providers.displayName')}>
            <Input
              disabled={readOnly || busy}
              defaultValue={provider.displayName}
              onBlur={(e) => {
                if (e.target.value !== provider.displayName)
                  void patch({ displayName: e.target.value })
              }}
              className="h-7 w-[260px]"
            />
          </FieldRow>
          <FieldRow label={t('settings.providers.baseUrl')}>
            <Input
              disabled={readOnly || busy}
              defaultValue={provider.baseUrl}
              placeholder={t('settings.providers.baseUrlPlaceholder')}
              onBlur={(e) => {
                if (e.target.value !== provider.baseUrl) void patch({ baseUrl: e.target.value })
              }}
              className="h-7 w-[260px] font-mono text-[12px]"
            />
          </FieldRow>
          <FieldRow label={t('settings.providers.apiKey.label')}>
            <div className="flex items-center gap-1.5">
              <Input
                type="password"
                disabled={readOnly || busy}
                value={keyDraft}
                placeholder={keyPlaceholder}
                onChange={(e) => setKeyDraft(e.target.value)}
                onBlur={() => {
                  const v = keyDraft
                  if (v.length === 0) return
                  setKeyDraft('')
                  void patch({ apiKey: v })
                }}
                className="h-7 w-[220px]"
                aria-label={t('settings.providers.apiKey.label')}
              />
              {provider.hasKey && !readOnly && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void patch({ apiKey: null })}
                  aria-label={t('settings.providers.apiKey.clearAria')}
                >
                  {t('settings.providers.apiKey.clear')}
                </Button>
              )}
            </div>
          </FieldRow>
          <FieldRow label={t('settings.providers.headers.label')}>
            <div className="w-[320px]">
              <HeadersEditor
                key={provider.headerNames.join('\n')}
                headerNames={provider.headerNames}
                readOnly={readOnly || busy}
                onCommit={(next) => patch({ headers: next })}
              />
            </div>
          </FieldRow>
          <FieldRow label={t('settings.providers.test.label')}>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={testing || readOnly}
                onClick={() => void handleTest()}
              >
                {testing ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" />
                    {t('settings.providers.test.running')}
                  </>
                ) : (
                  <>
                    <Plug className="size-3.5" />
                    {t('settings.providers.test.button')}
                  </>
                )}
              </Button>
              {testResult &&
                (testResult.ok ? (
                  <span className="rounded bg-ok/15 px-1.5 py-0.5 text-aux text-ok">
                    {/* Defensive, not a live bug: serve-api emits latencyMs on both of its
                        branches today, so this only covers a degraded / older backend —
                        without the guard a missing field renders "undefined ms" into the UI. */}
                    {typeof testResult.latencyMs === 'number'
                      ? t('settings.providers.test.ok', { ms: testResult.latencyMs })
                      : t('settings.providers.test.okNoLatency')}
                  </span>
                ) : (
                  <span
                    className="max-w-[280px] truncate text-aux text-fail"
                    title={testResult.error ?? ''}
                  >
                    {testResult.error ?? t('settings.providers.test.fail')}
                  </span>
                ))}
            </div>
          </FieldRow>
          <ProviderModelsPanel providerId={provider.id} readOnly={readOnly} />
        </div>
      )}
    </div>
  )
}
