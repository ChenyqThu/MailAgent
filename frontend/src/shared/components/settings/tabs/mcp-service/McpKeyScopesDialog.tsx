// Create / edit MCP API key scopes, TTL, and rate-limit dialog.

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'

import type { McpApiKey, McpKeyBase, McpKeyWithPlaintext } from '@shared/api/types'
import { Button } from '@shared/components/ui/button'
import { Checkbox } from '@shared/components/ui/checkbox'
import { CollapseChevron } from '@shared/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@shared/components/ui/dialog'
import { Input } from '@shared/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@shared/components/ui/radio-group'
import { useMailApi } from '@shared/hooks/useMailApi'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { toastError } from '@shared/state/toast'

import { useScopeText, type ScopesDialogTarget } from './mcpServiceUtils'

export function KeyScopesDialog({
  target,
  open,
  onClose,
  onCreated,
  onUpdated
}: {
  target: ScopesDialogTarget
  open: boolean
  onClose: () => void
  onCreated: (r: McpKeyWithPlaintext) => void
  onUpdated: (key: McpApiKey) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const scopeText = useScopeText()
  const editing = target.mode === 'edit' ? target.key : null

  const optionsQuery = useQuery({
    queryKey: qk.mcpService.scopeOptions(),
    queryFn: () => api.mcpService.getScopeOptions()
  })

  const [label, setLabel] = React.useState('')
  const [base, setBase] = React.useState<McpKeyBase>(editing?.base ?? 'readonly')
  const [extra, setExtra] = React.useState<readonly string[]>(editing?.extra ?? [])
  const [advancedOpen, setAdvancedOpen] = React.useState(false)
  const [granularMode, setGranularMode] = React.useState(false)
  const [granularScopes, setGranularScopes] = React.useState<string[]>(
    editing ? [...editing.scopes] : []
  )
  const [ttlDays, setTtlDays] = React.useState<number | null>(null)
  const [ttlDirty, setTtlDirty] = React.useState(false)
  const [writeRpmText, setWriteRpmText] = React.useState(
    editing?.write_rpm_limit != null ? String(editing.write_rpm_limit) : ''
  )
  const [rpmDirty, setRpmDirty] = React.useState(false)
  const [disabledTools, setDisabledTools] = React.useState<string[]>(
    editing?.disabled_tools ? [...editing.disabled_tools] : []
  )
  const [toolsDirty, setToolsDirty] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)

  const options = optionsQuery.data
  // 按接口给的顺序提交，与勾选先后无关。
  const selectedExtra = options
    ? options.extras.map((e) => e.scope).filter((scope) => extra.includes(scope))
    : []

  function toggleExtra(scope: string, checked: boolean): void {
    setExtra((prev) => (checked ? [...prev, scope] : prev.filter((s) => s !== scope)))
  }

  function enableGranularMode(): void {
    const baseScopes = options?.bases.find((b) => b.id === base)?.scopes ?? []
    setGranularScopes(Array.from(new Set([...baseScopes, ...selectedExtra])))
    setGranularMode(true)
  }

  function toggleGranularScope(scope: string, checked: boolean): void {
    setGranularScopes((prev) =>
      checked ? Array.from(new Set([...prev, scope])) : prev.filter((s) => s !== scope)
    )
  }

  function toggleDisabledTool(toolName: string, disabled: boolean): void {
    setToolsDirty(true)
    setDisabledTools((prev) =>
      disabled ? Array.from(new Set([...prev, toolName])) : prev.filter((n) => n !== toolName)
    )
  }

  async function handleSubmit(): Promise<void> {
    setSubmitting(true)
    const rpmTrim = writeRpmText.trim()
    const parsedRpm = rpmTrim === '' ? null : Math.max(1, Math.trunc(Number(rpmTrim)))
    const usePolicy = granularMode || ttlDirty || rpmDirty || toolsDirty
    try {
      if (editing) {
        if (usePolicy && api.mcpService.updateKeyPolicy) {
          const updated = await api.mcpService.updateKeyPolicy(editing.id, {
            ...(granularMode ? { scopes: granularScopes } : { base, extra: [...selectedExtra] }),
            ...(ttlDirty
              ? { ttl_days: ttlDays, ...(ttlDays === null ? { expires_at: null } : {}) }
              : {}),
            ...(rpmDirty ? { write_rpm_limit: Number.isFinite(parsedRpm) ? parsedRpm : null } : {}),
            ...(toolsDirty ? { disabled_tools: disabledTools } : {})
          })
          onUpdated(updated)
        } else {
          onUpdated(await api.mcpService.updateKeyScopes(editing.id, base, selectedExtra))
        }
      } else if (usePolicy && api.mcpService.createKeyWithPolicy) {
        const created = await api.mcpService.createKeyWithPolicy({
          label: label.trim(),
          ...(granularMode ? { scopes: granularScopes } : { base, extra: [...selectedExtra] }),
          ...(ttlDirty && ttlDays != null ? { ttl_days: ttlDays } : {}),
          ...(disabledTools.length > 0 ? { disabled_tools: disabledTools } : {}),
          ...(parsedRpm != null && Number.isFinite(parsedRpm) ? { write_rpm_limit: parsedRpm } : {})
        })
        onCreated(created)
      } else {
        onCreated(await api.mcpService.createKey(label.trim(), base, selectedExtra))
      }
    } catch (err) {
      toastError(
        t(editing ? 'settings.mcp.keys.updateScopesFailed' : 'settings.mcp.keys.createFailed'),
        errorMessage(err)
      )
    } finally {
      setSubmitting(false)
    }
  }

  const hasGranularCapabilities =
    options != null &&
    ((options.read_scopes?.length ?? 0) > 0 ||
      (options.available_tools?.length ?? 0) > 0 ||
      (options.ttl_presets_days?.length ?? 0) > 0)

  const canSubmit =
    options != null &&
    !submitting &&
    (editing != null || label.trim() !== '') &&
    (!granularMode || granularScopes.length > 0)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {editing
              ? t('settings.mcp.editScopes.title', { label: editing.label })
              : t('settings.mcp.create.title')}
          </DialogTitle>
          <DialogDescription>
            {editing ? t('settings.mcp.editScopes.desc') : t('settings.mcp.create.desc')}
          </DialogDescription>
        </DialogHeader>

        {editing ? null : (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="mcp-key-label" className="text-aux font-medium text-ink-fg">
              {t('settings.mcp.create.nameLabel')}
            </label>
            <Input
              id="mcp-key-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('settings.mcp.create.namePlaceholder')}
            />
          </div>
        )}

        {optionsQuery.isError ? (
          <div className="flex items-center justify-between gap-2 text-aux">
            <span className="text-fail">{errorMessage(optionsQuery.error)}</span>
            <Button size="sm" variant="outline" onClick={() => void optionsQuery.refetch()}>
              {t('settings.mcp.retry')}
            </Button>
          </div>
        ) : !options ? (
          <div className="flex justify-center py-4">
            <Loader2 className="size-4 animate-spin text-ink-fg-3" aria-label="loading" />
          </div>
        ) : (
          <>
            {!granularMode ? (
              <>
                <div className="flex flex-col gap-1.5">
                  <div className="text-aux font-medium text-ink-fg">
                    {t('settings.mcp.create.baseLabel')}
                  </div>
                  <RadioGroup
                    value={base}
                    onValueChange={(v) => setBase(v as McpKeyBase)}
                    aria-label={t('settings.mcp.create.baseLabel')}
                  >
                    {options.bases.map(({ id: b }) => {
                      const id = `mcp-base-${b}`
                      return (
                        <div
                          key={b}
                          className={cn(
                            'flex items-start gap-2.5 rounded-md border px-3 py-2.5',
                            'transition-colors duration-fast ease-standard',
                            base === b ? 'border-coral/60' : 'border-ink-border-soft'
                          )}
                        >
                          <RadioGroupItem value={b} id={id} className="mt-1" />
                          <div className="min-w-0 flex-1">
                            <label
                              htmlFor={id}
                              className="block text-aux text-ink-fg cursor-pointer"
                            >
                              {t(`settings.mcp.presets.${b}.label`)}
                            </label>
                            <div className="text-meta text-ink-fg-2 mt-0.5 leading-relaxed">
                              {t(`settings.mcp.presets.${b}.desc`)}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </RadioGroup>
                </div>

                <div className="flex flex-col gap-1.5">
                  <div className="text-aux font-medium text-ink-fg">
                    {t('settings.mcp.create.extraLabel')}
                  </div>
                  {options.extras.map(({ scope, risk }) => {
                    const high = risk === 'high'
                    const checked = extra.includes(scope)
                    const descId = `mcp-extra-${scope.replace(/[^a-zA-Z0-9]/g, '-')}-desc`
                    const desc = scopeText.desc(scope)
                    return (
                      <label
                        key={scope}
                        data-risk={risk}
                        className={cn(
                          'flex items-start gap-2.5 rounded-md border px-3 py-2.5 cursor-pointer',
                          'transition-colors duration-fast ease-standard',
                          checked ? 'border-coral/60' : 'border-ink-border-soft'
                        )}
                      >
                        <Checkbox
                          className="mt-0.5"
                          checked={checked}
                          onCheckedChange={(next) => toggleExtra(scope, next)}
                          aria-label={scopeText.label(scope)}
                          aria-describedby={desc ? descId : undefined}
                        />
                        <div className="min-w-0 flex-1">
                          <div className={cn('text-aux', high ? 'text-warn' : 'text-ink-fg')}>
                            {scopeText.label(scope)}
                          </div>
                          {desc ? (
                            <div
                              id={descId}
                              className={cn(
                                'text-meta mt-0.5 leading-relaxed',
                                high ? 'text-warn' : 'text-ink-fg-2'
                              )}
                            >
                              {desc}
                            </div>
                          ) : null}
                        </div>
                      </label>
                    )
                  })}
                </div>
              </>
            ) : null}

            {hasGranularCapabilities ? (
              <div className="border-t border-ink-border-soft pt-2.5">
                <button
                  type="button"
                  aria-expanded={advancedOpen}
                  onClick={() => setAdvancedOpen((prev) => !prev)}
                  className="inline-flex items-center gap-1.5 text-aux text-coral hover:underline"
                >
                  <CollapseChevron expanded={advancedOpen} />
                  <span>{t('settings.mcp.policy.advancedToggle')}</span>
                </button>
                {advancedOpen ? (
                  <div className="mt-2.5 space-y-3 rounded-md border border-ink-border-soft bg-ink-1/40 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-aux font-medium text-ink-fg">
                        {t('settings.mcp.policy.scopeModeLabel')}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          if (granularMode) setGranularMode(false)
                          else enableGranularMode()
                        }}
                      >
                        {granularMode
                          ? t('settings.mcp.policy.usePresetMode')
                          : t('settings.mcp.policy.useGranularMode')}
                      </Button>
                    </div>

                    {granularMode ? (
                      <div className="space-y-2">
                        {(options.read_scopes?.length ?? 0) > 0 && (
                          <div className="space-y-1">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-aux text-ink-fg-2">
                                {t('settings.mcp.policy.readScopesLabel')}
                              </span>
                              <button
                                type="button"
                                onClick={() =>
                                  setGranularScopes((cur) =>
                                    Array.from(new Set([...cur, ...(options.read_scopes ?? [])]))
                                  )
                                }
                                className="text-aux text-coral hover:underline"
                              >
                                {t('settings.mcp.policy.selectAllRead')}
                              </button>
                            </div>
                            <div className="grid grid-cols-2 gap-1.5">
                              {(options.read_scopes ?? []).map((scope) => (
                                <label
                                  key={scope}
                                  className="flex items-center gap-2 rounded border border-ink-border-soft px-2 py-1.5 text-aux text-ink-fg cursor-pointer"
                                >
                                  <Checkbox
                                    checked={granularScopes.includes(scope)}
                                    onCheckedChange={(checked) =>
                                      toggleGranularScope(scope, checked)
                                    }
                                    aria-label={scopeText.label(scope)}
                                  />
                                  <span className="truncate">{scopeText.label(scope)}</span>
                                </label>
                              ))}
                            </div>
                          </div>
                        )}
                        {(options.write_scopes?.length ?? 0) > 0 && (
                          <div className="space-y-1">
                            <div className="text-aux text-ink-fg-2">
                              {t('settings.mcp.policy.writeScopesLabel')}
                            </div>
                            <div className="grid grid-cols-2 gap-1.5">
                              {(options.write_scopes ?? []).map(({ scope, risk }) => (
                                <label
                                  key={scope}
                                  className="flex items-center gap-2 rounded border border-ink-border-soft px-2 py-1.5 text-aux cursor-pointer"
                                >
                                  <Checkbox
                                    checked={granularScopes.includes(scope)}
                                    onCheckedChange={(checked) =>
                                      toggleGranularScope(scope, checked)
                                    }
                                    aria-label={scopeText.label(scope)}
                                  />
                                  <span
                                    className={cn(
                                      'truncate',
                                      risk === 'high' ? 'text-warn' : 'text-ink-fg'
                                    )}
                                  >
                                    {scopeText.label(scope)}
                                  </span>
                                </label>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ) : null}

                    <div className="grid grid-cols-2 gap-2.5">
                      <div>
                        <label htmlFor="mcp-key-ttl" className="mb-1 block text-aux text-ink-fg-2">
                          {t('settings.mcp.policy.ttlLabel')}
                        </label>
                        <select
                          id="mcp-key-ttl"
                          value={ttlDays == null ? 'never' : String(ttlDays)}
                          onChange={(e) => {
                            const val = e.target.value
                            setTtlDirty(true)
                            setTtlDays(val === 'never' ? null : Number(val))
                          }}
                          className="h-8 w-full rounded-[var(--r-ctl)] border border-ink-border bg-ink-1 px-2 text-aux text-ink-fg outline-none focus:border-coral"
                        >
                          <option value="never">{t('settings.mcp.policy.ttlNever')}</option>
                          <option value="7">{t('settings.mcp.policy.ttlDays', { days: 7 })}</option>
                          <option value="30">
                            {t('settings.mcp.policy.ttlDays', { days: 30 })}
                          </option>
                          <option value="90">
                            {t('settings.mcp.policy.ttlDays', { days: 90 })}
                          </option>
                        </select>
                      </div>
                      <div>
                        <label htmlFor="mcp-key-rpm" className="mb-1 block text-aux text-ink-fg-2">
                          {t('settings.mcp.policy.writeRpmLabel')}
                        </label>
                        <Input
                          id="mcp-key-rpm"
                          type="number"
                          min={1}
                          max={10000}
                          value={writeRpmText}
                          onChange={(e) => {
                            setRpmDirty(true)
                            setWriteRpmText(e.target.value)
                          }}
                          placeholder={t('settings.mcp.policy.writeRpmUnlimited')}
                        />
                      </div>
                    </div>

                    {(options.available_tools?.length ?? 0) > 0 && (
                      <div className="space-y-1.5">
                        <div className="text-aux text-ink-fg-2">
                          {t('settings.mcp.policy.disabledToolsLabel')}
                        </div>
                        <div className="max-h-36 space-y-1 overflow-y-auto rounded border border-ink-border-soft p-2 scrollbar-thin">
                          {(options.available_tools ?? []).map((tool) => {
                            const rawToolName = tool.tool || tool.name.replace(/^mailagent_/, '')
                            const isOff = disabledTools.includes(rawToolName)
                            return (
                              <label
                                key={tool.name}
                                className="flex items-center justify-between gap-2 text-aux cursor-pointer"
                              >
                                <span className="truncate font-mono text-meta text-ink-fg">
                                  {tool.name}
                                </span>
                                <span className="inline-flex shrink-0 items-center gap-1.5 text-aux text-ink-fg-2">
                                  <Checkbox
                                    checked={!isOff}
                                    onCheckedChange={(enabled) =>
                                      toggleDisabledTool(rawToolName, !enabled)
                                    }
                                    aria-label={tool.name}
                                  />
                                  <span>
                                    {isOff
                                      ? t('settings.mcp.policy.toolDisabled')
                                      : t('settings.mcp.policy.toolEnabled')}
                                  </span>
                                </span>
                              </label>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        )}

        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {t('settings.mcp.cancel')}
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={!canSubmit}>
            {submitting ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {editing ? t('settings.mcp.editScopes.submit') : t('settings.mcp.create.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
