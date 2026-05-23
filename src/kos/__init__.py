"""KOS MCP client - OAuth 2.1 + JSON-RPC over HTTP with SSE response (PR-2c).

接入用户已有的 Jarvis KOS v2 (gbrain fork on mac mini @ kos.chenge.ink).
Wire spec: ~/Projects/jarvis-knowledge-os-v2/docs/EXTERNAL-CLIENTS-MCP-WIRE-HANDOFF.md
"""

from src.kos.client import KOSClient, KOSError, KOSTokenCache

__all__ = ["KOSClient", "KOSError", "KOSTokenCache"]
