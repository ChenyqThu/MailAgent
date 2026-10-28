"""mailagent-mcp —— MCP stdio server，把 MailAgent Skill manifest 暴露为 MCP tools。

设计：
  - **tools 从 manifest 生成**（``mcp_exposed`` 的 tool），不手写第二套工具定义 → 无第二真源。
  - 工具名 ``mailagent_<tool>``（前缀避免与其他 MCP server 冲突）；同一次投影里 tool 名撞了
    （owner 视角下 installed skill 复用 builtin 工具）才退回 ``mailagent_<skill>_<tool>``。
  - 每个工具带 ``title`` 与 ``annotations``，四个 hint 由 ``side_effect`` 一处推导、一律显式输出
    （规范默认值是 destructive / open-world，不输出 = 客户端把读工具也当危险写工具）。
  - 生产经 ``HttpSkillClient`` 打 serve-api（Bearer key）；测试/本地 selftest 用
    ``LocalSkillClient`` in-process 跑 registry（无需起服务）；serve-api 的 HTTP 端点
    ``/mcp``（``src/api/routers/skills.py``）用 ``PrincipalSkillClient`` 按已鉴权的
    principal in-process 调用。
  - 协议核心 ``handle_request(req, client)`` 是纯函数（给定 client）→ 易单测，stdio 与
    HTTP 两种传输共用。

MCP 协议最小实现：initialize（版本协商）/ ping / tools/list / tools/call + notifications。
JSON-RPC over stdio：每行一个 JSON 对象（newline-delimited）。
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from collections import Counter
from typing import Any, Optional

PROTOCOL_VERSION = "2024-11-05"
# initialize 版本协商：客户端请求的版本在集内则回显，否则回最新（MCP lifecycle 规范）。
# 本实现只用到三版共有的 tools 子集，无版本差异分支。
SUPPORTED_PROTOCOL_VERSIONS = ("2024-11-05", "2025-03-26", "2025-06-18")
TOOL_PREFIX = "mailagent_"


# ---------------------------------------------------------------------------
# manifest → MCP tools
# ---------------------------------------------------------------------------
# side_effect → MCP ToolAnnotations 的四个 hint（readOnly, destructive, idempotent, openWorld）。
# annotations 只是给客户端的提示；真正的权限仍由 scope 与 confirm 闸负责。
_HINTS_BY_SIDE_EFFECT: dict[str, tuple[bool, bool, bool, bool]] = {
    "read": (True, False, True, False),
    "write": (False, False, False, False),
    "external_call": (False, False, False, True),
    "send": (False, True, False, True),
}


def tool_annotations(
    title: str,
    side_effect: str,
    *,
    destructive: Optional[bool] = None,
    idempotent: Optional[bool] = None,
) -> dict[str, Any]:
    """按 ``side_effect`` 推导 MCP annotations。未知值 → KeyError（新增 SideEffect 必须来这里补一行）。

    ``destructive`` / ``idempotent`` 非 None 时覆盖推导值（``ToolDef`` 的同名字段）；
    readOnly / openWorld 恒取推导值。
    """
    read_only, derived_destructive, derived_idempotent, open_world = _HINTS_BY_SIDE_EFFECT[side_effect]
    if destructive is None:
        destructive = derived_destructive
    if idempotent is None:
        idempotent = derived_idempotent
    return {
        "title": title,
        "readOnlyHint": read_only,
        "destructiveHint": destructive,
        "idempotentHint": idempotent,
        "openWorldHint": open_world,
    }


def _field(obj: Any, key: str, default: Any = None) -> Any:
    """pydantic 模型与 HTTP manifest dict 两种形态统一取字段。"""
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def manifest_to_mcp_tools(manifest: Any) -> list[dict[str, Any]]:
    """SkillManifest（pydantic 或 dict）→ MCP tool 定义列表（仅 mcp_exposed）。"""
    exposed: list[tuple[str, Any]] = []
    for skill in _field(manifest, "skills"):
        sname = _field(skill, "name")
        for t in _field(skill, "tools"):
            if _field(t, "mcp_exposed"):
                exposed.append((sname, t))

    name_counts = Counter(_field(t, "name") for _sname, t in exposed)

    tools: list[dict[str, Any]] = []
    for sname, t in exposed:
        name = _field(t, "name")
        mcp_name = f"{TOOL_PREFIX}{name}" if name_counts[name] == 1 else f"{TOOL_PREFIX}{sname}_{name}"
        title = _field(t, "title") or name
        tools.append(
            {
                "name": mcp_name,
                "title": title,
                "description": _field(t, "description"),
                "inputSchema": _field(t, "input_schema"),
                "annotations": tool_annotations(
                    title,
                    _field(t, "side_effect"),
                    destructive=_field(t, "destructive"),
                    idempotent=_field(t, "idempotent"),
                ),
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


class PrincipalSkillClient:
    """in-process client，按已鉴权的 principal 过滤与调用（serve-api ``/mcp`` 端点用）。

    与 ``/api/skills`` 走同一套 ``build_manifest`` / ``invoke_skill``：scope、confirm、配额、
    输入校验全部原样生效。``on_call(skill, tool, error_code, t0)`` 在每次 invoke 结束后
    回调（审计用，``error_code`` 为 None 表示成功）。
    """

    def __init__(self, principal: Any, ctx: Any, on_call: Any = None) -> None:
        self._principal = principal
        self._ctx = ctx
        self._on_call = on_call

    async def list_tools(self) -> list[dict[str, Any]]:
        from src.skills.registry import build_manifest

        return manifest_to_mcp_tools(build_manifest(self._principal))

    async def call_tool(self, skill: str, tool: str, args: dict[str, Any]) -> dict[str, Any]:
        from src.skills.errors import SkillError
        from src.skills.invoke import invoke_skill

        # 🔴 严格布尔，不做 truthiness（codex blocker）：仅 JSON true 算确认。
        confirm = (args.pop("confirm", False) is True) if isinstance(args, dict) else False
        t0 = time.perf_counter()
        try:
            result = await invoke_skill(
                self._principal, skill, tool, args, confirm=confirm, ctx=self._ctx
            )
        except SkillError as exc:
            if self._on_call is not None:
                self._on_call(skill, tool, exc.code, t0)
            raise _ToolError(exc.code, exc.message) from exc
        if self._on_call is not None:
            self._on_call(skill, tool, None, t0)
        return result


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
        from src.skills.registry import _server_version

        requested = (req.get("params") or {}).get("protocolVersion")
        if requested in SUPPORTED_PROTOCOL_VERSIONS:
            version = requested
        elif requested is None:
            version = PROTOCOL_VERSION
        else:
            version = SUPPORTED_PROTOCOL_VERSIONS[-1]
        return _ok(
            req_id,
            {
                "protocolVersion": version,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "mailagent", "version": _server_version()},
            },
        )
    if method == "ping":
        return _ok(req_id, {})
    if method in ("notifications/initialized", "initialized"):
        return None  # notification，无响应
    if method == "tools/list":
        tools = await client.list_tools()
        public = [{k: v for k, v in t.items() if not k.startswith("_")} for t in tools]
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
