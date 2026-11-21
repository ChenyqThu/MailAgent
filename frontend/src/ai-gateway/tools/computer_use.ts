// WS-4 (`computer_use_run` — design.md §5.1–§5.4): bounded Browser / Desktop operator sub-agent.
//
// Security & Reliability Invariants:
//   1. Risk & Venue Floor: `class: 'exec'`, `tier: 'edit'` (default ask, configurable=false in
//      `tool_prefs.py`). Structurally excluded and execute-time rejected in `im_chat`,
//      `untrusted_trigger`, `contact_governance`, `matter_followup`, and `cron_headless` in Wave 4.
//   2. Parent-Child Session & Tool Isolation: creates/reuses an auditable child session
//      (`parentSessionId`, `parentToolCallId`, `invokedBy: 'main_agent'`), forwards only
//      active `mcp__browser_use__*` / `mcp__desktop_use__*` tools (filtered by `target_hint`),
//      and NEVER exposes `computer_use_run` (zero recursion) or mail/file/exec tools.
//   3. Sliding-Window Visual Pruning: child `prepareStep({ messages })` retains full screenshot
//      images ONLY for the latest <= 2 visual steps, replacing older visual parts with concise text
//      placeholders `[screenshot from step #k omitted: see action summary]`.
//   4. App / Domain Scope Guard: rejects non-`http(s)://` URL schemes (`file://`, `javascript:`,
//      `data:`, `chrome://`, etc.), rejects suffix-spoofed domains (`evil-oa.company.com.attacker.io`),
//      and aborts on app/domain drift (`status: 'scope_violation'`).
//   5. `stop_before_submit` Terminal Dock: defaults to `true` (and can be host-forced `true`),
//      intercepting irreversible Submit/Send/Approve/Pay/Delete controls and returning
//      `status: 'awaiting_confirmation'` with `filled_fields`, `pending_action`, `current_url_or_app`.
//   6. Narrow `auto_scope_grant`: `policyEvaluate` may auto-allow ONLY when `contextMode === 'manual_chat'`,
//      `stop_before_submit === true`, and non-empty concrete allowlists match (`*` or empty lists NEVER).

import {
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type Tool,
  type ToolSet
} from 'ai'

import {
  IDLE_COMPUTER_USE_ACTIVITY,
  type ComputerUseActivityState,
  type ComputerUseSurface
} from '../../shared/computerUseOverlayContract'
import { DomainError, type DomainPolicyVerdict, type MailAgentDomainClient } from '../python/domainClient'
import type { ApprovalGuard } from '../security/approval'
import {
  isCustomAgentComputerUseEnabled,
  isMatterItemComputerUseEnabled,
  isToolAllowedInContext,
  normalizeContextMode,
  type AgentContextMode,
  type AgentModeGrants,
  type AgentRunContext,
  type CustomAgentComputerUsePolicy,
  type MatterItemComputerUsePolicy
} from './policy'
import { computerUseRunSchema, type ComputerUseRunInput } from './schemas'
import {
  auditedWriteTool,
  type GatewayApprovalMode,
  type GatewayToolApprovalPrefs,
  type GatewayToolAuditCollector
} from './types'

/** Catalog source-of-truth array inspected by `tests/agent_eval/runner/validate_catalog.py`. */
export const GATEWAY_COMPUTER_USE_TOOL_NAMES = ['computer_use_run'] as const

export const BROWSER_USE_PREFIX = 'mcp__browser_use__'
export const DESKTOP_USE_PREFIX = 'mcp__desktop_use__'
export const MAX_CHILD_VISUAL_STEPS = 2

const UNSAFE_OR_ALLOWED_SCHEMES = new Set(['http:', 'https:'])
const TERMINAL_COMMIT_ACTION_RE =
  /\b(submit|send|approve|pay|checkout|purchase|confirm(\s+payment|\s+order|\s+delete|\s+transfer)?|delete|remove|destroy|publish|transfer|wire)\b|提交|发送|确认付款|确认支付|审批通过|批准|删除|注销|发布|转账/i
const SENSITIVE_FIELD_RE = /(pass(word)?|secret|token|pin|otp|cvv|cvc|ssn)/i
const URL_ARG_KEYS = new Set(['url', 'href', 'uri', 'target_url', 'targetUrl', 'start_url', 'startUrl'])
const APP_ARG_KEYS = new Set([
  'app',
  'application',
  'bundle_id',
  'bundleId',
  'app_name',
  'appName',
  'target_app',
  'targetApp',
  'window_app',
  'windowApp'
])
const FILL_TOOL_NAME_RE = /(fill|type|input|enter|select|choose|set_value|press_key)/i
const SUBMIT_CLICK_TOOL_NAME_RE = /(click|submit|press|tap|invoke|activate|double_click|confirm)/i

export type ComputerUseTargetHint = 'auto' | 'browser' | 'desktop'

export interface AutoScopeGrantVerdict extends DomainPolicyVerdict {
  granted_apps?: string[]
  granted_domains?: string[]
}

export type ComputerUseAutoScopeGrantEvaluator = (
  input: ComputerUseRunInput,
  contextMode: AgentContextMode
) => Promise<AutoScopeGrantVerdict>

export interface ComputerUseToolDeps {
  model?: LanguageModel
  resolveChildModel?: () => Promise<LanguageModel> | LanguageModel
  maxOutputTokens?: number
  childTools?: ToolSet
  parentSessionId?: number | null
  findSessionByParentToolCall?: (parentSessionId: number, parentToolCallId: string) => number | null
  createAgentSession?: (input: {
    agentId: string
    title: string
    parentSessionId: number
    parentToolCallId: string
    invokedBy: 'user' | 'main_agent'
  }) => number
  persistChildSummary?: (sessionId: number, summaryText: string) => void
  evaluateAutoScopeGrant?: ComputerUseAutoScopeGrantEvaluator
  forceStopBeforeSubmit?: boolean
  matterItemPolicy?: MatterItemComputerUsePolicy
  customAgentPolicy?: CustomAgentComputerUsePolicy
  onActivity?: (state: ComputerUseActivityState) => void
  registerAbort?: (runId: string, abort: () => void) => () => void
}

export interface ComputerUseExecutionBinding {
  model?: LanguageModel
  maxOutputTokens?: number
  sessionId?: number | null
  finalTools?: ToolSet
}

interface InternalComputerUseBinding extends ComputerUseExecutionBinding {
  getChildToolsFromFinalSet?: () => ToolSet | undefined
}

const computerUseBindings = new WeakMap<object, InternalComputerUseBinding>()

/** Attach live turn context (`resolvedModel`, `sessionId`, final `ToolSet`) to `computer_use_run`
 *  after `prepareChatRun` completes tool filtering & model resolution. */
export function bindComputerUseExecution(
  toolObj: Tool | undefined,
  binding: ComputerUseExecutionBinding
): boolean {
  const execFn = toolObj?.execute
  if (typeof execFn !== 'function') return false
  const target = computerUseBindings.get(execFn)
  if (!target) return false
  if (binding.model !== undefined) target.model = binding.model
  if (binding.maxOutputTokens !== undefined) target.maxOutputTokens = binding.maxOutputTokens
  if (binding.sessionId !== undefined) target.sessionId = binding.sessionId
  if (binding.finalTools !== undefined) target.finalTools = binding.finalTools
  return true
}

export function isComputerUseChildToolName(name: string): boolean {
  return (
    typeof name === 'string' &&
    (name.startsWith(BROWSER_USE_PREFIX) || name.startsWith(DESKTOP_USE_PREFIX))
  )
}

/** Return ONLY admitted `mcp__browser_use__*` and/or `mcp__desktop_use__*` child tools matching `targetHint`.
 *  Never admits `computer_use_run` or unrelated built-in/connector tools. */
export function selectComputerUseChildTools(
  allTools: ToolSet,
  targetHint: ComputerUseTargetHint = 'auto'
): ToolSet {
  const out: ToolSet = {}
  for (const [name, tool] of Object.entries(allTools)) {
    if (name === 'computer_use_run') continue
    if (name.startsWith(BROWSER_USE_PREFIX) && (targetHint === 'auto' || targetHint === 'browser')) {
      out[name] = tool
    } else if (
      name.startsWith(DESKTOP_USE_PREFIX) &&
      (targetHint === 'auto' || targetHint === 'desktop')
    ) {
      out[name] = tool
    }
  }
  return out
}

function isVisualMediaType(mediaType: unknown): boolean {
  return typeof mediaType === 'string' && (mediaType === 'image' || mediaType.startsWith('image/'))
}

function isToolResultVisualPart(part: unknown): boolean {
  if (!part || typeof part !== 'object') return false
  const p = part as { type?: unknown; mediaType?: unknown }
  if (p.type === 'image-data') return true
  if ((p.type === 'file' || p.type === 'file-data' || p.type === 'media') && isVisualMediaType(p.mediaType)) {
    return true
  }
  return false
}

function isMessageVisualPart(part: unknown): boolean {
  if (!part || typeof part !== 'object') return false
  const p = part as { type?: unknown; mediaType?: unknown }
  if (p.type === 'image' || p.type === 'image-data') return true
  if (p.type === 'file' && isVisualMediaType(p.mediaType)) return true
  return false
}

function messageHasVisualContent(msg: ModelMessage): boolean {
  if (!Array.isArray(msg.content)) return false
  if (msg.role === 'tool') {
    return msg.content.some((part) => {
      if (!part || typeof part !== 'object' || part.type !== 'tool-result') return false
      const out = (part as { output?: unknown }).output as
        | { type?: unknown; value?: unknown }
        | undefined
      if (!out || out.type !== 'content' || !Array.isArray(out.value)) return false
      return out.value.some(isToolResultVisualPart)
    })
  }
  if (msg.role === 'user' || msg.role === 'assistant') {
    return msg.content.some(isMessageVisualPart)
  }
  return false
}

/** Retain visual screenshot payloads ONLY for the latest `<= maxVisualSteps` visual steps;
 *  older visual parts are replaced in a cloned message structure with concise text placeholders. */
export function pruneSlidingWindowScreenshots(
  messages: ModelMessage[],
  maxVisualSteps = MAX_CHILD_VISUAL_STEPS
): ModelMessage[] {
  const keepCount = Math.max(0, Math.trunc(maxVisualSteps))
  const visualMessageIndices: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messageHasVisualContent(messages[i])) visualMessageIndices.push(i)
  }
  if (visualMessageIndices.length <= keepCount) return messages

  const cutoff = visualMessageIndices.length - keepCount
  const prunedStepByIndex = new Map<number, number>()
  for (let idx = 0; idx < cutoff; idx++) {
    prunedStepByIndex.set(visualMessageIndices[idx], idx + 1)
  }

  return messages.map((msg, msgIdx) => {
    const visualStepNumber = prunedStepByIndex.get(msgIdx)
    if (visualStepNumber === undefined || !Array.isArray(msg.content)) return msg
    const placeholderText = `[screenshot from step #${visualStepNumber} omitted: see action summary]`

    if (msg.role === 'tool') {
      const nextContent = msg.content.map((part) => {
        if (!part || typeof part !== 'object' || part.type !== 'tool-result') return part
        const toolPart = part as {
          type: 'tool-result'
          toolCallId: string
          toolName: string
          output?: { type?: unknown; value?: unknown }
        }
        const out = toolPart.output
        if (!out || out.type !== 'content' || !Array.isArray(out.value)) return part
        let changed = false
        const nextValues = out.value.map((valPart) => {
          if (isToolResultVisualPart(valPart)) {
            changed = true
            return { type: 'text' as const, text: placeholderText }
          }
          return valPart
        })
        if (!changed) return part
        return {
          ...toolPart,
          output: {
            ...out,
            value: nextValues
          }
        }
      })
      return { ...msg, content: nextContent } as ModelMessage
    }

    if (msg.role === 'user' || msg.role === 'assistant') {
      let changed = false
      const nextContent = msg.content.map((part) => {
        if (isMessageVisualPart(part)) {
          changed = true
          return { type: 'text' as const, text: placeholderText }
        }
        return part
      })
      return changed ? ({ ...msg, content: nextContent } as ModelMessage) : msg
    }

    return msg
  })
}

export interface UrlValidationResult {
  allowed: boolean
  reason?: 'invalid_url' | 'blocked_scheme' | 'domain_not_allowed'
  host?: string
  scheme?: string
}

function normalizeDomainPattern(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase().replace(/\.+$/, '')
  if (!trimmed || trimmed === '*' || trimmed === '*.*') return null
  const stripped = trimmed.startsWith('*.') ? trimmed.slice(2) : trimmed
  if (!stripped || stripped.includes('*')) return null
  if (stripped.includes('://')) {
    try {
      const parsed = new URL(stripped)
      return parsed.hostname.toLowerCase().replace(/\.+$/, '') || null
    } catch {
      return null
    }
  }
  const slashIdx = stripped.indexOf('/')
  const hostPart = slashIdx >= 0 ? stripped.slice(0, slashIdx) : stripped
  const colonIdx = hostPart.indexOf(':')
  const hostOnly = colonIdx >= 0 ? hostPart.slice(0, colonIdx) : hostPart
  return hostOnly || null
}

/** Validate a URL against safe protocols (`http:` / `https:`) and exact/subdomain `allowedDomains`.
 *  Prevents `file://`, `javascript:`, `chrome://`, and suffix spoofing like `evil-oa.company.com.attacker.io`. */
export function validateNavigationUrl(
  rawUrl: string,
  allowedDomains?: readonly string[]
): UrlValidationResult {
  if (typeof rawUrl !== 'string') return { allowed: false, reason: 'invalid_url' }
  const cleaned = rawUrl.trim()
  if (!cleaned || /[\r\n\0]/.test(cleaned)) return { allowed: false, reason: 'invalid_url' }

  let parsed: URL
  try {
    parsed = new URL(cleaned)
  } catch {
    return { allowed: false, reason: 'invalid_url' }
  }

  const scheme = parsed.protocol.toLowerCase()
  if (!UNSAFE_OR_ALLOWED_SCHEMES.has(scheme)) {
    return { allowed: false, reason: 'blocked_scheme', scheme }
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase()
  if (!host) return { allowed: false, reason: 'invalid_url' }

  if (allowedDomains && allowedDomains.length > 0) {
    const matched = allowedDomains.some((rawRule) => {
      const rule = normalizeDomainPattern(rawRule)
      if (!rule) return false
      return host === rule || host.endsWith(`.${rule}`)
    })
    if (!matched) {
      return { allowed: false, reason: 'domain_not_allowed', host, scheme }
    }
  }

  return { allowed: true, host, scheme }
}

/** Strict app / bundle ID matching (prevents bare wildcards and loose substring matches). */
export function matchesAllowedApp(
  observedApp: string,
  allowedApps?: readonly string[]
): boolean {
  if (!allowedApps || allowedApps.length === 0) return true
  const normObserved = observedApp.trim().toLowerCase().replace(/\.app$/, '')
  if (!normObserved) return false
  return allowedApps.some((rawRule) => {
    const rule = rawRule.trim().toLowerCase()
    if (!rule || rule.includes('*')) return false
    const normRule = rule.replace(/\.app$/, '')
    return normObserved === normRule
  })
}

function isConcreteScopeEntry(raw: string): boolean {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.includes('*')) return false
  const lower = trimmed.toLowerCase()
  return lower !== 'all' && lower !== 'any'
}

/** Pure predicate checking whether `auto_scope_grant` prerequisites hold:
 *  manual_chat + stop_before_submit === true + non-empty concrete allowlist(s) matching target_hint. */
export function isBoundedScopeForAutoGrant(
  input: Pick<ComputerUseRunInput, 'target_hint' | 'allowed_apps' | 'allowed_domains' | 'stop_before_submit'>,
  contextMode: AgentContextMode
): boolean {
  if (contextMode !== 'manual_chat') return false
  if (input.stop_before_submit === false) return false

  const apps = (input.allowed_apps ?? []).filter((v) => typeof v === 'string' && v.trim().length > 0)
  const domains = (input.allowed_domains ?? []).filter((v) => typeof v === 'string' && v.trim().length > 0)

  if (apps.length === 0 && domains.length === 0) return false
  if (apps.some((a) => !isConcreteScopeEntry(a))) return false
  if (domains.some((d) => !isConcreteScopeEntry(d) || normalizeDomainPattern(d) === null)) {
    return false
  }

  const hint = input.target_hint ?? 'auto'
  if (hint === 'browser' && domains.length === 0) return false
  if (hint === 'desktop' && apps.length === 0) return false
  return true
}

function strictListSubset(requested: readonly string[] | undefined, granted: readonly string[] | undefined): boolean {
  if (!requested || requested.length === 0) return true
  if (!granted || granted.length === 0) return false
  const grantedSet = new Set(granted.map((g) => g.trim().toLowerCase()))
  return requested.every((r) => grantedSet.has(r.trim().toLowerCase()))
}

interface BoundedComputerUseScopePolicy {
  allowedApps: readonly string[]
  allowedDomains: readonly string[]
  connectors: readonly ('browser_use' | 'desktop_use')[]
}

function resolveBoundedScope(
  input: ComputerUseRunInput,
  policy: BoundedComputerUseScopePolicy,
  prefix: 'matter' | 'custom_agent' = 'matter'
): { allowedApps: string[]; allowedDomains: string[] } | { violation: PreflightViolation } {
  const hint = (input.target_hint ?? 'auto') as ComputerUseTargetHint
  if (
    hint === 'browser' &&
    (policy.allowedDomains.length === 0 || !policy.connectors.includes('browser_use'))
  ) {
    return { violation: { reason: `${prefix}_target_hint_exceeded`, observed: 'browser' } }
  }
  if (
    hint === 'desktop' &&
    (policy.allowedApps.length === 0 || !policy.connectors.includes('desktop_use'))
  ) {
    return { violation: { reason: `${prefix}_target_hint_exceeded`, observed: 'desktop' } }
  }

  const reqApps = (input.allowed_apps ?? []).map((v) => v.trim()).filter(Boolean)
  if (reqApps.length > 0) {
    if (policy.allowedApps.length === 0) {
      return { violation: { reason: `${prefix}_app_scope_exceeded`, observed: reqApps[0] } }
    }
    const badApp = reqApps.find((app) => !matchesAllowedApp(app, policy.allowedApps))
    if (badApp) {
      return { violation: { reason: `${prefix}_app_scope_exceeded`, observed: badApp } }
    }
  }

  const reqDomains = (input.allowed_domains ?? []).map((v) => v.trim()).filter(Boolean)
  if (reqDomains.length > 0) {
    if (policy.allowedDomains.length === 0) {
      return { violation: { reason: `${prefix}_domain_scope_exceeded`, observed: reqDomains[0] } }
    }
    for (const rawDomain of reqDomains) {
      const host = normalizeDomainPattern(rawDomain)
      if (!host || !validateNavigationUrl(`https://${host}`, policy.allowedDomains).allowed) {
        return { violation: { reason: `${prefix}_domain_scope_exceeded`, observed: rawDomain } }
      }
    }
  }

  return {
    allowedApps: reqApps.length > 0 ? reqApps : [...policy.allowedApps],
    allowedDomains: reqDomains.length > 0 ? reqDomains : [...policy.allowedDomains]
  }
}

function resolveMatterBoundedScope(
  input: ComputerUseRunInput,
  matterPolicy: MatterItemComputerUsePolicy
): { allowedApps: string[]; allowedDomains: string[] } | { violation: PreflightViolation } {
  return resolveBoundedScope(input, matterPolicy, 'matter')
}

/** Narrow `policyEvaluate` helper: delegates to host evaluator or `/agent/policy/evaluate` ONLY
 *  when `isBoundedScopeForAutoGrant` passes, and verifies subset containment on any `auto_allow`. */
export async function evaluateComputerUsePolicy(
  input: ComputerUseRunInput,
  opts: {
    contextMode: AgentContextMode
    domain: MailAgentDomainClient
    evaluateAutoScopeGrant?: ComputerUseAutoScopeGrantEvaluator
    forceStopBeforeSubmit?: boolean
    matterItemPolicy?: MatterItemComputerUsePolicy
    customAgentPolicy?: CustomAgentComputerUsePolicy
    agentId?: string
  }
): Promise<DomainPolicyVerdict> {
  if (opts.contextMode === 'matter_followup') {
    const mp = opts.matterItemPolicy
    if (!mp || !isMatterItemComputerUseEnabled({ matterItemComputerUse: mp })) {
      return { decision: 'ask', rule_id: null }
    }
    const scoped = resolveMatterBoundedScope(input, mp)
    if ('violation' in scoped) {
      return { decision: 'ask', rule_id: null }
    }
    return {
      decision: 'auto_allow',
      rule_id: null,
      audit_status: 'auto_scope_grant'
    }
  }

  if (opts.contextMode === 'untrusted_trigger' || opts.contextMode === 'cron_headless') {
    const cp = opts.customAgentPolicy
    if (!cp || !isCustomAgentComputerUseEnabled({ customAgentComputerUse: cp })) {
      return { decision: 'ask', rule_id: null }
    }
    const scoped = resolveBoundedScope(input, cp, 'custom_agent')
    if ('violation' in scoped) {
      return { decision: 'ask', rule_id: null }
    }
    if (
      cp.submitMode === 'stop_before_submit' &&
      input.stop_before_submit === false &&
      opts.forceStopBeforeSubmit !== true
    ) {
      return { decision: 'ask', rule_id: null }
    }
    return {
      decision: 'auto_allow',
      rule_id: null,
      audit_status: 'auto_scope_grant'
    }
  }

  const effectiveInput =
    opts.forceStopBeforeSubmit === true ? { ...input, stop_before_submit: true } : input
  if (!isBoundedScopeForAutoGrant(effectiveInput, opts.contextMode)) {
    return { decision: 'ask', rule_id: null }
  }

  let verdict: AutoScopeGrantVerdict
  if (opts.evaluateAutoScopeGrant) {
    verdict = await opts.evaluateAutoScopeGrant(effectiveInput, opts.contextMode)
  } else {
    verdict = await opts.domain.policyEvaluate(
      'computer_use',
      {
        tool: 'computer_use_run',
        target_hint: effectiveInput.target_hint ?? 'auto',
        allowed_apps: effectiveInput.allowed_apps ?? [],
        allowed_domains: effectiveInput.allowed_domains ?? [],
        stop_before_submit: true
      },
      opts.contextMode,
      AbortSignal.timeout(2500),
      opts.agentId
    )
  }

  if (verdict.decision !== 'auto_allow') {
    return { decision: 'ask', rule_id: null }
  }
  if (verdict.granted_apps !== undefined && !strictListSubset(effectiveInput.allowed_apps, verdict.granted_apps)) {
    return { decision: 'ask', rule_id: null }
  }
  if (
    verdict.granted_domains !== undefined &&
    !strictListSubset(effectiveInput.allowed_domains, verdict.granted_domains)
  ) {
    return { decision: 'ask', rule_id: null }
  }
  return {
    decision: 'auto_allow',
    rule_id: verdict.rule_id ?? null,
    audit_status: verdict.audit_status ?? 'auto_scope_grant'
  }
}

interface PreflightViolation {
  reason: string
  observed: string
}

function inspectArgsForScopeViolation(
  args: unknown,
  allowedApps?: readonly string[],
  allowedDomains?: readonly string[]
): PreflightViolation | null {
  if (!args || typeof args !== 'object') return null

  const visit = (val: unknown, keyName?: string): PreflightViolation | null => {
    if (typeof val === 'string') {
      const trimmed = val.trim()
      if (!trimmed) return null
      const lower = trimmed.toLowerCase()
      const looksUrl =
        (keyName != null && URL_ARG_KEYS.has(keyName)) ||
        /^(https?|file|javascript|data|vbscript|chrome|chrome-extension|about|blob|ftp):/i.test(
          lower
        )
      if (looksUrl) {
        const res = validateNavigationUrl(trimmed, allowedDomains)
        if (!res.allowed) {
          return {
            reason: res.reason ?? 'blocked_url',
            observed: trimmed
          }
        }
      }
      if (
        keyName != null &&
        APP_ARG_KEYS.has(keyName) &&
        allowedApps &&
        allowedApps.length > 0 &&
        !matchesAllowedApp(trimmed, allowedApps)
      ) {
        return {
          reason: 'app_not_allowed',
          observed: trimmed
        }
      }
      return null
    }
    if (Array.isArray(val)) {
      for (const item of val) {
        const hit = visit(item, keyName)
        if (hit) return hit
      }
      return null
    }
    if (typeof val === 'object' && val !== null) {
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        const hit = visit(v, k)
        if (hit) return hit
      }
    }
    return null
  }

  return visit(args)
}

function extractUrlsAndAppsFromOutput(output: unknown): { urls: string[]; apps: string[]; hasImage: boolean } {
  const urls: string[] = []
  const apps: string[] = []
  let hasImage = false

  const scanString = (text: string): void => {
    for (const match of text.matchAll(/(?:Page URL|Current URL|URL)\s*:\s*([^\s"'<>]+)/gi)) {
      if (match[1]) urls.push(match[1])
    }
    for (const match of text.matchAll(/\b(?:file|javascript|chrome):\/\/[^\s"'<>]+/gi)) {
      urls.push(match[0])
    }
    for (const match of text.matchAll(/(?:Active App|Application|App)\s*:\s*([^\n\r]+)/gi)) {
      const v = match[1]?.trim()
      if (v) apps.push(v)
    }
  }

  const visit = (node: unknown, keyHint?: string): void => {
    if (node == null) return
    if (typeof node === 'string') {
      if (keyHint && URL_ARG_KEYS.has(keyHint)) urls.push(node)
      else if (keyHint === 'current_url' || keyHint === 'currentUrl') urls.push(node)
      else if (keyHint && APP_ARG_KEYS.has(keyHint)) apps.push(node)
      else if (keyHint === 'active_app' || keyHint === 'activeApp') apps.push(node)
      scanString(node)
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, keyHint)
      return
    }
    if (typeof node === 'object') {
      const rec = node as Record<string, unknown>
      if (Array.isArray(rec.images) && rec.images.length > 0) hasImage = true
      if (typeof rec.mediaType === 'string' && isVisualMediaType(rec.mediaType)) hasImage = true
      for (const [k, v] of Object.entries(rec)) {
        if (k === 'images' && Array.isArray(v)) {
          if (v.length > 0) hasImage = true
          continue
        }
        visit(v, k)
      }
    }
  }

  visit(output)
  return { urls, apps, hasImage }
}

function detectTerminalAction(toolName: string, args: unknown): string | null {
  const shortName = toolName.replace(/^mcp__(browser_use|desktop_use)__/, '')
  const checkText = (txt: string): boolean => TERMINAL_COMMIT_ACTION_RE.test(txt)

  if (/(?:^|[_-])submit(?:$|[_-])/i.test(shortName)) {
    return `${shortName}`
  }

  if (!SUBMIT_CLICK_TOOL_NAME_RE.test(shortName)) return null

  const candidates: string[] = []
  if (args && typeof args === 'object') {
    for (const key of ['element', 'label', 'name', 'text', 'selector', 'title', 'action', 'target']) {
      const val = (args as Record<string, unknown>)[key]
      if (typeof val === 'string' && val.trim().length > 0) candidates.push(val.trim())
    }
  }
  const hit = candidates.find(checkText)
  return hit ? `${shortName}: ${hit}` : null
}

function recordFilledFields(
  toolName: string,
  args: unknown,
  sink: Record<string, string>
): void {
  const shortName = toolName.replace(/^mcp__(browser_use|desktop_use)__/, '')
  if (!FILL_TOOL_NAME_RE.test(shortName) || !args || typeof args !== 'object') return
  const rec = args as Record<string, unknown>
  if (Array.isArray(rec.fields)) {
    for (const f of rec.fields) {
      if (!f || typeof f !== 'object') continue
      const item = f as Record<string, unknown>
      const k = String(item.name ?? item.label ?? item.ref ?? '').trim()
      if (!k) continue
      const rawV = String(item.value ?? '')
      sink[k] = SENSITIVE_FIELD_RE.test(k) ? '[redacted]' : rawV.slice(0, 120)
    }
    return
  }
  const fieldKey = String(
    rec.element ?? rec.label ?? rec.name ?? rec.ref ?? rec.selector ?? 'field'
  ).trim()
  const rawVal = rec.text ?? rec.value ?? rec.values
  if (rawVal !== undefined && fieldKey) {
    sink[fieldKey] = SENSITIVE_FIELD_RE.test(fieldKey)
      ? '[redacted]'
      : String(rawVal).slice(0, 120)
  }
}

function buildChildSystemPrompt(input: {
  goal: string
  targetHint: ComputerUseTargetHint
  allowedApps?: readonly string[]
  allowedDomains?: readonly string[]
  stopBeforeSubmit: boolean
}): string {
  const lines = [
    '# Computer Use Sub-Agent Policy',
    'You are executing ONE bounded UI task on the local browser and/or desktop.',
    '1. AX / DOM FIRST: Always inspect semantic structure first (`browser_snapshot` ARIA/DOM refs or desktop Accessibility `@ref` snapshots).',
    '2. WINDOW-SCOPED SCREENSHOT FALLBACK ONLY: Capture a viewport or window-scoped screenshot ONLY when AX/DOM nodes are missing or ambiguous; never guess coordinates blindly.',
    `3. TARGET SURFACE: ${input.targetHint}.`
  ]
  if (input.allowedApps?.length) {
    lines.push(`4. ALLOWED APPS ONLY: ${input.allowedApps.join(', ')}. Never switch to another application.`)
  }
  if (input.allowedDomains?.length) {
    lines.push(
      `5. ALLOWED DOMAINS ONLY: ${input.allowedDomains.join(', ')}. Only http(s) URLs under these domains are allowed.`
    )
  }
  if (input.stopBeforeSubmit) {
    lines.push(
      '6. STOP BEFORE SUBMIT (MANDATORY): Fill drafts/forms up to the review step, then STOP cleanly BEFORE clicking Submit / Send / Approve / Pay / Delete / Publish. Report filled fields and pending action.'
    )
  }
  lines.push(`Goal: ${input.goal}`)
  return lines.join('\n')
}

export function buildComputerUseTool(
  domain: MailAgentDomainClient,
  collector: GatewayToolAuditCollector,
  guard: ApprovalGuard,
  opts: {
    a2uiEnabled?: boolean
    approvalMode?: GatewayApprovalMode
    toolApprovalPrefs?: GatewayToolApprovalPrefs['tools']
    oneShot?: boolean
    contextMode?: AgentContextMode
    agentRunContext?: AgentRunContext
    getChildToolsFromFinalSet?: () => ToolSet | undefined
  } & ComputerUseToolDeps
): Tool {
  const contextMode = normalizeContextMode(opts.contextMode)
  const matterItemPolicy = opts.matterItemPolicy ?? opts.agentRunContext?.modeGrants?.matterItemComputerUse
  const customAgentPolicy = opts.customAgentPolicy ?? opts.agentRunContext?.modeGrants?.customAgentComputerUse
  const binding: InternalComputerUseBinding = {
    model: opts.model,
    maxOutputTokens: opts.maxOutputTokens,
    sessionId: opts.parentSessionId,
    finalTools: opts.childTools,
    getChildToolsFromFinalSet: opts.getChildToolsFromFinalSet
  }

  const allowSubmitSuffix =
    customAgentPolicy?.submitMode === 'allow_submit'
      ? ' Authorized custom-agent allow_submit mode: pass stop_before_submit=false when ready to click the final submit/approve/join action.'
      : ''

  // CRITICAL: Non-generic `auditedWriteTool(` so `validate_catalog.py::FACTORY_RE` indexes it.
  const built = auditedWriteTool(
    {
      name: 'computer_use_run',
      description:
        'Delegate a bounded browser or desktop GUI automation goal to an isolated Computer Use ' +
        'sub-agent (`mcp__browser_use__*` / `mcp__desktop_use__*` only). Edit tier — always asks ' +
        'unless a bounded manual-session auto_scope_grant rule matches with stop_before_submit=true. ' +
        'Use ONLY when native MailAgent tools and direct MCP connectors do not cover the UI workflow.' +
        allowSubmitSuffix,
      inputSchema: computerUseRunSchema,
      risk: 'edit',
      a2uiEnabled: opts.a2uiEnabled,
      approvalMode: opts.approvalMode,
      toolApprovalPrefs: opts.toolApprovalPrefs,
      oneShot: opts.oneShot,
      contextMode,
      modeGrants: opts.agentRunContext?.modeGrants,
      policyEvaluate: (input: ComputerUseRunInput) =>
        evaluateComputerUsePolicy(input, {
          contextMode,
          domain,
          evaluateAutoScopeGrant: opts.evaluateAutoScopeGrant,
          forceStopBeforeSubmit: opts.forceStopBeforeSubmit,
          matterItemPolicy,
          customAgentPolicy,
          agentId: opts.agentRunContext?.agentId
        }),
      run: async (input: ComputerUseRunInput, { signal, toolCallId }) => {
        const matterAuthorized =
          contextMode === 'matter_followup' &&
          isMatterItemComputerUseEnabled({ matterItemComputerUse: matterItemPolicy })
        const customAgentAuthorized =
          (contextMode === 'untrusted_trigger' || contextMode === 'cron_headless') &&
          isCustomAgentComputerUseEnabled({ customAgentComputerUse: customAgentPolicy })
        if (contextMode !== 'manual_chat' && !matterAuthorized && !customAgentAuthorized) {
          throw new DomainError(
            'E_CONTEXT_MODE_DENIED',
            `computer_use_run is not permitted in context mode '${contextMode}'.`
          )
        }

        let effectiveAllowedApps = input.allowed_apps
        let effectiveAllowedDomains = input.allowed_domains
        if (matterAuthorized && matterItemPolicy) {
          const scoped = resolveMatterBoundedScope(input, matterItemPolicy)
          if ('violation' in scoped) {
            throw new DomainError(
              'E_SCOPE_VIOLATION',
              `Requested Computer Use scope exceeds matter dispatch bounds (${scoped.violation.reason}): ${scoped.violation.observed}`
            )
          }
          effectiveAllowedApps = scoped.allowedApps
          effectiveAllowedDomains = scoped.allowedDomains
        } else if (customAgentAuthorized && customAgentPolicy) {
          const scoped = resolveBoundedScope(input, customAgentPolicy, 'custom_agent')
          if ('violation' in scoped) {
            throw new DomainError(
              'E_SCOPE_VIOLATION',
              `Requested Computer Use scope exceeds custom agent bounds (${scoped.violation.reason}): ${scoped.violation.observed}`
            )
          }
          effectiveAllowedApps = scoped.allowedApps
          effectiveAllowedDomains = scoped.allowedDomains
        }

        const boundedPolicyActive = matterAuthorized || customAgentAuthorized
        const effectiveStopBeforeSubmit =
          matterAuthorized ||
          opts.forceStopBeforeSubmit === true ||
          (customAgentAuthorized && customAgentPolicy?.submitMode === 'stop_before_submit')
            ? true
            : input.stop_before_submit !== false
        const targetHint = (input.target_hint ?? 'auto') as ComputerUseTargetHint
        const rawToolPool =
          opts.childTools ?? binding.finalTools ?? binding.getChildToolsFromFinalSet?.() ?? {}
        const childToolsRaw = selectComputerUseChildTools(rawToolPool, targetHint)
        if (Object.keys(childToolsRaw).length === 0) {
          throw new DomainError(
            'E_CONNECTOR_UNAVAILABLE',
            'No enabled browser_use or desktop_use connector tools matched this request. Open /connectors to install and enable Browser Use or Desktop Use.'
          )
        }

        const activeModel =
          binding.model ?? opts.model ?? (opts.resolveChildModel ? await opts.resolveChildModel() : undefined)
        if (!activeModel) {
          throw new DomainError(
            'E_NO_LLM_KEY',
            'No resolved language model available for computer_use_run child loop.'
          )
        }

        const parentSessionId = binding.sessionId ?? opts.parentSessionId ?? null
        let childSessionId: number | null = null
        if (parentSessionId != null && opts.createAgentSession) {
          const existing = opts.findSessionByParentToolCall?.(parentSessionId, toolCallId)
          childSessionId =
            existing ??
            opts.createAgentSession({
              agentId: 'computer_use',
              title: input.goal.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Computer Use',
              parentSessionId,
              parentToolCallId: toolCallId,
              invokedBy: 'main_agent'
            })
        }

        const childAbort = new AbortController()
        const onParentAbort = (): void => childAbort.abort(signal?.reason)
        if (signal) {
          if (signal.aborted) childAbort.abort(signal.reason)
          else signal.addEventListener('abort', onParentAbort, { once: true })
        }

        let scopeViolation: PreflightViolation | null = null
        let dockedPause: { pendingAction: string } | null = null
        let userStopped = false
        const filledFields: Record<string, string> = {}
        let currentUrlOrApp = 'unknown'
        let finalScreenshotRef: string | undefined
        let stepCount = 0

        const startedAt = Date.now()
        const runId = toolCallId || `cu-${startedAt}-${Math.random().toString(36).slice(2, 8)}`
        const childToolNames = Object.keys(childToolsRaw)
        const hasDesktopTools = childToolNames.some((n) => n.startsWith(DESKTOP_USE_PREFIX))
        const hasBrowserTools = childToolNames.some((n) => n.startsWith(BROWSER_USE_PREFIX))
        let currentSurface: ComputerUseSurface =
          targetHint === 'desktop'
            ? 'desktop'
            : targetHint === 'browser'
              ? 'browser'
              : hasDesktopTools && !hasBrowserTools
                ? 'desktop'
                : 'browser'
        let currentActionLabel: string | null = 'starting'
        const emitActivity = (overrides?: Partial<ComputerUseActivityState>): void => {
          opts.onActivity?.({
            active: true,
            runId,
            surface: currentSurface,
            actionLabel: currentActionLabel,
            currentTarget: currentUrlOrApp === 'unknown' ? null : currentUrlOrApp,
            stepCount,
            startedAt,
            ...overrides
          })
        }
        const unregisterAbort = opts.registerAbort?.(runId, () => {
          if (userStopped) return
          userStopped = true
          childAbort.abort(new Error('Stopped by user'))
        })
        emitActivity()

        const wrappedChildTools: ToolSet = {}
        for (const [name, childTool] of Object.entries(childToolsRaw)) {
          const baseExec = childTool.execute
          const origNeedsApproval = childTool.needsApproval
          wrappedChildTools[name] = {
            ...childTool,
            // Computer use already obtained task-level HITL on `computer_use_run`. Run original
            // needsApproval side-effects (guard.register for auditedWriteTool) and return false so
            // individual child UI clicks do not stall the sub-agent loop on unrenderable cards.
            ...(typeof origNeedsApproval === 'function'
              ? {
                  needsApproval: async (toolArgs, approvalCtx) => {
                    await origNeedsApproval(toolArgs, approvalCtx)
                    return false
                  }
                }
              : origNeedsApproval !== undefined
                ? { needsApproval: false }
                : {}),
            execute: async (toolArgs, execOpts) => {
              if (userStopped) {
                throw new DomainError('E_STOPPED_BY_USER', 'Computer use stopped by user.')
              }
              currentSurface = name.startsWith(DESKTOP_USE_PREFIX) ? 'desktop' : 'browser'
              currentActionLabel = name
                .replace(DESKTOP_USE_PREFIX, '')
                .replace(BROWSER_USE_PREFIX, '')
              if (toolArgs && typeof toolArgs === 'object') {
                const argsObj = toolArgs as Record<string, unknown>
                for (const key of [...URL_ARG_KEYS, ...APP_ARG_KEYS]) {
                  const val = argsObj[key]
                  if (typeof val === 'string' && val.trim()) {
                    currentUrlOrApp = val.trim()
                    break
                  }
                }
              }
              emitActivity()

              if (boundedPolicyActive) {
                const scopePrefix = matterAuthorized ? 'matter' : 'custom_agent'
                if (name.startsWith(DESKTOP_USE_PREFIX) && (!effectiveAllowedApps || effectiveAllowedApps.length === 0)) {
                  scopeViolation = { reason: `${scopePrefix}_app_scope_exceeded`, observed: name }
                  childAbort.abort(new Error(`Scope violation: desktop_use disabled in scope`))
                  throw new DomainError(
                    'E_SCOPE_VIOLATION',
                    'Desktop automation is outside the authorized allowed_apps scope.'
                  )
                }
                if (name.startsWith(BROWSER_USE_PREFIX) && (!effectiveAllowedDomains || effectiveAllowedDomains.length === 0)) {
                  scopeViolation = { reason: `${scopePrefix}_domain_scope_exceeded`, observed: name }
                  childAbort.abort(new Error(`Scope violation: browser_use disabled in scope`))
                  throw new DomainError(
                    'E_SCOPE_VIOLATION',
                    'Browser automation is outside the authorized allowed_domains scope.'
                  )
                }
              }
              const preViolation = inspectArgsForScopeViolation(
                toolArgs,
                effectiveAllowedApps,
                effectiveAllowedDomains
              )
              if (preViolation) {
                scopeViolation = preViolation
                childAbort.abort(new Error(`Scope violation: ${preViolation.reason}`))
                throw new DomainError(
                  'E_SCOPE_VIOLATION',
                  `Blocked out-of-scope action (${preViolation.reason}): ${preViolation.observed}`
                )
              }

              if (effectiveStopBeforeSubmit) {
                const pendingAction = detectTerminalAction(name, toolArgs)
                if (pendingAction) {
                  dockedPause = { pendingAction }
                  childAbort.abort(new Error(`stop_before_submit: ${pendingAction}`))
                  return {
                    status: 'awaiting_confirmation',
                    pending_action: pendingAction,
                    current_url_or_app: currentUrlOrApp
                  }
                }
              }

              recordFilledFields(name, toolArgs, filledFields)

              if (typeof baseExec !== 'function') {
                throw new DomainError('E_TOOL_UNAVAILABLE', `Child tool ${name} is not executable`)
              }
              const res = await baseExec(toolArgs, {
                ...execOpts,
                abortSignal: childAbort.signal
              })

              const observed = extractUrlsAndAppsFromOutput(res)
              if (observed.hasImage) {
                finalScreenshotRef = `step-${Math.max(1, stepCount)}-screenshot`
              }
              for (const u of observed.urls) {
                const check =
                  boundedPolicyActive && (!effectiveAllowedDomains || effectiveAllowedDomains.length === 0)
                    ? { allowed: false, reason: `${matterAuthorized ? 'matter' : 'custom_agent'}_domain_scope_exceeded` }
                    : validateNavigationUrl(u, effectiveAllowedDomains)
                if (!check.allowed) {
                  scopeViolation = { reason: check.reason ?? 'domain_drift', observed: u }
                  childAbort.abort(new Error(`Scope drift URL: ${u}`))
                  throw new DomainError(
                    'E_SCOPE_VIOLATION',
                    `Navigation drifted outside allowed_domains (${check.reason}): ${u}`
                  )
                }
                currentUrlOrApp = u
              }
              for (const app of observed.apps) {
                const appAllowed =
                  boundedPolicyActive && (!effectiveAllowedApps || effectiveAllowedApps.length === 0)
                    ? false
                    : !effectiveAllowedApps?.length || matchesAllowedApp(app, effectiveAllowedApps)
                if (!appAllowed) {
                  scopeViolation = { reason: 'app_drift', observed: app }
                  childAbort.abort(new Error(`Scope drift App: ${app}`))
                  throw new DomainError(
                    'E_SCOPE_VIOLATION',
                    `Active application drifted outside allowed_apps: ${app}`
                  )
                }
                if (currentUrlOrApp === 'unknown' || observed.urls.length === 0) {
                  currentUrlOrApp = app
                }
              }
              emitActivity()

              return res
            }
          }
        }

        const systemPrompt = buildChildSystemPrompt({
          goal: input.goal,
          targetHint,
          allowedApps: effectiveAllowedApps,
          allowedDomains: effectiveAllowedDomains,
          stopBeforeSubmit: effectiveStopBeforeSubmit
        })

        let finalSummary = ''
        let streamError: unknown = null
        try {
          const childRun = streamText({
            model: activeModel,
            system: systemPrompt,
            prompt: input.goal,
            tools: wrappedChildTools,
            abortSignal: childAbort.signal,
            ...(binding.maxOutputTokens ?? opts.maxOutputTokens
              ? { maxOutputTokens: binding.maxOutputTokens ?? opts.maxOutputTokens }
              : {}),
            stopWhen: stepCountIs(input.max_steps ?? 15),
            prepareStep: ({ messages, stepNumber }) => {
              stepCount = stepNumber + 1
              emitActivity({ stepCount })
              return {
                messages: pruneSlidingWindowScreenshots(messages, MAX_CHILD_VISUAL_STEPS)
              }
            }
          })
          for await (const chunk of childRun.fullStream) {
            if (chunk.type === 'error' && streamError == null) {
              streamError = (chunk as { error?: unknown }).error ?? 'Child streamText failed'
            }
          }
          if (streamError != null && !scopeViolation && !dockedPause && !userStopped) {
            throw streamError instanceof Error ? streamError : new Error(String(streamError))
          }
          finalSummary = await Promise.resolve(childRun.text)
          const completedSteps = await Promise.resolve(childRun.steps)
          if (Array.isArray(completedSteps) && completedSteps.length > stepCount) {
            stepCount = completedSteps.length
          }
        } catch (err) {
          if (!scopeViolation && !dockedPause && !userStopped) {
            signal?.removeEventListener('abort', onParentAbort)
            throw err
          }
        } finally {
          signal?.removeEventListener('abort', onParentAbort)
          unregisterAbort?.()
          opts.onActivity?.(IDLE_COMPUTER_USE_ACTIVITY)
        }

        if (signal?.aborted && !scopeViolation && !dockedPause && !userStopped) {
          throw signal.reason instanceof Error ? signal.reason : new Error('Aborted')
        }

        if (userStopped) {
          const payload = {
            status: 'stopped_by_user' as const,
            child_session_id: childSessionId,
            filled_fields: filledFields,
            current_url_or_app: currentUrlOrApp,
            ...(finalScreenshotRef ? { final_screenshot_ref: finalScreenshotRef } : {}),
            steps_executed: stepCount,
            summary: 'User stopped computer use and took over control.'
          }
          if (childSessionId != null && opts.persistChildSummary) {
            opts.persistChildSummary(childSessionId, payload.summary)
          }
          return payload
        }

        if (scopeViolation) {
          const v = scopeViolation as PreflightViolation
          const payload = {
            status: 'scope_violation' as const,
            child_session_id: childSessionId,
            reason: v.reason,
            observed: v.observed,
            allowed_apps: effectiveAllowedApps ?? [],
            allowed_domains: effectiveAllowedDomains ?? [],
            steps_executed: stepCount
          }
          if (childSessionId != null && opts.persistChildSummary) {
            opts.persistChildSummary(childSessionId, JSON.stringify(payload))
          }
          return payload
        }

        if (dockedPause) {
          const d = dockedPause as { pendingAction: string }
          const payload = {
            status: 'awaiting_confirmation' as const,
            child_session_id: childSessionId,
            filled_fields: filledFields,
            pending_action: d.pendingAction,
            current_url_or_app: currentUrlOrApp,
            ...(finalScreenshotRef ? { final_screenshot_ref: finalScreenshotRef } : {}),
            steps_executed: stepCount
          }
          if (childSessionId != null && opts.persistChildSummary) {
            opts.persistChildSummary(childSessionId, JSON.stringify(payload))
          }
          return payload
        }

        const payload = {
          status: 'completed' as const,
          child_session_id: childSessionId,
          summary: finalSummary.trim() || 'Completed browser/desktop task.',
          filled_fields: filledFields,
          current_url_or_app: currentUrlOrApp,
          ...(finalScreenshotRef ? { final_screenshot_ref: finalScreenshotRef } : {}),
          steps_executed: stepCount
        }
        if (childSessionId != null && opts.persistChildSummary) {
          opts.persistChildSummary(childSessionId, payload.summary)
        }
        return payload
      }
    },
    collector,
    guard
  )

  if (typeof built.execute === 'function') {
    computerUseBindings.set(built.execute, binding)
  }
  return built
}

export function createComputerUseTools(
  domain: MailAgentDomainClient,
  collector: GatewayToolAuditCollector,
  guard: ApprovalGuard,
  opts: Parameters<typeof buildComputerUseTool>[3] = {}
): Record<string, Tool> {
  return {
    computer_use_run: buildComputerUseTool(domain, collector, guard, opts)
  }
}

export function hasActiveComputerUseChildTools(tools: ToolSet | undefined): boolean {
  if (!tools) return false
  return Object.keys(tools).some(isComputerUseChildToolName)
}

export function hasNonEmptyExecAndDomainWhitelist(
  ctxMode: AgentContextMode,
  grants?: AgentModeGrants
): boolean {
  return isToolAllowedInContext('computer_use_run', 'exec', ctxMode, grants)
}
