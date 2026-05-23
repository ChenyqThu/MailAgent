"""KOS MCP client + producer (PR-2c + PR-2d).

接入用户已有的 Jarvis KOS v2 (gbrain fork on mac mini @ kos.chenge.ink).
Wire spec: ~/Projects/jarvis-knowledge-os-v2/docs/EXTERNAL-CLIENTS-MCP-WIRE-HANDOFF.md

- KOSClient / KOSError / KOSTokenCache — PR-2c MCP client (OAuth + SSE)
- build_kos_page_payload / push_email_to_kos / priority_at_or_above
  / normalize_message_id_for_slug — PR-2d producer pipeline
"""

from src.kos.client import KOSClient, KOSError, KOSTokenCache
from src.kos.producer import (
    build_kos_page_payload,
    normalize_message_id_for_slug,
    priority_at_or_above,
    push_email_to_kos,
)

__all__ = [
    "KOSClient",
    "KOSError",
    "KOSTokenCache",
    "build_kos_page_payload",
    "normalize_message_id_for_slug",
    "priority_at_or_above",
    "push_email_to_kos",
]
