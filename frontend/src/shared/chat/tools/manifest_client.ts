// P2a — Skill manifest client. Fetches the authoritative manifest from serve-api
// (GET /api/skills) so the harness can build its tool catalog from the same
// single source the MCP / REST / external-agent surfaces use.
//
// The manifest is an ENHANCEMENT, never a hard dependency: any failure (network,
// auth, unexpected shape) returns null so the caller falls back to the legacy
// builtin catalog (architecture.md §3.2). Zero Electron/Node import.

import { request } from '../../api/http_client'
import type { SkillManifest } from './manifest'

/** Fetch the Skill manifest. `baseUrl` already carries the `/api` prefix (same
 *  value the chat reads use), so the path is `/skills` → `/api/skills`. Returns
 *  null on any failure or a shape that isn't a manifest (so the harness can fall
 *  back to createBuiltinTools). request() unwraps the success envelope's `data`. */
export async function fetchSkillManifest(baseUrl: string): Promise<SkillManifest | null> {
  try {
    const manifest = await request<SkillManifest>(baseUrl, 'GET', '/skills')
    if (manifest && Array.isArray(manifest.skills)) return manifest
    return null
  } catch (err) {
    console.warn('[chat] skill manifest fetch failed; falling back to builtin catalog', err)
    return null
  }
}
