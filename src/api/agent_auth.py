"""第四条鉴权腿 —— scoped Bearer agent key（Phase 1 Custom AI Harness 对外交付面）。

现有 ``src/api/auth.py`` 的 ``verify_cf_access`` 有三态：dev bypass → 同机 local token →
远程 CF Access JWT。headless 第三方 agent 无浏览器、拿不到 CF cookie，需要一条
``Authorization: Bearer <key>`` 通道。

本模块新增 ``authenticate_principal`` 作为 **Skill 路由专用** 的鉴权 dependency，按
``dev → local → bearer → CF`` 四腿顺序解析出一个 ``Principal``：

  - dev / local / CF 三腿 **逐字节复用** ``auth.py`` 的判据与常量（AUTH_DISABLED /
    LOCAL_TOKEN_HEADER / _LOCAL_API_TOKEN / verify_cf_access）—— 现有三态语义不削弱
    （Phase 0 「CF/local 既有路径不回归」）。
  - bearer 腿是新增：present + 合法 → ``kind='agent'`` 的 scoped principal；present +
    非法/撤销/过期 → **403 fail-closed**（不静默回落 CF，坏 key 必须明确拒绝）。

**为何只挂在 Skill 路由、不并进 verify_cf_access**：其余路由（email/reports/... 写端点）
只做 ``Depends(verify_cf_access)``、**无 per-tool scope gate**。若把 bearer 并进
verify_cf_access，一个 read-only agent key 就能直打 ``POST /api/email/send`` 绕过 scope。
把 bearer 局限在 ``/api/skills`` 表面（唯一做 scope 强制的路由），其余路由对 agent key
天然 401（无 CF JWT / 无 local token）—— 越权 by construction 不可达。
"""

from __future__ import annotations

import hmac
from dataclasses import dataclass
from typing import Iterable, Optional

from fastapi import HTTPException, Request

from src.api import auth as _auth
from src.security import api_keys as _api_keys


@dataclass
class Principal:
    """鉴权身份。

    ``scopes is None`` 表示 owner（dev / local / CF —— 本机用户本人），隐含全部 scope；
    agent key 的 scopes 是其被授予的有限集合。
    """

    kind: str  # 'human' | 'agent'
    auth_method: str  # 'dev' | 'local' | 'bearer' | 'cf'
    user_email: Optional[str] = None
    key_id: Optional[str] = None
    label: Optional[str] = None
    scopes: Optional[frozenset[str]] = None

    @property
    def is_agent(self) -> bool:
        return self.kind == "agent"

    def has_scopes(self, required: Iterable[str]) -> bool:
        """owner（scopes=None）恒 True；agent 需 required ⊆ 自身 scopes。"""
        if self.scopes is None:
            return True
        return all(s in self.scopes for s in required)


async def authenticate_principal(request: Request) -> Principal:
    """Skill 路由鉴权 dependency：四腿（dev → local → bearer → CF）→ Principal。

    成功把 principal 落到 ``request.state.principal`` + ``request.state.user_email``。
    失败 raise HTTPException（缺凭据 401 / 非法凭据 403），由全局 handler 转 envelope。
    """
    # --- 腿 1：dev bypass（仅 dev，auth.py 模块加载期已强制 MAILAGENT_API_DEV=true）---
    if _auth.AUTH_DISABLED:
        return _set_principal(
            request, Principal(kind="human", auth_method="dev", user_email="dev@localhost")
        )

    # --- 腿 2：同机 local token（逐字节复用 auth.py 常量 + compare_digest）---
    local_tok = request.headers.get(_auth.LOCAL_TOKEN_HEADER)
    if (
        _auth._LOCAL_API_TOKEN
        and local_tok
        and hmac.compare_digest(local_tok, _auth._LOCAL_API_TOKEN)
    ):
        email = _auth._resolve_allowed_email() or "local@127.0.0.1"
        return _set_principal(
            request, Principal(kind="human", auth_method="local", user_email=email)
        )

    # --- 腿 3：Bearer agent key（新增）---
    authz = request.headers.get("Authorization") or ""
    if authz.startswith("Bearer "):
        token = authz[len("Bearer ") :].strip()
        # 模块级属性访问（非顶层 import）→ 测试可 monkeypatch get_api_key_store。
        record = _api_keys.get_api_key_store().verify(token) if token else None
        if record is None:
            # present-but-invalid（无此 key / 撤销 / 过期）→ fail-closed，不回落 CF。
            raise HTTPException(status_code=403, detail="invalid or revoked agent API key")
        _api_keys.get_api_key_store().record_use(record.id)
        return _set_principal(
            request,
            Principal(
                kind="agent",
                auth_method="bearer",
                user_email=f"agent:{record.label}",
                key_id=record.id,
                label=record.label,
                scopes=frozenset(record.scopes),
            ),
        )

    # --- 腿 4：远程 CF Access JWT（委托 auth.verify_cf_access，单一真源）---
    # verify_cf_access 自身会再过 dev/local（均已 fall-through）再做 CF；无 token → 401。
    await _auth.verify_cf_access(request)
    return _set_principal(
        request,
        Principal(
            kind="human",
            auth_method="cf",
            user_email=getattr(request.state, "user_email", None),
        ),
    )


def _set_principal(request: Request, principal: Principal) -> Principal:
    request.state.principal = principal
    request.state.user_email = principal.user_email
    return principal
