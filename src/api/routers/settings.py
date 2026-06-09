"""settings 路由 — /api/notion-agent/* + /api/settings/* + /api/prompts/*
(task 06-08-chat 第二波 — 远程 config P0+P1)。

远程 web（``HttpApi`` fetch serve-api）打开 AI Chat panel 时，第一个 config 读
（notionAgent.getConfig）必须成功，否则前端误判「未配置」跳 settings，且 settings
AI tab 的 secretsStatus / models / agents / prompts / settings 一连串读全 reject →
一直 loading。阶段 2 这些方法在 ``HttpApi`` 全是 ``notImplemented`` stub（只读设计），
现在远程要跑 chat，补这些 **只读配置端点**。

serve-api 跑在 Mac host，能读 host 的：
  - ``~/.notionagents/notion_account.json`` —— notion-agent CLI 账户（symlink）
  - ``~/.notionagents/models.json`` —— 友好 model 别名
  - 仓库根 ``.env`` —— secret 是否配置（dual-write 到 .env） + USER_EMAIL
  - prompt 文件（``LLM_*_PROMPT_PATH`` env override / 默认 ``prompts/email_*.md``）
  - ``notion-agent agents list --json`` —— Custom Agent 列表（spawn CLI）

本质 = 把 ElectronApi（IPC 直读 host）的配置读逻辑复刻成 serve-api Python 端点。
逐字段对齐 ``frontend/src/electron/main/notion_agent/config.ts`` /
``handlers/settings.ts`` / ``handlers/prompts.ts`` 的数据形状（``types.ts`` 契约）。

**只读**：写端点（setSecret / setAgent / setModel / prompts.write / settings.set）
在 ``HttpApi`` 仍 ``notImplemented`` stub —— 远程无 keychain / 无 CLI 写场景，用 host
已配置的值。

鉴权：所有端点 ``Depends(verify_cf_access)``（远程 CF Access / 本地 token），对齐
chat / reports 端点。envelope 用 ``success_envelope``。
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Request
from fastapi.concurrency import run_in_threadpool

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access

router = APIRouter(prefix="/api", tags=["settings"])


# ============================================================
# managed .env keys whitelist (mirror of env-keys.ts)
# ============================================================
# 逐字 port 自 SSoT = ``frontend/src/electron/main/lib/env-keys.ts``
# (``MANAGED_ENV_KEYS`` + ``SECRET_ENV_KEYS``). 远程 ``GET /api/env`` 只返回
# 受管 key 的值 —— 安全边界: 绝不把非受管的 os.environ 值出网 (那会泄漏 shell
# 里的任意密钥)。secret key 值脱敏成 '***' (set) / '' (unset), 复刻 env.ts
# ``redactSnapshot``。**新增受管 key 须同步两处** (这里 + env-keys.ts)。
_MANAGED_ENV_KEYS: List[str] = [
    # — Accounts
    "NOTION_TOKEN",
    "EMAIL_DATABASE_ID",
    "CALENDAR_DATABASE_ID",
    "USER_EMAIL",
    "MAIL_ACCOUNT_NAME",
    "MAIL_INBOX_NAME",
    "MAIL_SENT_NAME",
    "MAIL_ACCOUNT_URL_PREFIX",
    # — DavMail backend
    "DAVMAIL_HOST",
    "DAVMAIL_IMAP_PORT",
    "DAVMAIL_SMTP_PORT",
    "DAVMAIL_POC_CIPHER_KEY",
    "DAVMAIL_CIPHER_KEY",
    "DAVMAIL_POC_MODE",
    "DAVMAIL_FETCH_TIMEOUT_SEC",
    "DAVMAIL_UID_BACKFILL_ENABLED",
    "DAVMAIL_UID_BACKFILL_BATCH_SIZE",
    "DAVMAIL_UID_BACKFILL_SLEEP_SEC",
    "DAVMAIL_DRAFTS_FOLDER",
    "DAVMAIL_SENT_FOLDER",
    "DAVMAIL_ARCHIVE_SENT",
    "DAVMAIL_POLL_INTERVAL_SEC",
    "DAVMAIL_CALDAV_PORT",
    # — Sync
    "SYNC_DATE_MODE",
    "SYNC_START_DATE",
    "SYNC_LOOKBACK_DAYS",
    "SYNC_MAILBOXES",
    "RADAR_POLL_INTERVAL",
    "REVERSE_SYNC_INTERVAL",
    "HEALTH_CHECK_INTERVAL",
    "SYNC_MODE",
    "CALENDAR_SYNC_MODE",
    "CALENDAR_PAST_DAYS",
    "CALENDAR_FUTURE_DAYS",
    "CALENDAR_CALDAV_SYNC_ENABLED",
    # — Folder sync (多文件夹同步窗口; SYNC_FOLDERS 白名单走 folder API 不在此列)
    "FOLDER_SYNC_PAST_DAYS",
    "FOLDER_SYNC_MAX_MESSAGES",
    # — Backend selection
    "MAILAGENT_BACKEND",
    # — Daily digest
    "MAILAGENT_DAILY_DIGEST_ENABLED",
    # — AI Agent
    "LLM_AGENT_ENABLED",
    "LLM_API_BASE",
    "LLM_API_KEY",
    "LLM_MODEL",
    "LLM_TRANSLATE_BASE_URL",
    "LLM_TRANSLATE_API_KEY",
    "LLM_TRANSLATE_MODEL",
    "LLM_FALLBACK_MODELS",
    "LLM_CONTEXT_PAGE_ID",
    "LLM_INBOX_PROMPT_PATH",
    "LLM_SENT_PROMPT_PATH",
    "LLM_CACHE_ENABLED",
    "LLM_CACHE_TTL",
    # — Notifications
    "FEISHU_NOTIFY_ENABLED",
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "FEISHU_CHAT_ID",
    "ALERT_ENABLED",
    "ALERT_FEISHU_WEBHOOK_URL",
    "ALERT_FEISHU_WEBHOOK_SECRET",
    "ALERT_LEVELS",
    # — Integrations
    "PROJECT_PROGRESS_SYNC_ENABLED",
    "PROJECT_PROGRESS_AUTO_SYNC_ENABLED",
    "PROJECT_PROGRESS_DATABASE_ID",
    "PROJECT_PROGRESS_FILTER_BU",
    "PROJECT_PROGRESS_SUBJECT_PATTERN",
    "PROJECT_PROGRESS_SENDER",
    "OFFICE_CONVERT_ENABLED",
    "STATS_REPORT_URL",
    "STATS_REPORT_INTERVAL",
    "STATS_REPORT_TOKEN",
    "DASHBOARD_PASSWORD",
    "MAILAGENT_CLI_API_KEY",
    # — Realtime & Storage
    "REDIS_EVENTS_ENABLED",
    "REDIS_URL",
    "BODY_DUAL_WRITE_ENABLED",
    "MAILAGENT_SSE_ENABLED",
    "LOG_LEVEL",
    "MAILAGENT_OUTBOX_ENABLED",
    "MAILAGENT_OUTBOX_POLL_INTERVAL_SEC",
    "MAILAGENT_OUTBOX_MAX_ATTEMPTS",
    "MAILAGENT_OUTBOX_CONCURRENCY",
    # — Agent Harness + KOS
    "MAILAGENT_AGENT_HARNESS",
    "MAILAGENT_KOS_CONSUMER_ENABLED",
    "MAILAGENT_KOS_L1_HOT_BLOCK_ENABLED",
    "MAILAGENT_KOS_INGEST_ENABLED",
    "MAILAGENT_KOS_TIME_DECAY_ENABLED",
    # — Island
    "PING_ISLAND_ENABLED",
    "ISLAND_SOCKET_PATH",
    # — Remote Access
    "MAILAGENT_REMOTE_ACCESS_ENABLED",
    "CF_AUDIENCE",
    "CF_TEAM_DOMAIN",
    "MAILAGENT_API_PORT",
    "MAILAGENT_API_ALLOWED_EMAIL",
    # — Advanced / readonly display
    "SSE_LOCAL_HOST",
    "SSE_LOCAL_PORT",
]

# Keys whose values must NEVER cross the wire in plaintext — redacted to '***'
# (set) / '' (unset). Mirror of env-keys.ts SECRET_ENV_KEYS.
_SECRET_ENV_KEYS = {
    "NOTION_TOKEN",
    "FEISHU_APP_SECRET",
    "ALERT_FEISHU_WEBHOOK_SECRET",
    "LLM_API_KEY",
    "LLM_TRANSLATE_API_KEY",
    "STATS_REPORT_TOKEN",
    "DASHBOARD_PASSWORD",
    "MAILAGENT_CLI_API_KEY",
    "DAVMAIL_POC_CIPHER_KEY",
    "DAVMAIL_CIPHER_KEY",
    # codex r4 [HIGH] — these are MANAGED (returned) URLs whose value embeds a
    # credential, so they must be redacted, not sent in plaintext:
    #   ALERT_FEISHU_WEBHOOK_URL — the trailing path segment IS the bot token;
    #     anyone holding the full URL can post to the Feishu webhook.
    #   REDIS_URL — `redis://[:password@]host:port` can carry an inline password.
    "ALERT_FEISHU_WEBHOOK_URL",
    "REDIS_URL",
}

_MANAGED_ENV_KEY_SET = set(_MANAGED_ENV_KEYS)


# ============================================================
# .env merged read (serve-api does NOT load_dotenv)
# ============================================================
# serve-api (src/service.py) never calls load_dotenv — pydantic reads .env into
# Config fields but does NOT inject os.environ (only main.py local service does).
# So `os.environ.get()` alone misses .env-only values on the remote serve-api:
# secrets-status would read false, /prompts ignores LLM_*_PROMPT_PATH, /settings
# drops CUSTOM_API_ENDPOINT. We merge dotenv_values(env_file) under os.environ
# (os.environ wins → shell exports override .env, matching pydantic precedence).
#
# Read per-request (NOT cached): secrets are dual-written to .env, so a freshly
# saved value must be reflected immediately — lru_cache would pin a stale map.
def _resolve_env_file_safe() -> str:
    """Resolve the .env path, surviving a failed ``Config()`` singleton.

    Prefer config.py's canonical ``_resolve_env_file`` (single source: MAILAGENT_ENV_FILE
    or DATA_ROOT/.env). But ``import src.config`` eagerly constructs the module-level
    ``config = Config()`` singleton, which raises ``ValidationError`` when the resolved
    .env is missing required business keys. The settings/diagnostic endpoints below
    (``/api/env``, secrets-status, prompts) only need the env-file PATH, not a VALID
    config — and they must still work in a degraded state (onboarding, half-filled
    .env). So on import failure, fall back to the same ``MAILAGENT_ENV_FILE`` resolution
    inline. Returns '' only when neither source is determinable (→ exists:false).
    """
    try:
        from src.config import _resolve_env_file

        return str(_resolve_env_file())
    except Exception:  # noqa: BLE001 — singleton construction failed; resolve inline
        override = os.environ.get("MAILAGENT_ENV_FILE")
        return os.path.abspath(os.path.expanduser(override)) if override else ""


def _load_env_merged() -> Dict[str, str]:
    """Merge ``.env`` values under ``os.environ`` → single name→value map.

    Uses ``_resolve_env_file_safe()`` (config.py's single source, but resilient to a
    failed singleton) so it tracks the same file pydantic reads. ``os.environ`` is
    layered last so shell exports win over .env (pydantic precedence). Graceful: a
    missing / unparseable env_file falls back to plain ``os.environ``.
    """
    file_values: Dict[str, str] = {}
    path = _resolve_env_file_safe()
    if path:
        try:
            from dotenv import dotenv_values

            parsed = dotenv_values(path)
            # dotenv_values can yield None values for bare `KEY` lines — drop them.
            file_values = {k: v for k, v in parsed.items() if isinstance(v, str)}
        except Exception:  # noqa: BLE001 — missing / garbled env_file → os.environ only
            file_values = {}
    return {**file_values, **os.environ}


# ============================================================
# notion-agent CLI 账户（~/.notionagents/notion_account.json）
# ============================================================
# 复刻 frontend/src/electron/main/notion_agent/config.ts：
#   - ACCOUNT_PATH 是 symlink（notion_account.json → <profile>.json），读跟随它。
#   - configured = account.json 可读 AND token_v2 在位。
#   - 字段映射 agentName←agent_name / agentPageId←agent_context_page_id /
#     defaultModel←default_model（其余直读同名 key）。
#   - token_v2 **只返 tokenPresent boolean，永不返值**（auth 归 CLI）。
#   - 缺文件 / garbled JSON → configured:false，**never throw**（前端 getConfig 契约：
#     missing/garbled file yields configured:false）。
_NOTIONAGENTS_DIR = os.path.join(os.path.expanduser("~"), ".notionagents")
_ACCOUNT_PATH = os.path.join(_NOTIONAGENTS_DIR, "notion_account.json")
_MODELS_PATH = os.path.join(_NOTIONAGENTS_DIR, "models.json")

# notion-agent agents list 的子进程超时（对齐 config.ts CLI_TIMEOUT_MS=30s）。
_CLI_TIMEOUT_SEC = 30.0


def _resolve_notion_agent_bin() -> str:
    """解析 ``notion-agent`` 二进制（复用 src/chat/notion_agent，单一真源）。"""
    from src.chat.notion_agent import resolve_notion_agent_bin

    return resolve_notion_agent_bin()


def _read_account_record() -> Optional[dict[str, Any]]:
    """读 account.json → dict（跟随 symlink）。缺文件 / 非法 JSON / 非对象 → None。"""
    try:
        parsed = json.loads(Path(_ACCOUNT_PATH).read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 — missing / garbled → None (configured:false)
        return None
    return parsed if isinstance(parsed, dict) else None


def _acct_str(rec: Optional[dict[str, Any]], key: str) -> Optional[str]:
    """account 记录里取非空字符串字段，否则 None（对齐 config.ts ``str()`` helper）。"""
    if not rec:
        return None
    v = rec.get(key)
    return v if isinstance(v, str) and len(v) > 0 else None


def _read_notion_agent_config() -> dict[str, Any]:
    """复刻 config.ts ``readNotionAgentConfig()`` → NotionAgentConfig dict（camelCase）。"""
    cli_path = _resolve_notion_agent_bin()
    rec = _read_account_record()
    token_present = _acct_str(rec, "token_v2") is not None
    return {
        "accountPath": _ACCOUNT_PATH,
        "cliPath": cli_path,
        "cliFound": os.path.exists(cli_path),
        "configured": rec is not None and token_present,
        "tokenPresent": token_present,
        "userName": _acct_str(rec, "user_name"),
        "userEmail": _acct_str(rec, "user_email"),
        "spaceName": _acct_str(rec, "space_name"),
        "spaceId": _acct_str(rec, "space_id"),
        "agentName": _acct_str(rec, "agent_name"),
        "agentPageId": _acct_str(rec, "agent_context_page_id"),
        "agentAccessory": _acct_str(rec, "agent_accessory"),
        "defaultModel": _acct_str(rec, "default_model"),
        "timezone": _acct_str(rec, "timezone"),
    }


def _list_models() -> List[str]:
    """复刻 config.ts ``listModels()`` —— ~/.notionagents/models.json 的
    ``friendly_aliases`` keys。缺文件 / 非法 → []（picker 无 preset）。"""
    try:
        raw = json.loads(Path(_MODELS_PATH).read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 — missing / garbled → []
        return []
    if isinstance(raw, dict):
        aliases = raw.get("friendly_aliases")
        if isinstance(aliases, dict):
            return list(aliases.keys())
    return []


async def _list_agents() -> List[dict[str, Any]]:
    """复刻 config.ts ``listAgents()`` / handlers/notion_agent.ts —— spawn
    ``notion-agent agents list --json`` → NotionAgentListItem[]。

    CLI exit 127 → E_NOTION_AGENT_NOT_INSTALLED；其余非零且无 stdout → E_NOTION_AGENT_AGENTS；
    stdout 非数组 / 非法 JSON → E_NOTION_AGENT_AGENTS（对齐 TS tagError）。前端 listAgents
    在远程经 ``this.req`` 解包 envelope（失败 throw err.code），对齐 ElectronApi unwrap。
    """
    bin_path = _resolve_notion_agent_bin()
    try:
        proc = await asyncio.create_subprocess_exec(
            bin_path,
            "agents",
            "list",
            "--json",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        raise APIError(
            "E_NOTION_AGENT_NOT_INSTALLED",
            "notion-agent CLI not found",
            source="cli",
        )
    try:
        out_b, err_b = await asyncio.wait_for(proc.communicate(), timeout=_CLI_TIMEOUT_SEC)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise APIError("E_NOTION_AGENT_AGENTS", "agents list timed out", source="cli")

    stdout = out_b.decode("utf-8", "replace") if out_b else ""
    if proc.returncode != 0 and stdout.strip() == "":
        stderr = err_b.decode("utf-8", "replace") if err_b else ""
        if proc.returncode == 127:
            raise APIError(
                "E_NOTION_AGENT_NOT_INSTALLED",
                "notion-agent CLI not found",
                source="cli",
            )
        raise APIError("E_NOTION_AGENT_AGENTS", stderr or "agents list failed", source="cli")
    try:
        parsed = json.loads(stdout)
    except json.JSONDecodeError:
        raise APIError("E_NOTION_AGENT_AGENTS", "agents list output not valid JSON", source="cli")
    if not isinstance(parsed, list):
        raise APIError("E_NOTION_AGENT_AGENTS", "agents list output not an array", source="cli")
    return parsed


@router.get("/notion-agent/config", dependencies=[Depends(verify_cf_access)])
async def notion_agent_config(request: Request):
    """notion-agent 账户绑定 + token 在位（chat 启动 gate 第一读）。镜像
    notionAgent:getConfig → NotionAgentConfig。缺文件 / garbled → configured:false，
    never throw（读 account.json 是纯 fs 同步操作，threadpool 卸载避免阻塞 loop）。"""
    config = await run_in_threadpool(_read_notion_agent_config)
    return success_envelope(config, request=request, source="config")


@router.get("/notion-agent/models", dependencies=[Depends(verify_cf_access)])
async def notion_agent_models(request: Request):
    """友好 model 别名 keys（models.json）。镜像 notionAgent:listModels → string[]。
    缺失返 []。"""
    models = await run_in_threadpool(_list_models)
    return success_envelope(
        models, request=request, source="config", meta_extra={"count": len(models)}
    )


@router.get("/notion-agent/agents", dependencies=[Depends(verify_cf_access)])
async def notion_agent_agents(request: Request):
    """workspace 内 Custom Agent 列表（spawn CLI）。镜像 notionAgent:listAgents →
    NotionAgentListItem[]。CLI 失败 → APIError(err.code)。"""
    agents = await _list_agents()
    return success_envelope(
        agents, request=request, source="cli", meta_extra={"count": len(agents)}
    )


# ============================================================
# secrets 状态（.env 判断 4 个 key 是否非空）
# ============================================================
# 复刻 frontend keychain.ts getSecretsStatus() 的 4 boolean 形状，但远程读 **.env**
# 而非 keychain —— secret 已 dual-write 到 .env（前端 EnvSecretField + bootstrapDotenv），
# serve-api 读同一份 .env。env 名映射对齐 keychain.ts ACCOUNT_ENV_NAMES：
#   cliApiKey→MAILAGENT_CLI_API_KEY / llmApiKey→LLM_API_KEY /
#   llmTranslateApiKey→LLM_TRANSLATE_API_KEY / customApiKey→CUSTOM_API_KEY。
_SECRET_ENV_NAMES = {
    "cliApiKey": "MAILAGENT_CLI_API_KEY",
    "llmApiKey": "LLM_API_KEY",
    "llmTranslateApiKey": "LLM_TRANSLATE_API_KEY",
    "customApiKey": "CUSTOM_API_KEY",
}


def _env_value(name: str, env_map: Dict[str, str]) -> str:
    """读 merged env var（os.environ over .env，见 ``_load_env_merged``）。trim 后判非空。"""
    return (env_map.get(name) or "").strip()


@router.get("/settings/secrets-status", dependencies=[Depends(verify_cf_access)])
async def secrets_status(request: Request):
    """4 个 secret 是否配置（读 .env，非 keychain）。镜像 settings:secrets:status →
    SecretsStatus（4 boolean，never 返值）。一次请求读一次 merged env map（4 key 不重复读文件）。"""
    env_map = _load_env_merged()
    status = {
        slot: _env_value(env_name, env_map) != ""
        for slot, env_name in _SECRET_ENV_NAMES.items()
    }
    return success_envelope(status, request=request, source="config")


# ============================================================
# persistent settings（远程只读，userEmail 从 .env）
# ============================================================
@router.get("/settings", dependencies=[Depends(verify_cf_access)])
async def get_settings_payload(request: Request):
    """persistent settings（远程只读）。镜像 settings:get → PersistentSettings。

    远程无 ``<userData>/settings.json``（那是 host-local Electron 文件）——
    userEmail 从 .env USER_EMAIL（前端 nav-shell account header 唯一真用字段），
    其余字段给合理只读默认（dbPath/attachmentDir/notionAgent* null，pollIntervalSec=5，
    autoDownloadUpdates=true，customApiEndpoint=CUSTOM_API_ENDPOINT env / null）。
    """
    from src.api.deps import get_settings as _get_config

    cfg = _get_config()
    user_email = getattr(cfg, "user_email", None) or None
    custom_endpoint = _env_value("CUSTOM_API_ENDPOINT", _load_env_merged()) or None
    payload = {
        "dbPath": None,
        "attachmentDir": None,
        "pollIntervalSec": 5,
        "notionAgentPageId": None,
        "notionAgentName": None,
        "customApiEndpoint": custom_endpoint,
        "autoDownloadUpdates": True,
        "userEmail": user_email,
    }
    return success_envelope(payload, request=request, source="config")


# ============================================================
# managed .env snapshot（远程只读，逐字段对齐 EnvSnapshot）
# ============================================================
# 镜像本地 IPC env:get → EnvSnapshot
# (frontend/src/electron/main/handlers/env.ts / shared/api/types.ts:1615)。
# 远程 SettingsShell mount 时无条件调 useEnvStore.refresh() → mailApi.env.get()；
# HttpApi 接此端点。远程**只读**：EnvField 在 web 下控件 disabled，env:set 仍 stub。
def _build_env_snapshot() -> Dict[str, Any]:
    """读 merged .env → EnvSnapshot dict。过滤到受管 key（非受管不出网），secret
    脱敏。缺文件 → exists:false / values:{}（never throw，复刻 env.ts readSnapshot）。"""
    path = _resolve_env_file_safe()
    exists = bool(path) and Path(path).exists()
    merged = _load_env_merged()
    values: Dict[str, str] = {}
    for key in _MANAGED_ENV_KEYS:
        # Active keys only — 仅纳入在 merged map 里出现的受管 key（镜像 env.ts
        # "active keys only"，缺失的不放进 values）。
        if key not in merged:
            continue
        raw = merged.get(key) or ""
        if key in _SECRET_ENV_KEYS:
            # 明文密钥绝不出网：非空 → '***'，空 → ''（复刻 env.ts redactSnapshot）。
            values[key] = "***" if len(raw) > 0 else ""
        else:
            values[key] = raw
    return {
        "path": path,
        "exists": exists,
        "values": values,
        "managedKeys": list(_MANAGED_ENV_KEYS),
        "secretKeys": sorted(_SECRET_ENV_KEYS),
    }


@router.get("/env", dependencies=[Depends(verify_cf_access)])
async def get_env_snapshot(request: Request):
    """受管 .env 快照（远程只读展示）。镜像 env:get → EnvSnapshot。secret 脱敏，
    非受管 key 绝不出网。缺文件 → exists:false / values:{}，never throw。"""
    payload = await run_in_threadpool(_build_env_snapshot)
    return success_envelope(payload, request=request, source="config")


# ============================================================
# LLM prompt 文件（inbox / sent）
# ============================================================
# 复刻 frontend handlers/prompts.ts：
#   - 路径解析顺序：.env override (LLM_*_PROMPT_PATH) → 默认 prompts/email_{inbox,sent}.md
#     under data root（与后端 config.py _under_data_root 同口径）。
#   - 解析路径必须 clamp 在 data root 下（防 .env 配 /etc/passwd 经此读任意文件）。
#   - exists 由文件存在判断；read 缺文件 → {exists:false, content:''}。
_PROMPT_DEFAULTS = {
    "inbox": "prompts/email_inbox.md",
    "sent": "prompts/email_sent.md",
}
_PROMPT_ENV_KEYS = {
    "inbox": "LLM_INBOX_PROMPT_PATH",
    "sent": "LLM_SENT_PROMPT_PATH",
}


def _resolve_prompt_path(slot: str, env_map: Dict[str, str]) -> str:
    """复刻 prompts.ts ``resolvePromptPath()`` —— env override / 默认，clamp 在 data root。"""
    from src.config import _resolve_data_root

    root = Path(_resolve_data_root()).resolve()
    override = _env_value(_PROMPT_ENV_KEYS[slot], env_map)
    rel = override if override else _PROMPT_DEFAULTS[slot]
    candidate = Path(rel)
    absolute = (candidate if candidate.is_absolute() else root / candidate).resolve()
    # Clamp：解析路径必须在 data root 下（防 .env 配逃逸路径读任意文件）。
    try:
        absolute.relative_to(root)
    except ValueError:
        raise APIError(
            "E_PATH_ESCAPE",
            f'Prompt path "{rel}" escapes data root "{root}"',
            http_status=400,
            source="config",
        )
    return str(absolute)


def _prompt_info(slot: str) -> dict[str, Any]:
    path = _resolve_prompt_path(slot, _load_env_merged())
    return {"slot": slot, "path": path, "exists": os.path.exists(path)}


def _read_prompt(slot: str) -> dict[str, Any]:
    info = _prompt_info(slot)
    if not info["exists"]:
        return {**info, "content": ""}
    try:
        content = Path(info["path"]).read_text(encoding="utf-8")
    except OSError:
        # 文件刚消失 / 读权限 → 退回空内容（对齐前端 missing → ''）。
        return {**info, "exists": False, "content": ""}
    return {**info, "content": content}


@router.get("/prompts", dependencies=[Depends(verify_cf_access)])
async def list_prompts(request: Request):
    """两个 prompt slot 的路径 + exists。镜像 prompts:list → {inbox, sent} PromptInfo。"""
    payload = await run_in_threadpool(
        lambda: {"inbox": _prompt_info("inbox"), "sent": _prompt_info("sent")}
    )
    return success_envelope(payload, request=request, source="config")


@router.get("/prompts/{slot}", dependencies=[Depends(verify_cf_access)])
async def read_prompt(request: Request, slot: str):
    """读单个 prompt 内容。镜像 prompts:read → PromptContent。缺文件 → content:''。
    非法 slot → E_INVALID_ARG。"""
    if slot not in _PROMPT_DEFAULTS:
        raise APIError("E_INVALID_ARG", f"unknown prompt slot {slot!r}", source="config")
    payload = await run_in_threadpool(_read_prompt, slot)
    return success_envelope(payload, request=request, source="config")
