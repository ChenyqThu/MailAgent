"""Stable resource identity helpers for MailAgent-owned resources."""

from __future__ import annotations

import hashlib
import json
from typing import Any, Callable, Mapping, Optional

from loguru import logger

from src.library.constants import RESOURCE_KEY_PREFIX

EMAIL_PROVIDER = "mailagent"

#: mailagent 身份空间的 resource kind —— identity 由本模块发号（`parse_resource_key` /
#: `normalize_resource_key` 只认这几个）、存在性可本地验证（`repository.resource_available`）。
#: 提案 provider 白名单吃的是它的超集 `MAILAGENT_PROPOSAL_KINDS`（多一个 `file`）。
#: 各处消费同一份集合，不许各抄一份（跨边界手抄常量纪律）。
MAILAGENT_IDENTITY_KINDS = frozenset({"email", "thread", "event"})

#: 提案通道允许 mailagent 认领的 kind = 身份空间 + `file`（资料库文件，design §9.2）。
#: 🔴 `file` **有意不进** `MAILAGENT_IDENTITY_KINDS`：那个集合的成员会被
#: `normalize_resource_key` 规范、被 `parse_resource_key` 认领，而 file 的 external_key
#: （`attachment:<id>` / `library:<id>`）恒原样透传。两个集合分开 = 跟进 run 能提议挂
#: 库文件，而 normalize / parse 的行为一个字节不变。
MAILAGENT_PROPOSAL_KINDS = MAILAGENT_IDENTITY_KINDS | frozenset({"file"})


class MatterError(RuntimeError):
    def __init__(self, code: str, message: str, *, hint: str | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint


def email_resource_key(internal_id: int) -> str:
    return f"email:{int(internal_id)}"


def thread_resource_key(thread_id: str) -> str:
    value = str(thread_id or "").strip()
    if not value:
        raise ValueError("thread_id is required")
    return f"thread:{value}"


def event_resource_key(ical_uid: str) -> str:
    """日历事件（kind='event'）的稳定标识 —— **系列级**：只含 ical_uid，不含 recurrence_id。

    粒度是拍板过的（L4 批次 1 DB）：拒绝记忆的 resource_key 就是它，拒一次管整个系列
    —— 否则周会每结束一次就重新提案一次 = 审批疲劳。occurrence 细节（哪一次结束、
    谁在场）进 provenance / evidence，不进身份键。
    """
    value = str(ical_uid or "").strip()
    if not value:
        raise ValueError("ical_uid is required")
    return f"event:{value}"


def attachment_resource_key(attachment_id: int) -> str:
    """邮件附件被引用成 matter 资料（kind='file'）时的稳定标识。

    用 `email_attachment.id`（自增 PK，行在则 id 在）而不是「文件名 + 邮件」——同一封邮件里
    重名附件是合法的，用名字做键会把两份不同的文件折成一份。
    🔴 `normalize_resource_key` 只规范 `MAILAGENT_IDENTITY_KINDS`（email/thread/event），
    `file` 原样透传，故这里产出的字符串就是最终 external_key。
    """
    return f"attachment:{int(attachment_id)}"


def library_resource_key(file_id: int) -> str:
    """资料库文件被引用成 matter 资料（kind='file'）时的稳定标识（design §9.0 / §9.5）。

    与 `attachment_resource_key` **并列**：两者同为 kind='file'、同在 provider='mailagent'
    这一个身份空间里，靠前缀区分。
    🔴 `uq_resource_provider_key` 是 `(provider, external_key)` —— **不含 kind**。所以：
    ①「同一个 external_key 换个 kind 再写一遍」不会得到第二行，只会撞上既有行
    （`service._upsert_resource` 抛 `E_RESOURCE_IDENTITY_CONFLICT`）；② 本命名空间里的
    前缀必须互斥 —— `attachment:7` 与 `library:7` 是两份不同的资料，去掉前缀就会折成一份。
    前缀取 `src.library.constants.RESOURCE_KEY_PREFIX`（跨模块单源，不手抄字面量）。
    🔴 `normalize_resource_key` 只规范 `MAILAGENT_IDENTITY_KINDS`，`file` 原样透传，
    故这里产出的字符串就是最终 external_key。
    """
    return f"{RESOURCE_KEY_PREFIX}{int(file_id)}"


def is_library_resource_key(external_key: str) -> bool:
    return str(external_key or "").startswith(RESOURCE_KEY_PREFIX)


def parse_library_resource_key(external_key: str) -> int:
    """`library:<file_id>` → file_id；前缀不对、或 id 不是正整数，一律 ValueError。"""
    value = str(external_key or "")
    if not is_library_resource_key(value):
        raise ValueError(f"not a library resource key: {external_key!r}")
    identifier = value[len(RESOURCE_KEY_PREFIX) :]
    if not identifier.isdigit() or int(identifier) <= 0:
        raise ValueError(f"invalid library resource key: {external_key!r}")
    return int(identifier)


# ── 资料库解析回调（design §9.2：matters **不直接 import** library 存储层）─────────
#: 回调签名：``resolver(file_id: int, *, with_text: bool = False) -> Mapping | None``。
#: 返回 None = 这个 file_id **现在引用不了**（行不存在 / 不是 present）；返回 Mapping =
#: 可引用，且 `with_text=True` 时额外带两键：`summary`（frontmatter 的 summary /
#: description，由资料库侧择一）与 `text`（抽取正文）。
#: 🔴 存在性判定是**逐行**调用的（列表投影每份资料一次），所以 `with_text` 默认 False，
#: 实现方在 False 分支不许读正文。
LibraryFileResolver = Callable[..., Optional[Mapping[str, Any]]]

_library_file_resolver: Optional[LibraryFileResolver] = None


def set_library_file_resolver(resolver: Optional[LibraryFileResolver]) -> None:
    """注册资料库解析回调（进程级，serve-api 启动时装一次；传 None = 卸载）。

    🔴 模块级而不是 `MatterRepository` 的构造参数：库在不在、某个文件还在不在，是**进程级
    事实**，不是每个 repository 实例各自的事实 —— 仓里有 9 处构造 `MatterRepository`，
    走构造参数等于让这 9 处各自记得传一次，漏一处就是那条路径静默 fail-closed。
    """
    global _library_file_resolver
    _library_file_resolver = resolver


def resolve_library_file(
    file_id: int, *, with_text: bool = False
) -> Optional[Mapping[str, Any]]:
    """回调结果。**没注册回调恒 None**（fail-closed，理由见 `library_file_available`）。"""
    resolver = _library_file_resolver
    if resolver is None:
        return None
    try:
        payload = resolver(int(file_id), with_text=with_text)
    except Exception as exc:  # noqa: BLE001 — 回调炸了当「读不到」，不掀掉调用方的事务
        logger.warning(f"[matters] library resolver failed for file {file_id}: {exc}")
        return None
    return payload if isinstance(payload, Mapping) else None


def library_file_available(external_key: str) -> bool:
    """kind='file' 的存在性判定（`repository.resource_available` 的 `library:` 分支）。

    - 不是 `library:` 前缀（邮件附件 `attachment:<id>`）→ True：那类键本来就没有本地判定，
      行为与本分支出现之前逐字节一致；
    - 是 `library:` 但形状不对 / 回调说不在 / **回调没注册** → False。
      🔴 没注册回调时 fail-closed 是有意的：本判定唯一的作用就是挡住模型编造的 file id，
      「读不到就放行」等于把它整条关掉。代价是资料库没接线时已关联的库文件在列表里显示
      成不可用 —— 显示降级，既不崩也不无脑放行（人工关联本就不走这条判定，照常可挂）。
    """
    if not is_library_resource_key(external_key):
        return True
    try:
        file_id = parse_library_resource_key(external_key)
    except ValueError:
        return False
    return resolve_library_file(file_id) is not None


#: 挂库文件时服务端兜底摘要的长度（design §9.2：frontmatter 缺省取抽取文本首 300 字）。
LIBRARY_SUMMARY_FALLBACK_CHARS = 300
#: `metadata.cached_excerpt` 的长度。与 `service.context_snapshot` 投影里的 `excerpt[:2000]`
#: 同值 —— 存得再多也出不去那道投影，多存只是白占库。
LIBRARY_EXCERPT_MAX_CHARS = 2000


def library_resource_content(external_key: str) -> tuple[Optional[str], Optional[str]]:
    """(服务端兜底摘要, 缓存摘录)；非 library 键 / 回调读不到，恒 (None, None)。"""
    if not is_library_resource_key(external_key):
        return None, None
    try:
        file_id = parse_library_resource_key(external_key)
    except ValueError:
        return None, None
    payload = resolve_library_file(file_id, with_text=True)
    if payload is None:
        return None, None
    text = str(payload.get("text") or "").strip()
    summary = str(payload.get("summary") or "").strip()
    if not summary:
        summary = text[:LIBRARY_SUMMARY_FALLBACK_CHARS]
    return (summary or None), (text[:LIBRARY_EXCERPT_MAX_CHARS] or None)


def parse_resource_key(key: str) -> tuple[str, str]:
    kind, separator, value = str(key or "").partition(":")
    if not separator or kind not in MAILAGENT_IDENTITY_KINDS or not value:
        raise ValueError(f"invalid MailAgent resource key: {key!r}")
    if kind == "email":
        try:
            value = str(int(value))
        except ValueError as exc:
            raise ValueError(f"invalid email resource key: {key!r}") from exc
    return kind, value


def normalize_resource_key(provider: str, kind: str, external_key: str) -> str:
    if provider != EMAIL_PROVIDER or kind not in MAILAGENT_IDENTITY_KINDS:
        return external_key
    value = str(external_key or "").strip()
    if not value:
        raise MatterError("E_INVALID_ARG", "resource external_key is required")
    if value.startswith(f"{kind}:"):
        try:
            parsed_kind, identifier = parse_resource_key(value)
        except ValueError as exc:
            raise MatterError("E_INVALID_ARG", str(exc)) from exc
        if parsed_kind == "email":
            return email_resource_key(int(identifier))
        if parsed_kind == "thread":
            return thread_resource_key(identifier)
        return event_resource_key(identifier)
    if ":" in value:
        raise MatterError(
            "E_INVALID_ARG",
            f"resource external_key {value!r} does not match kind {kind!r}",
        )
    if kind == "email":
        if not value.isdigit():
            raise MatterError(
                "E_INVALID_ARG", f"invalid email resource key: {external_key!r}"
            )
        return email_resource_key(int(value))
    if kind == "thread":
        return thread_resource_key(value)
    return event_resource_key(value)


def rejection_resource_key(provider: str, kind: str, external_key: str) -> str:
    """Return the provider-qualified canonical key used by rejection memory."""
    normalized = normalize_resource_key(provider, kind, external_key)
    return f"{str(provider).strip().lower()}:{normalized}"


# 🔴 只有这些前缀是 durable anchor —— 它们描述「这封邮件和这个事项之间**客观存在**的关系」，
# 不随谁去搜、怎么搜而变。`keyword:` 来自事项文档的 bigram、`query:` 来自调用方入参，两样
# 都不 durable：0812 之前它们也进哈希，于是用户拒掉一条垃圾建议后，下一次跟进 run 只要改了
# `current_summary`，bigram 集合就变、指纹就变、抑制当场失效 —— 同一封垃圾原样回来。
# docstring 承诺的语义（"repeating the same search cannot bypass a rejection"）与实现是反的。
DURABLE_EVIDENCE_PREFIXES = ("thread:", "stakeholder:", "expansion:")


def durable_evidence(evidence: list[str] | tuple[str, ...]) -> list[str]:
    """Keep only the durable anchors of an evidence list (sorted, de-duplicated)."""
    return sorted(
        {
            text
            for item in evidence
            if (text := str(item).strip()).startswith(DURABLE_EVIDENCE_PREFIXES)
        }
    )


def evidence_fingerprint(resource_key: str, evidence: list[str] | tuple[str, ...]) -> str:
    """Hash stable evidence anchors for a resource suggestion.

    "Substantially new evidence" means the normalized set of durable anchors changes:
    linked thread ids, stakeholder email addresses, or an explicit expansion reason.
    Timestamps, random ids, confidence, and — since 0812 — matched keywords / query terms
    are deliberately excluded, so repeating the same search (or merely rewording the matter
    summary) cannot bypass a rejection while a genuinely new anchor can.
    """
    payload = {
        "resource_key": str(resource_key),
        "evidence": durable_evidence(evidence),
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()
