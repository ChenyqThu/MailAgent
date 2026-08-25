"""提案里**新建**一条资料关联的形状校验（0812 dogfood 收口）。

背景：跟进 run 的工具面 0812 起全开只读（全库邮件 + Notion/Jira/Confluence/Figma 等已连接
connector 的只读工具 + 网页检索），目的就是让它**发现新证据**。但在此之前，找到的东西没有
任何结构化落地通道 —— ``_apply_accepted_change`` 的 resource 分支只认「已经关联进本事项、
但还没确认」的 link，提案里给一个新的 Notion 页，owner 点接受时会被静默跳过。

本模块是那条通道的**校验单源**，两个消费点：

  - ``run_service._validate_changes``（propose 时）：白名单 = builtin + **已连接** connector
    —— 「这个 run 结构上有没有可能看见这个来源」。没连 Notion 就提 Notion 页 = 幻觉。
  - ``service._apply_accepted_change``（accept 时）：白名单 = builtin + **目录全集**
    —— owner 已经审过了，不该因为期间 connector 掉线就把接受动作静默变成 no-op；但
    「必须落在一份有限词表里」这条结构性约束照旧成立（第二道，防 changes_json 被改写）。

🔴 fail-closed 是硬要求：provider 推导不出（agent_config 读不到 / 总闸 off / 值不在词表）、
external_key 不合既有约定、mailagent 侧的对象根本不存在 —— 一律**拒绝该 change**，不是放行。
"""

from __future__ import annotations

import re
from typing import Any, Callable, Mapping, Optional
from urllib.parse import urlparse

from loguru import logger

from .models import MATTER_RESOURCE_KINDS, MATTER_RESOURCE_SUMMARY_MAX_CHARS
from .resource_identity import (
    EMAIL_PROVIDER,
    MAILAGENT_IDENTITY_KINDS,
    MatterError,
    normalize_resource_key,
)

#: 不经 connector、结构上恒可达的两个来源。
#: ``mailagent`` = 本机邮件库（email / thread，身份与存在性都可本地验证）；
#: ``web`` = 网页（``grantWeb='open'`` 让跟进 run 恒有 web_fetch/web_search）。
#: 值取自仓内既有用法，不新造：``mailagent`` = ``resource_identity.EMAIL_PROVIDER``；
#: ``web`` = URL 资料的既有 provider 值（``add_resource`` 的 url 用例、url_fetch 缓存面）。
WEB_PROVIDER = "web"
PROPOSAL_BUILTIN_PROVIDERS: frozenset[str] = frozenset({EMAIL_PROVIDER, WEB_PROVIDER})

#: 各 provider 允许的 resource kind。``MAILAGENT_IDENTITY_KINDS``（email/thread/event）
#: 是 mailagent 的身份空间专属（``repository.resource_available`` 的存在性判定就钉在
#: provider=='mailagent' 上），让 connector 认领这些 kind 会造出一条永远验不了的资料。
_KINDS_BY_PROVIDER: dict[str, frozenset[str]] = {
    EMAIL_PROVIDER: MAILAGENT_IDENTITY_KINDS,
    WEB_PROVIDER: frozenset({"url"}),
}
_CONNECTOR_KINDS: frozenset[str] = (
    frozenset(MATTER_RESOURCE_KINDS) - MAILAGENT_IDENTITY_KINDS
)

MAX_EXTERNAL_KEY_CHARS = 512
MAX_TITLE_CHARS = 500
MAX_URL_CHARS = 2000

#: connector id 的字面形状（与 catalog 的键同形；只用来挡住"随意串"，真正的裁决是白名单）。
_PROVIDER_RE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")

#: connector 侧 external_key 的既有约定 = ``<entity>:<id>``（仓内先例：
#: ``create_research._notion_resources`` 产出的 ``page:<page_id>``）。entity 是有界小写
#: token，id 不含空白与控制字符 —— 挡住把整段自然语言当 key 塞进来。
_CONNECTOR_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,31}:[^\s\x00-\x1f]{1,256}$")

_HTTP_SCHEMES = frozenset({"http", "https"})

#: drop 原因字面量（``_validate_changes`` 的 dropped 明细 / accept 侧 warning 都用它）。
REASON_PROVIDER_NOT_ALLOWED = "resource_provider_not_allowed"
REASON_KIND_NOT_ALLOWED = "resource_kind_not_allowed"
REASON_KEY_INVALID = "resource_key_invalid"
REASON_NOT_FOUND = "resource_not_found"
REASON_SPEC_INVALID = "resource_spec_invalid"


class ResourceProposalError(ValueError):
    """归一失败。``reason`` 直接进 dropped 明细 / accept warning，不拼错误字符串。"""

    def __init__(self, reason: str, detail: str = ""):
        super().__init__(detail or reason)
        self.reason = reason
        self.detail = detail


def new_resource_spec(change: Mapping[str, Any]) -> Optional[Mapping[str, Any]]:
    """``kind=resource`` 的 change 描述的是不是一份**新**资料。

    判据 = 带 ``resource`` 对象。带 ``target.id`` 的老形状（确认既有 link）返回 None，
    走原分支一字不动。两者同时给的互斥判定在调用方（propose 侧剔除该 change）——
    本函数只回答"描述里有没有一份新资料的身份"。
    """
    spec = change.get("resource")
    return spec if isinstance(spec, Mapping) else None


def connected_connector_ids(settings: Any) -> tuple[str, ...]:
    """已连接且启用的 connector id（跟进 run 的 grantConnectors 与提案白名单共用单源）。

    总闸 ``MAILAGENT_MCP_CONNECTORS`` off / agent_config 读不到 / 无已连接行 → 空元组。
    """
    if not bool(getattr(settings, "mcp_connectors_enabled", False)):
        return ()
    try:
        from src.agent_config.store import get_agent_config_store

        rows = get_agent_config_store().list_connectors()
        return tuple(
            row.connector_id for row in rows if row.status == "connected" and row.enabled
        )
    except Exception as exc:  # noqa: BLE001 — 可选增强，读不到就当没有（fail-closed）
        logger.warning(f"[matter-resource-proposal] connector enumeration failed: {exc}")
        return ()


def propose_allowed_providers(settings: Any) -> frozenset[str]:
    """propose 时的 provider 白名单 = builtin + **已连接** connector。"""
    return PROPOSAL_BUILTIN_PROVIDERS | frozenset(connected_connector_ids(settings))


def apply_allowed_providers() -> frozenset[str]:
    """accept 时的 provider 白名单 = builtin + connector **目录全集**（静态）。

    比 propose 侧宽一档是有意的：owner 已经在审阅界面上看到并接受了这条关联，此刻再去问
    「connector 现在还连着吗」只会让接受动作静默变成 no-op。但仍是白名单 —— 任意字符串
    进不来。目录读不到（裸 worktree / import 失败）→ 只剩 builtin，仍然 fail-closed。
    """
    try:
        from src.connectors.catalog import catalog_ids

        return PROPOSAL_BUILTIN_PROVIDERS | frozenset(catalog_ids())
    except Exception as exc:  # noqa: BLE001 — fail-closed 到 builtin
        logger.warning(f"[matter-resource-proposal] catalog unavailable: {exc}")
        return PROPOSAL_BUILTIN_PROVIDERS


def normalize_new_resource(
    spec: Mapping[str, Any],
    *,
    allowed_providers: frozenset[str],
    exists: Optional[Callable[[str, str, str], bool]] = None,
) -> dict[str, Any]:
    """校验并归一一份**新**资料的身份，产出 ``_upsert_resource`` 直接吃的入参形状。

    键名一律取 ``resource`` 表既有列 / ``_upsert_resource`` 既有入参（provider / kind /
    external_key / title / canonical_url），不另造命名。

    ``exists(provider, kind, external_key)`` = 可选存在性回调（mailagent 侧由
    ``repository.resource_available`` 提供）；返回 False → ``resource_not_found``。

    🔴 输出键集 = 提案 wire 契约的键集（``summary`` 也在内），且**输入输出同名** ——
    propose 侧把这份产物回写进 ``changes_json``、accept 侧再拿它跑一遍本函数，键名一
    换就会在第二趟静默丢字段。跨语言一致性闸见
    ``tests/matters/test_matters_contract_parity.py``。
    """
    if not isinstance(spec, Mapping):
        raise ResourceProposalError(REASON_SPEC_INVALID, "resource must be an object")

    provider = str(spec.get("provider") or "").strip().lower()
    if not provider or not _PROVIDER_RE.match(provider):
        raise ResourceProposalError(REASON_PROVIDER_NOT_ALLOWED, f"provider={provider!r}")
    if provider not in allowed_providers:
        raise ResourceProposalError(REASON_PROVIDER_NOT_ALLOWED, f"provider={provider!r}")

    kind = str(spec.get("kind") or "").strip()
    allowed_kinds = _KINDS_BY_PROVIDER.get(provider, _CONNECTOR_KINDS)
    if kind not in allowed_kinds:
        raise ResourceProposalError(
            REASON_KIND_NOT_ALLOWED, f"provider={provider!r} kind={kind!r}"
        )

    raw_key = str(spec.get("external_key") or "").strip()
    if not raw_key or len(raw_key) > MAX_EXTERNAL_KEY_CHARS:
        raise ResourceProposalError(REASON_KEY_INVALID, "external_key length")
    external_key = _normalize_external_key(provider, kind, raw_key)

    canonical_url = _optional_url(spec.get("canonical_url"))
    if provider == WEB_PROVIDER:
        # url 资料的 external_key 就是那个 URL（仓内既有形状）；canonical_url 缺省跟随它。
        canonical_url = canonical_url or external_key

    title = spec.get("title")
    title = str(title).strip()[:MAX_TITLE_CHARS] if title is not None else ""

    if exists is not None and not exists(provider, kind, external_key):
        raise ResourceProposalError(REASON_NOT_FOUND, f"{provider}:{external_key}")

    return {
        "provider": provider,
        "kind": kind,
        "external_key": external_key,
        "title": title or None,
        "canonical_url": canonical_url,
        "summary": _optional_summary(spec.get("summary"), provider=provider, kind=kind),
        "diff": _optional_diff(spec.get("diff"), provider=provider, kind=kind),
    }


def _optional_summary(value: Any, *, provider: str, kind: str) -> Optional[str]:
    """资料**内容**摘要（H3§6 的提案侧入口，落库进 ``resource.sum``）。

    🔴 mailagent 的 email/thread 恒返回 None —— 邮件类摘要复用邮件自带的 ``ai_summary``
    （``MatterService._resource_summary_fields`` 是那条推导的唯一写侧，``sum_src='mail'``），
    模型写的那句在库里根本不会生效。这里把它**在提案层就丢掉**，否则审阅卡会显示一段
    「Agent 已生成」的文字、接受后库里却是另一段（或空）—— 卡片对 owner 撒谎。

    超长截断而不是拒绝：与上面 ``title`` 同一姿态，摘要是增强信息，不该因为多写了几个字
    就把整条 change 剔掉。
    """
    if provider == EMAIL_PROVIDER and kind in ("email", "thread"):
        return None
    if value is None:
        return None
    return str(value).strip()[:MATTER_RESOURCE_SUMMARY_MAX_CHARS] or None


def _optional_diff(value: Any, *, provider: str, kind: str) -> Optional[str]:
    """检出到**新版本**时「这一版相对上一版变了什么」的一句话（H3§5.4 / §6）。

    接受时落进版本轨迹最新一行的 ``diff_text``（``MatterService``
    ``_apply_new_resource_link`` → ``repository.fill_latest_version_diff``）；那一行留
    档的正是被当前版本取代的上一版，所以模型描述的差异正好落在它身上。

    🔴 邮件类恒返回 None，理由与 ``_optional_summary`` 同源但更硬：邮件不会有"新版本"
    （一封邮件的内容是不变的），轨迹表里也永远不会有它的行 —— 收下来只会变成一句
    没有落点的话。截断而非拒绝，同上。
    """
    if provider == EMAIL_PROVIDER and kind in ("email", "thread"):
        return None
    if value is None:
        return None
    return str(value).strip()[:MATTER_RESOURCE_SUMMARY_MAX_CHARS] or None


def _normalize_external_key(provider: str, kind: str, value: str) -> str:
    if provider == EMAIL_PROVIDER:
        try:
            return normalize_resource_key(provider, kind, value)
        except (MatterError, ValueError) as exc:
            raise ResourceProposalError(REASON_KEY_INVALID, str(exc)) from exc
    if provider == WEB_PROVIDER:
        if not _is_http_url(value):
            raise ResourceProposalError(REASON_KEY_INVALID, "web key must be an http(s) URL")
        return value
    if not _CONNECTOR_KEY_RE.match(value):
        raise ResourceProposalError(REASON_KEY_INVALID, "expected <entity>:<id>")
    return value


def _optional_url(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if len(text) > MAX_URL_CHARS or not _is_http_url(text):
        raise ResourceProposalError(REASON_KEY_INVALID, "canonical_url must be http(s)")
    return text


def _is_http_url(value: str) -> bool:
    try:
        parsed = urlparse(value)
    except ValueError:
        return False
    return parsed.scheme in _HTTP_SCHEMES and bool(parsed.netloc)
