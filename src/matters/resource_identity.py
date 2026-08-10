"""Stable resource identity helpers for MailAgent-owned resources."""

from __future__ import annotations

EMAIL_PROVIDER = "mailagent"


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
