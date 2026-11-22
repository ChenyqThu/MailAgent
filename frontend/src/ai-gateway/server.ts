// chat-panel P4 Phase 02 — embedded AI SDK Gateway (HTTP server assembly & lifecycle).
//
// Route handlers live under ./routes/*.ts; this entrypoint keeps only CORS reflection, dispatch
// crash belt, and createAiGatewayServer / startAiGatewayServer.

import { createServer, type Server, type ServerResponse } from 'node:http'

import type { AiGatewayConfig } from './config'
import { corsHeadersFor, writeJson, writeSse } from './httpUtil'
import { handleAguiChat } from './agui/aguiRoute'
import { CompactCoordinator } from './compact'
import { handleInternalComplete } from './internalComplete'
import { GENERATED_IMAGE_ROUTE_PREFIX } from './tools/image'
import {
  handleChat,
  handleImChat,
  handleRunActive,
  handleRunStop,
  handleRunStream
} from './routes/chatRoutes'
import {
  handleCompact,
  handleCompactStop,
  handleQueuedInputEnqueue,
  handleQueuedInputInterrupt,
  handleQueuedInputList,
  handleQueuedInputMutation
} from './routes/queuedInputRoutes'
import {
  handleApprovalDecide,
  handleApprovalPending,
  handleApprovalResolve,
  handlePolicyRemember
} from './routes/approvalRoutes'
import { buildGroupScheduler, handleGroupChat, speakAsGroupMember } from './routes/groupRoutes'
import {
  handleAgentRun,
  handleEchoStream,
  handleGeneratedImage,
  handleSearchAgent,
  handleTitle
} from './routes/agentRoutes'

export { speakAsGroupMember }

const GATEWAY_VERSION = '0.2.0'

export interface AiGatewayHandle {
  server: Server
  /** actual listening port (kernel-assigned when cfg.port === 0). */
  port: number
  close: () => Promise<void>
}

/**
 * 🔴 The dispatcher's ONE crash belt (08-04 im-chat hang).
 *
 * Every route below is an async handler launched fire-and-forget from the SYNC createServer
 * callback. The old `void handleX(...)` swallowed the rejection, so any throw a handler does not
 * catch itself left the response NEVER WRITTEN — no status, no body, socket held open — and the
 * client hung until its OWN timeout. Not theoretical: prepareChatRun re-throws every non-credential
 * resolver failure (providers.ts throws a bare `Error('No enabled LLM provider: X')` for an unknown
 * provider ref), nothing caught it, and /api/ai/chat + /api/ai/im-chat answered nothing at all —
 * the 飞书 bridge's CHAT_READ_TIMEOUT_SEC is 1800s, i.e. a 30-minute silent hang for a typo in a
 * model ref, and the desktop panel waits on its own timeout too.
 *
 * This is a STRUCTURAL floor, not an error re-classifier: handlers that map their own failures
 * (title → 502 E_UPSTREAM, agent-run → 500 E_AGENT_RUN_CRASH, decide/resolve/remember → 500
 * E_INTERNAL) answer first and never reach here, and prepareChatRun's 503-vs-throw split is
 * unchanged. Pre-headers → 500 E_INTERNAL through writeJson, so the entry's single-point CORS
 * reflection still applies. Mid-stream → best-effort `{type:'error'}` SSE frame + end (every
 * streaming route here is text/event-stream, and that is the AI SDK UI message stream's own error
 * shape) so a streaming client sees a failure instead of a truncated stream; if even that write
 * throws, destroy.
 *
 * The log is a SUMMARY (name + message), never the error object: SDK errors routinely carry the
 * request body — i.e. the user's message text — so `console.error(err)` writes chat content into
 * the log (PRD Technical Notes ①, LobeHub's describePlatformError lesson).
 */
function dispatch(route: string, res: ServerResponse, work: Promise<void>): void {
  void work.catch((err: unknown) => {
    const name = err instanceof Error ? err.name : typeof err
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[ai-gateway] ${route} handler crashed`, { name, message })
    if (res.destroyed || res.writableEnded) return
    try {
      if (!res.headersSent) {
        writeJson(res, 500, { error: 'E_INTERNAL', hint: message })
        return
      }
      if (String(res.getHeader('content-type') ?? '').includes('text/event-stream')) {
        writeSse(res, { type: 'error', errorText: message })
      }
      res.end()
    } catch {
      try {
        res.destroy()
      } catch {
        /* already gone */
      }
    }
  })
}

/**
 * Create (but do not listen) the gateway HTTP server. Pure factory — all external
 * deps arrive via cfg, so the Electron main can embed it and the Node harness can
 * drive it directly.
 */
export function createAiGatewayServer(cfg: AiGatewayConfig): Server {
  const compactCoordinator =
    cfg.compactCoordinator ??
    (cfg.compactPersistence ? new CompactCoordinator(cfg, cfg.compactPersistence) : null)
  // g1 — one 调度器 per gateway process (single serial worker across every group session).
  const groupScheduler = buildGroupScheduler(cfg)
  // g2 — the ONE delivery seam the group tools (group_post / group_create) reach the 调度器
  // through: a narrow function written back onto the (mutable) cfg, so the lifecycle's tool hooks
  // can read it lazily at call time without ever holding the instance (stopFamily / requeue never
  // reach a tool). No 调度器 → the seam stays absent → the tools answer E_GROUP_NOT_ORCHESTRATED.
  if (groupScheduler) {
    cfg.deliverGroupMessage = (sessionId, row) => groupScheduler.onGroupMessage(sessionId, row)
  }
  return createServer((req, res) => {
    const url = req.url ?? '/'
    const method = req.method ?? 'GET'
    const path = url.split('?')[0]

    // Loopback-only CORS on EVERY response, from one spot. Phase 06a attached
    // corsHeadersFor to the SSE/chat writeHead sites but left the writeJson GET routes
    // (/health, /api/ai/config, /api/ai/run/active, …) without ACAO — the packaged
    // renderer tolerated that, but the DEV renderer (http://localhost:<vite>) is
    // cross-origin to this loopback server and the browser blocks the read → the
    // panel's health probe fails → spurious "engine unavailable" read-only face while
    // the gateway is healthy. corsHeadersFor stays restrictive (a remote origin gets
    // no ACAO), so reflecting here widens nothing; routes that already merge it just
    // re-set identical values. Array-form headers (unused here) pass through untouched.
    const cors = corsHeadersFor(req.headers.origin)
    if (Object.keys(cors).length > 0) {
      const origWriteHead = res.writeHead.bind(res)
      res.writeHead = ((status: number, arg2?: unknown, arg3?: unknown) => {
        if (typeof arg2 === 'string') {
          return Array.isArray(arg3)
            ? origWriteHead(status, arg2, arg3)
            : origWriteHead(status, arg2, { ...cors, ...(arg3 as object | undefined) })
        }
        return Array.isArray(arg2)
          ? origWriteHead(status, arg2)
          : origWriteHead(status, { ...cors, ...(arg2 as object | undefined) })
      }) as typeof res.writeHead
    }

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        ...corsHeadersFor(req.headers.origin),
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      })
      res.end()
      return
    }

    const hasKey = Boolean(cfg.apiKey && cfg.apiKey.length > 0)

    if (method === 'GET' && path === '/health') {
      writeJson(res, 200, {
        status: 'ok',
        service: 'mailagent-ai-gateway',
        version: GATEWAY_VERSION,
        model: cfg.model,
        hasKey,
        baseUrl: cfg.baseUrl
      })
      return
    }

    // Observable runtime config (renderer may prefetch before constructing the
    // AI SDK transport). modelConfigured mirrors the spec §3 health shape.
    if (method === 'GET' && path === '/api/ai/config') {
      writeJson(res, 200, {
        service: 'mailagent-ai-gateway',
        version: GATEWAY_VERSION,
        model: cfg.model,
        modelConfigured: hasKey,
        baseUrl: cfg.baseUrl,
        persistence: Boolean(cfg.persistTurn),
        // Phase 05 — observable so a client can discover the mirror without probing 404.
        aguiMirror: Boolean(cfg.aguiMirrorEnabled)
      })
      return
    }

    if (method === 'POST' && path === '/api/ai/echo-stream') {
      dispatch('/api/ai/echo-stream', res, handleEchoStream(req, res))
      return
    }

    if (method === 'POST' && path === '/api/ai/chat') {
      dispatch('/api/ai/chat', res, handleChat(req, res, cfg))
      return
    }

    if (method === 'POST' && path === '/api/ai/compact') {
      dispatch('/api/ai/compact', res, handleCompact(req, res, cfg, compactCoordinator))
      return
    }

    if (method === 'POST' && path === '/api/ai/compact/stop') {
      dispatch('/api/ai/compact/stop', res, handleCompactStop(req, res, compactCoordinator))
      return
    }

    // Stage 2 PR-1 — the im_chat entrypoint. Registered ONLY when MAILAGENT_IM_FEISHU is on
    // (cfg.imFeishuEnabled); flag-off the path falls through to 404 and the gateway stays
    // byte-identical (mirrors the AG-UI mirror's flag-gated registration).
    if (cfg.imFeishuEnabled === true && method === 'POST' && path === '/api/ai/im-chat') {
      dispatch('/api/ai/im-chat', res, handleImChat(req, res, cfg))
      return
    }

    // Phase 04a — edit-tier approval side-channel (DraftReplyCard edits before approve).
    if (method === 'POST' && path === '/api/ai/approval/resolve') {
      dispatch('/api/ai/approval/resolve', res, handleApprovalResolve(req, res, cfg))
      return
    }

    // Part B (island) + S6 W2 (in-record) — approval decision → server-side resume. Registered
    // unconditionally; cfg.approvalStash gates it (404 when server-side resume is off).
    if (method === 'POST' && path === '/api/ai/approval/decide') {
      dispatch('/api/ai/approval/decide', res, handleApprovalDecide(req, res, cfg))
      return
    }

    // S2 W1 — exec whitelist "always allow" side-channel. Registered unconditionally;
    // cfg.rememberExecApproval gates it (501 when exec tools aren't wired).
    if (method === 'POST' && path === '/api/ai/policy/remember') {
      dispatch('/api/ai/policy/remember', res, handlePolicyRemember(req, res, cfg))
      return
    }

    // S3 W1 — headless agentic search (⌘K palette). Registered unconditionally; no key → 503.
    if (method === 'POST' && path === '/api/ai/search-agent') {
      dispatch('/api/ai/search-agent', res, handleSearchAgent(req, res, cfg))
      return
    }

    // v30（群聊）— group-chat writes (user append + member speaker runs). Registered
    // unconditionally; the three group cfg hooks gate it (404 when not wired).
    if (method === 'POST' && path === '/api/ai/group-chat') {
      dispatch('/api/ai/group-chat', res, handleGroupChat(req, res, cfg, groupScheduler))
      return
    }

    // S4 W3 — headless custom-agent fresh-spawn (AgentRunWorker poke). Registered unconditionally;
    // cfg.fetchAgentRunSpec + cfg.createAgentSession gate it (404 when custom agents are off).
    if (method === 'POST' && path === '/api/ai/agent-run') {
      dispatch('/api/ai/agent-run', res, handleAgentRun(req, res, cfg))
      return
    }

    // Part B follow-up + S6 W1 — pending-approval truth probe. Registered unconditionally; a miss
    // (nothing stashed) → 404 { pending:false } (fail-closed truth), a hit → the enriched
    // decide-card body (never the resumeToken).
    if (method === 'GET' && path === '/api/ai/approval/pending') {
      // Async since #6 (the preview line is fetched from serve-api) → through the crash belt.
      dispatch('/api/ai/approval/pending', res, handleApprovalPending(res, cfg, url))
      return
    }

    // task 09-02 — generate_image's read-only file route (cfg.generatedImagesDir gates it: absent
    // → 404, same as an unknown path). Async (stat) → through the crash belt.
    if (method === 'GET' && path.startsWith(GENERATED_IMAGE_ROUTE_PREFIX)) {
      dispatch('/api/ai/generated', res, handleGeneratedImage(res, cfg, path))
      return
    }

    // B1 (harness-chat lane A) — detached-run truth probe + live stream replay + explicit stop channel.
    if (method === 'GET' && path === '/api/ai/run/active') {
      handleRunActive(res, cfg, url, groupScheduler)
      return
    }
    if (method === 'GET' && path === '/api/ai/run/stream') {
      handleRunStream(req, res, cfg, url)
      return
    }
    if (method === 'POST' && path === '/api/ai/run/stop') {
      dispatch('/api/ai/run/stop', res, handleRunStop(req, res, cfg, groupScheduler))
      return
    }

    if (method === 'GET' && path === '/api/ai/queued-input') {
      dispatch('/api/ai/queued-input', res, handleQueuedInputList(res, cfg, url))
      return
    }
    if (method === 'POST' && path === '/api/ai/queued-input') {
      dispatch('/api/ai/queued-input', res, handleQueuedInputEnqueue(req, res, cfg))
      return
    }
    if (method === 'POST' && path === '/api/ai/queued-input/update') {
      dispatch(
        '/api/ai/queued-input/update',
        res,
        handleQueuedInputMutation(req, res, cfg, 'update')
      )
      return
    }
    if (method === 'POST' && path === '/api/ai/queued-input/cancel') {
      dispatch(
        '/api/ai/queued-input/cancel',
        res,
        handleQueuedInputMutation(req, res, cfg, 'cancel')
      )
      return
    }
    if (method === 'POST' && path === '/api/ai/queued-input/send') {
      dispatch('/api/ai/queued-input/send', res, handleQueuedInputMutation(req, res, cfg, 'send'))
      return
    }
    if (method === 'POST' && path === '/api/ai/queued-input/interrupt') {
      dispatch('/api/ai/queued-input/interrupt', res, handleQueuedInputInterrupt(req, res, cfg))
      return
    }

    // Phase 10b — configurable LLM auto-title (renderer POSTs after the first turn when enabled).
    // Registered unconditionally; cfg.getTitleContext/saveSessionTitle gate it (501 when not wired).
    if (method === 'POST' && path === '/api/ai/title') {
      dispatch('/api/ai/title', res, handleTitle(req, res, cfg))
      return
    }

    // Phase 05 — AG-UI interop mirror. Registered ONLY when MAILAGENT_AG_UI_MIRROR is on
    // (cfg.aguiMirrorEnabled); flag-off the path falls through to 404 (byte-identical to 04b).
    if (cfg.aguiMirrorEnabled && method === 'POST' && path === '/api/ai/agui/chat') {
      dispatch('/api/ai/agui/chat', res, handleAguiChat(req, res, cfg))
      return
    }

    // Phase 4 WP-4C — Internal loopback LLM completion endpoint for Python background workers.
    if (method === 'POST' && path === '/api/ai/internal/complete') {
      dispatch('/api/ai/internal/complete', res, handleInternalComplete(req, res, cfg))
      return
    }

    writeJson(res, 404, { error: 'not_found', path })
  })
}

/** Create + listen (127.0.0.1). Returns the actual port + a graceful close. */
export function startAiGatewayServer(cfg: AiGatewayConfig): Promise<AiGatewayHandle> {
  const server = createAiGatewayServer(cfg)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(cfg.port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const addr = server.address()
      const actualPort = addr != null && typeof addr === 'object' ? addr.port : cfg.port
      resolve({
        server,
        port: actualPort,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res())
          })
      })
    })
  })
}
