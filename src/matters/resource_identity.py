"""Stable resource identity helpers for MailAgent-owned resources."""

from __future__ import annotations

import hashlib
import json

EMAIL_PROVIDER = "mailagent"


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


def attachment_resource_key(attachment_id: int) -> str:
    """邮件附件被引用成 matter 资料（kind='file'）时的稳定标识。

    用 `email_attachment.id`（自增 PK，行在则 id 在）而不是「文件名 + 邮件」——同一封邮件里
    重名附件是合法的，用名字做键会把两份不同的文件折成一份。
    🔴 `normalize_resource_key` 只规范 email/thread 两种 kind，`file` 原样透传，故这里产出的
    字符串就是最终 external_key。
    """
    return f"attachment:{int(attachment_id)}"


def parse_resource_key(key: str) -> tuple[str, str]:
    kind, separator, value = str(key or "").partition(":")
    if not separator or kind not in {"email", "thread"} or not value:
        raise ValueError(f"invalid MailAgent resource key: {key!r}")
    if kind == "email":
        try:
            value = str(int(value))
        except ValueError as exc:
            raise ValueError(f"invalid email resource key: {key!r}") from exc
    return kind, value


def normalize_resource_key(provider: str, kind: str, external_key: str) -> str:
    if provider != EMAIL_PROVIDER or kind not in {"email", "thread"}:
        return external_key
    value = str(external_key or "").strip()
    if not value:
        raise MatterError("E_INVALID_ARG", "resource external_key is required")
    if value.startswith(f"{kind}:"):
        try:
            parsed_kind, identifier = parse_resource_key(value)
        except ValueError as exc:
            raise MatterError("E_INVALID_ARG", str(exc)) from exc
        return (
            email_resource_key(int(identifier))
            if parsed_kind == "email"
            else thread_resource_key(identifier)
        )
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
    return thread_resource_key(value)


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
