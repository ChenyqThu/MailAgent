// Matter CRUD, follow-up runs, proposals, review, attention, and suggestions.
import type { DomainHttpCore } from './clientCore'
import type {
  DomainMatterMutation,
  DomainMatterResult,
  DomainMatterUpdateDetail
} from './domainTypes'

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- inferred for MailAgentDomainClient declaration merging
export function createMattersMethods(http: DomainHttpCore) {
  return {
  listMatters(
    opts: {
      q?: string
      status?: string
      health?: string
      priority?: string
      type?: string
      tag?: string
      view?: string
      archived?: boolean
      deleted?: boolean
      limit?: number
    },
    signal?: AbortSignal
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor?: string | null }> {
    return http.req('GET', '/matters', { query: opts, signal })
  },

  getMatter(
    publicId: string,
    include: readonly string[],
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return http.req('GET', `/matters/${encodeURIComponent(publicId)}`, {
      query: { include: include.join(',') },
      signal
    })
  },

  createMatter(
    data: Record<string, unknown>,
    mutation: DomainMatterMutation,
    signal?: AbortSignal
  ): Promise<DomainMatterResult> {
    return http.req('POST', '/matters', { body: { ...data, mutation }, signal })
  },

  updateMatter(
    publicId: string,
    operation: 'patch' | 'archive' | 'reopen' | 'trash' | 'restore',
    patch: Record<string, unknown> | undefined,
    mutation: DomainMatterMutation,
    signal?: AbortSignal
  ): Promise<DomainMatterResult> {
    const path = `/matters/${encodeURIComponent(publicId)}`
    if (operation === 'patch') {
      return http.req('PATCH', path, { body: { ...(patch ?? {}), mutation }, signal })
    }
    return http.req('POST', `${path}/${operation}`, { body: { mutation }, signal })
  },

  /** task 08-14 — 跟进配置的逐条编辑。`payload` 按 operation 各吃各的键，语义权威在 Python
   *  （src/matters/followup_config.py → triggers.py 归一）；这里只做透传，不在 TS 侧复刻一份
   *  envelope 逻辑。 */
  mutateMatterFollowup(
    publicId: string,
    operation: string,
    payload: Record<string, unknown>,
    mutation: DomainMatterMutation,
    signal?: AbortSignal
  ): Promise<DomainMatterResult> {
    return http.req('PATCH', `/matters/${encodeURIComponent(publicId)}/followup`, {
      body: { operation, payload, mutation },
      signal
    })
  },

  mutateMatterItem(
    publicId: string,
    operation: 'create' | 'update' | 'delete' | 'restore',
    itemId: number | undefined,
    data: Record<string, unknown> | undefined,
    mutation: DomainMatterMutation,
    signal?: AbortSignal
  ): Promise<DomainMatterResult> {
    const base = `/matters/${encodeURIComponent(publicId)}/items`
    if (operation === 'create')
      return http.req('POST', base, { body: { ...(data ?? {}), mutation }, signal })
    const itemPath = `${base}/${itemId}`
    if (operation === 'update')
      return http.req('PATCH', itemPath, { body: { ...(data ?? {}), mutation }, signal })
    if (operation === 'delete') return http.req('DELETE', itemPath, { body: { mutation }, signal })
    return http.req('POST', `${itemPath}/restore`, { body: { mutation }, signal })
  },

  /** task 08-25 — curated 进展条目的逐条写。路径形状与 items 逐字一致（POST / PATCH /
   *  DELETE / POST …/restore），语义权威在 Python。 */
  mutateMatterProgress(
    publicId: string,
    operation: 'create' | 'update' | 'delete' | 'restore',
    progressId: number | undefined,
    data: Record<string, unknown> | undefined,
    mutation: DomainMatterMutation,
    signal?: AbortSignal
  ): Promise<DomainMatterResult> {
    const base = `/matters/${encodeURIComponent(publicId)}/progress`
    if (operation === 'create')
      return http.req('POST', base, { body: { ...(data ?? {}), mutation }, signal })
    const progressPath = `${base}/${progressId}`
    if (operation === 'update')
      return http.req('PATCH', progressPath, { body: { ...(data ?? {}), mutation }, signal })
    if (operation === 'delete')
      return http.req('DELETE', progressPath, { body: { mutation }, signal })
    return http.req('POST', `${progressPath}/restore`, { body: { mutation }, signal })
  },

  mutateMatterResource(
    publicId: string,
    operation: 'link' | 'update' | 'unlink' | 'restore',
    resourceId: number | undefined,
    data: Record<string, unknown> | undefined,
    mutation: DomainMatterMutation,
    signal?: AbortSignal
  ): Promise<DomainMatterResult> {
    const base = `/matters/${encodeURIComponent(publicId)}/resources`
    if (operation === 'link')
      return http.req('POST', base, { body: { ...(data ?? {}), mutation }, signal })
    const resourcePath = `${base}/${resourceId}`
    if (operation === 'update')
      return http.req('PATCH', resourcePath, { body: { ...(data ?? {}), mutation }, signal })
    if (operation === 'unlink')
      return http.req('DELETE', resourcePath, { body: { mutation }, signal })
    return http.req('POST', `${resourcePath}/restore`, { body: { mutation }, signal })
  },

  mutateMatterStakeholder(
    publicId: string,
    operation: 'create' | 'update' | 'delete' | 'restore',
    stakeholderId: number | undefined,
    data: Record<string, unknown> | undefined,
    mutation: DomainMatterMutation,
    signal?: AbortSignal
  ): Promise<DomainMatterResult> {
    const base = `/matters/${encodeURIComponent(publicId)}/stakeholders`
    if (operation === 'create')
      return http.req('POST', base, { body: { ...(data ?? {}), mutation }, signal })
    const stakeholderPath = `${base}/${stakeholderId}`
    if (operation === 'update')
      return http.req('PATCH', stakeholderPath, { body: { ...(data ?? {}), mutation }, signal })
    if (operation === 'delete')
      return http.req('DELETE', stakeholderPath, { body: { mutation }, signal })
    return http.req('POST', `${stakeholderPath}/restore`, { body: { mutation }, signal })
  },

  mutateMatterRelation(
    publicId: string,
    operation: 'create' | 'update' | 'delete' | 'restore',
    relationId: number | undefined,
    data: Record<string, unknown> | undefined,
    mutation: DomainMatterMutation,
    signal?: AbortSignal
  ): Promise<DomainMatterResult> {
    const base = `/matters/${encodeURIComponent(publicId)}/relations`
    if (operation === 'create')
      return http.req('POST', base, { body: { ...(data ?? {}), mutation }, signal })
    const relationPath = `${base}/${relationId}`
    if (operation === 'update')
      return http.req('PATCH', relationPath, { body: { ...(data ?? {}), mutation }, signal })
    if (operation === 'delete')
      return http.req('DELETE', relationPath, { body: { mutation }, signal })
    return http.req('POST', `${relationPath}/restore`, { body: { mutation }, signal })
  },

  addMatterNote(
    publicId: string,
    data: Record<string, unknown>,
    mutation: DomainMatterMutation,
    signal?: AbortSignal
  ): Promise<DomainMatterResult> {
    return http.req('POST', `/matters/${encodeURIComponent(publicId)}/notes`, {
      body: { ...data, mutation },
      signal
    })
  },

  // ── 0813 轮 3 批 R — the four surfaces that had REST but no tool ─────────────────────────────

  /** GET /matters/attention (all Matters) or /matters/{id}/attention (one). Same service call
   *  behind both; the path is what scopes it. */
  listMatterAttention(
    opts: { publicId?: string; state?: string },
    signal?: AbortSignal
  ): Promise<{ items: Array<Record<string, unknown>> }> {
    const path =
      opts.publicId != null
        ? `/matters/${encodeURIComponent(opts.publicId)}/attention`
        : '/matters/attention'
    return http.req('GET', path, { query: { state: opts.state }, signal })
  },

  /** POST /matters/{id}/attention/{signal_id}/{resolve|snooze|dismiss}.
   *  🔴 The action is a PATH segment, so it is encoded here rather than posted as data — a
   *  mis-spelled action 404s at the router instead of silently taking a default branch. */
  triageMatterAttention(
    publicId: string,
    signalId: number,
    action: 'resolve' | 'snooze' | 'dismiss',
    payload: { until?: number },
    mutation: DomainMatterMutation,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return http.req(
      'POST',
      `/matters/${encodeURIComponent(publicId)}/attention/${signalId}/${action}`,
      { body: { ...payload, mutation }, signal }
    )
  },

  /** GET /matters/{id}/runs — the follow-up run ledger. Gated server-side by the matter-agent
   *  flag (409/403 when it is off), which is why the tool is only registered when that flag is on. */
  listMatterRuns(
    publicId: string,
    opts: { limit?: number },
    signal?: AbortSignal
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor?: number | null }> {
    return http.req('GET', `/matters/${encodeURIComponent(publicId)}/runs`, {
      query: { limit: opts.limit },
      signal
    })
  },

  /** GET /matters/tags — the tag vocabulary (name + color/shape + usage_count). */
  listMatterTags(signal?: AbortSignal): Promise<{ items: Array<Record<string, unknown>> }> {
    return http.req('GET', '/matters/tags', { signal })
  },

  /** POST /matters/{id}/resource-suggestions/bulk — confirm or reject unconfirmed suggestions in
   *  ONE version check + ONE version bump. Always 200: ids that were already handled elsewhere
   *  come back per-row in `skipped`, they do not fail the batch. */
  resolveMatterSuggestions(
    publicId: string,
    resourceIds: readonly number[],
    action: 'confirm' | 'reject',
    mutation: DomainMatterMutation,
    signal?: AbortSignal
  ): Promise<DomainMatterResult> {
    return http.req('POST', `/matters/${encodeURIComponent(publicId)}/resource-suggestions/bulk`, {
      body: { resource_ids: resourceIds, action, mutation },
      signal
    })
  },

  // ── Matters MVP P4 — follow-up runs, proposals, review (contracts §3.8/§3.9) ───────────────
  //
  // 🔴 `proposeMatterUpdate` targets the INTERNAL proposal endpoint (verify_local_token + the
  // matters/agent double flag gate, never the cf_access face): only the gateway, running a
  // server-assembled matter_followup spec, can reach it. The matter/run identity comes from the
  // path — the tool's input carries neither (D6).

  /** POST /matters/{public_id}/runs/{run_id}/proposal — the follow-up run's single write.
   *  409 E_PROPOSAL_EXISTS when this run already submitted one (at most one proposal per run). */
  proposeMatterUpdate(
    publicId: string,
    runId: number,
    proposal: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return http.req('POST', `/matters/${encodeURIComponent(publicId)}/runs/${runId}/proposal`, {
      body: proposal,
      signal
    })
  },

  /** POST /matters/{public_id}/item-dispatches/{dispatch_id}/report — an ITEM-dispatch run's
   *  single delivery (L4 批次3). Same INTERNAL face as proposeMatterUpdate above
   *  (verify_local_token, gateway-only): the matter + dispatch identity comes from the path, the
   *  tool's input carries neither. Either a result (summary/changes → a pending proposal) or a
   *  question (needs_input → the dispatch waits on the owner); Python enforces the one-of-two and
   *  409s a second delivery for the same attempt. */
  reportItemDispatch(
    publicId: string,
    dispatchId: number,
    report: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return http.req(
      'POST',
      `/matters/${encodeURIComponent(publicId)}/item-dispatches/${dispatchId}/report`,
      { body: report, signal }
    )
  },

  /** POST /matters/{public_id}/runs — start a manual follow-up run. `trigger_kind` is NOT part of
   *  the request: 'manual' is the only kind this face produces (contracts §4.4 — a schedule start
   *  is the scheduler's own internal path). An already-active run returns 200 + coalesced:true. */
  startMatterRun(
    publicId: string,
    mutation: DomainMatterMutation,
    signal?: AbortSignal
  ): Promise<DomainMatterResult> {
    return http.req('POST', `/matters/${encodeURIComponent(publicId)}/runs`, {
      body: { mutation },
      signal
    })
  },

  /** POST /matters/{public_id}/runs/{run_id}/cancel — CAS cancel (queued → canceled outright;
   *  running → a cooperative cancel request). Never rolls back what the run already observed. */
  cancelMatterRun(
    publicId: string,
    runId: number,
    mutation: DomainMatterMutation,
    signal?: AbortSignal
  ): Promise<DomainMatterResult> {
    return http.req('POST', `/matters/${encodeURIComponent(publicId)}/runs/${runId}/cancel`, {
      body: { mutation },
      signal
    })
  },

  /** GET /matters/{public_id}/updates/{update_id} — the full proposal (original + changes +
   *  citations + reviewed result). Consumed by matter_review_update's dynamic approval seam to
   *  decide whether the SELECTED changes touch a `field` (→ approval card). */
  getMatterUpdate(
    publicId: string,
    updateId: number,
    signal?: AbortSignal
  ): Promise<DomainMatterUpdateDetail> {
    return http.req('GET', `/matters/${encodeURIComponent(publicId)}/updates/${updateId}`, {
      signal
    })
  },

  /** POST /matters/{public_id}/updates/{update_id}/accept|reject — the owner's review decision.
   *  accept applies the selected (optionally edited) changes in ONE transaction and bumps the
   *  Matter version exactly once; reject applies nothing but still records the decision. */
  reviewMatterUpdate(
    publicId: string,
    updateId: number,
    decision: 'accept' | 'reject',
    payload: Record<string, unknown>,
    mutation: DomainMatterMutation,
    signal?: AbortSignal
  ): Promise<DomainMatterResult> {
    return http.req(
      'POST',
      `/matters/${encodeURIComponent(publicId)}/updates/${updateId}/${decision}`,
      { body: { ...payload, mutation }, signal }
    )
  }
  }
}

export type MattersMethods = ReturnType<typeof createMattersMethods>
