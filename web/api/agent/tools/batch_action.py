"""批量操作工具（通过内部 API 调用，复用既有权限与 Redis 推送）。"""

from __future__ import annotations

import json
from typing import Any

import httpx

from web.api.config import web_config


async def batch_action(inp: dict[str, Any]) -> str:
    action = inp.get("action", "")
    email_ids = inp.get("email_ids")
    view = inp.get("view")

    if not action:
        return json.dumps({"error": "missing action"})

    port = web_config.web_api_port
    base = f"http://127.0.0.1:{port}/api"
    token = web_config.web_api_token
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    async with httpx.AsyncClient(timeout=30) as client:
        if view:
            resp = await client.post(
                f"{base}/emails/view-action",
                headers=headers,
                json={"action": action, "view": view},
            )
        elif email_ids:
            if len(email_ids) > 200:
                email_ids = email_ids[:200]
            resp = await client.post(
                f"{base}/emails/batch-action",
                headers=headers,
                json={"action": action, "email_ids": email_ids},
            )
        else:
            return json.dumps({"error": "需要提供 email_ids 或 view 参数"})

        if resp.status_code != 200:
            return json.dumps({"error": f"API {resp.status_code}: {resp.text[:200]}"})

        return resp.text
