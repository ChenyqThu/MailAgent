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

``/web/search`` provider（R7）：配了 ``TAVILY_API_KEY``（get_settings，非 os.getenv；支持逗号
分隔多 key 额度轮换）→ 打**固定** api.tavily.com（国内可达）；空 → 回落**固定** DuckDuckGo HTML
端点（墙外/VPN 可用）。两者 host 均非用户控制 → 无 SSRF 面，只需超时 + size cap。DDG 解析 HTML
的 title/url/snippet 并解包 ``/l/?uddg=`` 重定向；Tavily 映射 JSON ``content`` → ``snippet``。

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

# canonical origin 唯一权威实现（ADR-004 rev3.1 D-fix-4）：redirect 逐跳检查必须与策略匹配侧
# （policy._match_web）经**同一函数**归一，禁止 httpx 侧字符串自比（tests/api 有同一性断言）。
from src.agent_config.policy import _normalize_origin
from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
from src.api.deps import get_settings
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
# ── Tavily search provider（R7）─────────────────────────────────────────────────
# agent web_search 的可选搜索后端：配了 TAVILY_API_KEY（经 get_settings，非 os.getenv）→ 走
# Tavily（国内可达）；空 → 回落 DDG。api.tavily.com 是固定可信 host（无 SSRF 面）。状态码语义
# 以官方 tavily-python SDK v0.7.26 为准（tavily/tavily.py:134-141）：
#   200=成功 · 429=UsageLimitExceeded(额度用尽) · 401=InvalidAPIKey(无效)
#   · 403/432/433=Forbidden(无权限) · 400=BadRequest(请求本身错，非 key 问题)。
_TAVILY_SEARCH_URL = "https://api.tavily.com/search"
_TAVILY_MAX_RESULTS = 20  # Tavily max_results 上限（docs：1–20）
_TAVILY_USAGE_EXHAUSTED = 429  # 该 key 额度用尽 → 轮换下一个 key
_TAVILY_KEY_REJECTED = frozenset({401, 403, 432, 433})  # key 无效/无权限 → 轮换


class WebFetchRequest(BaseModel):
    """POST /api/web/fetch 请求体（domainClient webFetch 的 wire）。

    ``agent_id`` + ``context_mode``（S6 W3, ADR-004 rev3.1 D-fix-1，additive）：gated headless
    agent fetch 由 gateway 附带（与 policyEvaluate 同源值）→ 启用 per-agent redirect origin
    白名单约束（见 :func:`_gated_allowed_origins`）。缺省 = 无约束（manual / open 档），wire
    与 S1 形状字节不变。
    """

    url: str = Field(min_length=1, max_length=4096)
    max_chars: int = Field(default=_DEFAULT_MAX_CHARS, ge=200, le=_MAX_MAX_CHARS)
    agent_id: Optional[str] = None
    context_mode: Optional[str] = None


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


def _gated_allowed_origins(body: WebFetchRequest) -> Optional[frozenset]:
    """gated 档的 redirect origin 聚合集（ADR-004 rev3.1 D-fix-1，P0）。

    集合定义 = **与 policyEvaluate 同候选集**：该 agent + 派生 context_mode 下 ``enabled=1`` 的
    capability='web' 规则（``candidate_policy_rules`` 双键严格等值，**禁止** raw
    ``list_policy_rules`` —— 会混入 disabled / 错 context_mode 行）origins 的 canonical 归一并集，
    再 ∪ **首跳 origin**：人批（审批卡）放行的 gated fetch 同样带约束参数 —— owner 批的是这个
    URL，其自身 origin 必须可达、但 redirect 出白名单域之外仍中止；免卡 fetch 的首跳本就 ∈
    候选集（policyEvaluate 刚命中），∪ 首跳不扩大任何免卡面。

    ``agent_id`` 缺省 → None（无约束：manual / open 档只有 SSRF 地板）；带 ``agent_id`` 但
    ``context_mode`` 非法 → 400（调用方 bug 早暴露，不静默降级成无约束）。
    """
    if body.agent_id is None:
        return None
    from src.agent_config.policy import CONTEXT_MODES, parse_matcher
    from src.agent_config.store import get_agent_config_store

    if body.context_mode not in CONTEXT_MODES:
        raise APIError(
            "E_INVALID_ARG",
            f"context_mode must be one of {list(CONTEXT_MODES)} when agent_id is set",
            http_status=400,
            source="web",
        )
    origins: set = set()
    for rule in get_agent_config_store().candidate_policy_rules(
        "web", body.context_mode, agent_id=body.agent_id
    ):
        try:
            matcher = parse_matcher("web", rule.matcher)
        except Exception:  # noqa: BLE001 — 坏规则跳过（与 evaluate 同语义），绝不因此放宽
            continue
        norm = _normalize_origin(matcher.origin)
        if norm:
            origins.add(norm)
    init = _normalize_origin(body.url)
    if init:
        origins.add(init)
    return frozenset(origins)


def _do_fetch(
    input_url: str, max_chars: int, allowed_origins: Optional[frozenset] = None
) -> dict[str, Any]:
    """同步执行 web_fetch（在 threadpool 跑）：逐跳手动 redirect + 每跳 SSRF 校验 + 钉 IP +
    size/time/content-type cap + 正文抽取。``allowed_origins``（gated 档）非 None 时每跳 origin
    经 canonical 归一后必须 ∈ 集，越界中止（结构化错误，SSRF 地板不弱化、叠加生效）。"""
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

            # gated 档逐跳 origin 白名单（D-fix-1）：在 DNS/SSRF 之前判，越界即中止 —— 命中集内
            # 仍逐 IP 过全套 SSRF 校验（两层叠加，谁都不豁免谁）。
            if allowed_origins is not None:
                hop_origin = _normalize_origin(str(current))
                if hop_origin is None or hop_origin not in allowed_origins:
                    raise APIError(
                        "E_WEB_ORIGIN_FORBIDDEN",
                        f"origin {hop_origin or str(current)!r} is outside this agent's "
                        "web origin whitelist (redirect constraint)",
                        http_status=403,
                        source="web",
                    )

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


def _ddg_search(query: str, limit: int) -> dict[str, Any]:
    """DuckDuckGo 回落搜索（在 threadpool 跑）：打固定 DDG HTML 端点 + 解析 top-N。DDG host
    非用户控制 → 无 SSRF 面，只需超时 + follow_redirects（DDG 自身可能跳）+ size cap（流式
    bounded 读，不全量 buffer；超顶截断后仍交给解析——结果页前部结构完整即可用）。异常/非
    200 → 明确错误码，非静默空。无 Tavily key 时的默认路径（行为字节级同 S1）。"""
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


def _map_tavily_results(query: str, limit: int, resp: httpx.Response) -> dict[str, Any]:
    """映射 Tavily 200 响应 → 现有 ``{query,count,results:[{url,title,snippet}]}`` shape
    （Tavily ``content`` → 我们的 ``snippet``）。防御性跳过缺 url 的条目，截 limit。"""
    try:
        payload = resp.json()
    except ValueError as e:
        raise APIError(
            "E_UPSTREAM", f"Tavily 响应非合法 JSON: {e}", http_status=502, source="web"
        ) from e
    raw = payload.get("results") if isinstance(payload, dict) else None
    results: list[dict[str, str]] = []
    for item in raw or []:
        if not isinstance(item, dict):
            continue
        url = item.get("url")
        if not isinstance(url, str) or not url:
            continue
        title = item.get("title")
        content = item.get("content")
        results.append(
            {
                "title": title if isinstance(title, str) else "",
                "url": url,
                "snippet": content if isinstance(content, str) else "",
            }
        )
        if len(results) >= limit:
            break
    return {"query": query, "count": len(results), "results": results}


def _tavily_search(query: str, limit: int, keys: list[str]) -> dict[str, Any]:
    """经 Tavily 执行 web_search（在 threadpool 跑），支持逗号分隔多 key 额度轮换（R7）。

    按顺序遍历 ``keys``：某 key 200 → 立即映射返回；429 额度用尽 / 401·403·432·433 无效或
    无权限 → 自动切下一个 key；400 或其他非 2xx（非 key 相关）/ 网络失败 → 立即报清晰错误。
    全部 key 失败 → 清晰错误（区分「全部额度已用尽」vs「含无效/无权限 key」），**绝不静默
    回落 DDG**（PRD R5/R7）。轮换在同一次请求内完成，对模型透明（只看到最终结果或最终错误）。

    固定可信 host api.tavily.com → 无 SSRF 面，只需 Bearer 认证 + 超时。状态码语义以官方
    tavily-python SDK v0.7.26 为准（``tavily/tavily.py:134-141``）。"""
    max_results = max(1, min(limit, _TAVILY_MAX_RESULTS))
    exhausted = 0  # 命中 429（额度用尽）的 key 数
    rejected = 0  # 命中 401/403/432/433（无效/无权限）的 key 数
    with httpx.Client(trust_env=False, timeout=_SEARCH_TIMEOUT_SEC) as client:
        for key in keys:
            try:
                resp = client.post(
                    _TAVILY_SEARCH_URL,
                    headers={
                        "Authorization": f"Bearer {key}",
                        "Content-Type": "application/json",
                    },
                    json={"query": query, "max_results": max_results},
                )
            except httpx.TimeoutException as e:
                # 网络超时非 key 相关（同一 host，轮换无益）→ 立即清晰错误。
                raise APIError(
                    "E_UPSTREAM", f"Tavily 搜索超时: {e}", http_status=504, source="web"
                ) from e
            except httpx.HTTPError as e:
                raise APIError(
                    "E_UPSTREAM",
                    f"Tavily 搜索连接失败（请检查网络）: {e}",
                    http_status=502,
                    source="web",
                ) from e

            if resp.status_code == 200:
                return _map_tavily_results(query, limit, resp)
            if resp.status_code == _TAVILY_USAGE_EXHAUSTED:
                exhausted += 1
                continue  # 该 key 额度用尽 → 切下一个
            if resp.status_code in _TAVILY_KEY_REJECTED:
                rejected += 1
                continue  # 该 key 无效/无权限 → 切下一个
            # 400（请求本身错）或其他非 2xx（5xx 等）非 key 相关 → 立即清晰错误，轮换无益。
            raise APIError(
                "E_UPSTREAM",
                f"Tavily 搜索上游返回 {resp.status_code}",
                http_status=502,
                source="web",
            )

    # 所有 key 都试过、无一成功 → 按失败原因给清晰错误（区分额度用尽 vs 无效/无权限）。
    if rejected == 0:
        detail = "所有 Tavily key 额度已用尽（HTTP 429），请补充额度或在 Settings 更换 key"
    elif exhausted == 0:
        detail = (
            "Tavily key 无效或无权限（HTTP 401/403），"
            "请在 Settings → 集成 → Web 搜索 检查 Tavily key"
        )
    else:
        detail = (
            "所有 Tavily key 均不可用（含额度已用尽与无效/无权限 key），"
            "请在 Settings → 集成 → Web 搜索 检查"
        )
    raise APIError("E_UPSTREAM", detail, http_status=502, source="web")


def _do_search(query: str, limit: int) -> dict[str, Any]:
    """web_search 分发器（在 threadpool 跑）。provider 选择（PRD R2 机制 A）：
    ``get_settings().tavily_api_key`` 配了（逗号分隔多 key，去空）→ 走 Tavily（国内可达，
    R7 额度轮换）；空 → 回落 DuckDuckGo（向后兼容，墙外/VPN 可用，行为字节级不变）。

    key 经 ``get_settings()`` 读（**绝不 os.getenv** —— serve-api 不 load_dotenv，os.getenv
    读不到 .env-only 值；Config(BaseSettings) 经 env_file 读是文档化 robust 路径，见
    settings.py §.env merged read）。"""
    raw_key = get_settings().tavily_api_key or ""
    keys = [k.strip() for k in raw_key.split(",") if k.strip()]
    if keys:
        return _tavily_search(query, limit, keys)
    return _ddg_search(query, limit)


# ── endpoints ──────────────────────────────────────────────────────────────────


@router.post("/fetch", dependencies=[Depends(verify_cf_access)])
async def web_fetch(request: Request, body: WebFetchRequest):
    """抓取一个 http/https URL 的正文（SSRF 防护 + 钉 IP + 逐跳 redirect + size/time/content-type
    cap + HTML→markdown 抽取）。执行在 threadpool（httpx 同步 + 阻塞 DNS）。返回 raw 文本，围栏
    由 gateway TS 工具做。gated headless agent 调用（带 agent_id/context_mode）另加 per-agent
    redirect origin 白名单约束（ADR-004 rev3.1 D-fix-1）。"""
    allowed_origins = _gated_allowed_origins(body)
    result = await run_in_threadpool(_do_fetch, body.url, body.max_chars, allowed_origins)
    return success_envelope(result, request=request, source="web")


@router.post("/search", dependencies=[Depends(verify_cf_access)])
async def web_search(request: Request, body: WebSearchRequest):
    """web 搜索 top-N（title/url/snippet）。provider = Tavily（配了 TAVILY_API_KEY，逗号分隔多
    key 额度轮换）或 DuckDuckGo HTML（回落）。best-effort（DDG 无官方 API，限流/结构变动 → 明确
    错误码而非静默空；Tavily 失败报清晰错误，不静默回落 DDG）。执行在 threadpool。"""
    result = await run_in_threadpool(_do_search, body.query, body.limit)
    return success_envelope(
        result, request=request, source="web", meta_extra={"best_effort": True}
    )
