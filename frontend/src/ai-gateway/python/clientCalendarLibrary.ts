// Calendar reads/writes and Library reads/writes.
import { AgentsDomainClient } from './clientAgents'
import { DomainError, libraryActorWire } from './clientCore'
import type { DomainLibraryActor, DomainLibraryFolder, DomainLibrarySearch } from './domainTypes'
import type { LibrarySource } from '@shared/libraryConstants'

export class CalendarLibraryDomainClient extends AgentsDomainClient {
  // ── calendar primitives (calendar epic 4.1/4.2) — the local calendar SSoT reads + the CalDAV/
  //    iTIP writes via serve-api /calendar/* (routers/calendar.py is the business authority: CLI-
  //    mirrored branch semantics, strict tz-aware ISO validation, audit line per write) → remote
  //    parity for free. The tools that call these are only registered when
  //    MAILAGENT_CALENDAR_AGENT_TOOLS is on; the three writes are edit-tier (always ask, D4 恒 HITL).

  /** calendar_events_list — occurrences in a window (RRULE expanded server-side). GET
   *  /calendar/events (camelCase alias query; C7: data = the bare occurrence array). fromIso/toIso
   *  are FULL tz-aware ISO datetimes — the TOOL computes them from tz-local wall dates (P2-4), so
   *  the server's UTC-midnight default window is never consulted. */
  calendarEventsList(
    opts: { fromIso: string; toIso: string; calendarName?: string; limit?: number },
    signal?: AbortSignal
  ): Promise<Array<Record<string, unknown>>> {
    return this._req<Array<Record<string, unknown>>>('GET', '/calendar/events', {
      query: {
        fromIso: opts.fromIso,
        toIso: opts.toIso,
        calendarName: opts.calendarName,
        limit: opts.limit
      },
      signal
    })
  }

  /** calendar_event_get — one event's full row by iCalendar UID. GET /calendar/events/by-uid
   *  (?uid&source&recurrenceId; C7: data = the bare detail object). E_NOT_FOUND → null. */
  async calendarEventGet(
    eventId: string,
    opts: { source?: string; recurrenceId?: string } = {},
    signal?: AbortSignal
  ): Promise<Record<string, unknown> | null> {
    try {
      return await this._req<Record<string, unknown>>('GET', '/calendar/events/by-uid', {
        query: { uid: eventId, source: opts.source, recurrenceId: opts.recurrenceId },
        signal
      })
    } catch (e) {
      if (e instanceof DomainError && e.code === 'E_NOT_FOUND') return null
      throw e
    }
  }

  /** calendar_event_reschedule — CalDAV update. PATCH /calendar/events/by-uid?uid=...; the body's
   *  recurrenceId/splitFuture combination selects the CLI-mirrored branch (整系列 / 改这一次
   *  detached / 改未来 split). startIso/endIso must be tz-aware (the server rejects naive). */
  calendarEventUpdate(
    eventId: string,
    body: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this._req<Record<string, unknown>>('PATCH', '/calendar/events/by-uid', {
      query: { uid: eventId },
      body,
      signal
    })
  }

  /** calendar_event_rsvp — send the IRREVOCABLE iTIP REPLY to the organizer (recipient is derived
   *  from the event row SERVER-SIDE — never a caller field). POST /calendar/events/by-uid/rsvp?uid=... */
  calendarEventRsvp(
    eventId: string,
    body: { response: string; recurrenceId?: string },
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const wire: Record<string, unknown> = { response: body.response }
    if (body.recurrenceId !== undefined) wire.recurrenceId = body.recurrenceId
    return this._req<Record<string, unknown>>('POST', '/calendar/events/by-uid/rsvp', {
      query: { uid: eventId },
      body: wire,
      signal
    })
  }

  /** calendar_event_delete — CalDAV DELETE (irreversible; the HTTP request IS the confirmation —
   *  the gateway approval card is the human gate). DELETE /calendar/events/by-uid?uid=...&calendarName=. */
  calendarEventDelete(
    eventId: string,
    calendarName?: string,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this._req<Record<string, unknown>>('DELETE', '/calendar/events/by-uid', {
      query: { uid: eventId, calendarName },
      signal
    })
  }

  // ── 资料库（Library）read face — design §3. Rows come back snake_case (= DB columns); the
  //    projection into the tool's return shape lives in tools/library.ts, not here. `maxBytes` is
  //    the wire ceiling (READ_TOOL_MAX_BYTES); the 12000-char cap is applied tool-side. ──

  /** library_list — GET /library/folder. Omitting `path` asks for the library root. */
  libraryFolder(
    opts: { path?: string; limit: number; offset: number },
    signal?: AbortSignal
  ): Promise<DomainLibraryFolder> {
    return this._req<DomainLibraryFolder>('GET', '/library/folder', {
      query: { path: opts.path, limit: opts.limit, offset: opts.offset },
      signal
    })
  }

  /** library_read step 1 — GET /library/file/{id}: metadata + `content_hash` +, for text files,
   *  the body itself. */
  libraryFile(
    fileId: number,
    maxBytes: number,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this._req<Record<string, unknown>>('GET', `/library/file/${fileId}`, {
      query: { max_bytes: maxBytes },
      signal
    })
  }

  /** library_read step 2 — GET /library/file/{id}/text: the parsed markdown (`library_text`), the
   *  same one the preview pane and FTS read. 🔴 This call is also what TRIGGERS extraction for a
   *  `pending` file (design §3 抽取兜底), so it is never a skippable round trip. */
  libraryFileText(
    fileId: number,
    maxBytes: number,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this._req<Record<string, unknown>>('GET', `/library/file/${fileId}/text`, {
      query: { max_bytes: maxBytes },
      signal
    })
  }

  /** library_read on a PROJECTED mail attachment — GET /library/attachment/{attachment_id}
   *  and its /text sibling. Projections have no library id, so the `/file/{id}` family is
   *  structurally uncallable for them; these two are the library-native read face (the /text one
   *  reads `email_attachment_text` and does NOT re-extract). */
  libraryAttachment(
    attachmentId: number,
    maxBytes: number,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this._req<Record<string, unknown>>('GET', `/library/attachment/${attachmentId}`, {
      query: { max_bytes: maxBytes },
      signal
    })
  }

  libraryAttachmentText(
    attachmentId: number,
    maxBytes: number,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this._req<Record<string, unknown>>('GET', `/library/attachment/${attachmentId}/text`, {
      query: { max_bytes: maxBytes },
      signal
    })
  }

  /** library_search — GET /library/search. Keyword only (no DSL); `warning` carries the
   *  too-short-query notice so a 1-character query is not a silent zero-hit. */
  librarySearch(
    opts: { q: string; limit: number },
    signal?: AbortSignal
  ): Promise<DomainLibrarySearch> {
    return this._req<DomainLibrarySearch>('GET', '/library/search', {
      query: { q: opts.q, limit: opts.limit },
      signal
    })
  }

  // ── 资料库 write face (P2-L1) — routers/library.py 的写端点。Every write carries `actor` (see
  //    DomainLibraryActor). Authorization is SERVER-side (mail-attachments projection / .trash /
  //    ro mount refuse; custom agent → agent-docs/ only; main agent also my-docs/; WRITE_EXT_ALLOWLIST;
  //    size cap): the gateway sends identity + target, never a verdict, and a refusal comes back as a
  //    DomainError the tool surfaces verbatim. A CAS miss is 409 E_VERSION_CONFLICT with the envelope's
  //    top-level data = {content_hash, content} (DomainError.data, see _req). Request models are
  //    `extra="forbid"` — send exactly these keys. Rows come back as LibraryFile rows like the read face;
  //    projection lives in tools/library.ts. ──

  /** library_write mode=create_new — POST /library/files JSON (the renderer's createTextFile body
   *  + actor). `source` is fixed to 'agent': the gateway is the only agent-side producer. An
   *  occupied path → 409 E_VERSION_CONFLICT (no data). */
  libraryCreateFile(
    input: { parentPath: string; filename: string; content: string; changeNote?: string },
    actor: DomainLibraryActor,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this._req<Record<string, unknown>>('POST', '/library/files', {
      body: {
        parent_path: input.parentPath,
        filename: input.filename,
        content: input.content,
        source: 'agent',
        change_note: input.changeNote ?? null,
        actor: libraryActorWire(actor)
      },
      signal
    })
  }

  /** 二进制入库 —— `POST /library/files` 的 **octet-stream 分支**
   *  (routers/library.py::library_create_file 的 else 支：参数走 query，请求体是裸字节)。
   *
   *  🔴 与上面 / 下面那几个写方法不同，这条**不带 actor**：那个分支服务端 hardcode
   *  `actor = Actor()`（= 用户），因为它是「app 代用户归档」的通道 —— renderer 的发送即入库、
   *  gateway 的 generate_image 归档，路径与文件名都由我们自己的代码算出，不是模型给的。
   *  **这不是给 agent 开的后门**：模型自己写库仍只能走 libraryCreateFile / libraryWriteFile /
   *  libraryAppendFile 那三条带 actor 的路，服务端照旧把 main agent 关在 agent-docs/ 与
   *  my-docs/ 里、且只允许 WRITE_EXT_ALLOWLIST 的文本扩展名。
   *  路径已被占用 → 409 E_VERSION_CONFLICT（与 create 同一条服务端语义）。 */
  libraryUploadBinary(
    input: {
      parentPath: string
      filename: string
      bytes: Uint8Array
      source: LibrarySource
      sourceRef?: string
    },
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this._req<Record<string, unknown>>('POST', '/library/files', {
      query: {
        parent_path: input.parentPath,
        filename: input.filename,
        source: input.source,
        source_ref: input.sourceRef
      },
      rawBody: input.bytes,
      signal
    })
  }

  /** library_write mode=overwrite — PUT /library/file/{id} {content, expected_hash, change_note,
   *  actor}. expected_hash ≠ current (or null) → 409 with data={content_hash, content}; same
   *  content → no-op (row returned unchanged, no history row). */
  libraryWriteFile(
    fileId: number,
    input: { content: string; expectedHash: string | null; changeNote?: string },
    actor: DomainLibraryActor,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this._req<Record<string, unknown>>('PUT', `/library/file/${fileId}`, {
      body: {
        content: input.content,
        expected_hash: input.expectedHash,
        change_note: input.changeNote ?? null,
        actor: libraryActorWire(actor)
      },
      signal
    })
  }

  /** library_append — POST /library/file/{id}/append {content, change_note, actor}. Additive (no
   *  CAS): the snapshot in history is still the full post-append text. */
  libraryAppendFile(
    fileId: number,
    input: { content: string; changeNote?: string },
    actor: DomainLibraryActor,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this._req<Record<string, unknown>>('POST', `/library/file/${fileId}/append`, {
      body: {
        content: input.content,
        change_note: input.changeNote ?? null,
        actor: libraryActorWire(actor)
      },
      signal
    })
  }

  /** library_move — POST /library/file/{id}/move {target_path, actor}. `target_path` is a virtual
   *  path (a full new path, or an existing folder → filename kept). */
  libraryMoveFile(
    fileId: number,
    targetPath: string,
    actor: DomainLibraryActor,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this._req<Record<string, unknown>>('POST', `/library/file/${fileId}/move`, {
      body: { target_path: targetPath, actor: libraryActorWire(actor) },
      signal
    })
  }

  /** library_delete — DELETE /library/file/{id}?actor_kind=&agent_id= : SOFT delete → .trash
   *  (restorable). The endpoint's `purge` query is a renderer-only affordance (mockup F11) the
   *  gateway never sends — omitted, so the server default (false) applies. */
  libraryTrashFile(
    fileId: number,
    actor: DomainLibraryActor,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this._req<Record<string, unknown>>('DELETE', `/library/file/${fileId}`, {
      query: { actor_kind: actor.kind, agent_id: actor.agentId },
      signal
    })
  }

  /** Issue an ephemeral loopback capability URL for browser_use preview of saved artifacts. */
  libraryIssueArtifactPreviewToken(
    input: { slug: string; version?: number; entryPath?: string },
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this._req<Record<string, unknown>>('POST', '/library/artifacts/preview-token', {
      body: {
        slug: input.slug,
        version: input.version ?? null,
        entry_path: input.entryPath ?? 'index.html'
      },
      signal
    })
  }

  /** Publish a saved local artifact directory / bundle to Canvas Artifact Server. */
  libraryPublishArtifactBundle(
    input: {
      slug: string
      version?: number
      title?: string
      artifactType?: string
      project?: string
      visibility?: 'private' | 'unlisted' | 'public'
      changeNote?: string
      entryPath?: string
    },
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    return this._req<Record<string, unknown>>('POST', '/library/artifacts/publish-bundle', {
      body: {
        slug: input.slug,
        version: input.version ?? null,
        title: input.title ?? null,
        artifact_type: input.artifactType ?? 'app',
        project: input.project ?? null,
        visibility: input.visibility ?? null,
        change_note: input.changeNote ?? null,
        entry_path: input.entryPath ?? 'index.html'
      },
      signal
    })
  }
}
