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


def evidence_fingerprint(resource_key: str, evidence: list[str] | tuple[str, ...]) -> str:
    """Hash stable evidence anchors for a resource suggestion.

    "Substantially new evidence" means the normalized set of durable anchors changes:
    linked thread ids, stakeholder email addresses, matched matter keywords, or an explicit
    expansion reason/query. Timestamps, random ids, and confidence are deliberately excluded,
    so repeating the same search cannot bypass a rejection while a genuinely new anchor can.
    """
    payload = {
        "resource_key": str(resource_key),
        "evidence": sorted({str(item).strip() for item in evidence if str(item).strip()}),
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()
