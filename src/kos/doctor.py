"""KOS 连接检查（issue #54）—— 分步探活，供 serve-api ``POST /api/chat/kos-doctor`` 用。

自部署 gbrain 场景下服务挂 / 隧道断 / 凭据错 / token 失效都是常态风险，此前 UI 无任何
联通反馈（gate 失败静默不注入工具）。分步 = 凭据配置 → GET /health（免 auth，验服务
可达）→ POST /token（验 OAuth 凭据）→ tools/call list_pages（验完整鉴权 + 服务端真实
可用——只验 token 拿得到不够）。任一步 fail 即停，后续步不跑，避免级联噪音。

返回 ``[{status: 'ok'|'fail', check, detail}]``，形状对齐 notion-agent doctor
（``NotionAgentDoctorCheck``），前端逐行 ok/fail 渲染。client 可注入（单测 stub）。
"""

from __future__ import annotations

from typing import Dict, List, Sequence

from src.kos.client import KOSError

#: 三项 OAuth 凭据（由 KOSClient 直接 os.getenv 读，不在 config.py，见 client.py 头注）。
KOS_CRED_KEYS = ("KOS_MCP_BASE", "KOS_OAUTH_CLIENT_ID", "KOS_OAUTH_CLIENT_SECRET")


def _ok(check: str, detail: str = "") -> Dict[str, str]:
    return {"status": "ok", "check": check, "detail": detail}


def _fail(check: str, detail: str) -> Dict[str, str]:
    return {"status": "fail", "check": check, "detail": detail}


def run_kos_doctor(
    client,
    *,
    missing_keys: Sequence[str],
    consumer_enabled: bool,
) -> List[Dict[str, str]]:
    """跑分步连接检查。``client`` = 用热读凭据新建的 KOSClient（勿传启动期单例——
    用户刚在 Settings 保存的凭据要立即生效，且单例的 token cache 会掩盖凭据失效）。"""
    checks: List[Dict[str, str]] = []

    # 1. 凭据配置 —— 同时是激活 gate 显因（gate = 开关 AND 凭据齐全，issue #54 病根：
    #    开关显示"开" ≠ 实际激活，此前不满足时静默）。
    if missing_keys:
        checks.append(
            _fail("凭据配置", f"缺 {', '.join(missing_keys)} —— 对话不会注入 KOS 工具")
        )
        return checks
    cred_detail = "KOS_MCP_BASE / CLIENT_ID / CLIENT_SECRET 齐全"
    if not consumer_enabled:
        cred_detail += "；但 MAILAGENT_KOS_CONSUMER_ENABLED 未开 —— 对话不会注入 KOS 工具"
    checks.append(_ok("凭据配置", cred_detail))

    # 2. 服务可达（GET /health，免 auth）—— 隧道断 / 服务挂在这一步暴露。
    try:
        h = client.health()
        detail = " · ".join(
            f"{k}={h.get(k)}" for k in ("status", "version", "engine") if h.get(k)
        )
        checks.append(_ok("服务可达 (GET /health)", detail or "ok"))
    except KOSError as e:
        checks.append(_fail("服务可达 (GET /health)", f"{e.code}: {e}"))
        return checks
    except Exception as e:  # noqa: BLE001 — doctor 面不许 500，任何异常转 fail 行
        checks.append(_fail("服务可达 (GET /health)", f"unexpected: {e}"))
        return checks

    # 3. OAuth token（POST /token client_credentials）—— 凭据错 / token 服务坏在这暴露。
    #    有意调私有 _refresh_token：显式强刷，绕过 token cache（缓存命中会掩盖已失效凭据）。
    try:
        client._refresh_token()
        checks.append(_ok("OAuth token (POST /token)", "client_credentials 获取成功"))
    except KOSError as e:
        checks.append(_fail("OAuth token (POST /token)", f"{e.code}: {e}"))
        return checks
    except Exception as e:  # noqa: BLE001
        checks.append(_fail("OAuth token (POST /token)", f"unexpected: {e}"))
        return checks

    # 4. 真实调用（tools/call list_pages limit=1）—— 完整鉴权 + MCP 面真实可用。
    try:
        result = client.list_pages(limit=1)
        detail = (
            f"list_pages 返回 {len(result)} 条"
            if isinstance(result, list)
            else "list_pages ok"
        )
        checks.append(_ok("真实调用 (list_pages)", detail))
    except KOSError as e:
        checks.append(_fail("真实调用 (list_pages)", f"{e.code}: {e}"))
    except Exception as e:  # noqa: BLE001
        checks.append(_fail("真实调用 (list_pages)", f"unexpected: {e}"))
    return checks
