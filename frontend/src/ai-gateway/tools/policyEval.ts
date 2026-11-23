// Context-mode grant parsers, typed grant contracts, and policy evaluation predicates.
import type { ToolSet } from 'ai'

import type {
  AgentContextMode,
  ConnectorGrant,
  MatterRunWebFace,
  SessionsGrant
} from './policy'
import type { GatewayToolClass } from './policyRules'

/** Per-agent web grant tier (ADR-004 rev3.1 D1/D2): 'off' = not registered headless (default),
 *  'gated' = registered + per-agent origin-whitelist免卡 for web_fetch (web_search grant-level),
 *  'open' = registered + grant-level免卡 for any URL. A three-state enum (not two booleans) so the
 *  illegal state "full access while web is off" is unrepresentable. */
export type WebGrant = 'off' | 'gated' | 'open'

/** Fail-closed parse of a spec's grantWeb: ONLY the exact literals 'gated'/'open' pass; anything
 *  else (true / 1 / 'yes' / junk / absent) collapses to 'off' — the web mirror of the
 *  `grantExec === true` discrimination, never a raw passthrough. */
export function parseWebGrant(raw: unknown): WebGrant {
  return raw === 'gated' || raw === 'open' ? raw : 'off'
}

/** Fail-closed parse of a spec's grantSessions: ONLY the exact literal 'all' widens; anything else
 *  (absent / junk / 'own') collapses to 'own' — the sessions mirror of parseWebGrant. */
export function parseSessionsGrant(raw: unknown): SessionsGrant {
  return raw === 'all' ? 'all' : 'own'
}

/** Fail-closed parse of a spec's grantConnectors (`{connectorId: ceiling}`): only entries with a
 *  non-empty string key AND an exact 'read'/'write'/'update' literal value survive; every other
 *  entry (junk value, 'delete', empty key) is dropped PER-ENTRY, and an empty/absent/non-object
 *  result collapses to undefined (= no connector grants at all — the connector mirror of
 *  parseWebGrant, never a raw passthrough). */
export function parseConnectorGrants(raw: unknown): Record<string, ConnectorGrant> | undefined {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, ConnectorGrant> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!key) continue
    if (value === 'read' || value === 'write' || value === 'update') out[key] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** PR3 — does this (possibly junk) connectors grant object carry ANY write-capable ceiling?
 *  Re-parses fail-closed (a hand-built / stash-frozen grants object may carry junk), so a
 *  'read'-only grant, 'delete'/junk values, empty keys and non-object shapes all yield false.
 *  This is the connector_write CLASS row's coarse gate — see isToolClassAllowedInMode. */
export function hasConnectorWriteGrant(connectors: unknown): boolean {
  const parsed = parseConnectorGrants(connectors)
  if (!parsed) return false
  return Object.values(parsed).some((v) => v === 'write' || v === 'update')
}

/** Per-agent mode grants (ADR-004 §4.1, web key added by ADR-004 rev3.1 D1, connectors key added
 *  by stage 1 PR3 — the explicit revisions of the ADR-001 §5 matrix's exec/web/connector rows).
 *  🔴 The type has ONLY the `exec`, `web` and `connectors` keys: capability_change and outbound
 *  (send) have NO corresponding field — they are structurally un-grantable (not "don't pass true"
 *  but "nowhere to pass it"), fixing the red line at the type level. Constructed by the gateway
 *  from the strictly-parsed spec as discriminated typed values ({ exec: spec.toolPolicy?.grantExec
 *  === true, web: parseWebGrant(spec.toolPolicy?.grantWeb) }, plus `connectors` ONLY when
 *  parseConnectorGrants yields a non-empty record — an absent key means "no connector grants",
 *  keeping every pre-PR3 grants object byte-identical) — NEVER a passthrough of a raw spec object
 *  (a future spec field must not silently flow into the matrix). */
export interface MatterItemComputerUsePolicy {
  enabled: true
  mode: 'propose_only'
  stopBeforeSubmit: true
  allowedApps: string[]
  allowedDomains: string[]
  connectors: Array<'browser_use' | 'desktop_use'>
  jobId?: number
  dispatchId: number
}

export interface CustomAgentComputerUsePolicy {
  enabled: true
  submitMode: 'stop_before_submit' | 'allow_submit'
  allowedApps: string[]
  allowedDomains: string[]
  connectors: Array<'browser_use' | 'desktop_use'>
  jobId?: number
}

export interface AgentModeGrants {
  exec?: boolean
  web?: WebGrant
  /** PR3 — per-connector crud ceilings ({connectorId: 'read'|'write'|'update'}), spec-derived via
   *  parseConnectorGrants (fail-closed per-entry; 'delete' unrepresentable). Consumed by (a) the
   *  connector_write matrix row below (coarse class gate) and (b) createConnectorTools'
   *  registration filter (the per-connector / per-tool precision). */
  connectors?: Record<string, ConnectorGrant>
  /** Phase 5 — per-connector per-tool allowlists ({connectorId: [toolName, ...]}). */
  connectorTools?: Record<string, string[]>
  /** WS-5 — bounded Computer Use draft grant on a `matter_followup` item-run (`propose_only` +
   *  `stopBeforeSubmit === true` only). Read solely by `isToolAllowedInContext` (never by
   *  `isToolClassAllowedInMode`, keeping `exec` strictly closed for general exec tools). */
  matterItemComputerUse?: MatterItemComputerUsePolicy
  /** Wave 6 — bounded Computer Use grant on an `untrusted_trigger` / `cron_headless` Custom Agent. */
  customAgentComputerUse?: CustomAgentComputerUsePolicy
}

/** The per-agent run context threaded through a headless custom-agent run (ADR-004 §3.1/§4.4):
 *  agentRun.ts constructs it from the pulled spec, buildTools/write/exec factories consume it, and
 *  the approval stash FREEZES it at pause time so an island resume rebuilds the exact same tool
 *  face (never wider). Manual entrypoints never construct one — absent everywhere means the
 *  pre-ADR-004 behaviour, byte-identical. */
export interface AgentRunContext {
  agentId: string
  /** The owner's per-agent allow-list, already normalized: an agent run ALWAYS carries an array
   *  (a malformed spec normalizes to [] — fail-closed, ADR-004 §5.1); undefined only survives in
   *  hand-built test contexts and wrapCfgForAgentRun re-normalizes it to []. */
  allowedTools?: string[]
  /** S6 W3 (ADR-004 rev3.1 §5.1/D3) — the owner's per-agent skill MOUNT list, spec-projected
   *  (the Python side substitutes the default mount set for NULL, so a real spec always carries
   *  the resolved array; missing/malformed → [] fail-closed, mirroring allowedTools). Consumed by
   *  buildGatewayTools as a SECOND applySkillGating pass (mounted ∩ advertised — pure reduction,
   *  independent of the M4a flag and of the advertisedSkills null fail-open, which are manual
   *  business-state semantics). Never widens: CORE_UNGATED / collision-exempt floors stay. */
  skills?: string[]
  modeGrants?: AgentModeGrants
  /** task 09-02 — the chat-history read radius (parseSessionsGrant of the spec's grantSessions).
   *  Present ONLY when 'all' (conditional include, so every pre-09-02 context object — and the
   *  stash-freeze assertions on it — stays byte-identical); absent = 'own'. Consumed by ONE
   *  reader: buildGatewayTools' session-tool binding (allowAllHistory). */
  grantSessions?: SessionsGrant
  /** S6 W1 — the async_jobs row id of this headless run, frozen into the run context so a paused
   *  approval carries it into the stash (maybeStashAndAnnounceApproval freezes the whole context).
   *  Read-only metadata for GET /api/ai/approval/pending's record-view projection; NEVER consulted
   *  by the matrix / intersection / whitelist. Absent on manual entrypoints (the pre-S6 shape,
   *  byte-identical), so pending → jobId:null for a non-agent approval. */
  jobId?: number
  /** Matters MVP P4 (D5/D7) — the Matter this run follows up, built by agentRunContextFromSpec
   *  from the SERVER-assembled spec's `matter` key (never a body). Present ONLY for a
   *  matter_followup run; every manual/im/cron context omits it, so every pre-P4 assembly is
   *  byte-identical. Two consumers, both in tools/index.ts: (a) it SCOPES the email read tools to
   *  this Matter's resource set (the headless counterpart of the manual matterScopeFilter), and
   *  (b) it is the registration condition + the server-stamped identity of
   *  `matter_update_propose` (the model never passes matter_id / run_id — they are not in the
   *  schema at all). NOT a policy input: the matrix row keys on the MODE, so a mis-threaded
   *  matterRun can never widen a tool face. */
  matterRun?: {
    matterId: number
    publicId: string
    runId: number
  }
  /** L4 批次3 (task 08-25) — the ITEM DISPATCH this run executes, built by agentRunContextFromSpec
   *  from the SERVER-assembled spec's `matterItem` key (never a body). Present ONLY for a
   *  `matter_item_run` spec; every other context omits it, so every pre-批次3 assembly is
   *  byte-identical. Two consumers, both structural: (a) it is the registration condition + the
   *  server-stamped identity of `matter_item_report` (the model passes no matter / item /
   *  dispatch id — the schema has none), and (b) it selects wrapCfgForAgentRun's item read-face
   *  belt. 🔴 NOT a policy input (the matrix row keys on the MODE), and deliberately a SECOND
   *  input beside the derived mode, so a broken deriveContextMode cannot take both belts down at
   *  once. Frozen into the approval stash with the rest of the context. */
  matterItemRun?: {
    matterId: number
    publicId: string
    itemId: number
    dispatchId: number
  }
  /** WS-5 — validated `computer_use_run` propose-only draft policy for a `matter_item_run`.
   *  Present ONLY when `runKind === 'matter_item_run'`, `mode === 'propose_only'`,
   *  `stopBeforeSubmit === true`, and non-empty concrete scope entries exist. */
  matterItemComputerUse?: MatterItemComputerUsePolicy
  /** Wave 6 — validated bounded Computer Use policy for `untrusted_trigger` / `cron_headless` custom agents. */
  customAgentComputerUse?: CustomAgentComputerUsePolicy
  /** 0812 dogfood — the owner-configured web tier of THIS follow-up run, resolved ONCE by
   *  runHeadlessAgent (owner_settings `matter_run_web_face` via the lifecycle's TTL-cached hot
   *  read) and consumed ONLY by wrapCfgForAgentRun's matter belt (matterRunAdmitsWeb). It rides
   *  the run context — rather than being re-read at wrap time — for the same reason the grants
   *  do: the approval stash FREEZES this object, so an island resume rebuilds the exact same
   *  face and a mid-run setting change can never widen a paused run.
   *  🔴 NOT a policy input (the matrix row keys on the MODE alone) and NOT set by
   *  agentRunContextFromSpec: absent means "use MATTER_RUN_WEB_FACE_DEFAULT", so every context
   *  built without a resolver (tests, manual entrypoints, non-matter runs) stays byte-identical. */
  matterWebFace?: MatterRunWebFace
  /** Contact Directory WP7 — the SERVER's stamp that this run is the contact-directory governance
   *  scan, built by agentRunContextFromSpec from `spec.runKind` (never a body). Present ONLY for a
   *  contact_governance run; every manual / im / cron / matter context omits it, so every pre-WP7
   *  assembly is byte-identical. Its ONE consumer is wrapCfgForAgentRun's contact read-face belt —
   *  the SECOND, independent belt behind the matrix row above. 🔴 NOT a policy input: the matrix
   *  row keys on the MODE alone, so a mis-threaded flag can never widen a tool face; and it is
   *  deliberately a SECOND input (the spec's runKind stamp) rather than the derived mode, so a
   *  broken deriveContextMode cannot take both belts down at once. Frozen into the approval stash
   *  with the rest of the context, so a resume rebuilds the exact same face. */
  contactGovernanceRun?: boolean
}

/** Stage 2 PR-1 (grill Q19=A) — VENUE-level switches of the im_chat row. 🔴 NOT grants: the
 *  AgentModeGrants axis is the owner's per-AGENT headless authorization; these are per-VENUE
 *  owner switches (env/Settings), threaded from the lifecycle as trusted data. Only the im_chat
 *  branch ever reads them — every other mode ignores the object entirely, so passing it to a
 *  non-im run is behavior-inert. `imWebEnabled` mirrors MAILAGENT_IM_WEB_ENABLED (default off):
 *  false → web tools are not even registered in an im run; true → registered AND 恒 HITL
 *  (mayAutoApprove stays manual-only — the switch never relaxes approval). */
export interface ImVenueSwitches {
  imWebEnabled?: boolean
}

/** May approvalMode 'auto-reversible' skip the approval card for this tool? Only a reversible
 *  DOMAIN write in an owner-driven manual session (ADR-001 D3). The caller additionally requires
 *  tier==='preview' (unchanged UX vocabulary) — this predicate carries the class/mode half. */
export function mayAutoApprove(toolClass: GatewayToolClass, mode: AgentContextMode): boolean {
  return toolClass === 'domain_write' && mode === 'manual_chat'
}

/** WS-5 (Belt 2) — verify a server-authorized `matter_item_run` Computer Use draft policy. */
export function isMatterItemComputerUseEnabled(
  grants?: AgentModeGrants
): grants is AgentModeGrants & { matterItemComputerUse: MatterItemComputerUsePolicy } {
  const cu = grants?.matterItemComputerUse
  return (
    cu != null &&
    cu.enabled === true &&
    cu.mode === 'propose_only' &&
    cu.stopBeforeSubmit === true &&
    Number.isInteger(cu.dispatchId) &&
    cu.dispatchId > 0 &&
    (cu.allowedApps.length > 0 || cu.allowedDomains.length > 0) &&
    cu.connectors.length > 0
  )
}

/** Wave 6 — verify a bounded Custom Agent `grant_computer_use` policy (`stop_before_submit` or `allow_submit`). */
export function isCustomAgentComputerUseEnabled(
  grants?: AgentModeGrants
): grants is AgentModeGrants & { customAgentComputerUse: CustomAgentComputerUsePolicy } {
  const cu = grants?.customAgentComputerUse
  return (
    cu != null &&
    cu.enabled === true &&
    (cu.submitMode === 'stop_before_submit' || cu.submitMode === 'allow_submit') &&
    (cu.allowedApps.length > 0 || cu.allowedDomains.length > 0) &&
    Array.isArray(cu.connectors) &&
    cu.connectors.length > 0
  )
}

export type ToolClassMatrixPredicate = (
  toolClass: GatewayToolClass,
  mode: AgentContextMode,
  grants?: AgentModeGrants,
  venue?: ImVenueSwitches,
  toolName?: string
) => boolean

export function evaluateToolAllowedInContext(
  toolName: string,
  toolClass: GatewayToolClass,
  mode: AgentContextMode,
  allowClassFn: ToolClassMatrixPredicate,
  grants?: AgentModeGrants,
  venue?: ImVenueSwitches
): boolean {
  if (toolName === 'computer_use_run') {
    if (mode === 'manual_chat') return true
    if (mode === 'matter_followup') return isMatterItemComputerUseEnabled(grants)
    if (mode === 'untrusted_trigger' || mode === 'cron_headless') {
      return isCustomAgentComputerUseEnabled(grants)
    }
    return false
  }
  return allowClassFn(toolClass, mode, grants, venue, toolName)
}

export function filterToolsByContextMode(
  tools: ToolSet,
  mode: AgentContextMode,
  allowClassFn: ToolClassMatrixPredicate,
  resolveClassFn: (name: string) => GatewayToolClass,
  grants?: AgentModeGrants,
  venue?: ImVenueSwitches
): ToolSet {
  if (mode === 'manual_chat') return tools
  const out: ToolSet = {}
  for (const [name, t] of Object.entries(tools)) {
    if (
      evaluateToolAllowedInContext(name, resolveClassFn(name), mode, allowClassFn, grants, venue)
    ) {
      out[name] = t
    }
  }
  return out
}
