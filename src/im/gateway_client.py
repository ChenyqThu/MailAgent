"""AI SDK Gateway 的 loopback HTTP 客户端（08-01 阶段 2 PR-3）。

飞书桥（Python，``serve`` 进程）→ ``http://127.0.0.1:<port>``（Electron main 内嵌
gateway）。**直连 loopback、不经 serve-api 反代**（dossier Q4：反代是给远程浏览器
造的，多一跳还要自造鉴权头；``AgentRunWorker`` 已在走同款直连）。

四个面（全部**不抛**，返回 typed dataclass —— 调用侧把每种失败翻成人话）：
  - ``stream_im_chat``  POST ``/api/ai/im-chat``（SSE drain + 提取最终文本/暂停证据）
  - ``approval_pending`` GET ``/api/ai/approval/pending?sessionId=N``
  - ``decide``           POST ``/api/ai/approval/decide {approvalId, decision}``
  - ``stop_run``         POST ``/api/ai/run/stop {sessionId}``

## SSE wire（实证，见 ``frontend/tests/ai-gateway/im_chat_endpoint.test.ts``）

``data: {json}\\n\\n`` 帧 + 终帧 ``data: [DONE]``。文本 = ``{type:'text-delta',
id, delta}``（防御性兼容 ``text`` 字段 —— 镜像 ``approvalResume.ts:206-211`` 的
双读）；审批暂停会先出一帧 ``{type:'tool-approval-request', approvalId,
toolCallId}``（``agui/eventMapper.ts:212`` 同名 case 为证）——这是「本轮真的停在
审批门」的**流内证据**，桥接用它和 ``/approval/pending`` 互相印证。
多个文本块（工具调用前后各一段）按 ``text-start`` 分块、块间双换行拼接。

## 端口解析

env ``MAILAGENT_AI_GATEWAY_PORT``，缺省/非法 → 8300。🔴 这是**第三处**同形抄写
（``src/agents/run_worker.py:328-343`` / ``src/api/routers/ai_gateway_proxy.py:103-115``）
—— 按 CLAUDE.md 纪律本该下沉零依赖叶子三处共用，但那要动 agents/api 两个
lane 外文件（本 PR 边界禁碰）；先抄 + ``tests/im/test_gateway_client.py`` 的
跨模块一致闸钉住，下沉留给收敛 PR。
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import httpx
from loguru import logger

from src.im.logfmt import describe_error

_DEFAULT_AI_GATEWAY_PORT = 8300

# im-chat 流超时：connect 短（gateway 没起 = 立刻 connection refused，不该等）；
# read 给到 runtime 预算同量级（gateway 侧 run 的墙钟上限是 30min）。
CHAT_CONNECT_TIMEOUT_SEC = 10.0
CHAT_READ_TIMEOUT_SEC = 1800.0
# decide 会跑真实写工具（create_draft 60s / send 等）——照抄 island 的 100s
# （src/api/routers/island.py::_GATEWAY_DECIDE_TIMEOUT_SEC）。
DECIDE_TIMEOUT_SEC = 100.0
# pending / stop 是纯内存查询，短超时。
PROBE_TIMEOUT_SEC = 10.0


def resolve_gateway_port() -> int:
    """gateway loopback 端口。同形三抄写之三（见模块 docstring，有一致闸）。"""
    raw = os.environ.get("MAILAGENT_AI_GATEWAY_PORT")
    if raw is None:
        return _DEFAULT_AI_GATEWAY_PORT
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return _DEFAULT_AI_GATEWAY_PORT
    return n if n > 0 else _DEFAULT_AI_GATEWAY_PORT


@dataclass
class ImChatOutcome:
    """一次 ``/api/ai/im-chat`` 调用的结果。``ok`` = HTTP 200 且流正常读完。"""

    ok: bool = False
    transport_error: str = ""  # 非空 = 请求根本没到 / 中途断（E_CONNECT/E_TIMEOUT/E_HTTP）
    http_status: int = 0
    error_code: str = ""       # 非 200 时 gateway body 里的 error（E_RUN_ACTIVE 等）
    hint: str = ""
    session_id: Optional[int] = None  # x-mailagent-session-id 响应头
    text: str = ""             # 各文本块按块间双换行拼接
    saw_approval_request: bool = False
    approval_id: str = ""      # tool-approval-request 帧携带的 approvalId
    stream_error: str = ""     # 流内 {type:'error'} 帧的 errorText


@dataclass
class PendingApproval:
    approval_id: str
    tool_name: str
    input_preview: str
    age_ms: int = 0
    # PR-4：MCP 服务方自报的 destructive_hint（gateway 在暂停时冻进 stash → ``/pending``
    # 透出）。缺字段 / 老 gateway → False = 不加红警告（**不编**：宁可少一句提示，也不
    # 能凭模型参数猜一个出来 —— 与桌面 McpApprovalCard 同一条纪律）。
    destructive: bool = False


@dataclass
class DecideOutcome:
    ok: bool = False
    transport_error: str = ""
    http_status: int = 0
    status: str = ""   # completed | rejected | repaused | error | not_found
    summary: str = ""  # 🔴 gateway 侧 180 字符截断的一行摘要，不是完整回复
    error: str = ""


@dataclass
class StopOutcome:
    ok: bool = False
    transport_error: str = ""
    http_status: int = 0
    stopped: bool = False


@dataclass
class _SseAccumulator:
    """SSE 帧 → 文本块 / 暂停证据 / 流内错误。"""

    blocks: List[str] = field(default_factory=list)
    block_ids: List[str] = field(default_factory=list)
    saw_approval_request: bool = False
    approval_id: str = ""
    stream_error: str = ""

    def feed(self, frame: Dict[str, Any]) -> None:
        ftype = frame.get("type")
        if ftype == "text-start":
            self.blocks.append("")
            self.block_ids.append(str(frame.get("id") or ""))
        elif ftype == "text-delta":
            piece = frame.get("delta")
            if not isinstance(piece, str):
                piece = frame.get("text")
            if not isinstance(piece, str):
                return
            fid = str(frame.get("id") or "")
            if self.blocks and (not fid or not self.block_ids or self.block_ids[-1] == fid):
                self.blocks[-1] += piece
            else:
                # 没见过 text-start 的 delta（防御）→ 自成一块
                self.blocks.append(piece)
                self.block_ids.append(fid)
        elif ftype == "tool-approval-request":
            self.saw_approval_request = True
            aid = frame.get("approvalId")
            if isinstance(aid, str) and aid:
                self.approval_id = aid
        elif ftype == "error":
            err = frame.get("errorText")
            if isinstance(err, str) and err:
                self.stream_error = err

    @property
    def text(self) -> str:
        return "\n\n".join(b for b in self.blocks if b.strip())


class GatewayClient:
    """gateway loopback 客户端。``transport`` 供测试注入 ``httpx.MockTransport``。"""

    def __init__(
        self,
        *,
        base_url: Optional[str] = None,
        transport: Optional[httpx.BaseTransport] = None,
    ) -> None:
        self._base_url = base_url
        self._transport = transport

    @property
    def base_url(self) -> str:
        # 每次调用现算（不缓存）：与 run_worker 同语义 —— env 是 backend_lifecycle
        # 注入的，进程存活期内不变，但测试会 monkeypatch。
        return self._base_url or f"http://127.0.0.1:{resolve_gateway_port()}"

    def _client(self, timeout: httpx.Timeout) -> httpx.Client:
        return httpx.Client(transport=self._transport, timeout=timeout)

    # ── im-chat ───────────────────────────────────────────────────────────
    def stream_im_chat(
        self,
        messages: List[Dict[str, Any]],
        session_id: Optional[int],
        model: Optional[str] = None,
    ) -> ImChatOutcome:
        """``model`` = providerRef（空/None → 不进 body，gateway 用 ``cfg.model``）。

        🔴 **只许传已对「在册模型全集」校验过的 ref**（``EnabledModelCatalog.find``）。
        provider 不存在时 gateway 的 ``createProviderRegistry`` 抛裸 Error，而
        ``server.ts`` 是 ``void handleImChat(...)``（无 ``.catch``）—— HTTP 响应
        **永不写出**，这边就干等到 ``CHAT_READ_TIMEOUT_SEC``（30 分钟）。
        """
        out = ImChatOutcome()
        body: Dict[str, Any] = {"messages": messages}
        if session_id is not None:
            body["sessionId"] = int(session_id)
        if model:
            body["model"] = model
        timeout = httpx.Timeout(
            connect=CHAT_CONNECT_TIMEOUT_SEC,
            read=CHAT_READ_TIMEOUT_SEC,
            write=30.0,
            pool=CHAT_CONNECT_TIMEOUT_SEC,
        )
        acc = _SseAccumulator()
        try:
            with self._client(timeout) as client:
                with client.stream(
                    "POST", f"{self.base_url}/api/ai/im-chat", json=body
                ) as resp:
                    out.http_status = resp.status_code
                    raw_sid = resp.headers.get("x-mailagent-session-id")
                    if raw_sid:
                        try:
                            out.session_id = int(raw_sid)
                        except (TypeError, ValueError):
                            out.session_id = None
                    if resp.status_code != 200:
                        resp.read()
                        self._fill_error_body(out, resp)
                        return out
                    for line in resp.iter_lines():
                        if not line.startswith("data: "):
                            continue
                        payload = line[len("data: "):].strip()
                        if not payload or payload == "[DONE]":
                            continue
                        try:
                            frame = json.loads(payload)
                        except (TypeError, ValueError):
                            continue
                        if isinstance(frame, dict):
                            acc.feed(frame)
        except httpx.ConnectError as e:
            out.transport_error = "E_CONNECT"
            out.hint = describe_error(e)
            return out
        except httpx.TimeoutException as e:
            out.transport_error = "E_TIMEOUT"
            out.hint = describe_error(e)
            # 超时前已读到的文本仍带回（半截回复 + 明说超时，好过全丢）
            out.text = acc.text
            out.saw_approval_request = acc.saw_approval_request
            out.approval_id = acc.approval_id
            return out
        except httpx.HTTPError as e:
            out.transport_error = "E_HTTP"
            out.hint = describe_error(e)
            return out

        out.ok = True
        out.text = acc.text
        out.saw_approval_request = acc.saw_approval_request
        out.approval_id = acc.approval_id
        out.stream_error = acc.stream_error
        return out

    @staticmethod
    def _fill_error_body(out: ImChatOutcome, resp: httpx.Response) -> None:
        try:
            data = resp.json()
        except (TypeError, ValueError):
            data = None
        if isinstance(data, dict):
            out.error_code = str(data.get("error") or "")
            out.hint = str(data.get("hint") or "")

    # ── approval ──────────────────────────────────────────────────────────
    def approval_pending(self, session_id: int) -> Optional[PendingApproval]:
        """live pending or None（404 miss / 传输失败都归 None，失败另记日志）。"""
        try:
            with self._client(httpx.Timeout(PROBE_TIMEOUT_SEC)) as client:
                resp = client.get(
                    f"{self.base_url}/api/ai/approval/pending",
                    params={"sessionId": int(session_id)},
                )
        except httpx.HTTPError as e:
            logger.warning(f"[im-feishu] 查询 pending 审批失败: {describe_error(e)}")
            return None
        if resp.status_code != 200:
            return None
        try:
            data = resp.json()
        except (TypeError, ValueError):
            return None
        if not isinstance(data, dict) or not data.get("pending"):
            return None
        approval_id = str(data.get("approvalId") or "")
        if not approval_id:
            return None
        return PendingApproval(
            approval_id=approval_id,
            tool_name=str(data.get("toolName") or ""),
            input_preview=str(data.get("inputPreview") or ""),
            age_ms=int(data.get("ageMs") or 0),
            destructive=data.get("destructive") is True,
        )

    def decide(self, approval_id: str, decision: str) -> DecideOutcome:
        """``{approvalId, decision}``（in-record 形状 —— resumeToken 永不出 gateway，
        gateway 经 ``peekByApprovalId`` 自反查并驱动真 resume，``server.ts:987-996``）。"""
        out = DecideOutcome()
        try:
            with self._client(httpx.Timeout(DECIDE_TIMEOUT_SEC)) as client:
                resp = client.post(
                    f"{self.base_url}/api/ai/approval/decide",
                    json={"approvalId": approval_id, "decision": decision},
                )
        except httpx.ConnectError as e:
            out.transport_error = "E_CONNECT"
            out.error = describe_error(e)
            return out
        except httpx.TimeoutException as e:
            out.transport_error = "E_TIMEOUT"
            out.error = describe_error(e)
            return out
        except httpx.HTTPError as e:
            out.transport_error = "E_HTTP"
            out.error = describe_error(e)
            return out
        out.http_status = resp.status_code
        try:
            data = resp.json()
        except (TypeError, ValueError):
            data = {}
        if isinstance(data, dict):
            out.ok = bool(data.get("ok", False))
            out.status = str(data.get("status") or "")
            out.summary = str(data.get("summary") or "")
            err = data.get("error")
            if isinstance(err, str):
                out.error = err
            hint = data.get("hint")
            if not out.error and isinstance(hint, str):
                out.error = hint
        return out

    # ── run control ───────────────────────────────────────────────────────
    def stop_run(self, session_id: int) -> StopOutcome:
        """``POST /api/ai/run/stop {sessionId}``（``server.ts:500-518``：200
        ``{stopped: bool}``；registry 未接线 → 404）。"""
        out = StopOutcome()
        try:
            with self._client(httpx.Timeout(PROBE_TIMEOUT_SEC)) as client:
                resp = client.post(
                    f"{self.base_url}/api/ai/run/stop",
                    json={"sessionId": int(session_id)},
                )
        except httpx.HTTPError as e:
            out.transport_error = "E_CONNECT" if isinstance(e, httpx.ConnectError) else "E_HTTP"
            logger.warning(f"[im-feishu] /run/stop 调用失败: {describe_error(e)}")
            return out
        out.http_status = resp.status_code
        if resp.status_code != 200:
            return out
        try:
            data = resp.json()
        except (TypeError, ValueError):
            data = {}
        out.ok = True
        out.stopped = bool(isinstance(data, dict) and data.get("stopped"))
        return out
