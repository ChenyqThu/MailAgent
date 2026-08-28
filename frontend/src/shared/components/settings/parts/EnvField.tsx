// Sprint 18 §PR D — generic .env-backed field renderer.
//
// One <EnvField envKey="NOTION_TOKEN" control="password" label={t(...)}
// helper={t(...)} /> draws a complete Row with the right control type, wires
// blur → env:set, optimistically updates useEnvStore, and dispatches
// markRestartRequired on success. On failure the local input reverts to the
// store value and a toast carries the error code.
//
// SECRETS are handled here as `control="password"` for read-only mask UI —
// the value bound to the input is ALWAYS '' (renderer never has the plaintext),
// the input is write-only with a reveal toggle that flips type=password ↔
// text on what the user is currently TYPING (not what's stored). For the two
// secrets that Electron-main itself consumes (LLM_API_KEY,
// MAILAGENT_CLI_API_KEY) use <EnvSecretField> instead — it dual-writes to
// keytar + .env so both Python and the main process see the same key.

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Eye, EyeOff, Loader2, X } from 'lucide-react'

import type { EnvSetResult } from '@shared/api/types'
import { cn } from '@shared/lib/cn'
import { Input } from '@shared/components/ui/input'
import { Switch } from '@shared/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@shared/components/ui/select'
import { toastError, toastSuccess } from '@shared/state/toast'
import { applyEnvPatch, useEnvStore } from '@shared/state/env'
import { useRestartStore } from '@shared/state/restart'

import { Row } from './Row'

/** Coerce a ReactNode label into a string for toast titles, which expect a
 *  plain string. Non-string nodes (rare — most labels are i18n strings) fall
 *  back to the envKey so the toast still surfaces something meaningful. */
function labelString(node: React.ReactNode, fallback: string): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  return fallback
}

export type EnvFieldControl =
  | 'text'
  | 'number'
  | 'toggle'
  | 'select'
  | 'tag-list'
  | 'date'
  | 'password'
  | 'readonly'

interface EnvFieldOption {
  value: string
  label: React.ReactNode
}

/** select-only（task 07-12 P3）：分组选项（provider registry on 时功能位选择器按
 *  provider 分组）。与 `options` 可并存——`options` 先渲染为未分组项（如「不设备
 *  模型」空值哨兵），组随后。不传 = 旧扁平渲染，字节级不变。 */
interface EnvFieldOptionGroup {
  label: React.ReactNode
  options: EnvFieldOption[]
}

interface EnvFieldProps {
  envKey: string
  control: EnvFieldControl
  label: React.ReactNode
  helper?: React.ReactNode
  /** Required for control="select". */
  options?: EnvFieldOption[]
  /** select-only：分组选项，见 EnvFieldOptionGroup。 */
  optionGroups?: EnvFieldOptionGroup[]
  /** Optional placeholder for text/number/password. */
  placeholder?: string
  /** number-only — UI lets the user type within these bounds but server
   *  validation isn't enforced (Python re-validates via pydantic). */
  min?: number
  max?: number
  /** UI label for the toast that fires on successful save (e.g. "已保存
   *  Notion Token"). Defaults to the label prop. */
  savedToastTitle?: React.ReactNode
  /** Disable interaction (e.g. when a parent toggle is off). */
  disabled?: boolean
  /** Hide the field entirely (handy for conditional sub-fields). */
  hidden?: boolean
  /** Skip markRestartRequired on save — for keys the backend hot-reads from
   *  .env (e.g. TAVILY_API_KEY, read live via dotenv_values), so the "需重启"
   *  banner would be misleading. Defaults false (most keys need a restart). */
  hotReload?: boolean
  /** toggle-only — how an UNSET key ('' in the snapshot) renders. Default false
   *  (unset → off), correct for default-false backend flags. Pass true for
   *  default-ON flags (MAILAGENT_MEM0_CAPTURE 等 cutover 后默认开、显式 false 才
   *  回退的键): unset must render as ON or the toggle is lying about the actual
   *  behavior (WebCapabilityRow 先例 — 未设 → 按默认 ON 展示)。Explicit values
   *  ('true'/'false'/garbage) render the same regardless of this prop. */
  defaultOn?: boolean
  /** select-only — render the `placeholder` when the key is UNSET. Radix only
   *  shows a placeholder for value===''|undefined; EnvField maps '' to a
   *  sentinel (needed by callers with a real ''-valued option, e.g. AiTab
   *  LLM_FALLBACK_MODELS), so an unset key otherwise renders a BLANK trigger.
   *  Opt in for enum keys with a backend default (ISLAND_MAIL_NOTIFY_SCOPE 等):
   *  unset → value=undefined → placeholder announces the effective default
   *  (「仅重要（默认）」) instead of blank. Explicit stored values unaffected. */
  placeholderOnEmpty?: boolean
  className?: string
}

function joinTags(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export function EnvField({
  envKey,
  control,
  label,
  helper,
  options,
  optionGroups,
  placeholder,
  min,
  max,
  savedToastTitle,
  disabled = false,
  hidden = false,
  hotReload = false,
  defaultOn = false,
  placeholderOnEmpty = false,
  className
}: EnvFieldProps): React.ReactElement | null {
  const { t } = useTranslation()
  const storeState = useEnvStore((s) => s.state)
  const markRestartRequired = useRestartStore((s) => s.markRestartRequired)

  // Remote web (HttpApi) is read-only: env.set is notImplemented, so all write
  // controls render disabled. Same VITE_BUILD_TARGET probe as api/factory.ts
  // (曾同款的 StatusBar 已随 08-27 标签工作区批退役)。
  const isWeb =
    (import.meta as unknown as { env?: { VITE_BUILD_TARGET?: string } }).env?.VITE_BUILD_TARGET ===
    'web'

  // store value — for secrets this is '***' (set) or '' (unset); for non-
  // secrets it's the plaintext .env value (managed keys only).
  const storeValue = storeState.status === 'ready' ? (storeState.snapshot.values[envKey] ?? '') : ''
  const isSecret =
    storeState.status === 'ready' ? storeState.snapshot.secretKeys.includes(envKey) : false

  // Local mirror: what the user is currently editing. For secrets, the local
  // state holds plaintext UNTIL blur (then it's sent through env:set and
  // cleared). For non-secrets the local mirror matches the store value.
  const [local, setLocalValue] = React.useState<string>(() => (isSecret ? '' : storeValue))
  const [revealed, setRevealed] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  // React docs "Storing information from previous renders" pattern: hold the
  // last storeValue we synced from in plain state, then conditionally call
  // setState during render. React bails out when the second setState in the
  // same render matches existing state.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [lastSyncedStore, setLastSyncedStore] = React.useState(storeValue)
  if (storeValue !== lastSyncedStore) {
    setLastSyncedStore(storeValue)
    if (!isSecret) setLocalValue(storeValue)
  }

  if (hidden) return null

  async function persist(patch: Record<string, string | null>): Promise<EnvSetResult> {
    setSubmitting(true)
    try {
      const result = await applyEnvPatch(patch)
      if (result.ok) {
        if (!hotReload && result.changedKeys.length > 0) {
          markRestartRequired(result.changedKeys)
        }
        toastSuccess(labelString(savedToastTitle ?? label, envKey))
      } else {
        toastError(labelString(label, envKey), `${result.error.code}: ${result.error.message}`)
        // Revert local to whatever the store currently shows. The render-
        // phase sync block above handles re-comparing on the next render —
        // we don't need to touch lastSyncedStore manually.
        setLocalValue(isSecret ? '' : storeValue)
      }
      return result
    } finally {
      setSubmitting(false)
    }
  }

  function handleTextBlur(next: string): void {
    const trimmed = next
    if (trimmed === storeValue && !isSecret) return // no-op blur
    if (trimmed.length === 0 && isSecret) return // empty secret blur = noop
    void persist({ [envKey]: trimmed })
    if (isSecret) {
      // Clear plaintext from local memory the moment we hand it off to IPC.
      // The IPC has already serialized the value into the rename-target
      // string; React won't keep it longer than the next render.
      setLocalValue('')
      setRevealed(false)
    }
  }

  async function handleToggle(checked: boolean): Promise<void> {
    void persist({ [envKey]: checked ? 'true' : 'false' })
  }

  // password-only — explicit "clear" (env:set null → comments out the .env line).
  // The plain blur-with-empty path is a no-op for secrets (line 166) so a set key
  // can't be cleared by typing nothing; this CTA is the dedicated unset flow. Only
  // rendered when a value is stored (hasStored) so it can't fire on an already-empty
  // field. applyEnvPatch handles the null → unsetLocal optimistic drop.
  function handleClear(): void {
    void persist({ [envKey]: null })
    setLocalValue('')
    setRevealed(false)
  }

  async function handleSelect(value: string): Promise<void> {
    void persist({ [envKey]: value })
  }

  function handleTagListBlur(next: string): void {
    const normalized = joinTags(next).join(',')
    if (normalized === storeValue) return
    void persist({ [envKey]: normalized })
  }

  // idle / loading → spinner (first env:get round-trip in flight).
  if (storeState.status === 'idle' || storeState.status === 'loading') {
    return (
      <Row label={label} helper={helper} className={className}>
        <Loader2 className="size-4 animate-spin text-ink-fg-3" aria-label="loading" />
      </Row>
    )
  }

  // error → render the field disabled with empty value (storeValue=''/isSecret=
  // false default above) + a tiny error hint. NEVER an infinite spinner: a failed
  // env.get used to leave the whole tab spinning (Bug 6 — remote web env.get).
  const loadFailed = storeState.status === 'error'

  // Remote web is read-only; a failed load disables writes too.
  // The "remote read-only" notice is surfaced ONCE page-level (SettingsShell
  // banner), not per-field — repeating it on ~72 fields would be noise AND
  // would clobber each field's own helper. Here we only keep the control
  // disabled in web; the helper is preserved verbatim.
  const effectiveDisabled = disabled || isWeb || loadFailed

  // helper line: on load failure APPEND a one-line error hint below the field's
  // own helper (never replace it — keep the field documentation). Otherwise the
  // original helper passes through untouched.
  const helperWithNotice: React.ReactNode = loadFailed ? (
    <>
      {helper}
      <span className="block text-ink-fg-3">{t('settings.env.loadError')}</span>
    </>
  ) : (
    helper
  )

  // sharedInputProps is reused across text/number/date/tag-list cases.
  // `placeholder` is deliberately NOT included — each case threads its own
  // placeholder so the per-case i18n default (tag-list comma-separated hint etc.)
  // can win over the caller-supplied prop without dropping it on tag-list.
  const sharedInputProps = {
    disabled: effectiveDisabled || submitting,
    className: cn('w-[260px]')
  }

  switch (control) {
    case 'toggle': {
      // Unset ('') renders the backend default (defaultOn); explicit values are
      // literal. Mirrors WebCapabilityRow's envBool rendering for default-ON keys.
      const isOn = storeValue === '' ? defaultOn : storeValue === 'true' || storeValue === '1'
      return (
        <Row label={label} helper={helperWithNotice} className={className}>
          <Switch
            checked={isOn}
            disabled={effectiveDisabled || submitting}
            onCheckedChange={handleToggle}
            aria-label={typeof label === 'string' ? label : envKey}
          />
        </Row>
      )
    }
    case 'select': {
      // Radix UI SelectItem does not allow an empty string value (it reserves ''
      // for the clear/placeholder semantic and throws at runtime). Options with
      // value='' are mapped to this sentinel for rendering and mapped back on
      // change so callers (e.g. AiTab LLM_FALLBACK_MODELS) need no changes.
      const SELECT_EMPTY_SENTINEL = '__empty__'
      const toDisplay = (v: string): string => (v === '' ? SELECT_EMPTY_SENTINEL : v)
      const fromDisplay = (v: string): string => (v === SELECT_EMPTY_SENTINEL ? '' : v)

      // placeholderOnEmpty：未设键传 undefined 让 Radix 走 placeholder 分支
      // （sentinel 无匹配项时 trigger 是空白，见 prop 注释）。
      const selectValue =
        placeholderOnEmpty && storeValue === ''
          ? undefined
          : storeValue !== undefined
            ? toDisplay(storeValue)
            : undefined
      return (
        <Row label={label} helper={helperWithNotice} className={className}>
          <div className="w-[200px]">
            <Select
              value={selectValue}
              onValueChange={(v) => handleSelect(fromDisplay(v))}
              disabled={effectiveDisabled || submitting}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={placeholder ?? t('settings.envField.selectPlaceholder')}
                />
              </SelectTrigger>
              <SelectContent>
                {(options ?? []).map((o) => (
                  <SelectItem key={toDisplay(o.value)} value={toDisplay(o.value)}>
                    {o.label}
                  </SelectItem>
                ))}
                {(optionGroups ?? []).map((g, gi) => (
                  <SelectGroup key={gi}>
                    <SelectLabel>{g.label}</SelectLabel>
                    {g.options.map((o) => (
                      <SelectItem key={toDisplay(o.value)} value={toDisplay(o.value)}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </div>
        </Row>
      )
    }
    case 'number': {
      return (
        <Row label={label} helper={helperWithNotice} className={className}>
          <Input
            type="number"
            value={local}
            onChange={(e) => setLocalValue(e.target.value)}
            onBlur={(e) => handleTextBlur(e.target.value)}
            min={min}
            max={max}
            placeholder={placeholder}
            {...sharedInputProps}
            className={cn(sharedInputProps.className, 'w-[140px]')}
          />
        </Row>
      )
    }
    case 'date': {
      return (
        <Row label={label} helper={helperWithNotice} className={className}>
          <Input
            type="date"
            value={local}
            onChange={(e) => setLocalValue(e.target.value)}
            onBlur={(e) => handleTextBlur(e.target.value)}
            placeholder={placeholder}
            {...sharedInputProps}
            className={cn(sharedInputProps.className, 'w-[180px]')}
          />
        </Row>
      )
    }
    case 'tag-list': {
      return (
        <Row label={label} helper={helperWithNotice} className={className}>
          <Input
            value={local}
            onChange={(e) => setLocalValue(e.target.value)}
            onBlur={(e) => handleTagListBlur(e.target.value)}
            {...sharedInputProps}
            placeholder={placeholder ?? t('settings.envField.tagListPlaceholder')}
          />
        </Row>
      )
    }
    case 'password': {
      const hasStored = storeValue.length > 0
      // Clear CTA only when a value is stored AND the field is writable (web is read-only,
      // load-failed disables writes). Sits left of the reveal toggle; input reserves pr-16
      // when both show, pr-9 when reveal-only (no stored value → nothing to clear).
      const showClear = hasStored && !effectiveDisabled
      return (
        <Row label={label} helper={helperWithNotice} className={className}>
          <div className="relative w-[260px]">
            <Input
              type={revealed ? 'text' : 'password'}
              value={local}
              onChange={(e) => setLocalValue(e.target.value)}
              onBlur={(e) => handleTextBlur(e.target.value)}
              placeholder={
                hasStored
                  ? t('settings.envField.secretSet')
                  : (placeholder ?? t('settings.envField.secretUnset'))
              }
              disabled={effectiveDisabled || submitting}
              className={showClear ? 'pr-16' : 'pr-9'}
              aria-label={typeof label === 'string' ? label : envKey}
            />
            {showClear && (
              <button
                type="button"
                tabIndex={-1}
                onClick={handleClear}
                disabled={submitting}
                aria-label={t('settings.envField.clear')}
                title={t('settings.envField.clear')}
                className={cn(
                  'absolute right-9 top-1/2 -translate-y-1/2 inline-flex h-7 w-7 items-center justify-center rounded-md',
                  'text-ink-fg-2 hover:bg-ink-3 hover:text-ink-fg',
                  'transition-colors duration-fast ease-standard',
                  'disabled:opacity-40 disabled:pointer-events-none'
                )}
              >
                <X className="size-4" />
              </button>
            )}
            <button
              type="button"
              tabIndex={-1}
              onClick={() => setRevealed((v) => !v)}
              disabled={local.length === 0}
              aria-label={revealed ? t('settings.envField.hide') : t('settings.envField.reveal')}
              className={cn(
                'absolute right-1 top-1/2 -translate-y-1/2 inline-flex h-7 w-7 items-center justify-center rounded-md',
                'text-ink-fg-2 hover:bg-ink-3 hover:text-ink-fg',
                'transition-colors duration-fast ease-standard',
                'disabled:opacity-40 disabled:pointer-events-none'
              )}
            >
              <span className="icon-swap">
                <span className="icon-swap-item" data-active={revealed ? 'true' : 'false'}>
                  <EyeOff className="size-4" />
                </span>
                <span className="icon-swap-item" data-active={revealed ? 'false' : 'true'}>
                  <Eye className="size-4" />
                </span>
              </span>
            </button>
          </div>
        </Row>
      )
    }
    case 'readonly': {
      return (
        <Row label={label} helper={helperWithNotice} className={className}>
          <div className="w-[260px] text-aux text-ink-fg-1 truncate" title={storeValue}>
            {storeValue.length > 0 ? storeValue : <span className="text-ink-fg-3">—</span>}
          </div>
        </Row>
      )
    }
    case 'text':
    default: {
      return (
        <Row label={label} helper={helperWithNotice} className={className}>
          <Input
            type="text"
            value={local}
            onChange={(e) => setLocalValue(e.target.value)}
            onBlur={(e) => handleTextBlur(e.target.value)}
            placeholder={placeholder}
            {...sharedInputProps}
          />
        </Row>
      )
    }
  }
}
