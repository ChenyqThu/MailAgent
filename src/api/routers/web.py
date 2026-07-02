"""web 联网工具执行端点 — /api/web/* (S1 R3, agent openness wave1).

TS 薄壳（``frontend/src/ai-gateway/tools/web.ts``）→ 本 Python 端点执行（业务权威在 Python +
远程 parity 免费）。两工具 ``web_fetch`` / ``web_search``，在 gateway 侧均 edit-tier **恒人审**；
本层只负责真实出网 + SSRF 防护 + 内容抽取，**不做审批**（审批权在 gateway ApprovalGuard），
也**不做**围栏（返回 raw，围栏统一在 TS 工具层 ``fenceUntrusted('WEB_CONTENT')`` 做）。

🔴 SSRF 防护（本 wave 安全重心）—— ``/web/fetch`` 的 url 完全由模型/用户控制：
  - scheme 仅 http/https；拒 userinfo（``user:pass@host`` = 凭据经 URL 泄漏面）
  - DNS 解析后**逐 IP 校验**（``socket.getaddrinfo`` 全部结果，v4+v6，含 v4-mapped v6 /
    6to4 / teredo 内嵌 v4）：拒 loopback/private/link-local/reserved/multicast/unspecified
  - **连接钉死已校验 IP**（防 DNS rebinding TOCTOU）：把 URL host 改写成已校验的 IP 字面量
    → httpcore 不再二次解析（``connect_tcp`` 连 origin.host 字面量）；``Host`` header 保原
    host（vhost）+ ``sni_hostname`` request extension 保原 host → TLS SNI + 证书按**原 host**
    校验（见 httpcore ``_sync/connection.py:107,151``，server_hostname=sni_hostname）。故 HTTP
    与 HTTPS 都成立：连接落到我们校验过的那个 IP，证书仍按主机名验，rebinding 窗口关闭。
  - redirect 不自动跟（``follow_redirects=False``）手动循环 ≤5 跳，**每跳重走全套校验**
  - size cap（流式边读边截 ~2 MiB）+ 总超时 ~15s + content-type 白名单（text/html/json/xml/plain）

``/web/search`` 打**固定** DuckDuckGo HTML 端点（host 非用户控制 → 无 SSRF 面），只需超时 +
size cap；解析 DDG HTML 的 title/url/snippet，DDG 的 ``/l/?uddg=`` 重定向包装解包成真实 URL。

鉴权与 domainClient 消费的既有端点一致（``verify_cf_access``：本地 token 腿 / CF JWT 腿）。
无新增 pip 依赖（httpx / BeautifulSoup / markdownify 均已在 requirements）。
"""

from __future__ import annotations

import logging
import time
import urllib.parse
from typing import Any, Optional

import httpx
from bs4 import BeautifulSoup
from fastapi import APIRouter, Depends, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
from src.api.ssrf import check_ip as _check_ip
from src.api.ssrf import default_addrinfo as _addrinfo
from src.api.ssrf import host_port_scheme as _host_port_scheme
from src.api.ssrf import pinned_send as _ssrf_pinned_send
from src.api.ssrf import resolve_and_validate as _ssrf_resolve_and_validate
from src.api.ssrf import validate_url as _validate_url

router = APIRouter(prefix="/api/web", tags=["web"])

logger = logging.getLogger(__name__)

# ── fetch 硬编码合理默认（不进 config.py —— 单本机 owner 工具，过度配置化无收益；
#    调参走这里的常量即可，二选一见 PRD R3「超时/cap 硬编码合理默认亦可」）──────────────
_FETCH_TIMEOUT_SEC = 15.0  # 跨所有 redirect 跳的**总**预算
_MAX_RESPONSE_BYTES = 2 * 1024 * 1024  # 2 MiB 硬顶（流式边读边截）
_MAX_REDIRECTS = 5  # 手动逐跳，每跳重校验
_DEFAULT_MAX_CHARS = 50_000  # 抽取正文默认截断
_MAX_MAX_CHARS = 200_000  # clamp 调用方给的 max_chars 上限
# content-type 白名单（media type，小写，不含 charset 参数）。
_ALLOWED_CONTENT_TYPES = frozenset(
    {
        "text/html",
        "application/xhtml+xml",
        "text/plain",
        "application/json",
        "application/xml",
        "text/xml",
    }
)
# ── search 常量 ────────────────────────────────────────────────────────────────
_SEARCH_TIMEOUT_SEC = 12.0
_SEARCH_MAX_RESULTS = 10
_DDG_HTML_URL = "https://html.duckduckgo.com/html/"
# 面向浏览器的 UA —— DDG html 端点对明显 bot UA 可能返回挑战页；真实出网用它，测试全 mock。
_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)


class WebFetchRequest(BaseModel):
    """POST /api/web/fetch 请求体（domainClient webFetch 的 wire）。"""

    url: str = Field(min_length=1, max_length=4096)
    max_chars: int = Field(default=_DEFAULT_MAX_CHARS, ge=200, le=_MAX_MAX_CHARS)


class WebSearchRequest(BaseModel):
    """POST /api/web/search 请求体（domainClient webSearch 的 wire）。"""

    query: str = Field(min_length=1, max_length=500)
    limit: int = Field(default=5, ge=1, le=_SEARCH_MAX_RESULTS)


# ── SSRF 校验（实现在 src/api/ssrf.py，本模块保留可 monkeypatch 的薄壳）──────────────────
# 四件套自 web.py 抽到 ssrf.py（S2 W2，skill pack 下载器复用同一防护）。``_check_ip`` / ``_addrinfo``
# / ``_validate_url`` / ``_host_port_scheme`` 直接 import-as 成模块级名字，使 tests/api/test_web.py
# 对它们的直接调用与 monkeypatch 在实现搬家后仍原样生效（校验语义未动，只是实现搬家）。


def _resolve_and_validate(host: str, port: int) -> str:
    """薄壳：透传模块级 ``_addrinfo`` / ``_check_ip``（monkeypatch 友好，测试放行 loopback /
    假 DNS 仍生效），实现在 ``ssrf.resolve_and_validate``。"""
    return _ssrf_resolve_and_validate(host, port, addrinfo=_addrinfo, check=_check_ip)


# ── fetch 执行 ─────────────────────────────────────────────────────────────────


def _pinned_send(
    client: httpx.Client, url: httpx.URL, pinned_ip: str, remaining: float
) -> httpx.Response:
    """薄壳：构造 fetch 专用 headers（含 ``Accept-Encoding: identity`` 防解压炸弹），委托
    ``ssrf.pinned_send`` 做钉 IP + Host/SNI 保原主机名。stream=True 供上层边读边截。"""
    headers = {
        "User-Agent": _UA,
        "Accept": "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5",
        "Accept-Language": "en,zh;q=0.8",
        # identity：httpx 的 iter_bytes 按响应 Content-Encoding **解压后**产出字节，压缩响应会让
        # 2 MiB cap 作用在解压后 → gzip 炸弹可在触达 cap 前膨胀。要求不压缩；上游若无视强行
        # 压缩，_do_fetch 读 body 前还有 content-encoding fail-closed 检查兜底。
        "Accept-Encoding": "identity",
    }
    return _ssrf_pinned_send(client, url, pinned_ip, headers, remaining, stream=True)


def _extract(media_type: str, raw: bytes, encoding: Optional[str], max_chars: int) -> tuple[str, Optional[str]]:
    """把响应字节按 content-type 抽成文本（HTML → markdown 正文 + title；其余原样），截 max_chars。
    返回 (text, title)。"""
    text = raw.decode(encoding or "utf-8", errors="replace")
    title: Optional[str] = None
    if media_type in ("text/html", "application/xhtml+xml"):
        soup = BeautifulSoup(text, "html.parser")
        for tag in soup(["script", "style", "noscript", "template", "svg"]):
            tag.decompose()
        if soup.title and soup.title.string:
            title = soup.title.string.strip()
        # 懒 import：html_to_markdown 顶部无重依赖，但对齐 router lazy-import 纪律
        # （裸 worktree import self-check 不触发 converter 链）。
        from src.converter.html_to_markdown import html_to_markdown

        body_md = html_to_markdown(str(soup), strip_images=True)
        text = body_md
    if len(text) > max_chars:
        text = text[:max_chars]
    return text, title


def _do_fetch(input_url: str, max_chars: int) -> dict[str, Any]:
    """同步执行 web_fetch（在 threadpool 跑）：逐跳手动 redirect + 每跳 SSRF 校验 + 钉 IP +
    size/time/content-type cap + 正文抽取。"""
    deadline = time.monotonic() + _FETCH_TIMEOUT_SEC
    current = _validate_url(input_url)
    truncated = False

    # trust_env=False：不吃系统代理（memory 记录的 httpx trust_env 系统代理劫持坑），
    # 且代理会绕过我们的钉 IP → SSRF 兜底也失效。verify=True（默认）保 TLS 证书校验。
    with httpx.Client(trust_env=False, follow_redirects=False) as client:
        for hop in range(_MAX_REDIRECTS + 1):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise APIError("E_UPSTREAM", "fetch timed out", http_status=504, source="web")

            host, port, _scheme = _host_port_scheme(current)
            pinned_ip = _resolve_and_validate(host, port)

            try:
                resp = _pinned_send(client, current, pinned_ip, remaining)
            except httpx.TimeoutException as e:
                raise APIError("E_UPSTREAM", f"fetch timed out: {e}", http_status=504, source="web") from e
            except httpx.HTTPError as e:
                raise APIError(
                    "E_UPSTREAM", f"fetch failed: {e}", http_status=502, source="web"
                ) from e

            try:
                # redirect：不自动跟，手动解析 Location → 下一跳重校验。
                if resp.status_code in (301, 302, 303, 307, 308):
                    location = resp.headers.get("location")
                    if not location:
                        raise APIError(
                            "E_UPSTREAM",
                            f"redirect {resp.status_code} without Location",
                            http_status=502,
                            source="web",
                        )
                    if hop >= _MAX_REDIRECTS:
                        raise APIError(
                            "E_UPSTREAM",
                            f"too many redirects (>{_MAX_REDIRECTS})",
                            http_status=502,
                            source="web",
                        )
                    # 相对 Location 依当前 URL join；下一轮循环重走 _validate_url 语义（scheme/
                    # userinfo）+ SSRF 校验。用原 host 的 URL join（非 pinned IP）保语义正确。
                    current = _validate_url(str(current.join(location)))
                    continue

                # content-type 白名单（media type，去 charset）。缺 Content-Type 也拒
                # （fail-closed：无标注的响应无法判断可解析性，不放行）。
                raw_ct = resp.headers.get("content-type", "")
                media_type = raw_ct.split(";", 1)[0].strip().lower()
                if not media_type or media_type not in _ALLOWED_CONTENT_TYPES:
                    raise APIError(
                        "E_CONTENT_TYPE",
                        f"unsupported content-type: {media_type or '(missing)'}",
                        http_status=415,
                        source="web",
                    )

                # 解压炸弹 fail-closed：我们发 Accept-Encoding: identity，上游若仍返回压缩编码，
                # iter_bytes 会产出**解压后**字节（cap 失去对真实传输字节的约束）→ 直接拒。
                content_encoding = resp.headers.get("content-encoding", "").strip().lower()
                if content_encoding and content_encoding != "identity":
                    raise APIError(
                        "E_UPSTREAM",
                        f"unexpected content-encoding: {content_encoding}",
                        http_status=502,
                        source="web",
                    )

                # Content-Length 预检（有则据此标 truncated；无则靠流式 cap 兜底）。
                cl = resp.headers.get("content-length")
                if cl is not None:
                    try:
                        if int(cl) > _MAX_RESPONSE_BYTES:
                            truncated = True
                    except ValueError:
                        pass

                # 流式边读边截（硬顶 2 MiB）——不 resp.read() 全量进内存。
                chunks: list[bytes] = []
                total = 0
                for chunk in resp.iter_bytes():
                    # 总 deadline 也约束 body 读取：httpx timeout 是 per-operation，慢速逐
                    # chunk（每块都在 timeout 内到）否则可无限占线程。超时失败，不静默截断。
                    if time.monotonic() > deadline:
                        raise APIError(
                            "E_UPSTREAM",
                            "fetch body read timed out",
                            http_status=504,
                            source="web",
                        )
                    if total + len(chunk) > _MAX_RESPONSE_BYTES:
                        chunks.append(chunk[: _MAX_RESPONSE_BYTES - total])
                        truncated = True
                        break
                    chunks.append(chunk)
                    total += len(chunk)
                raw = b"".join(chunks)
            finally:
                resp.close()

            text, title = _extract(media_type, raw, resp.encoding, max_chars)
            if len(text) >= max_chars:
                truncated = True
            return {
                "url": input_url,
                "final_url": str(current),
                "status": resp.status_code,
                "content_type": media_type or None,
                "title": title,
                "text": text,
                "truncated": truncated,
            }

    # 循环理应在 return / raise 中退出；到此说明 redirect 用尽（防御性）。
    raise APIError(
        "E_UPSTREAM", f"too many redirects (>{_MAX_REDIRECTS})", http_status=502, source="web"
    )


# ── search 执行 ────────────────────────────────────────────────────────────────


def _unwrap_uddg(href: str) -> str:
    """DDG 结果链接是 ``//duckduckgo.com/l/?uddg=<enc-real-url>&rut=...`` 重定向包装 —— 解包
    出真实 URL；非包装链接原样返回。"""
    if "uddg=" not in href:
        return href
    try:
        parsed = urllib.parse.urlparse(href)
        qs = urllib.parse.parse_qs(parsed.query)
        uddg = qs.get("uddg")
        if uddg and uddg[0]:
            return uddg[0]
    except ValueError:
        pass
    return href


def _parse_ddg(html: str, limit: int) -> list[dict[str, str]]:
    """解析 DDG HTML 结果页 → [{title, url, snippet}] top-N。结构稳定锚点：``a.result__a``
    （标题+链接）+ ``.result__snippet``（摘要），链接经 _unwrap_uddg 解包。"""
    soup = BeautifulSoup(html, "html.parser")
    results: list[dict[str, str]] = []
    for res in soup.select("div.result"):
        a = res.select_one("a.result__a")
        if a is None:
            continue
        href = a.get("href", "")
        if not href:
            continue
        real_url = _unwrap_uddg(href)
        title = a.get_text(" ", strip=True)
        snippet_el = res.select_one(".result__snippet")
        snippet = snippet_el.get_text(" ", strip=True) if snippet_el else ""
        results.append({"title": title, "url": real_url, "snippet": snippet})
        if len(results) >= limit:
            break
    return results


def _do_search(query: str, limit: int) -> dict[str, Any]:
    """同步执行 web_search（在 threadpool 跑）：打固定 DDG HTML 端点 + 解析 top-N。DDG host
    非用户控制 → 无 SSRF 面，只需超时 + follow_redirects（DDG 自身可能跳）+ size cap（流式
    bounded 读，不全量 buffer；超顶截断后仍交给解析——结果页前部结构完整即可用）。异常/非
    200 → 明确错误码，非静默空。"""
    try:
        with httpx.Client(
            trust_env=False, follow_redirects=True, timeout=_SEARCH_TIMEOUT_SEC
        ) as client:
            with client.stream(
                "GET",
                _DDG_HTML_URL,
                params={"q": query},
                headers={"User-Agent": _UA, "Accept": "text/html"},
            ) as resp:
                if resp.status_code != 200:
                    raise APIError(
                        "E_UPSTREAM",
                        f"search upstream returned {resp.status_code}",
                        http_status=502,
                        source="web",
                    )
                chunks: list[bytes] = []
                total = 0
                for chunk in resp.iter_bytes():
                    if total + len(chunk) > _MAX_RESPONSE_BYTES:
                        chunks.append(chunk[: _MAX_RESPONSE_BYTES - total])
                        break
                    chunks.append(chunk)
                    total += len(chunk)
                raw = b"".join(chunks)
                encoding = resp.encoding
    except httpx.HTTPError as e:
        raise APIError("E_UPSTREAM", f"search request failed: {e}", http_status=502, source="web") from e

    results = _parse_ddg(raw.decode(encoding or "utf-8", errors="replace"), limit)
    return {"query": query, "count": len(results), "results": results}


# ── endpoints ──────────────────────────────────────────────────────────────────


@router.post("/fetch", dependencies=[Depends(verify_cf_access)])
async def web_fetch(request: Request, body: WebFetchRequest):
    """抓取一个 http/https URL 的正文（SSRF 防护 + 钉 IP + 逐跳 redirect + size/time/content-type
    cap + HTML→markdown 抽取）。执行在 threadpool（httpx 同步 + 阻塞 DNS）。返回 raw 文本，围栏
    由 gateway TS 工具做。"""
    result = await run_in_threadpool(_do_fetch, body.url, body.max_chars)
    return success_envelope(result, request=request, source="web")


@router.post("/search", dependencies=[Depends(verify_cf_access)])
async def web_search(request: Request, body: WebSearchRequest):
    """DuckDuckGo HTML 搜索 top-N（title/url/snippet，uddg 解包）。best-effort（DDG 无官方 API，
    限流/结构变动 → 明确错误码而非静默空）。执行在 threadpool。"""
    result = await run_in_threadpool(_do_search, body.query, body.limit)
    return success_envelope(
        result, request=request, source="web", meta_extra={"best_effort": True}
    )
