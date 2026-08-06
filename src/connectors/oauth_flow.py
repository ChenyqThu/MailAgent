"""OAuth 回调 rendezvous + 每 connector 的在途授权流状态（全 in-process，serve-api 单进程）。

**威胁模型**（照 ``routers/island.py:77`` 能力令牌形状，本仓第二个无 CF 门路由的依据）：
回调端点 ``GET /api/connector/oauth/callback`` 不能挂 verify_cf_access（浏览器 302 顶层跳转
带不了自定义 header，必 401）。鉴权 = ``state`` 参数本身：

  - **不可猜**：state 由 MCP SDK ``secrets.token_urlsafe(32)`` 生成（我们从授权 URL 里抽出来
    登记，不自造第二个随机源）；
  - **单次消费**：deliver 命中即标记 consumed，重放同一 state → 404；
  - **短 TTL**：默认 600s（用户在浏览器里授权要留足时间，但一个挂了一夜的 state 不该还能进）；
  - **404 不泄因**：未知 / 过期 / 已消费在响应上不可区分（对齐 auth.py codex Fix 5 教训）。

SDK 侧还有第二道：``_perform_authorization_code_grant`` 用 ``secrets.compare_digest`` 复核
callback 送回的 state === 它自己生成的那个，对不上直接 OAuthFlowError —— 本表只是把
「浏览器回调」翻译成「唤醒等在 callback_handler 上的那个授权协程」。
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Dict, Optional

from mcp.shared.auth import AuthorizationCodeResult

#: state 条目寿命（秒）—— 覆盖「打开浏览器 → 登录 → 点同意」的正常时长，杜绝隔夜重放。
RENDEZVOUS_TTL_SECONDS = 600.0


class OAuthCallbackDenied(Exception):
    """授权服务器经回调返回 error（用户拒绝 / access_denied 等）。"""

    def __init__(self, error: str) -> None:
        super().__init__(f"authorization was not granted: {error}")
        self.error = error


@dataclass
class _RendezvousEntry:
    created_at: float
    event: asyncio.Event = field(default_factory=asyncio.Event)
    result: Optional[AuthorizationCodeResult] = None
    error: Optional[str] = None
    consumed: bool = False


class OAuthRendezvous:
    """state → 授权码交汇表（register 由授权协程做，deliver 由回调端点做，单次消费 + TTL）。"""

    def __init__(self, *, ttl_seconds: float = RENDEZVOUS_TTL_SECONDS, now=time.monotonic) -> None:
        self._ttl = ttl_seconds
        self._now = now
        self._entries: Dict[str, _RendezvousEntry] = {}

    def _prune(self) -> None:
        cutoff = self._now() - self._ttl
        for state in [s for s, e in self._entries.items() if e.created_at < cutoff]:
            del self._entries[state]

    def register(self, state: str) -> None:
        """授权协程在拿到授权 URL（含 state）后登记；同 state 重复登记 = 覆盖重来。"""
        self._prune()
        self._entries[state] = _RendezvousEntry(created_at=self._now())

    def deliver(
        self,
        state: str,
        *,
        code: Optional[str] = None,
        iss: Optional[str] = None,
        error: Optional[str] = None,
    ) -> bool:
        """回调端点投递。命中未消费的活 state → True；未知/过期/已消费 → False（端点 404）。"""
        self._prune()
        entry = self._entries.get(state)
        if entry is None or entry.consumed:
            return False
        entry.consumed = True
        if error:
            entry.error = error
        else:
            entry.result = AuthorizationCodeResult(code=code or "", state=state, iss=iss)
        entry.event.set()
        return True

    async def wait(self, state: str, *, timeout: float) -> AuthorizationCodeResult:
        """授权协程阻塞等投递（SDK ``callback_handler`` 的实现体）。

        超时 → ``asyncio.TimeoutError``（caller 转 E_CONNECTOR_TIMEOUT）；error 投递 →
        ``OAuthCallbackDenied``。无论结局如何条目都被丢弃（等待方就是唯一消费者）。
        """
        entry = self._entries.get(state)
        if entry is None:
            raise RuntimeError(f"oauth state not registered before wait: {state!r}")
        try:
            await asyncio.wait_for(entry.event.wait(), timeout)
        finally:
            self._entries.pop(state, None)
        if entry.error is not None:
            raise OAuthCallbackDenied(entry.error)
        assert entry.result is not None
        return entry.result

    def discard(self, state: Optional[str]) -> None:
        if state:
            self._entries.pop(state, None)


# 生产单例（serve-api 单进程 asyncio —— in-process 表即全局真源，排雷报告 §四）。
oauth_rendezvous = OAuthRendezvous()


# ---------------------------------------------------------------------------
# 每 connector 的在途授权流（start 端点 ↔ 后台授权协程 ↔ status 端点的交接面）
# ---------------------------------------------------------------------------


@dataclass
class ConnectorFlowState:
    """一次 ``POST /oauth/start`` 发起的授权流的可观测状态（in-process，单 owner）。"""

    connector_id: str
    started_at: float
    #: 授权 URL 就绪信号：redirect_handler 填 ``auth_url`` 后 set；失败路径也 set（携 error），
    #: 让 start 端点的等待恒有下文。
    auth_url_ready: asyncio.Event = field(default_factory=asyncio.Event)
    auth_url: Optional[str] = None
    #: pending → authorizing（URL 已给出，等浏览器回调）→ connected / error 终态。
    status: str = "pending"
    error: Optional[str] = None
    tool_count: Optional[int] = None
    #: SDK 生成的 state（清理 rendezvous 用）。`custom_mcp` 轨才有。
    state_param: Optional[str] = None
    #: 08-05 WP-12（composio 轨）：本流已经产出过几条授权 URL。
    #: 🔴 存在的理由 = **多 toolkit 的 connector**（Atlassian = JIRA + CONFLUENCE）要**顺序**
    #: 授权两次：流把第 1 条 URL 交出去、等它连上，再把第 2 条填进 `auth_url` 并把这个序号
    #: +1。前端轮询 status 时比对序号，涨了就再开一次浏览器 —— 不这样的话第二条链接谁也
    #: 不会去打开（同时弹两个授权页则是更糟的 UX）。`custom_mcp` 轨**从不递增**（恒 0）：
    #: 那条流只产一条 URL，且由 start 端点的响应直接交给前端。
    link_seq: int = 0
    #: 当前在等哪个 toolkit 授权（composio 轨的可观测位）。
    pending_toolkit: Optional[str] = None
    #: 承载整个授权流的后台 task（🔴 anyio cancel scope 纪律：连接的整个生命周期都在这
    #: 一个 task 里；替换流 = cancel 整个 task，绝不跨 task 收尾）。
    task: Optional[asyncio.Task] = None


_ACTIVE_FLOWS: Dict[str, ConnectorFlowState] = {}


def begin_flow(connector_id: str) -> ConnectorFlowState:
    """开新流；同 connector 已有在途流 → 取消其 task + 丢弃其 rendezvous 条目（owner 重点
    「连接」应当重来，而不是撞上一个挂着等回调的旧流）。"""
    old = _ACTIVE_FLOWS.get(connector_id)
    if old is not None:
        oauth_rendezvous.discard(old.state_param)
        if old.task is not None and not old.task.done():
            old.task.cancel()
    flow = ConnectorFlowState(connector_id=connector_id, started_at=time.time())
    _ACTIVE_FLOWS[connector_id] = flow
    return flow


def get_flow(connector_id: str) -> Optional[ConnectorFlowState]:
    return _ACTIVE_FLOWS.get(connector_id)


def clear_flow(connector_id: str, flow: ConnectorFlowState) -> None:
    """按身份清除（后来者已替换时不动新流）。终态流留在表里供 status 查询，故只在
    显式断开/测试清理时调用。"""
    if _ACTIVE_FLOWS.get(connector_id) is flow:
        del _ACTIVE_FLOWS[connector_id]
