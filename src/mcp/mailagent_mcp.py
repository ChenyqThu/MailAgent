"""mailagent-mcp —— MCP stdio server，把 MailAgent Skill manifest 暴露为 MCP tools。

设计：
  - **tools 从 manifest 生成**（``mcp_exposed`` 的 tool），不手写第二套工具定义 → 无第二真源。
  - 工具名加前缀 ``mailagent_<skill>_<tool>``，避免与其他 MCP server 冲突。
  - 生产经 ``HttpSkillClient`` 打 serve-api（Bearer key）；测试/本地 selftest 用
    ``LocalSkillClient`` in-process 跑 registry（无需起服务）。
  - 协议核心 ``handle_request(req, client)`` 是纯函数（给定 client）→ 易单测。

MCP 协议（2024-11-05）最小实现：initialize / tools/list / tools/call + notifications。
JSON-RPC over stdio：每行一个 JSON 对象（newline-delimited）。
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from typing import Any, Optional

PROTOCOL_VERSION = "2024-11-05"
TOOL_PREFIX = "mailagent_"


# ---------------------------------------------------------------------------
# manifest → MCP tools
# ---------------------------------------------------------------------------
def manifest_to_mcp_tools(manifest: Any) -> list[dict[str, Any]]:
    """SkillManifest（pydantic 或 dict）→ MCP tool 定义列表（仅 mcp_exposed）。"""
    skills = manifest.skills if hasattr(manifest, "skills") else manifest["skills"]
    tools: list[dict[str, Any]] = []
    for skill in skills:
        sname = skill.name if hasattr(skill, "name") else skill["name"]
        stools = skill.tools if hasattr(skill, "tools") else skill["tools"]
        for t in stools:
            name = t.name if hasattr(t, "name") else t["name"]
            mcp_exposed = t.mcp_exposed if hasattr(t, "mcp_exposed") else t["mcp_exposed"]
            if not mcp_exposed:
                continue
            desc = t.description if hasattr(t, "description") else t["description"]
            schema = t.input_schema if hasattr(t, "input_schema") else t["input_schema"]
            tools.append(
                {
                    "name": f"{TOOL_PREFIX}{sname}_{name}",
                    "description": desc,
                    "inputSchema": schema,
                    "_skill": sname,
                    "_tool": name,
                }
            )
    return tools


def _split_tool_name(prefixed: str, tools: list[dict[str, Any]]) -> Optional[tuple[str, str]]:
    for t in tools:
        if t["name"] == prefixed:
            return t["_skill"], t["_tool"]
    return None


# ---------------------------------------------------------------------------
# Skill clients（HTTP / local）
# ---------------------------------------------------------------------------
class LocalSkillClient:
    """in-process client：直接跑 registry/invoke（测试 + selftest-local，无需起服务）。"""

    def __init__(self, ctx: Any = None) -> None:
        self._ctx = ctx

    async def list_tools(self) -> list[dict[str, Any]]:
        from src.skills.registry import build_manifest

        return manifest_to_mcp_tools(build_manifest(None, generated_at="local"))

    async def call_tool(self, skill: str, tool: str, args: dict[str, Any]) -> dict[str, Any]:
        from src.skills.invoke import invoke_skill

        # 🔴 严格布尔，不做 truthiness（codex blocker）：仅 JSON true 算确认。
        confirm = (args.pop("confirm", False) is True) if isinstance(args, dict) else False
        return await invoke_skill(None, skill, tool, args, confirm=confirm, ctx=self._ctx)


class HttpSkillClient:
    """生产 client：经 Bearer key 打 serve-api /api/skills(+/invoke)。"""

    def __init__(self, base_url: str, api_key: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}

    async def list_tools(self) -> list[dict[str, Any]]:
        import httpx

        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.get(f"{self.base_url}/api/skills", headers=self._headers())
            r.raise_for_status()
            return manifest_to_mcp_tools(r.json()["data"])

    async def call_tool(self, skill: str, tool: str, args: dict[str, Any]) -> dict[str, Any]:
        import httpx

        # 🔴 严格布尔，不做 truthiness（codex blocker）：仅 JSON true 算确认。
        confirm = (args.pop("confirm", False) is True) if isinstance(args, dict) else False
        payload = {"skill": skill, "tool": tool, "input": args, "confirm": confirm}
        async with httpx.AsyncClient(timeout=180) as c:
            r = await c.post(
                f"{self.base_url}/api/skills/invoke", headers=self._headers(), json=payload
            )
            body = r.json()
            if r.status_code >= 400:
                err = body.get("error") or {}
                raise _ToolError(err.get("code", "E_INTERNAL"), err.get("message", "invoke failed"))
            return body["data"]


class _ToolError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


# ---------------------------------------------------------------------------
# JSON-RPC dispatch（纯函数，给定 client）
# ---------------------------------------------------------------------------
def _ok(req_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def _err(req_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}


async def handle_request(req: dict[str, Any], client: Any) -> Optional[dict[str, Any]]:
    """处理一个 JSON-RPC 请求 → 响应 dict（notification 返回 None，不回复）。"""
    method = req.get("method")
    req_id = req.get("id")
    is_notification = "id" not in req

    if method == "initialize":
        return _ok(
            req_id,
            {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "mailagent", "version": "1.0.0"},
            },
        )
    if method in ("notifications/initialized", "initialized"):
        return None  # notification，无响应
    if method == "tools/list":
        tools = await client.list_tools()
        public = [
            {"name": t["name"], "description": t["description"], "inputSchema": t["inputSchema"]}
            for t in tools
        ]
        return _ok(req_id, {"tools": public})
    if method == "tools/call":
        params = req.get("params") or {}
        name = params.get("name")
        args = params.get("arguments") or {}
        tools = await client.list_tools()
        resolved = _split_tool_name(name, tools)
        if resolved is None:
            return _err(req_id, -32602, f"unknown tool: {name}")
        skill, tool = resolved
        try:
            result = await client.call_tool(skill, tool, dict(args))
        except _ToolError as exc:
            return _ok(
                req_id,
                {
                    "content": [{"type": "text", "text": f"[{exc.code}] {exc.message}"}],
                    "isError": True,
                },
            )
        except Exception as exc:  # noqa: BLE001 — 任何失败转 MCP isError 文本，不崩 server
            return _ok(
                req_id,
                {"content": [{"type": "text", "text": f"error: {exc}"}], "isError": True},
            )
        return _ok(
            req_id,
            {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}]},
        )

    if is_notification:
        return None
    return _err(req_id, -32601, f"method not found: {method}")


# ---------------------------------------------------------------------------
# stdio loop
# ---------------------------------------------------------------------------
async def _serve_stdio(client: Any) -> None:
    loop = asyncio.get_event_loop()
    reader = asyncio.StreamReader()
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    while True:
        line = await reader.readline()
        if not line:
            break
        text = line.decode("utf-8").strip()
        if not text:
            continue
        try:
            req = json.loads(text)
        except json.JSONDecodeError:
            sys.stdout.write(json.dumps(_err(None, -32700, "parse error")) + "\n")
            sys.stdout.flush()
            continue
        resp = await handle_request(req, client)
        if resp is not None:
            sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
            sys.stdout.flush()


def main() -> None:
    """entry point ``mailagent-mcp``：读 env MAILAGENT_API_BASE + MAILAGENT_AGENT_KEY 起 stdio server。"""
    base = os.environ.get("MAILAGENT_API_BASE", "http://127.0.0.1:8200")
    key = os.environ.get("MAILAGENT_AGENT_KEY", "")
    if not key:
        sys.stderr.write("MAILAGENT_AGENT_KEY not set — refusing to start MCP server.\n")
        sys.exit(2)
    client = HttpSkillClient(base, key)
    try:
        asyncio.run(_serve_stdio(client))
    except KeyboardInterrupt:  # pragma: no cover
        pass


if __name__ == "__main__":  # pragma: no cover
    main()
