#!/usr/bin/env python3
"""MCP connector OAuth spike（08-01 阶段 1 PR1 —— owner 一条龙验收脚本）。

两种模式：

  --mode dry（默认，**不发任何网络**）：
      用 httpx2.MockTransport 伪装远端（401 → PRM → AS metadata → DCR /register），
      驱动真 OAuthClientProvider 走到「构造出授权 URL 并交给 redirect_handler」为止，
      打印该 URL 后停。验证的是 registry 常量 / client_metadata（AnyUrl redirect_uri）/
      provider 三层装配 / DCR 请求响应处理这条链本身。凭证走 in-memory storage ——
      不碰 agent_config.db / Keychain。

  --mode live（真连；serve-api 必须在跑且 MAILAGENT_MCP_CONNECTORS=true）：
      ① POST /api/connector/{id}/oauth/start 拿授权 URL
      ② 自动开浏览器（owner 在浏览器里登录 + 同意；回调打回 serve-api callback）
      ③ 轮询 status 至 connected / error
      ④ POST sync 已在授权流里做过首轮 —— 这里 GET tools 打印落库清单

用法（venv 内）：
    python scripts/dev/connector_oauth_spike.py --connector notion            # dry
    python scripts/dev/connector_oauth_spike.py --connector notion --mode live

live 模式鉴权：--local-token 显式传入走本地 token 腿；缺省时自动从运行中的 serve-api
进程 env 抓（darwin ``ps eww``——token 是 app 每会话随机生成、不落盘，shell 变量里没有）；
抓不到给出人话说明；serve-api 若 MAILAGENT_API_AUTH_DISABLED=true 则无需 token。

Atlassian 预期（排雷报告风险 2）：DCR 可能仅限批准 client —— live 模式若在 start /
授权页被拒，把响应原文记进 issue（PR1 只承诺 Notion 实连，Atlassian 记录结论即可）。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
import webbrowser
from typing import Optional

# 允许 `python scripts/dev/...` 直跑（repo 根进 sys.path）
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))


# ---------------------------------------------------------------------------
# dry 模式
# ---------------------------------------------------------------------------


class _SpikeStop(Exception):
    """dry 模式哨兵：URL 已打印，到此为止。"""


class _MemoryStorage:
    """dry 模式专用 in-memory TokenStorage（绝不触碰 agent_config.db / Keychain）。"""

    def __init__(self) -> None:
        self.tokens = None
        self.client_info = None

    async def get_tokens(self):
        return self.tokens

    async def set_tokens(self, tokens) -> None:
        self.tokens = tokens

    async def get_client_info(self):
        return self.client_info

    async def set_client_info(self, client_info) -> None:
        self.client_info = client_info


def _mock_transport(server_url: str):
    """伪装远端：401 挑战 → protected-resource metadata → AS metadata → DCR 注册。"""
    import httpx2

    from urllib.parse import urlparse

    parsed = urlparse(server_url)
    origin = f"{parsed.scheme}://{parsed.netloc}"

    def handler(request: httpx2.Request) -> httpx2.Response:
        path = request.url.path
        if path.startswith("/.well-known/oauth-protected-resource"):
            return httpx2.Response(
                200,
                json={
                    "resource": server_url,
                    "authorization_servers": [origin],
                },
            )
        if path.startswith("/.well-known/oauth-authorization-server") or path.startswith(
            "/.well-known/openid-configuration"
        ):
            return httpx2.Response(
                200,
                json={
                    "issuer": origin,
                    "authorization_endpoint": f"{origin}/authorize",
                    "token_endpoint": f"{origin}/token",
                    "registration_endpoint": f"{origin}/register",
                    "response_types_supported": ["code"],
                    "grant_types_supported": ["authorization_code", "refresh_token"],
                    "code_challenge_methods_supported": ["S256"],
                    "token_endpoint_auth_methods_supported": ["none"],
                    "scopes_supported": ["default"],
                },
            )
        if path == "/register" and request.method == "POST":
            body = json.loads(request.content.decode("utf-8"))
            return httpx2.Response(
                201,
                json={
                    "client_id": "spike-dry-client",
                    "client_id_issued_at": int(time.time()),
                    "redirect_uris": body.get("redirect_uris", []),
                    "token_endpoint_auth_method": "none",
                    "grant_types": ["authorization_code", "refresh_token"],
                    "response_types": ["code"],
                    "client_name": body.get("client_name", ""),
                },
            )
        # 其余（首个 MCP 请求）→ 401 挑战，触发 OAuth 发现流。
        return httpx2.Response(
            401,
            headers={
                "WWW-Authenticate": (
                    'Bearer resource_metadata="'
                    f'{origin}/.well-known/oauth-protected-resource{parsed.path}"'
                )
            },
        )

    return httpx2.MockTransport(handler)


async def run_dry(connector_id: str) -> int:
    import httpx2

    from src.connectors.client import ConnectorClient

    # SDK 会把哨兵异常按 "OAuth flow error" ERROR 级打 traceback —— dry 模式里是预期收梢，静音。
    import logging

    logging.getLogger("mcp").setLevel(logging.CRITICAL)

    printed: dict[str, Optional[str]] = {"url": None}

    async def redirect_handler(url: str) -> None:
        printed["url"] = url
        print("\n=== authorization URL (dry, 未发网络) ===")
        print(url)
        print("=========================================\n")

    async def callback_handler():
        raise _SpikeStop()

    cc = ConnectorClient(
        connector_id,
        interactive=True,
        redirect_handler=redirect_handler,
        callback_handler=callback_handler,
        timeout_seconds=5.0,
        storage=_MemoryStorage(),
    )
    provider = cc._build_provider()
    transport = _mock_transport(cc.definition.server_url)
    try:
        async with httpx2.AsyncClient(auth=provider, transport=transport) as http:
            await http.post(cc.definition.server_url, json={"probe": True})
    except Exception as e:  # noqa: BLE001 — 走到 URL 之后的任何收梢异常都按哨兵判
        chain: list[BaseException] = []
        cur: Optional[BaseException] = e
        while cur is not None and cur not in chain:
            chain.append(cur)
            cur = cur.__cause__ or cur.__context__
        if printed["url"] is None and not any(isinstance(c, _SpikeStop) for c in chain):
            raise
    if printed["url"] is None:
        print("FAIL: OAuth flow ran but no authorization URL was produced", file=sys.stderr)
        return 1
    print("DRY OK — provider 装配 / DCR / 授权 URL 构造这条链通了（未发任何网络）。")
    return 0


# ---------------------------------------------------------------------------
# live 模式（驱动运行中的 serve-api；真实 OAuth 由 owner 在浏览器完成）
# ---------------------------------------------------------------------------


def _auto_local_token() -> Optional[str]:
    """从运行中的 serve-api 进程 env 抓 MAILAGENT_LOCAL_API_TOKEN（darwin only）。

    该 token 是 Electron main 每会话 randomBytes 生成、只注入 serve-api 子进程 env、
    **不落盘** —— shell 里 ``$MAILAGENT_LOCAL_API_TOKEN`` 是拿不到的（PR1 usage 文案的坑）。
    ``ps eww <pid>`` 能吐出进程完整 env，从中解析出来。
    """
    import subprocess

    if sys.platform != "darwin":
        return None
    try:
        pids = subprocess.run(
            ["pgrep", "-f", "serve-api"], capture_output=True, text=True, timeout=5
        ).stdout.split()
        for pid in pids:
            out = subprocess.run(
                ["ps", "eww", pid], capture_output=True, text=True, timeout=5
            ).stdout
            for word in out.split():
                if word.startswith("MAILAGENT_LOCAL_API_TOKEN="):
                    tok = word.split("=", 1)[1]
                    if tok:
                        return tok
    except (OSError, subprocess.SubprocessError):
        return None
    return None


def _live_headers(local_token: Optional[str]) -> dict[str, str]:
    headers = {}
    tok = local_token or os.environ.get("MAILAGENT_LOCAL_API_TOKEN") or ""
    if not tok:
        tok = _auto_local_token() or ""
        if tok:
            print("[auth] local token 已自动从 serve-api 进程 env 抓取 (ps eww)")
        else:
            print(
                "[auth] 拿不到 local token：它是 app 每会话随机生成、只注入 serve-api "
                "进程 env、不落盘 —— shell 环境变量里没有。请用 --local-token 显式传入"
                "（macOS 可手抓：TOK=$(ps eww $(pgrep -f serve-api | head -1) | tr ' ' '\\n'"
                " | grep '^MAILAGENT_LOCAL_API_TOKEN=' | cut -d= -f2-)）。"
                "若 serve-api 设了 MAILAGENT_API_AUTH_DISABLED=true 则无需 token，继续裸跑。",
                file=sys.stderr,
            )
    if tok:
        headers["X-MailAgent-Local-Token"] = tok
    return headers


def run_live(connector_id: str, base: str, local_token: Optional[str], wait_seconds: int) -> int:
    import httpx

    headers = _live_headers(local_token)
    with httpx.Client(base_url=base, headers=headers, timeout=40.0) as client:
        print(f"[1/4] POST /api/connector/{connector_id}/oauth/start")
        r = client.post(f"/api/connector/{connector_id}/oauth/start")
        if r.status_code != 200:
            print(f"start failed: HTTP {r.status_code}: {r.text[:800]}", file=sys.stderr)
            if connector_id == "atlassian":
                print(
                    "(Atlassian DCR 被拒是已知风险 —— 把上面的响应原文记进 issue)",
                    file=sys.stderr,
                )
            return 1
        data = r.json().get("data") or {}
        url = data.get("authorize_url")
        print(f"    authorize_url: {url}")
        print("[2/4] 打开浏览器完成授权（登录 + 同意）…")
        webbrowser.open(url)

        print(f"[3/4] 轮询 status（至多 {wait_seconds}s）…")
        deadline = time.time() + wait_seconds
        status = "pending"
        while time.time() < deadline:
            s = client.get(f"/api/connector/{connector_id}/status")
            payload = (s.json().get("data") or {}) if s.status_code == 200 else {}
            flow = payload.get("flow") or {}
            status = flow.get("status") or payload.get("status") or "pending"
            if status in ("connected", "error"):
                if status == "error":
                    print(f"flow error: {flow.get('error')}", file=sys.stderr)
                    return 1
                break
            time.sleep(2)
        if status != "connected":
            print(f"timed out waiting for authorization (last status={status})", file=sys.stderr)
            return 1
        print("    connected ✔")

        print("[4/4] GET tools（授权流已同步落库）")
        t = client.get(f"/api/connector/{connector_id}/tools")
        if t.status_code != 200:
            print(f"tools failed: HTTP {t.status_code}: {t.text[:400]}", file=sys.stderr)
            return 1
        tools = (t.json().get("data") or {}).get("tools") or []
        print(f"\n{len(tools)} tools synced:")
        for tool in tools:
            mark = "✓" if tool.get("effective_enabled") else " "
            print(
                f"  [{mark}] {tool['name']:<44} {tool['crud_type']:<7} "
                f"{(tool.get('description') or '')[:60]}"
            )
        print("\nLIVE OK — OAuth 走通且工具清单已落 agent_config.db。")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--connector", default="notion", choices=["notion", "atlassian"])
    parser.add_argument("--mode", default="dry", choices=["dry", "live"])
    parser.add_argument("--base", default="http://127.0.0.1:8200")
    parser.add_argument("--local-token", default=None)
    parser.add_argument("--wait", type=int, default=300, help="live 模式等授权完成的秒数")
    args = parser.parse_args()

    if args.mode == "dry":
        return asyncio.run(run_dry(args.connector))
    return run_live(args.connector, args.base, args.local_token, args.wait)


if __name__ == "__main__":
    raise SystemExit(main())
