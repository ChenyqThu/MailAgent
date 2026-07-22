// task 07-21 (codex R3 HIGH) — the gateway's env kill-switch parser, extracted from
// ai_gateway_lifecycle.ts so it can be pinned by a lightweight vitest (importing the
// full lifecycle module drags in electron + the whole `ai` SDK graph).
//
// 🔴 SINGLE SOURCE OF TRUTH for the Node-side kill-switch judgment. The Python side
// (src/skills/invoke.py `_gateway_envbool_on`) is a byte-for-byte mirror of THIS truth
// table so a shell/OS env value like `garbage` or a whitespace-only value is judged
// identically on both ends (no cross-end split-brain). Any change here MUST update the
// Python mirror + tests/api/test_skill_invoke.py's table, and vice versa.
//
// Truth table (envBool(key, def), reading process.env[key]):
//   undefined            → def          (unset → the supplied default)
//   ''    (empty string) → def          (checked BEFORE trim — same as unset)
//   '   ' (whitespace)   → false        (NOT ''; trims to '' → not '1'/'true')
//   '1' / ' 1 '          → true
//   'true'/'TRUE'/' true '→ true         (trim + case-insensitive)
//   '0'/'false'/'no'/'off'→ false
//   'garbage' / anything → false        (any other non-empty value → false)
//
// The asymmetry between '' (→ default) and '   ' (→ false) is intentional and mirrored.

/** Mirror electron readEnvBool: only '1'/'true' (case-insensitive, trimmed) → true;
 *  unset OR empty-string → the supplied default; any other non-empty value → false. */
export function envBool(key: string, def: boolean): boolean {
  const raw = process.env[key]
  if (raw == null || raw === '') return def
  const v = raw.trim().toLowerCase()
  return v === '1' || v === 'true'
}
