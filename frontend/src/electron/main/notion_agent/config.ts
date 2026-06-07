// Notion Agent CLI configuration service (main process).
//
// Reads + edits the notion-agent-cli account file
// (~/.notionagents/notion_account.json) so the in-app Settings page can show
// the current binding and switch the bound Custom Agent / default model
// without the user touching a terminal. token_v2 is never surfaced or
// editable here — auth lives with the CLI (`notion-agent init`); we only
// report whether it's present.
//
// The account file is a symlink (notion_account.json → <profile>.json). Reads
// follow it; writes resolve to the real target and go through a tmp+rename so
// the symlink itself is never clobbered and a crash mid-write can't truncate
// the live file. We round-trip the whole JSON object (only mutating the
// agent-binding / default-model keys) so every other field the CLI owns —
// token_v2, browser_id, device_id, … — survives untouched.

import { execa } from 'execa'
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import { whichSync } from '../bin_resolver'

const ACCOUNT_PATH = join(homedir(), '.notionagents', 'notion_account.json')
const MODELS_PATH = join(homedir(), '.notionagents', 'models.json')

const CLI_TIMEOUT_MS = 30_000

// V2.1 阶段 3c-4：从删除的 chat/backends/notion_agent.ts 迁入。cutover 删了 main execa
// NotionAgentBackend（notion-agent 执行归 serve-api asyncio spawn），但 notion-agent 的
// binary 解析是**配置探测**（agent 列表 / 默认 model 写入 / cliFound 都需要它），不是 chat
// 执行 —— 归属本配置模块（唯一非测试消费方就是本文件的 resolveConfig / list / write 路径）。
let _notionAgentBinCache: string | null = null

/** Resolve the `notion-agent` binary once and cache.
 *  Search order:
 *    1. $NOTION_AGENT_BIN (full path; ops escape hatch)
 *    2. `which notion-agent` (PATH lookup; pipx default if user ran `pipx ensurepath`)
 *    3. ~/.local/bin/notion-agent (pipx install location without PATH integration) */
export function resolveNotionAgentBin(): string {
  if (_notionAgentBinCache) return _notionAgentBinCache
  const fromEnv = process.env['NOTION_AGENT_BIN']
  if (fromEnv && existsSync(fromEnv)) {
    _notionAgentBinCache = fromEnv
    return fromEnv
  }
  try {
    const resolved = whichSync('notion-agent')
    if (resolved) {
      _notionAgentBinCache = resolved
      return resolved
    }
  } catch {
    /* fall through to pipx default */
  }
  const fallback = join(homedir(), '.local', 'bin', 'notion-agent')
  _notionAgentBinCache = fallback
  return fallback
}

/** Test-only — reset the binary path cache so tests can swap env vars. */
export function __resetNotionAgentBinCache(): void {
  _notionAgentBinCache = null
}

export interface NotionAgentConfig {
  /** Path we read/write (the symlink, not its target). */
  accountPath: string
  /** Resolved `notion-agent` binary path. */
  cliPath: string
  /** Whether that binary actually exists on disk. */
  cliFound: boolean
  /** account.json readable AND token_v2 present → backend can run. */
  configured: boolean
  /** token_v2 is set (we never return its value). */
  tokenPresent: boolean
  userName: string | null
  userEmail: string | null
  spaceName: string | null
  spaceId: string | null
  /** Bound Custom Agent display name (account.agent_name). */
  agentName: string | null
  /** Bound Custom Agent page id (account.agent_context_page_id). */
  agentPageId: string | null
  agentAccessory: string | null
  defaultModel: string | null
  timezone: string | null
}

export interface NotionAgentDoctorCheck {
  status: string
  check: string
  detail: string
}

export interface NotionAgentListItem {
  agent_id: string
  name: string
  agent_page_id: string
  description: string | null
  icon: string | null
  most_recent_thread_title?: string | null
}

type AccountRecord = Record<string, unknown>

function readAccountRecord(): AccountRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(ACCOUNT_PATH, 'utf8')) as unknown
    if (parsed && typeof parsed === 'object') return parsed as AccountRecord
    return null
  } catch {
    return null
  }
}

function str(rec: AccountRecord | null, key: string): string | null {
  if (!rec) return null
  const v = rec[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** Resolve the symlink to its real target and write atomically so the
 *  symlink stays intact and a partial write can't corrupt the live file. */
function writeAccountRecord(rec: AccountRecord): void {
  // realpathSync throws if the file is missing — but we only ever call this
  // after readAccountRecord() succeeded, so the path resolves.
  const realPath = realpathSync(ACCOUNT_PATH)
  const tmp = `${realPath}.tmp`
  writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`, 'utf8')
  renameSync(tmp, realPath)
}

export function readNotionAgentConfig(): NotionAgentConfig {
  const cliPath = resolveNotionAgentBin()
  const rec = readAccountRecord()
  const tokenPresent = str(rec, 'token_v2') !== null
  return {
    accountPath: ACCOUNT_PATH,
    cliPath,
    cliFound: existsSync(cliPath),
    configured: rec !== null && tokenPresent,
    tokenPresent,
    userName: str(rec, 'user_name'),
    userEmail: str(rec, 'user_email'),
    spaceName: str(rec, 'space_name'),
    spaceId: str(rec, 'space_id'),
    agentName: str(rec, 'agent_name'),
    agentPageId: str(rec, 'agent_context_page_id'),
    agentAccessory: str(rec, 'agent_accessory'),
    defaultModel: str(rec, 'default_model'),
    timezone: str(rec, 'timezone')
  }
}

/** Friendly model aliases from ~/.notionagents/models.json. The file shape is
 *  `{ "friendly_aliases": { "opus-4.8": "<notion-id>", … }, "updated_at": … }`,
 *  so we read the keys of `friendly_aliases`. Empty list when missing — the
 *  picker just shows no presets. */
export function listModels(): string[] {
  try {
    const raw = JSON.parse(readFileSync(MODELS_PATH, 'utf8')) as unknown
    if (raw && typeof raw === 'object') {
      const aliases = (raw as { friendly_aliases?: unknown }).friendly_aliases
      if (aliases && typeof aliases === 'object') {
        return Object.keys(aliases as Record<string, unknown>)
      }
    }
    return []
  } catch {
    return []
  }
}

function tagError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

/** Run `notion-agent doctor --json` for a live connectivity/auth readout. */
export async function runDoctor(): Promise<NotionAgentDoctorCheck[]> {
  const bin = resolveNotionAgentBin()
  let stdout: string
  try {
    const r = await execa(bin, ['doctor', '--json'], {
      timeout: CLI_TIMEOUT_MS,
      reject: false,
      buffer: true
    })
    stdout = typeof r.stdout === 'string' ? r.stdout : ''
    // doctor can exit non-zero when a check fails but still print the JSON
    // report; only treat "no JSON at all" as a hard failure.
    if (stdout.trim().length === 0) {
      const stderr = typeof r.stderr === 'string' ? r.stderr : ''
      if (r.exitCode === 127)
        throw tagError('notion-agent CLI not found', 'E_NOTION_AGENT_NOT_INSTALLED')
      throw tagError(stderr || 'doctor produced no output', 'E_NOTION_AGENT_DOCTOR')
    }
  } catch (err) {
    if (err instanceof Error && 'code' in err) throw err
    throw tagError(err instanceof Error ? err.message : String(err), 'E_NOTION_AGENT_DOCTOR')
  }
  try {
    const parsed = JSON.parse(stdout) as unknown
    if (Array.isArray(parsed)) return parsed as NotionAgentDoctorCheck[]
    throw tagError('doctor output not an array', 'E_NOTION_AGENT_DOCTOR')
  } catch (err) {
    if (err instanceof Error && 'code' in err) throw err
    throw tagError('doctor output not valid JSON', 'E_NOTION_AGENT_DOCTOR')
  }
}

/** List Custom Agents in the bound workspace via `agents list --json`. */
export async function listAgents(): Promise<NotionAgentListItem[]> {
  const bin = resolveNotionAgentBin()
  const r = await execa(bin, ['agents', 'list', '--json'], {
    timeout: CLI_TIMEOUT_MS,
    reject: false,
    buffer: true
  })
  const stdout = typeof r.stdout === 'string' ? r.stdout : ''
  if (r.exitCode !== 0 && stdout.trim().length === 0) {
    const stderr = typeof r.stderr === 'string' ? r.stderr : ''
    if (r.exitCode === 127)
      throw tagError('notion-agent CLI not found', 'E_NOTION_AGENT_NOT_INSTALLED')
    throw tagError(stderr || 'agents list failed', 'E_NOTION_AGENT_AGENTS')
  }
  try {
    const parsed = JSON.parse(stdout) as unknown
    if (Array.isArray(parsed)) return parsed as NotionAgentListItem[]
    throw tagError('agents list output not an array', 'E_NOTION_AGENT_AGENTS')
  } catch (err) {
    if (err instanceof Error && 'code' in err) throw err
    throw tagError('agents list output not valid JSON', 'E_NOTION_AGENT_AGENTS')
  }
}

/** Bind a Custom Agent by writing agent_name + agent_context_page_id into
 *  account.json. The CLI reads these on the next `chat` to overlay the
 *  agent's persona. We don't re-run `init` (which would need the token) —
 *  binding_mode stays whatever it was; chat works off name+page_id alone. */
export function setBoundAgent(
  pageId: string,
  name: string,
  accessory?: string | null
): NotionAgentConfig {
  const rec = readAccountRecord()
  if (!rec)
    throw tagError(
      'account file not readable — run `notion-agent init` first',
      'E_NOTION_AGENT_NO_ACCOUNT'
    )
  rec['agent_context_page_id'] = pageId
  rec['agent_name'] = name
  if (typeof accessory === 'string' && accessory.length > 0) rec['agent_accessory'] = accessory
  writeAccountRecord(rec)
  return readNotionAgentConfig()
}

/** Set the default model alias (account.default_model). chat uses this when
 *  no per-call --model is passed. */
export function setDefaultModel(alias: string): NotionAgentConfig {
  const rec = readAccountRecord()
  if (!rec)
    throw tagError(
      'account file not readable — run `notion-agent init` first',
      'E_NOTION_AGENT_NO_ACCOUNT'
    )
  rec['default_model'] = alias
  writeAccountRecord(rec)
  return readNotionAgentConfig()
}
