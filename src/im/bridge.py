"""消息 → agent run → 回投 + 飞书内审批闭环（08-01 阶段 2 PR-3 的本体）。

``ImAgentBridge`` 接进 PR-2 留好的两条接缝：

  - ``handle_owner_message(text, ctx)`` → ``ImEventRouter(owner_handler=…)``：
    命令（``/new`` ``/stop`` ``/model``）→ 否则重建历史 → POST gateway
    ``/api/ai/im-chat``（loopback，SSE drain）→ 投递最终回复；drain 后发现停在审批门
    → 发通用审批卡。
  - ``on_card_action(data)`` → ``FeishuConnection(card_action_handler=…)``（经
    ``lark_api.wrap_card_action_handler`` 包装）：3s 内回 toast → executor 线程
    POST ``/decide`` → 照 island ``repaused`` 非终态语义补下一张卡
    （``src/api/routers/island.py:224-230`` 的教训照抄）→ PATCH 卡片终态 +
    投递模型的后续回复。

## 最终回复的取法（两条路线的裁决，写死在这里防止将来被"顺手统一"）

- **消息路径 = (a) 解析 SSE text-delta 拼装**。wire 是 ai-sdk UIMessage stream
  （``im_chat_endpoint.test.ts`` 有逐帧 fixture），文本帧就是最终回复本体 ——
  零额外等待、零竞态。不取 (b)（drain 后读 CHAT_DB）：persistTurn 虽在 [DONE]
  前完成（onFinish 在流 flush 内被 await），但那是实现细节而非 wire 契约，
  且 createImSession 失败时会话不落库、(b) 会整路失明。
- **审批 decide 路径 = (b) 读 CHAT_DB 镜像**。``/decide`` 的 HTTP 响应里只有
  180 字符截断的 ``summary``（``approvalResume.ts::clipSummary``），不是完整
  回复；而 resume 的 drain + persistTurn 在 gateway 端 **decide 响应返回之前**
  就完成了（``resumeApprovalRun`` 内部 ``for await`` 到流关闭、onFinish 被
  await —— 所以这里的 (b) 没有消息路径那种时序赌注），带**新鲜度时间闸** +
  有界重试兜残余偏差，读不到再退回 ``summary``。
  🔴 时间闸判据是 ``max(created_at, updated_at)`` **不是 created_at** ——
  见 ``_read_final_reply``：暂停轮的 assistant 行在**暂停时**就 eager 落库了，
  resume 的 persistTurn 是**就地 UPDATE 同一行**，``created_at`` 停在暂停时刻。

所有出错路径**绝不静默**：每种失败翻成一句人话投回飞书 + ``[im-feishu]`` 日志。
本模块跑在 executor 线程（可以慢、可以做 IO）；**唯一**跑在 lark WS 线程上的是
``on_card_action``（3s 预算），它只做纯内存解析 + 去重 + submit —— 连
``get_bound_open_id``（sqlite 读）都推迟到 executor 任务里。
"""

from __future__ import annotations

import time
from typing import Any, Callable, Dict, Optional, Protocol

from loguru import logger

from src.agent_config.enabled_models import (
    EnabledModel,
    EnabledModelCatalog,
    load_enabled_model_catalog,
)
from src.im.cards import (
    CARD_VALUE_KIND,
    build_approval_card,
    build_decided_card,
)
from src.im.dedupe import EventDeduper
from src.im.gateway_client import (
    GatewayClient,
    ImChatOutcome,
    PendingApproval,
)
from src.im.handler import ImMessageContext
from src.im.lark_api import parse_card_action
from src.im.history import build_history
from src.im.logfmt import describe_error
from src.im.state import ImFeishuState

# ── 文本命令 ──────────────────────────────────────────────────────────────────
CMD_NEW = "/new"
CMD_STOP = "/stop"
# 🔴 带参命令：分发按**首个空白**切开再拿第一段全等比 CMD_MODEL，**不是**
# ``startswith(CMD_MODEL)`` —— 否则 ``/modelx 你好`` 会被吞成命令而不是提问。
CMD_MODEL = "/model"
#: ``/model reset`` 的子命令字面量（大小写不敏感匹配）。
MODEL_ARG_RESET = "reset"

# ── 固定文案（全部导出，测试逐字断言）────────────────────────────────────────
NEW_SESSION_REPLY = "✅ 好，下一条消息将开始全新对话。"
STOP_NO_SESSION_REPLY = "当前没有进行中的会话，无需停止。"
STOP_DONE_REPLY = "⏹️ 已停止正在运行的任务。"
STOP_IDLE_REPLY = "当前没有正在运行的任务。"
STOP_UNAVAILABLE_REPLY = "AI 引擎未启用后台运行控制，无法远程停止（任务若在跑会自行结束）。"

# ── /model 文案 ───────────────────────────────────────────────────────────────
# IM 侧没有 /help —— ``/model``（无参）的输出是用户**唯一**的命令发现入口，所以列表
# 末尾恒附这段用法（包含 /new / /stop）。
MODEL_LIST_TITLE = "🧠 当前模型：{current}"
MODEL_LIST_SECTION_HEADER = "可用模型："
MODEL_MARK_CURRENT = "当前"
MODEL_MARK_DEFAULT = "默认"
MODEL_USAGE_HINT = (
    "用法：\n"
    "· /model <模型> —— 切换本会话后续消息用的模型（/new 不会重置它）\n"
    "· /model reset —— 恢复默认模型\n"
    "· /new 开新对话 · /stop 停止正在跑的任务"
)
MODEL_EMPTY_REPLY = (
    "取不到可用模型清单 —— 请在桌面 App 的设置里检查模型配置（至少启用一个模型）。"
)
MODEL_SWITCHED_REPLY = "✅ 已切换到 {model}。本飞书会话后续消息都用它（/model reset 恢复默认）。"
MODEL_RESET_REPLY = "✅ 已恢复默认模型：{model}。"
# 🔴 配置整个读不出来时（``_catalog()`` 兜底分支，default_model 为空）用这条：偏好确实清了
# 是事实，但「默认模型叫什么」此刻没有任何依据 —— 报一个代码级兜底常量就是编。
MODEL_RESET_REPLY_UNKNOWN = "✅ 已清掉模型偏好，本会话恢复用默认模型（当前取不到配置，报不出它的名字）。"
MODEL_UNKNOWN_REPLY = "没有「{ref}」这个模型 —— 发 /model 看当前可用的清单。"
# 已存偏好在本轮开跑前**再校验一次**（owner 可能事后禁用了那个模型）：本轮回退默认
# 模型并如实说明，**不自动清键** —— 由用户自己 /model 重选或 /model reset。
MODEL_PREF_STALE_NOTICE = (
    "（提示：之前选的模型「{ref}」现在不在可用清单里，本轮已改用默认模型 {default}。"
    "发 /model 重新选，或 /model reset 清掉这个偏好。）"
)
# 🔴 与上面那条严格分开，且**有意不报默认模型的名字**：走到这里说明清单整体读不出来，
# 此时连「默认模型叫什么」都没有可靠依据，报一个名字就是编。
MODEL_PREF_UNVERIFIABLE_NOTICE = (
    "（提示：这轮取不到可用模型清单，无法确认之前选的模型「{ref}」还在不在，"
    "已保守改用默认模型。）"
)

GATEWAY_DOWN_REPLY = (
    "连不上 AI 引擎 —— 桌面 App（MailAgent）可能没有在运行。请启动 App 后再试。"
)
RUN_ACTIVE_REPLY = "上一条消息还在处理中，请稍等；想中断可以发 /stop。"
FLAG_OFF_REPLY = (
    "AI 引擎侧的飞书对话入口没有开启（MAILAGENT_IM_FEISHU 未生效，或 App 需要重启/更新）。"
)
NO_LLM_KEY_REPLY = "AI 引擎缺少模型凭证（未配置 LLM key）。请在桌面 App 设置里配置后再试。"
TOO_LARGE_REPLY = "这轮对话内容太长，AI 引擎拒收了。发 /new 开个新会话再试。"
RUN_TIMEOUT_REPLY = (
    "等待超时，AI 可能仍在后台运行 —— 稍后可在桌面 App 查看结果，或发 /stop 停止。"
)
GENERIC_GATEWAY_ERROR_REPLY = "调用 AI 引擎失败（{code}）。请稍后再试，或查看 MailAgent 日志。"

APPROVAL_DETAILS_MISSING_REPLY = (
    "AI 停在一个待审批的操作上，但审批详情已不可用（可能已过期或应用刚重启）。"
    "请重新发起，或到桌面 App 处理。"
)
CARD_SEND_FAILED_REPLY = (
    "AI 请求执行 {tool}，但审批卡片发送失败 —— 请到桌面 App 处理这次审批。"
)
STALE_PENDING_NOTICE = (
    "（提示：还有一个更早的待审批操作在等待：{tool}。可回到之前的审批卡片处理。）"
)

DECIDE_INVALID_DETAIL = "该审批已失效（可能已被处理、已超时、或应用重启过）。请重新发起。"
DECIDE_BUSY_REPLY = (
    "会话正忙（可能有别的回合在跑），这次点击没有生效 —— 卡片仍有效，稍后再点一次。"
)
DECIDE_DOWN_REPLY = (
    "连不上 AI 引擎，这次点击没有生效 —— 卡片仍有效，请确认桌面 App 在运行后再点一次。"
)
# 🔴 与 DOWN 严格分开：连接被拒（E_CONNECT）= 请求根本没送到，「没有生效」是**真话**；
# 读超时 / 传输中断（E_TIMEOUT / E_HTTP）= 请求**已经送到**，gateway 那边 stash 可能
# 已被 claim、被批准的工具**可能已经执行完**（DECIDE_TIMEOUT_SEC=100s，写工具跑久了
# 就会撞上）。此时说「这次点击没有生效、再点一次」= 谎报未执行 + 诱导重复操作，
# 与「卡片说已执行就必须真的执行了」是同一条如实性红线的两面。
DECIDE_UNKNOWN_REPLY = (
    "决定已经发给 AI 引擎，但等结果超时了 —— ⚠️ **这次操作可能已经执行**。"
    "请先到桌面 App 确认结果，不要直接再点一次卡片。"
)
REPAUSED_NEXT_MISSING_REPLY = (
    "已批准。后续还有待审批的操作，但详情拉取失败 —— 请到桌面 App 继续处理。"
)
# PR-4（复核留档项 2）：repaused 是非终态，走不到下面「取最终回复投递」那一段，于是
# 模型在这一跳里说的话此前**整段被丢掉** —— 用户只看到「已批准 → 又来一张卡」，中间
# 发生了什么全无。这里把 ``/decide`` 响应里的 ``summary``（gateway ``clipSummary`` 截到
# 180 字符）当**中间进展**投递，并**显式标明是摘要** —— 不标就是把一段截断文本冒充成
# 模型的完整回复（这一跳的完整文本要等整轮跑完才在 CHAT_DB 里落定，此刻取不到）。
REPAUSED_PROGRESS_PREFIX = "（中间进展 · 摘要，完整内容见桌面 App）\n"
REJECTED_FALLBACK_TEXT = "❌ 已拒绝，未执行。"
APPROVED_FALLBACK_TEXT = "✅ 已批准，已执行。"
REPAUSED_FALLBACK_TEXT = "✅ 已批准；还有后续操作待确认。"

# ── 卡片 toast（``on_card_action`` 的 3s 返回值）──────────────────────────────
TOAST_RECEIVED_APPROVE = {"toast": {"type": "info", "content": "已收到（批准），正在处理…"}}
TOAST_RECEIVED_REJECT = {"toast": {"type": "info", "content": "已收到（拒绝），正在处理…"}}
TOAST_DUPLICATE = {"toast": {"type": "warning", "content": "重复回调，已忽略"}}
TOAST_UNKNOWN = {"toast": {"type": "warning", "content": "未知操作，已忽略"}}
TOAST_BUSY = {"toast": {"type": "warning", "content": "系统正忙，这次点击没有生效，稍后再点一次"}}
TOAST_ERROR = {"toast": {"type": "warning", "content": "处理出错，请看 MailAgent 日志"}}

# 审批暂停证据与 stash 落地之间的保险重试（正常一次就命中：stash 写在 onFinish 里、
# 先于流终帧；重试只兜 flush 时序的实现细节变化）。
PENDING_PROBE_RETRIES = 3
PENDING_PROBE_DELAY_SEC = 0.4
# decide 后读 CHAT_DB 最终回复的有界重试 + 时钟偏差余量。
FINAL_REPLY_ATTEMPTS = 4
FINAL_REPLY_DELAY_SEC = 0.3
FINAL_REPLY_CLOCK_SKEW_MS = 5000


def _resolve_model_input(
    catalog: EnabledModelCatalog, raw: str
) -> Optional[EnabledModel]:
    """把用户在飞书里打的模型写法解析成在册模型；解析不出 → None。

    两步（顺序有意如此）：
      1. **原样**查 —— 覆盖 ``provider:model`` 与裸 ``model``，也覆盖 model id 自身
         含 ``/`` 的情形（openrouter 风格 ``anthropic/claude-x`` 挂在 default provider 下）；
      2. 仍不中，把**第一个** ``/`` 归一成 ``:`` 再查 —— 覆盖 ``provider/model`` 写法。
         只归一第一个：``openrouter/anthropic/claude-x`` 要变成
         ``openrouter:anthropic/claude-x``，后面的 ``/`` 是 model id 的一部分。

    先原样后归一，是为了不让第 2 步把「default provider 下的斜杠 model id」误判成
    「provider/model」而找不到。
    """
    ref = (raw or "").strip()
    if not ref:
        return None
    hit = catalog.find(ref)
    if hit is not None:
        return hit
    if "/" in ref:
        return catalog.find(ref.replace("/", ":", 1))
    return None


class CardSender(Protocol):
    """审批卡出站面（``worker._LazySender`` 实现；文本走 ``FeishuDelivery``）。"""

    def create_message(
        self, receive_id: str, msg_type: str, content: Dict[str, Any]
    ) -> Optional[str]: ...

    def patch_message(self, message_id: str, content: Dict[str, Any]) -> bool: ...


class ImAgentBridge:
    """飞书 ↔ AI SDK Gateway 的桥。**除 ``on_card_action`` 外全部跑在 executor 线程。**"""

    def __init__(
        self,
        *,
        state: ImFeishuState,
        delivery: Any,
        card_sender: CardSender,
        submit: Callable[..., Any],
        gateway: Optional[GatewayClient] = None,
        chat_db: Any = None,
        sleep: Callable[[float], None] = time.sleep,
        model_catalog: Optional[Callable[[], EnabledModelCatalog]] = None,
    ) -> None:
        """
        Args:
            state: ``im.feishu.*`` 门面（会话映射 + 绑定读取）。
            delivery: ``FeishuDelivery``（文本投递，分块/重试/日志已内置）。
            card_sender: 卡片发送/PATCH 面（``_LazySender``）。
            submit: ``executor.submit`` 形状（卡片回调把慢活甩出去用）。
            gateway: 测试注入；缺省 = 真 loopback 客户端。
            chat_db: 测试注入；缺省 = 懒构造 ``src.chat.db.ChatDb``。
            sleep: 测试注入（重试等待）。
            model_catalog: 测试注入；缺省 = ``load_enabled_model_catalog``
                （与 ``/chat/config.enabledModels`` 同一份聚合，见
                ``src/agent_config/enabled_models.py``）。
        """
        self._state = state
        self._delivery = delivery
        self._card_sender = card_sender
        self._submit = submit
        self._gateway = gateway or GatewayClient()
        self._chat_db = chat_db
        self._sleep = sleep
        self._model_catalog = model_catalog
        # 卡片回调有自己的 event_id 空间，与消息事件分开去重。
        self._card_deduper = EventDeduper()

    # ── 消息路径（executor 线程）──────────────────────────────────────────
    def handle_owner_message(self, text: str, ctx: ImMessageContext) -> None:
        stripped = (text or "").strip()
        if stripped == CMD_NEW:
            self._cmd_new(ctx)
            return
        if stripped == CMD_STOP:
            self._cmd_stop(ctx)
            return
        # 带参命令：按**首个空白**切（``split(None, 1)`` 认全角空格 U+3000 —— 中文输入法
        # 下打出的 ``/model　claude-x`` 用 ``startswith("/model ")`` 判不出来，整条会掉进
        # agent run 当提问）。判据仍是**第一段全等**，所以 ``/modelx 是什么`` 照旧是提问。
        parts = stripped.split(None, 1)
        if parts and parts[0] == CMD_MODEL:
            self._cmd_model(parts[1].strip() if len(parts) > 1 else "", ctx)
            return
        self._run_turn(text, ctx)

    def _cmd_new(self, ctx: ImMessageContext) -> None:
        self._state.clear_active_session(ctx.chat_id)
        logger.info(f"[im-feishu] /new：已清活跃会话 chat_id={ctx.chat_id}")
        ctx.delivery.send_text(ctx.open_id, NEW_SESSION_REPLY)

    def _cmd_stop(self, ctx: ImMessageContext) -> None:
        session_id = self._state.get_active_session(ctx.chat_id)
        if session_id is None:
            ctx.delivery.send_text(ctx.open_id, STOP_NO_SESSION_REPLY)
            return
        out = self._gateway.stop_run(session_id)
        if out.transport_error:
            ctx.delivery.send_text(ctx.open_id, GATEWAY_DOWN_REPLY)
            return
        if out.http_status == 404:
            ctx.delivery.send_text(ctx.open_id, STOP_UNAVAILABLE_REPLY)
            return
        logger.info(f"[im-feishu] /stop session_id={session_id} stopped={out.stopped}")
        ctx.delivery.send_text(
            ctx.open_id, STOP_DONE_REPLY if out.stopped else STOP_IDLE_REPLY
        )

    # ── /model（列表 / 切换 / reset）───────────────────────────────────────
    def _cmd_model(self, arg: str, ctx: ImMessageContext) -> None:
        catalog = self._catalog()
        if not arg:
            ctx.delivery.send_text(
                ctx.open_id, self._render_model_list(catalog, ctx.chat_id)
            )
            return
        if arg.lower() == MODEL_ARG_RESET:
            self._state.clear_model_pref(ctx.chat_id)
            logger.info(f"[im-feishu] /model reset chat_id={ctx.chat_id}")
            ctx.delivery.send_text(
                ctx.open_id,
                MODEL_RESET_REPLY.format(model=catalog.default_model)
                if catalog.default_model
                else MODEL_RESET_REPLY_UNKNOWN,
            )
            return
        match = _resolve_model_input(catalog, arg)
        if match is None:
            # 🔴 校验不过 = **不落库、不透传**。没在册的 ref 传到 gateway 会让
            # createProviderRegistry 抛裸 Error 且无人 catch → 响应永不写出 → 读超时 30min。
            logger.info(
                f"[im-feishu] /model 拒绝不在册的 ref={arg!r} chat_id={ctx.chat_id} "
                f"(source={catalog.source} n={len(catalog.refs)})"
            )
            ctx.delivery.send_text(ctx.open_id, MODEL_UNKNOWN_REPLY.format(ref=arg))
            return
        self._state.set_model_pref(ctx.chat_id, match.ref)
        logger.info(f"[im-feishu] /model 切换到 {match.ref} chat_id={ctx.chat_id}")
        ctx.delivery.send_text(
            ctx.open_id, MODEL_SWITCHED_REPLY.format(model=match.label)
        )

    def _render_model_list(self, catalog: EnabledModelCatalog, chat_id: str) -> str:
        """``/model`` 无参输出：当前模型 + 按 provider 分组的清单 + 用法（唯一发现入口）。"""
        if not catalog.groups:
            return f"{MODEL_EMPTY_REPLY}\n\n{MODEL_USAGE_HINT}"
        pref = self._state.get_model_pref(chat_id)
        # 🔴 默认模型也走 ``find`` 归一：``LLM_MODEL`` 写成 ``default:x`` 时清单里的 ref 是裸
        # ``x``，裸字符串比会让「当前」标记整个消失（标题显示一种写法、列表里一个都不标）。
        default_hit = catalog.find(catalog.default_model)
        current = (catalog.find(pref) if pref else None) or default_hit
        current_ref = current.ref if current is not None else catalog.default_model
        lines = [
            MODEL_LIST_TITLE.format(
                current=current.label if current is not None else catalog.default_model
            ),
            "",
            MODEL_LIST_SECTION_HEADER,
        ]
        for group in catalog.groups:
            if group.provider_name:
                lines.append(f"【{group.provider_name}】")
            for model in group.models:
                marks = []
                if model.ref == current_ref:
                    marks.append(MODEL_MARK_CURRENT)
                if default_hit is not None and model.ref == default_hit.ref:
                    marks.append(MODEL_MARK_DEFAULT)
                suffix = f" —— {' · '.join(marks)}" if marks else ""
                lines.append(f"· {model.label}{suffix}")
        lines.append("")
        lines.append(MODEL_USAGE_HINT)
        return "\n".join(lines)

    def _resolve_turn_model(self, chat_id: str) -> tuple[str, str]:
        """本轮要用的模型 ref + 需要附给用户的提示（``("", "")`` = 用默认、无提示）。

        🔴 存过的偏好**每轮都再校验一次** —— owner 可能事后在设置里禁用了那个模型，
        而透传一个已下架的 ref 会把整轮卡成 30 分钟读超时。校验不过就回退默认 + 如实
        告知（不自动清键：清掉等于替用户做决定，且下次他就再也看不到这条提示了）。
        """
        pref = self._state.get_model_pref(chat_id)
        if not pref:
            return "", ""
        catalog = self._catalog()
        if not catalog.refs:
            # 清单整体取不到（store 异常 / 表空 + env 也空）→ 无法判定在不在册。
            # 保守回退默认，但**不能**说「这个模型没了」（那是没有根据的断言）。
            return "", MODEL_PREF_UNVERIFIABLE_NOTICE.format(ref=pref)
        match = catalog.find(pref)
        if match is None:
            logger.warning(
                f"[im-feishu] 已存模型偏好 {pref!r} 不在当前可用清单里 —— "
                f"本轮回退默认模型 chat_id={chat_id}"
            )
            return "", MODEL_PREF_STALE_NOTICE.format(
                ref=pref, default=catalog.default_model
            )
        return match.ref, ""

    def _run_turn(self, text: str, ctx: ImMessageContext) -> None:
        session_id = self._state.get_active_session(ctx.chat_id)
        rows = []
        if session_id is not None:
            try:
                rows = self._db().list_messages(session_id)
            except Exception as e:  # noqa: BLE001 — 历史读不到 → 降级为无历史新turn
                logger.warning(
                    f"[im-feishu] 读会话历史失败（按无历史继续）session_id={session_id}: "
                    f"{describe_error(e)}"
                )
                rows = []
        messages = build_history(rows, text, f"im-{ctx.event_id}")
        model_ref, model_notice = self._resolve_turn_model(ctx.chat_id)

        t0 = time.monotonic()
        logger.info(
            f"[im-feishu] agent run 开始 event_id={ctx.event_id} "
            f"session_id={session_id} history_msgs={len(messages) - 1} "
            f"model={model_ref or '(default)'}"
        )
        out = self._gateway.stream_im_chat(messages, session_id, model=model_ref or None)
        elapsed = time.monotonic() - t0

        # 首轮：gateway 预建的 origin='im' 会话经响应头回传 → 收编落盘（跨重启存活）。
        if out.session_id is not None and out.session_id != session_id:
            self._state.set_active_session(ctx.chat_id, out.session_id)
        effective_sid = out.session_id if out.session_id is not None else session_id

        if not out.ok:
            logger.warning(
                f"[im-feishu] agent run 失败 event_id={ctx.event_id} "
                f"http={out.http_status} code={out.error_code or out.transport_error} "
                f"hint={out.hint}"
            )
            # 读超时前已经拿到的半截回复照投（明说被截断，好过全丢）。
            if out.transport_error == "E_TIMEOUT" and out.text.strip():
                ctx.delivery.send_text(ctx.open_id, out.text)
            ctx.delivery.send_text(ctx.open_id, self._error_reply(out))
            return

        logger.info(
            f"[im-feishu] agent run 结束 event_id={ctx.event_id} "
            f"session_id={effective_sid} elapsed={elapsed:.1f}s "
            f"text_chars={len(out.text)} paused={out.saw_approval_request}"
        )

        reply_text = out.text
        if out.stream_error:
            suffix = f"⚠️ 生成中途出错：{out.stream_error}"
            reply_text = f"{reply_text}\n\n{suffix}" if reply_text.strip() else suffix
        if model_notice:
            # 偏好失效的提示挂在**本轮回复末尾**（两条路径都要：暂停轮也是这轮的回复）。
            reply_text = (
                f"{reply_text}\n\n{model_notice}" if reply_text.strip() else model_notice
            )

        if out.saw_approval_request:
            # 暂停回合：先投模型已产出的文本（"我准备发邮件…"），再补审批卡。
            if reply_text.strip():
                ctx.delivery.send_text(ctx.open_id, reply_text)
            pending = (
                self._probe_pending(effective_sid) if effective_sid is not None else None
            )
            if pending is not None:
                self._send_approval_card(
                    ctx.open_id, effective_sid, ctx.chat_id, pending
                )
            else:
                logger.error(
                    f"[im-feishu] 流内见到审批暂停但 /pending 无 live 审批 "
                    f"session_id={effective_sid} —— 如实告知"
                )
                ctx.delivery.send_text(ctx.open_id, APPROVAL_DETAILS_MISSING_REPLY)
            return

        # 完成回合：空文本走 delivery 的 "(空回复)" 兜底，不静默失联。
        ctx.delivery.send_text(ctx.open_id, reply_text)
        # 本轮没暂停但 stash 里还挂着更早的 live 审批（owner 之前无视了卡片）→ 提示一句。
        if effective_sid is not None:
            stale = self._gateway.approval_pending(effective_sid)
            if stale is not None:
                ctx.delivery.send_text(
                    ctx.open_id,
                    STALE_PENDING_NOTICE.format(tool=stale.tool_name or "一个操作"),
                )

    @staticmethod
    def _error_reply(out: ImChatOutcome) -> str:
        if out.transport_error in ("E_CONNECT", "E_HTTP"):
            return GATEWAY_DOWN_REPLY
        if out.transport_error == "E_TIMEOUT":
            return RUN_TIMEOUT_REPLY
        if out.http_status == 409 or out.error_code == "E_RUN_ACTIVE":
            return RUN_ACTIVE_REPLY
        if out.http_status == 404:
            return FLAG_OFF_REPLY
        if out.http_status == 503 or out.error_code == "E_NO_LLM_KEY":
            return NO_LLM_KEY_REPLY
        if out.http_status == 413:
            return TOO_LARGE_REPLY
        return GENERIC_GATEWAY_ERROR_REPLY.format(
            code=out.error_code or out.http_status
        )

    # ── 审批卡（executor 线程）────────────────────────────────────────────
    def _probe_pending(self, session_id: int) -> Optional[PendingApproval]:
        for attempt in range(PENDING_PROBE_RETRIES):
            pending = self._gateway.approval_pending(session_id)
            if pending is not None:
                return pending
            if attempt < PENDING_PROBE_RETRIES - 1:
                self._sleep(PENDING_PROBE_DELAY_SEC)
        return None

    def _send_approval_card(
        self,
        open_id: str,
        session_id: Optional[int],
        chat_id: str,
        pending: PendingApproval,
    ) -> Optional[str]:
        card = build_approval_card(
            tool_name=pending.tool_name,
            input_preview=pending.input_preview,
            approval_id=pending.approval_id,
            session_id=session_id,
            chat_id=chat_id,
            # PR-4：destructive 红警告随卡（MCP 服务方 destructive_hint，经 gateway
            # stash → /pending 透出）。老 gateway 不返回该字段 → False = 不加警告。
            destructive=pending.destructive,
        )
        message_id = self._card_sender.create_message(open_id, "interactive", card)
        if message_id:
            logger.info(
                f"[im-feishu] 审批卡已发出 approval_id={pending.approval_id} "
                f"tool={pending.tool_name} session_id={session_id} "
                f"message_id={message_id}"
            )
        else:
            logger.error(
                f"[im-feishu] 审批卡发送失败 approval_id={pending.approval_id} "
                f"tool={pending.tool_name} —— fallback 文本告知（去桌面 App 批）"
            )
            self._delivery.send_text(
                open_id, CARD_SEND_FAILED_REPLY.format(tool=pending.tool_name or "一个操作")
            )
        return message_id

    # ── 卡片回调（🔴 lark WS 线程，3 秒预算：纯内存 + submit，一个 sqlite 读都没有）──
    def on_card_action(self, data: Any) -> Dict[str, Any]:
        try:
            parsed = parse_card_action(data)
            if parsed is None:
                return TOAST_ERROR
            if self._card_deduper.seen(parsed["event_id"]):
                logger.warning(
                    "[im-feishu] 收到**重推**卡片回调（飞书判超时后重发），已去重："
                    f"event_id={parsed['event_id']}"
                )
                return TOAST_DUPLICATE
            value = parsed["value"]
            if value.get("kind") != CARD_VALUE_KIND:
                logger.info(
                    f"[im-feishu] 未知卡片回调 kind={value.get('kind')!r}，忽略"
                )
                return TOAST_UNKNOWN
            decision = value.get("decision")
            if decision not in ("approve", "reject"):
                return TOAST_UNKNOWN
            accepted = self._submit(self._process_card_decision, parsed)
            if accepted is False:
                return TOAST_BUSY
            logger.info(
                f"[im-feishu] 卡片点击已受理 decision={decision} "
                f"approval_id={value.get('approval_id')} event_id={parsed['event_id']}"
            )
            return TOAST_RECEIVED_APPROVE if decision == "approve" else TOAST_RECEIVED_REJECT
        except Exception as e:  # noqa: BLE001 — handler 抛异常 = 飞书判失败并重推
            logger.error(f"[im-feishu] on_card_action 异常（已兜住）: {describe_error(e)}")
            return TOAST_ERROR

    # ── 审批决定（executor 线程）──────────────────────────────────────────
    def _process_card_decision(self, parsed: Dict[str, Any]) -> None:
        value = parsed["value"]
        approval_id = str(value.get("approval_id") or "")
        decision = "reject" if value.get("decision") == "reject" else "approve"
        operator = parsed["operator_open_id"]
        card_mid = parsed["open_message_id"]
        tool_name = str(value.get("tool_name") or "")
        input_preview = str(value.get("input_preview") or "")
        chat_id = str(value.get("chat_id") or "")
        try:
            session_id: Optional[int] = (
                int(value["session_id"]) if value.get("session_id") is not None else None
            )
        except (TypeError, ValueError):
            session_id = None

        # 操作者校验（sqlite 读，所以在 executor 线程做）：只认已绑定 owner。
        bound = self._state.get_bound_open_id()
        if not bound or operator != bound:
            logger.warning(
                f"[im-feishu] 拒绝非 owner 的卡片操作 operator={operator} "
                f"approval_id={approval_id}"
            )
            return
        if not approval_id:
            logger.warning("[im-feishu] 卡片 value 缺 approval_id，忽略")
            return

        logger.info(
            f"[im-feishu] 审批决定提交 decision={decision} approval_id={approval_id} "
            f"session_id={session_id}"
        )
        decide_start_ms = time.time() * 1000
        res = self._gateway.decide(approval_id, decision)

        # —— 可重试失败：卡片**不动**（按钮保留），文本如实告知 ——
        if res.transport_error:
            logger.error(
                f"[im-feishu] decide 调用失败 approval_id={approval_id} "
                f"{res.transport_error}: {res.error}"
            )
            # E_CONNECT = 没送到（真「没有生效」）；其余 = 送到了但没等到结果，
            # 执行与否未知 → 绝不宣称「没有生效」（见 DECIDE_UNKNOWN_REPLY 红字）。
            self._delivery.send_text(
                operator,
                DECIDE_DOWN_REPLY
                if res.transport_error == "E_CONNECT"
                else DECIDE_UNKNOWN_REPLY,
            )
            return
        if res.http_status == 409:
            logger.warning(
                f"[im-feishu] decide 409（会话正忙，stash 未消费）approval_id={approval_id}"
            )
            self._delivery.send_text(operator, DECIDE_BUSY_REPLY)
            return

        # —— 终态失效：重复点击已消费的审批 / stash 过期 / gateway 重启（fail-closed）——
        if res.http_status == 404 or res.status == "not_found":
            logger.warning(f"[im-feishu] 审批已失效 approval_id={approval_id}")
            self._update_card(
                card_mid,
                build_decided_card(
                    outcome="invalid",
                    tool_name=tool_name,
                    input_preview=input_preview,
                    detail=DECIDE_INVALID_DETAIL,
                ),
                operator,
                fallback_text=DECIDE_INVALID_DETAIL,
            )
            return
        if res.http_status != 200:
            logger.error(
                f"[im-feishu] decide 意外响应 http={res.http_status} "
                f"approval_id={approval_id} error={res.error}"
            )
            self._delivery.send_text(
                operator,
                f"审批提交失败（HTTP {res.http_status}）。卡片可能仍有效，稍后再点一次；"
                "多次失败请查看 MailAgent 日志。",
            )
            return

        status = res.status
        logger.info(
            f"[im-feishu] 审批结果 approval_id={approval_id} decision={decision} "
            f"status={status}"
        )

        # 🔴 repaused = 非终态（island.py:224-230 教训照抄）：本卡标「已批准」，
        # 但**必须补发下一张审批卡**，绝不宣布完成。
        if status == "repaused":
            self._update_card(
                card_mid,
                build_decided_card(
                    outcome="approved_repaused",
                    tool_name=tool_name,
                    input_preview=input_preview,
                ),
                operator,
                fallback_text=REPAUSED_FALLBACK_TEXT,
            )
            # 🔴 中间跳的叙述不能丢：把 summary 当「中间进展」投递（**标明是摘要**），
            # 再发下一张卡 —— 顺序有意如此，用户先读到「刚才发生了什么」，再面对
            # 「下一个要不要批」。summary 为空（gateway 没给）→ 什么都不发，不造空消息。
            if res.summary.strip():
                self._delivery.send_text(
                    operator, f"{REPAUSED_PROGRESS_PREFIX}{res.summary.strip()}"
                )
            next_pending = (
                self._probe_pending(session_id) if session_id is not None else None
            )
            if next_pending is not None:
                self._send_approval_card(operator, session_id, chat_id, next_pending)
            else:
                logger.error(
                    f"[im-feishu] repaused 但拉不到下一个 pending session_id={session_id}"
                )
                self._delivery.send_text(operator, REPAUSED_NEXT_MISSING_REPLY)
            return

        if status == "error" or not res.ok:
            err = res.error or res.summary or "unknown"
            self._update_card(
                card_mid,
                build_decided_card(
                    outcome="error",
                    tool_name=tool_name,
                    input_preview=input_preview,
                    detail=f"**结果**：{err}",
                ),
                operator,
                fallback_text=f"审批后执行失败：{err}",
            )
            return

        if status == "rejected":
            self._update_card(
                card_mid,
                build_decided_card(
                    outcome="rejected", tool_name=tool_name, input_preview=input_preview
                ),
                operator,
                fallback_text=REJECTED_FALLBACK_TEXT,
            )
        else:
            # completed（含「已在 app 内处理」的赛点短路）
            self._update_card(
                card_mid,
                build_decided_card(
                    outcome="approved", tool_name=tool_name, input_preview=input_preview
                ),
                operator,
                fallback_text=APPROVED_FALLBACK_TEXT,
            )

        # 🔴 拒绝也是合法路径：reject 后 run 继续跑完（模型收到拒绝反馈）——
        # completed / rejected 都取最终回复投递。
        final = ""
        if session_id is not None:
            final = self._read_final_reply(session_id, decide_start_ms)
        final = final or res.summary
        if final.strip():
            self._delivery.send_text(operator, final)
        logger.info(
            f"[im-feishu] 审批后回复已投递 approval_id={approval_id} "
            f"session_id={session_id} chars={len(final)}"
        )

    def _read_final_reply(self, session_id: int, since_ms: float) -> str:
        """decide 后从 CHAT_DB 镜像读本回合的完整 assistant 回复（时间闸 + 有界重试）。

        gateway 侧 resume 的 persistTurn 在 decide 响应返回前已完成（见模块
        docstring 裁决），单次读通常即命中；重试只兜时钟偏差 / WAL 可见性毛刺。
        读不到（会话未落库 / legacy 行 / 本轮根本没 persist）→ 空串，调用侧退回
        decide 的 summary（安全降级：宁可给截断摘要，也不给别的回合的旧文本）。

        🔴 **新鲜度判据 = ``max(created_at, updated_at)``，不是 created_at**：
        暂停轮若有前导文本（模型先说「我准备发邮件」再请求审批），那行 assistant
        在**暂停时**就被 ``persistPausedAssistant`` eager 落库了；resume 的
        persistTurn 认同一个 UIMessage id → 走 ``updateMessage`` **就地替换**
        （``ai_gateway_lifecycle.ts:202-213`` → ``chat_db/messages.ts::updateMessage``
        只 bump ``updated_at``）。所以最终回复所在行的 ``created_at`` 停在**暂停
        时刻** —— 只看 created_at 的话，owner 隔 5 秒以上才点卡片（= 绝大多数
        真实点击）就恒判「这是旧行」，完整回复**永远取不到**、恒退回 180 字符
        summary，整个 (b) 路线名存实亡。
        """
        for attempt in range(FINAL_REPLY_ATTEMPTS):
            row = None
            try:
                row = self._db().get_latest_assistant_message(session_id)
            except Exception as e:  # noqa: BLE001 — 镜像读失败降级 summary，不炸
                logger.warning(
                    f"[im-feishu] 读最终回复失败 session_id={session_id}: "
                    f"{describe_error(e)}"
                )
            if row is not None:
                touched_at = max(row.get("created_at") or 0, row.get("updated_at") or 0)
                content = (row.get("content") or "").strip()
                if content and touched_at >= since_ms - FINAL_REPLY_CLOCK_SKEW_MS:
                    return content
            if attempt < FINAL_REPLY_ATTEMPTS - 1:
                self._sleep(FINAL_REPLY_DELAY_SEC)
        return ""

    def _update_card(
        self,
        message_id: str,
        card: Dict[str, Any],
        open_id: str,
        *,
        fallback_text: str,
    ) -> bool:
        """PATCH 卡片终态；失败 fallback 发新消息。**两路成败都显式日志**。"""
        if message_id:
            ok = False
            try:
                ok = bool(self._card_sender.patch_message(message_id, card))
            except Exception as e:  # noqa: BLE001 — sender 契约不抛，这是防御
                logger.error(
                    f"[im-feishu] 卡片 PATCH 异常 message_id={message_id}: "
                    f"{describe_error(e)}"
                )
            if ok:
                logger.info(f"[im-feishu] 卡片 PATCH 成功 message_id={message_id}")
                return True
            logger.error(
                f"[im-feishu] 卡片 PATCH 失败 message_id={message_id} —— "
                "fallback 发新消息"
            )
        else:
            logger.warning("[im-feishu] 卡片回调没带 open_message_id —— 直接发新消息")
        if fallback_text:
            self._delivery.send_text(open_id, fallback_text)
        return False

    # ── 内部 ──────────────────────────────────────────────────────────────
    def _catalog(self) -> EnabledModelCatalog:
        """当前可选模型全集（每次现取：owner 在设置里改完模型不必重启 IM）。

        聚合本体永不抛（内部逐层 best-effort 回退），这里只兜「配置整个读不出来」的
        极端情形 —— 返回空 catalog，由调用侧翻成人话，绝不把飞书这条链带崩。
        """
        loader = self._model_catalog or load_enabled_model_catalog
        try:
            return loader()
        except Exception as e:  # noqa: BLE001 — 取不到清单只该降级，不该断链
            logger.warning(f"[im-feishu] 取可用模型清单失败: {describe_error(e)}")
            # 空清单 **且 default_model 留空**：``load_enabled_model_catalog`` 自己的各条
            # 回退都保证 default_model 非空，落到这里 = 连配置都读不出来。此时报任何模型名
            # （哪怕代码级兜底常量）都是没依据的断言 —— 空串就是「不知道」的信号，
            # 调用侧据此挑不带模型名的文案。
            return EnabledModelCatalog()

    def _db(self) -> Any:
        if self._chat_db is None:
            from src.chat.db import ChatDb

            self._chat_db = ChatDb()
        return self._chat_db
