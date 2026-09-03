"""邮件正文远程图片代理 — ``GET /api/email/remote-image?url=…&exp=…&sig=…``
＋签名签发 ``POST /api/email/remote-image/grant``。

HTML 邮件里的 ``https://…`` 远程图片在 renderer 被页面 CSP（``index.html`` 的 ``img-src``）
拦掉，这是**要保留的隐私默认**（远程图片是追踪像素的主要载体）。CSP 写在 meta 里、运行时
改不了 ⇒ 用户点了「加载图片」之后不能靠放宽 CSP，只能把 ``<img>`` 的 src 改写成打本机
serve-api —— ``img-src`` 已放行 ``http://127.0.0.1:*``。本端点就是那条腿。

🔴 **鉴权挡不住正文自己写的 URL**（本端点上线后的复核结论）：renderer 发出的 ``<img>``
请求会被主进程 ``chat_local_bridge`` 的 webRequest 拦截器按端口命中并**无条件**注入
``X-MailAgent-Local-Token``；远程 web 走同源 ``/api`` + CF Access cookie 同理。也就是说
邮件正文里硬编码一个 ``…/api/email/remote-image?url=https://tracker/p.png``，浏览器打开
邮件的瞬间就带着合法凭证把它发出去了 —— 零点击追踪出网，且前端的「加载图片」同意闸
完全没参与。**故凭证不是授权**：本端点要求一份**正文伪造不出来的**签名。

授权模型（两段）：
  - ``POST /remote-image/grant``（鉴权）：renderer 在用户点「加载图片」后，把这次要放行的
    URL 清单交上来换 ``(exp, sig)``。签名 = HMAC-SHA256(进程内随机密钥, ``f"{exp}\\n{url}"``)。
    密钥 **不落盘、不下发、进程重启即换**（重启后旧 srcDoc 里的签名失效 = 重新点一次）。
  - ``GET /remote-image``：先验签再取图。签名缺失 / 被篡改（换 url）/ 过期一律 403 空体。
本方案成立的前提：正文 iframe 是 ``sandbox="allow-same-origin"``（**无** ``allow-scripts``，
见 ``EmailBodyFrame.tsx``），正文里跑不了 JS ⇒ 拿不到、也算不出签名。
前端侧配套的「哪些写法算远程」判据（``srcset`` / ``poster`` / ``background`` / CSS
``url()`` / 单斜杠 ``http:/host`` 等）在 ``frontend/src/shared/lib/emailRemoteImages.ts``。

🔴 ``url`` 完全由邮件内容（= 不可信输入）控制 ⇒ SSRF 防护是本端点的重心，逐条：
  ① scheme 仅 http/https                            （``ssrf.validate_url``）
  ② DNS 解析后**逐 IP** 拒 loopback/私网/link-local/保留段（v4/v6 + v4-mapped/6to4/teredo
     内嵌 v4）                                       （``ssrf.check_ip``）
  ③ 拒 URL 内嵌凭证 ``user:pass@host``               （``ssrf.validate_url``）
  ④ redirect **不自动跟**，手动 ≤3 跳，每跳重走 ①②③（外加钉 IP 防 DNS rebinding）
  ⑤ 响应 ``Content-Type`` 必须 ``image/*``；缺失也拒（fail-closed）
  ⑥ 响应体 10 MiB 上限，流式边读边截 —— 超限即拒（不回半张损坏的图）
  ⑦ 连接 + 总预算 10s（``_TIMEOUT_SEC`` 是跨所有跳的**总**预算）
  ⑧ 出站**不带** cookie / Referer / 任何本机凭证：headers 由本模块从零构造（入站请求的
     header 一个都不转发），``trust_env=False`` 连系统代理与 netrc 都不吃（代理还会绕过
     钉 IP 让 ②④ 失效）
     ⚠️ 字面精确说明：``httpx.Client`` 自带 cookie jar，同一次取图的 redirect 链内，上游
     在第 n 跳 ``Set-Cookie``、第 n+1 跳会被回送（浏览器同款语义）。Client 只活这一次取图
     （``with`` 块内），**不跨请求持久化**，且回送的 cookie 本就来自上游自己 ⇒ 无泄漏面。
     ⑧ 说的「不带 cookie」指**我们的**凭证（本机 token / CF cookie / 用户身份）一个不带。
  ⑨ 只回图片字节 + 我们自己的安全响应头；上游其余响应头（Set-Cookie / 缓存 / 追踪头）
     一律不透传

失败一律 4xx/5xx + **空体**（不把上游错误原文透出，避免把内网探测结果当 oracle 回给
邮件作者）；细节只进日志。不做缓存（v1 从简）。

可用性护栏：每次取图占一个 ``run_in_threadpool`` 令牌最长 ``_TIMEOUT_SEC``（Starlette
默认池 40）⇒ 一封信几百张图会把整个 API 拖死。本模块用一个进行中计数器把并发取图钉在
``_MAX_INFLIGHT_FETCHES``，超出直接 503 空体（浏览器对单 host 的 HTTP/1.1 并发本就 ≈6，
正常渲染碰不到这个上限）。
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
import time

import httpx
from fastapi import APIRouter, Body, Depends, Query, Request, Response
from fastapi.concurrency import run_in_threadpool

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
from src.api.ssrf import check_ip as _check_ip
from src.api.ssrf import default_addrinfo as _addrinfo
from src.api.ssrf import host_port_scheme as _host_port_scheme
from src.api.ssrf import pinned_send as _ssrf_pinned_send
from src.api.ssrf import resolve_and_validate as _ssrf_resolve_and_validate
from src.api.ssrf import validate_url as _validate_url

router = APIRouter(prefix="/api/email", tags=["email"])

logger = logging.getLogger(__name__)

# ── 硬编码合理默认（不进 config.py —— 单本机 owner 功能，配置化无收益）────────────
_TIMEOUT_SEC = 10.0  # 跨所有 redirect 跳的**总**预算（含连接与 body 读）
_MAX_IMAGE_BYTES = 10 * 1024 * 1024  # 10 MiB 硬顶（流式边读边截）
_MAX_REDIRECTS = 3  # 手动逐跳，每跳重校验
# 出站 UA：不伪装成浏览器 —— 这条链路只取图片，不需要绕反爬，也不该假装是用户在浏览。
_UA = "MailAgent/1.0 (local email image proxy)"
# 一次 grant 最多签几条。🔴 超限**丢掉多余的、其余照签**，不是整批 422：计数口径是**每条
# URL**（srcset 每个候选 / CSS 每个 url() / picture 每个 source 各占一条），长图文新闻信很容易
# 越线，而整批失败的用户体感是「点了『加载图片』，一张票都没有 + 一句没线索的失败，而且永远
# 修不好」。与既有「脏 URL 静默不签、不整批失败」同一语义。前端按 grants 条数少于送上来的条数
# 提示「还有 N 张没能加载」。
_MAX_GRANT_URLS = 500
# 请求体条数硬顶：纯粹拦病态请求（正常邮件够不着 _MAX_GRANT_URLS，更够不着这个），
# 让 Pydantic 在解析阶段就挡住，而不是把无界的列表拖进签名循环。
_MAX_GRANT_REQUEST_URLS = 5000
# 签名有效期：够「点开一封信，来回切主题 / 重渲染几次」，又让 srcDoc 里的票据不长期有效。
_GRANT_TTL_SEC = 1800
# 同时在取的图片数上限（见模块 docstring 的可用性护栏）。
_MAX_INFLIGHT_FETCHES = 8

# 签名密钥：进程内随机，**不落盘、不下发、不进任何响应**。重启即换 = 旧票据全失效
# （代价只是重新点一次「加载图片」），也免掉了密钥轮换/持久化这一整摊事。
_SIGNING_KEY = secrets.token_bytes(32)

# 进行中的取图数。事件循环单线程 ⇒ 这个计数器的 +1/-1 之间没有 await，无需锁。
_inflight_fetches = 0


def _sign(url: str, exp: int) -> str:
    """URL + 过期时刻的 HMAC。分隔符用 ``\\n``：URL 里出现不了裸换行，拼接无歧义。"""
    payload = f"{exp}\n{url}".encode()
    return hmac.new(_SIGNING_KEY, payload, hashlib.sha256).hexdigest()


def _signature_ok(url: str, exp: object, sig: object) -> bool:
    """验签：缺参 / 非法 exp / 过期 / 不匹配一律 False（调用方回 403 空体，不分类）。"""
    if not isinstance(exp, int) or not isinstance(sig, str) or not sig:
        return False
    if exp < int(time.time()):
        return False
    return hmac.compare_digest(_sign(url, exp), sig)


# 回给 renderer 的响应头（⑨）。nosniff + CSP sandbox 是为 ``image/svg+xml``：SVG 在
# ``<img>`` 里本就不执行脚本，但本端点的 URL 也可能被直接打开（那时 SVG 会拿到 serve-api
# 的 origin）—— ``default-src 'none'; sandbox`` 把它钉进不透明 origin 且禁一切子资源。
_SAFE_RESPONSE_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
}


class _Reject(Exception):
    """内部拒斥信号：只携带**回给客户端的状态码** + 仅供日志的原因。

    刻意不复用 ``APIError``：全局 handler 会把 message 渲进 JSON envelope 回给调用方，
    而本端点必须回空体（上游错误原文 = 内网探测 oracle）。
    """

    def __init__(self, status: int, reason: str) -> None:
        super().__init__(reason)
        self.status = status
        self.reason = reason


def _reject_from(exc: APIError) -> _Reject:
    """``ssrf.py`` 抛的 APIError → 本端点的状态码（不带 message 回客户端）。"""
    if exc.code == "E_SSRF_BLOCKED":
        return _Reject(403, exc.message)
    if exc.code == "E_INVALID_ARG":
        return _Reject(400, exc.message)
    return _Reject(502, exc.message)  # E_UPSTREAM（DNS 失败等）


def _validated_url(raw: str) -> httpx.URL:
    """①③：scheme + userinfo + host 校验（首跳与每个 redirect 跳都走这里）。"""
    try:
        return _validate_url(raw)
    except APIError as exc:
        raise _reject_from(exc) from exc


def _validated_target_ip(host: str, port: int) -> str:
    """②：DNS 解析 + 逐 IP 校验，返回钉死连接用的 IP。

    透传模块级 ``_addrinfo`` / ``_check_ip``（monkeypatch 注入点：测试放行 loopback 打
    fake server 时，**非 loopback 仍走真 validator**）。
    """
    try:
        return _ssrf_resolve_and_validate(host, port, addrinfo=_addrinfo, check=_check_ip)
    except APIError as exc:
        raise _reject_from(exc) from exc


def _outbound_headers() -> dict[str, str]:
    """⑧：出站请求头**从零构造** —— 无 Cookie / Referer / Authorization / 本地 token。

    ``Accept-Encoding: identity`` 与 web fetch 同理：httpx 的 ``iter_bytes`` 产出的是解压后
    字节，压缩响应会让 ⑥ 的 cap 作用在解压后 → 解压炸弹可在触达 cap 前膨胀。
    """
    return {
        "User-Agent": _UA,
        "Accept": "image/*",
        "Accept-Encoding": "identity",
    }


def _fetch_remote_image(raw_url: str) -> tuple[bytes, str]:
    """同步执行取图（在 threadpool 跑）：逐跳手动 redirect + 每跳全套校验 + 钉 IP +
    content-type / size / time cap。返回 ``(bytes, media_type)``；失败 raise ``_Reject``。"""
    deadline = time.monotonic() + _TIMEOUT_SEC
    current = _validated_url(raw_url)

    # trust_env=False：不吃系统代理（代理会绕过钉 IP → ②④ 失效）、不读 netrc（⑧）。
    # follow_redirects=False：④ 的前提，redirect 由下面的循环手动逐跳重校验。
    with httpx.Client(trust_env=False, follow_redirects=False) as client:
        for hop in range(_MAX_REDIRECTS + 1):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise _Reject(504, "remote image fetch timed out")

            host, port, _scheme = _host_port_scheme(current)
            pinned_ip = _validated_target_ip(host, port)

            try:
                resp = _ssrf_pinned_send(
                    client, current, pinned_ip, _outbound_headers(), remaining, stream=True
                )
            except httpx.TimeoutException as e:
                raise _Reject(504, f"upstream timeout: {e}") from e
            except httpx.HTTPError as e:
                raise _Reject(502, f"upstream error: {e}") from e

            try:
                if resp.status_code in (301, 302, 303, 307, 308):
                    location = resp.headers.get("location")
                    if not location:
                        raise _Reject(502, f"redirect {resp.status_code} without Location")
                    if hop >= _MAX_REDIRECTS:
                        raise _Reject(502, f"too many redirects (>{_MAX_REDIRECTS})")
                    # 相对 Location 依**原 host 的 URL**（非 pinned IP）join 保语义正确；
                    # 下一轮循环重走 ①②③。
                    current = _validated_url(str(current.join(location)))
                    continue

                if resp.status_code != 200:
                    raise _Reject(502, f"upstream status {resp.status_code}")

                # ⑤ content-type 必须 image/*；缺失也拒（fail-closed）。
                media_type = resp.headers.get("content-type", "").split(";", 1)[0].strip().lower()
                if not media_type.startswith("image/"):
                    raise _Reject(415, f"non-image content-type: {media_type or '(missing)'}")

                # 解压炸弹 fail-closed：我们发了 identity，上游仍压缩 → cap 失去对真实传输
                # 字节的约束（见 _outbound_headers）。
                encoding = resp.headers.get("content-encoding", "").strip().lower()
                if encoding and encoding != "identity":
                    raise _Reject(502, f"unexpected content-encoding: {encoding}")

                # ⑥ Content-Length 预检（有则一字节都不读就拒）。
                declared = resp.headers.get("content-length")
                if declared is not None:
                    try:
                        oversize = int(declared) > _MAX_IMAGE_BYTES
                    except ValueError:
                        oversize = False
                    if oversize:
                        raise _Reject(413, f"declared size {declared} over cap")

                # ⑥ 流式边读边截：累计超过 cap 立即停读并拒 —— 半张图解不出来，回 413 比
                # 回一段截断字节更诚实（前端拿到 4xx 就是占位，不会画出破图）。
                chunks: list[bytes] = []
                total = 0
                for chunk in resp.iter_bytes():
                    # ⑦ httpx 的 timeout 是 per-operation，慢速逐 chunk 可无限占线程 →
                    # 总 deadline 也约束 body 读取。
                    if time.monotonic() > deadline:
                        raise _Reject(504, "remote image body read timed out")
                    total += len(chunk)
                    if total > _MAX_IMAGE_BYTES:
                        raise _Reject(413, f"body over cap ({_MAX_IMAGE_BYTES} bytes)")
                    chunks.append(chunk)
                return b"".join(chunks), media_type
            finally:
                resp.close()

    # 循环理应在 return / raise 中退出；到此说明 redirect 用尽（防御性）。
    raise _Reject(502, f"too many redirects (>{_MAX_REDIRECTS})")


@router.post("/remote-image/grant", dependencies=[Depends(verify_cf_access)])
async def grant_remote_images(
    request: Request,
    urls: list[str] = Body(..., embed=True, max_length=_MAX_GRANT_REQUEST_URLS),
) -> Response:
    """把「用户点了「加载图片」」这件事换成一批**正文伪造不出来**的放行票。

    只有走鉴权 fetch（renderer 自己的代码）才能调到这里 —— 正文 iframe 无 ``allow-scripts``，
    发不出 fetch。返回 ``{grants:[{url, exp, sig}]}``，前端据此拼 ``<img src>``。

    签不了的 URL（scheme 不对 / 带内嵌凭证）**静默不签**而不是整批失败：一封信里混进一条
    脏 URL 不该把其余图片一起废掉，前端查不到票就继续按占位处理（fail-closed）。
    超过 ``_MAX_GRANT_URLS`` 的部分同理 —— 丢掉多余的、其余照签。
    """
    exp = int(time.time()) + _GRANT_TTL_SEC
    grants: list[dict[str, object]] = []
    for raw in urls[:_MAX_GRANT_URLS]:
        if not raw or len(raw) > 4096:
            continue
        try:
            _validate_url(raw)  # ①③：scheme + 内嵌凭证（②④ 留给取图时逐跳做）
        except APIError:
            continue
        grants.append({"url": raw, "exp": exp, "sig": _sign(raw, exp)})
    return success_envelope({"grants": grants}, request=request)


@router.get("/remote-image", dependencies=[Depends(verify_cf_access)])
async def remote_image(
    url: str = Query(..., min_length=1, max_length=4096),
    exp: int | None = Query(None),
    sig: str | None = Query(None, max_length=128),
) -> Response:
    """代理一张邮件正文里的远程图片。成功 → 图片字节 + ``image/*``；失败 → 4xx/5xx 空体。

    🔴 先验签：``exp``/``sig`` 缺失、过期、或与 ``url`` 对不上 → 403 空体。邮件正文里硬编码
    的代理 URL 签不出来，所以哪怕它带着被 webRequest 注入的合法 token 打进来也取不到图。
    ``exp``/``sig`` 声明成可选再自己判，是为了让缺参也走「403 + 空体」这条统一出口
    （交给 FastAPI 校验会回 422 + JSON envelope，与本端点「失败恒空体」的契约不一致）。
    """
    global _inflight_fetches

    if not _signature_ok(url, exp, sig):
        logger.info("remote-image rejected (403): missing or invalid signature")
        return Response(status_code=403, headers=_SAFE_RESPONSE_HEADERS)

    if _inflight_fetches >= _MAX_INFLIGHT_FETCHES:
        logger.info("remote-image rejected (503): %d fetches in flight", _inflight_fetches)
        return Response(status_code=503, headers=_SAFE_RESPONSE_HEADERS)

    _inflight_fetches += 1
    try:
        payload, media_type = await run_in_threadpool(_fetch_remote_image, url)
    except _Reject as rej:
        logger.info("remote-image rejected (%d): %s", rej.status, rej.reason)
        return Response(status_code=rej.status, headers=_SAFE_RESPONSE_HEADERS)
    except Exception:  # noqa: BLE001 — 兜底：任何意外都回空体 502，绝不让全局 handler 把
        # 异常文本渲进 JSON envelope 回给调用方（内网探测 oracle）。
        logger.exception("remote-image unexpected failure")
        return Response(status_code=502, headers=_SAFE_RESPONSE_HEADERS)
    finally:
        _inflight_fetches -= 1
    return Response(content=payload, media_type=media_type, headers=_SAFE_RESPONSE_HEADERS)
