"""Cloudflare Access JWT 二次校验 (鉴权 L2)。

严格照 REMOTE-ACCESS §6.3 范本 (REVIEW-LOG.md C-01 重写版):
  - PyJWKClient 按 kid 缓存 (cache_keys=True) + lifespan + unknown kid 自动 refresh
    → CF 月度 key rotation 不停机。
  - algorithms=["RS256"] 白名单 → 防 ``alg=none`` 攻击。
  - options.require=["exp","iat","iss","aud"] → 这四个 claim 必须存在，缺一即拒。
  - 校验 issuer (CF_ISSUER) + audience (CF_AUDIENCE)。
  - identity 只从 verified JWT claims["email"] 取，**绝不**信任
    CF-Access-Authenticated-User-Email header (CF 边缘 header tunnel 误配时可伪造)。
  - lazy: 进程启动不拉 JWKS，第一次 verify 时才拉 → uvicorn 启动快。

纵深防御 (codex C1, security-review): CF Access OAuth 邮箱白名单 (L1) 是独立 SoT，
本层 (L2) **不能只信** CF L1 —— policy drift / service-token 路径可能签出一张无 ``email``
claim、或 email 不在白名单内的合法 JWT。因此本层额外强制:
  - claims 必含 ``email`` (缺 → 403)；
  - ``email`` 必须在配置的多邮箱白名单内（USER_EMAIL 与 MAILAGENT_API_ALLOWED_EMAIL
    的**并集**），不匹配 → 403。
比对大小写不敏感 + strip。allowed email 集合解析见 ``_resolve_allowed_emails``。
典型场景: 邮箱迁移期（如 lucien.chen@tp-link.com → lucien.chen@omadanetworks.com），
USER_EMAIL 设新邮箱，MAILAGENT_API_ALLOWED_EMAIL 追加旧邮箱（逗号分隔），两个都放行。

鉴权分层见 §6.4: L1 = CF Access OAuth + 邮箱白名单 (独立 SoT)，L2 = 本层 (防 tunnel
误配把 8200 直接暴露公网时的兜底)。两层共享同一 CF Access JWKS。

dev bypass (仅本地 dev:web 用): MAILAGENT_API_AUTH_DISABLED=true 时整层跳过，
不校验 JWT，user_email 置为 dev 占位。**仅 dev 允许** —— 必须同时显式声明 dev 上下文
(MAILAGENT_API_DEV=true)，否则模块加载即 RuntimeError 拒绝启动 (codex C2: 防生产
误设 AUTH_DISABLED 把鉴权整层敞开)。生产 (cloudflared + CF Access) 下两者都必须保持关闭。
"""

from __future__ import annotations

import hmac
import logging
import os

import jwt
from fastapi import HTTPException, Request
from jwt import PyJWKClient

logger = logging.getLogger("mailagent.api.auth")

# CF Zero Trust 配置 — 从 env 读 (REMOTE-ACCESS §6.3 写死示例值，这里参数化便于
# 不同部署 / dev 覆盖)。生产由 cloudflared 同机的 .env / pm2 env 注入。
CF_TEAM_DOMAIN = os.environ.get("CF_TEAM_DOMAIN", "chenyq.cloudflareaccess.com")
CF_AUDIENCE = os.environ.get("CF_AUDIENCE", "")  # CF Zero Trust dashboard 的 application-audience-tag
CF_ISSUER = f"https://{CF_TEAM_DOMAIN}"

# dev bypass 开关 (仅本地 dev:web)。任何非 "true" 值 (含未设) 都视为关闭。
AUTH_DISABLED = os.environ.get("MAILAGENT_API_AUTH_DISABLED", "").lower() == "true"

# 显式 dev 上下文标记 (codex C2)。auth bypass 只在 dev 允许 —— 单靠 AUTH_DISABLED
# 不足以证明这是 dev (生产可能误设)，必须同时设 MAILAGENT_API_DEV=true。
_DEV_CONTEXT = os.environ.get("MAILAGENT_API_DEV", "").lower() == "true"

# 可选: 追加额外的 allowed emails（逗号分隔，支持多个）。与 config.user_email 取并集。
# 典型场景: 邮箱迁移期两个邮箱并行放行（旧邮箱填此处，新邮箱走 USER_EMAIL）。
# 留空时白名单仅含 config.user_email (= USER_EMAIL)。解析见 _resolve_allowed_emails。
ALLOWED_EMAIL_OVERRIDE = os.environ.get("MAILAGENT_API_ALLOWED_EMAIL", "").strip()

# C2 双层鉴权第二条腿 — 本地 per-session ephemeral token。
# 同机 Electron 客户端 (主进程 events_bridge→9200 SSE; D1 起 renderer→8200 写) 用自定义
# header X-MailAgent-Local-Token 携带, 由 Electron 主进程 crypto.randomBytes 每会话生成,
# 经 env MAILAGENT_LOCAL_API_TOKEN 注入本进程 (见 frontend local_token.ts + backend_lifecycle)。
# loopback ≠ 安全: 同机任意进程都能打 127.0.0.1:8200, 自定义 header 天然抗 CSRF (浏览器无法
# 伪造 + CORS 白名单只放 mail.chenge.ink)。空 = 未配置 (远程-only / dev), 此腿停用回落 CF JWT。
LOCAL_TOKEN_HEADER = "X-MailAgent-Local-Token"  # 🔴 必须与 src/sse_server.py + local_token.ts 一致
_LOCAL_API_TOKEN = os.environ.get("MAILAGENT_LOCAL_API_TOKEN", "").strip()

# codex C2: auth-disable **仅 dev 允许**。设了 AUTH_DISABLED 却无明确 dev 上下文
# (MAILAGENT_API_DEV != true) → 极可能是生产误配把整层鉴权敞开，启动即 RuntimeError
# 拒绝起服务，逼操作者要么撤掉 bypass、要么显式声明这是 dev。
# 注意: auth-disable 不碰 CORS —— CORS 白名单由 app.py 的 MAILAGENT_API_DEV_CORS
# 独立控制 (codex C2 第二点)，本模块不参与。
if AUTH_DISABLED and not _DEV_CONTEXT:
    raise RuntimeError(
        "MAILAGENT_API_AUTH_DISABLED=true but no dev context declared. "
        "Auth bypass is dev-only: also set MAILAGENT_API_DEV=true to confirm this "
        "is a local dev run, or unset MAILAGENT_API_AUTH_DISABLED in production "
        "(REMOTE-ACCESS §6.3 — never ship with JWT verification disabled)."
    )

# fail-fast: 鉴权开启 (生产) 却**一种鉴权方式都没配** → 整层敞开或全员被锁在外且难诊断。
# C2 起判据从「必须有 CF_AUDIENCE」放宽为「至少一种鉴权方式」: CF_AUDIENCE (远程 CF Access)
# 或 _LOCAL_API_TOKEN (同机 ephemeral token, 让没配 Cloudflare 的本地 Electron 也能用 daemon
# 写面)。两者都空才 fail-closed 退出。dev bypass 下不校验 (本地无 CF Access)。
if not AUTH_DISABLED and not CF_AUDIENCE and not _LOCAL_API_TOKEN:
    raise RuntimeError(
        "No auth method configured: set CF_AUDIENCE (CF Zero Trust application audience "
        "tag, for remote CF Access) and/or MAILAGENT_LOCAL_API_TOKEN (same-machine "
        "ephemeral token) — or, for local dev, set MAILAGENT_API_AUTH_DISABLED=true "
        "(REMOTE-ACCESS §6.3)."
    )

# 1) lazy + cache by kid + 自动 refresh on unknown key (CF key rotation 友好)
# 2) 进程启动不阻塞 — 第一次 verify 时才拉 JWKS
_jwk_client = PyJWKClient(
    f"{CF_ISSUER}/cdn-cgi/access/certs",
    cache_keys=True,
    lifespan=3600,  # JWKS in-memory cache 1h
    max_cached_keys=8,
)


def _resolve_allowed_emails() -> set[str]:
    """解析 L2 比对用的多邮箱白名单（大小写不敏感，内部全小写存储）。

    返回值 = config.user_email（可用且非空时）与 MAILAGENT_API_ALLOWED_EMAIL（逗号分隔）
    的**并集**。不再是"优先/回退"二选一，两处都配时两个都放行。

    典型场景: 邮箱迁移期 lucien.chen@tp-link.com → lucien.chen@omadanetworks.com:
      USER_EMAIL=lucien.chen@omadanetworks.com（新邮箱）
      MAILAGENT_API_ALLOWED_EMAIL=lucien.chen@tp-link.com（旧邮箱追加）
    → 两个都进白名单，CF 登录不管用哪个邮箱都放行。

    lazy + 容错: config 单例在 import 期构造，裸 worktree (无 .env) 会 ValidationError；
    本函数只在**真实校验路径** (bypass off) 被调用，运行环境已具 .env，正常拿到
    user_email。若 config 导入/构造失败 (裸 worktree / 缺 .env)，吞掉异常只取 override，
    保证 ``import src.api.auth`` 永不因此崩。

    返回空集合表示两处都没配 → 调用方按 fail-closed 处理（拒绝放行）。
    """
    allowed: set[str] = set()

    # 1. config.user_email (= USER_EMAIL 必填项)
    try:
        from src.config import config as _config_singleton

        candidate = (getattr(_config_singleton, "user_email", "") or "").strip()
        if candidate:
            allowed.add(candidate.lower())
    except Exception:  # noqa: BLE001 — 裸 worktree / 缺 .env / 任何 config 构造失败都跳过
        logger.debug("config.user_email unavailable; skipping for allowed-emails resolution")

    # 2. MAILAGENT_API_ALLOWED_EMAIL 追加白名单（逗号分隔，支持多个）
    for raw in ALLOWED_EMAIL_OVERRIDE.split(","):
        email = raw.strip().lower()
        if email:
            allowed.add(email)

    return allowed


def _resolve_allowed_email() -> str:
    """本地 token 腿的单值身份解析 + 测试兼容接口。

    语义：config.user_email 可用且非空时**优先**返回它（= USER_EMAIL，主配置身份）；
    否则返回 MAILAGENT_API_ALLOWED_EMAIL 逗号分隔列表中按配置顺序第一个非空项；
    都没有则返回 ""。

    生产代码（本地 token 腿 verify_cf_access）用此函数给 request.state.user_email 赋值，
    语义是"当前实例的主身份"，应与 USER_EMAIL 对齐而非取字典序最小。
    测试可直接 monkeypatch 本函数。新的多邮箱校验请用 _resolve_allowed_emails()。
    """
    # 1. config.user_email 优先（= USER_EMAIL 必填项，主配置身份）
    try:
        from src.config import config as _config_singleton

        candidate = (getattr(_config_singleton, "user_email", "") or "").strip()
        if candidate:
            return candidate.lower()
    except Exception:  # noqa: BLE001 — 裸 worktree / 缺 .env / config 构造失败都跳过
        logger.debug("config.user_email unavailable; falling back to ALLOWED_EMAIL_OVERRIDE")

    # 2. override env 中按配置顺序第一个非空项
    for raw in ALLOWED_EMAIL_OVERRIDE.split(","):
        email = raw.strip().lower()
        if email:
            return email

    return ""


async def verify_cf_access(request: Request) -> None:
    """FastAPI dependency: 校验 Cf-Access-Jwt-Assertion，把 email 落到 request.state。

    成功: request.state.user_email = <verified + allow-listed claims email>，无返回值。
    失败: raise HTTPException —
          - 缺 token → 401；
          - JWT 非法 / 签名校验失败 → 403；
          - JWT 合法但缺 ``email`` claim → 403 (codex C1)；
          - email 不在配置的多邮箱白名单内（USER_EMAIL ∪ MAILAGENT_API_ALLOWED_EMAIL）→ 403 (codex C1)。
          (与 §6.3 范本、auth-layer 失败映射一致。)

    dev bypass: AUTH_DISABLED 时直接放行，user_email = "dev@localhost" (仅 dev，
    模块加载期已强制 MAILAGENT_API_DEV=true，见顶部 C2 守卫)。

    C2 双层鉴权: 远程 CF JWT 逻辑**一字不改** (下方); 仅在其之前加一条本地 token 腿 ——
    配了 _LOCAL_API_TOKEN 且 X-MailAgent-Local-Token header 匹配 (compare_digest 防时序
    侧信道) → 放行本地身份。未配 token / 不匹配 → 跳过, 回落 CF JWT (fail-closed: 都没有→401)。
    """
    if AUTH_DISABLED:
        request.state.user_email = "dev@localhost"
        return

    # --- 本地 ephemeral token 腿 (同机 Electron/renderer) ---------------------
    local_tok = request.headers.get(LOCAL_TOKEN_HEADER)
    if _LOCAL_API_TOKEN and local_tok and hmac.compare_digest(local_tok, _LOCAL_API_TOKEN):
        # 本地身份 = 配置的 allowed email (USER_EMAIL 优先); 解析不出则回落同机 sentinel。
        # 用 _resolve_allowed_email() 取有序第一个（config.user_email 优先于 override）。
        request.state.user_email = _resolve_allowed_email() or "local@127.0.0.1"
        return

    token = request.headers.get("Cf-Access-Jwt-Assertion")
    if not token:
        raise HTTPException(status_code=401, detail="no access JWT")

    try:
        signing_key = _jwk_client.get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            key=signing_key.key,
            algorithms=["RS256"],  # alg 白名单，防 alg=none
            audience=CF_AUDIENCE,
            issuer=CF_ISSUER,
            options={"require": ["exp", "iat", "iss", "aud"]},
        )
    except jwt.PyJWTError as exc:  # noqa: BLE001 — PyJWT 所有校验失败都归此基类
        raise HTTPException(status_code=403, detail=f"access JWT invalid: {exc}") from exc

    # --- 纵深防御 L2 (codex C1): 不只信 CF L1 白名单 -----------------------
    # identity 只从 verified claims 取，绝不信任 CF-Access-Authenticated-User-Email header。
    email = (claims.get("email") or "").strip()
    if not email:
        # service-token / 误配 policy 可能签出无 email 的合法 JWT —— 拒绝。
        logger.warning("CF Access JWT verified but carries no 'email' claim — rejected")
        raise HTTPException(status_code=403, detail="access JWT missing email claim")

    allowed = _resolve_allowed_emails()
    if not allowed:
        # 锁定路径却没配 allowed email (USER_EMAIL / MAILAGENT_API_ALLOWED_EMAIL 都空)
        # → fail-closed 拒绝，而非放行任意已签名身份。
        logger.error(
            "No allowed email configured (USER_EMAIL / MAILAGENT_API_ALLOWED_EMAIL both empty); "
            "denying request fail-closed"
        )
        raise HTTPException(status_code=403, detail="server email allowlist not configured")

    if email.lower() not in allowed:
        logger.warning("CF Access JWT email not in allowlist — rejected")
        raise HTTPException(status_code=403, detail="email not allowed")

    request.state.user_email = email
