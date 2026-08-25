"""审批卡 preview —— 服务端按真实 payload 生成（L4 批次 1 #6）。

## 为什么不在 gateway 拼

gateway 的 ``approvalInputPreview``（``frontend/src/ai-gateway/chatRun.ts``）只认识
**模型给的 args**：挑 ``to`` / ``subject`` / ``body`` 拼一行，认不出就整段
``JSON.stringify``。问题是写工具的一部分载荷是**服务端派生的**：

- ``email_draft_reply`` 不传 ``to`` 就是「让服务端算 reply-all 收件人」——审批时刻
  用户在卡上看不到真实收件人，执行完才有 ``final_to`` 回显；
- ``calendar_event_reschedule`` 只带一个 ``ical_uid``——「改期前是什么样」在岛 / 飞书
  卡上全靠模型自述（桌面 ``CalendarApprovalCard`` 已经改成现查，但那三个面拿不到）。

范式取自 ``CalendarApprovalCard``：**事实由服务端现查，模型只出提案**。

## 覆盖面（首批）

======================================  ==========================================
工具                                     服务端事实
======================================  ==========================================
``email_draft_reply``                   最终收件人 / 抄送 / 主题（走 ``compose_plan``
                                        dry-run，与执行同一条派生，不是另抄一份）
``calendar_event_reschedule``           事件现标题 + 现起止（``calendar_event`` 行）
======================================  ==========================================

其余工具一律返回 ``None`` —— 调用方（gateway 两处产出点）据此 fail-open 回落旧文案。

🔴 **有意不覆盖** ``email_prepare_send``：它的收件人 / 主题 / 正文全是模型显式给的，
服务端没有任何派生或现值可查。再生成一遍只是把模型自述换个壳重讲一次，反而让用户
以为这行字被服务端核对过 —— 比不覆盖更毒。要新增覆盖前先问：这个工具有没有服务端
派生值或库内现值？没有就别进这张表。
"""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING, Any, Callable, Optional

from loguru import logger

if TYPE_CHECKING:  # pragma: no cover - typing only
    from src.config import Config
    from src.services.context import ServiceContext

# 与 gateway ``approvalInputPreview`` 同一个上限：飞书审批卡（``src/im/cards.py``）
# 按「上游已截到 ≤180」渲染，岛 envelope 亦按一行摘要展示。
APPROVAL_PREVIEW_MAX_CHARS = 180

# 收件人最多列几个，超出折成「等 N 人」——直接靠 180 截断会把最后一个地址切半。
_ADDR_DISPLAY_CAP = 4


def _one_line(text: str) -> str:
    """折叠空白 + 截到 ``APPROVAL_PREVIEW_MAX_CHARS``（镜像 gateway 的 clip）。"""
    one = " ".join((text or "").split())
    if len(one) > APPROVAL_PREVIEW_MAX_CHARS:
        return one[:APPROVAL_PREVIEW_MAX_CHARS] + "…"
    return one


def _fmt_addrs(addrs: list[str]) -> str:
    """``['a@x','b@y']`` → ``'a@x, b@y'``；超过展示上限折「等 N 人」。"""
    clean = [a.strip() for a in addrs if isinstance(a, str) and a.strip()]
    if not clean:
        return ""
    if len(clean) <= _ADDR_DISPLAY_CAP:
        return ", ".join(clean)
    head = ", ".join(clean[:_ADDR_DISPLAY_CAP])
    return f"{head} 等 {len(clean)} 人"


def _join_addr_list(value: Any) -> Optional[str]:
    """模型 args 的收件人列表 → 逗号串（``None`` = 未覆盖，让服务端推导）。

    语义镜像执行链上**两步**（缺一步就会在卡上少报收件人）：
    ① ``normalizeAddrs``（``frontend/src/ai-gateway/tools/write.ts``）—— 只留非空的
       trim 后字符串，清空后为空 → ``undefined``；
    ② ``domainClient.draftReply`` + serve-api ``_compose_request_from_body._join``
       —— 非空才带上 ``to``，即**空列表不是「清空」而是「没有覆盖」**。

    只做 ② 的话，``to: ["  "]`` / ``to: [null]`` 这类"非空但清完为空"的列表在 preview
    里变成「收件人 (空)」，执行时却照样 reply-all 发出去 —— 正是本模块要消灭的那类
    「卡上比现实少」。上游任一步改了语义，本函数跟着改。
    """
    if not isinstance(value, list):
        return None
    clean = [x.strip() for x in value if isinstance(x, str) and x.strip()]
    return ",".join(clean) if clean else None


def _preview_email_draft_reply(
    tool_input: dict, ctx: "ServiceContext", settings: "Config"
) -> Optional[str]:
    """``email_draft_reply`` —— 真实收件人（含服务端推导的 reply-all）+ 真实主题。

    走 ``MailWriteService.compose_plan``（文档化的「无 auth / 无写」dry-run，与执行
    共用 ``_prepare_draft``）—— 收件人 / 主题的派生因此**不可能**与执行漂移。
    ``quote_original=False``：preview 只消费 to/cc/subject，关掉引用块构造省一次正文
    读，收件人与主题不受它影响。
    """
    internal_id = tool_input.get("internal_id")
    if not isinstance(internal_id, int) or isinstance(internal_id, bool):
        return None

    from src.services.mail_write import ComposeRequest, MailWriteService

    mode = tool_input.get("mode")
    body = tool_input.get("body_markdown")
    request = ComposeRequest(
        internal_id=internal_id,
        mode=mode if mode in ("reply", "reply-all") else "reply-all",
        to=_join_addr_list(tool_input.get("to")),
        cc=_join_addr_list(tool_input.get("cc")),
        bcc=_join_addr_list(tool_input.get("bcc")),
        body_text=body if isinstance(body, str) and body else None,
        quote_original=False,
    )
    plan = MailWriteService(ctx).compose_plan(request)

    to_line = _fmt_addrs(plan.get("to") or [])
    cc_line = _fmt_addrs(plan.get("cc") or [])
    subject = (plan.get("subject") or "").strip()
    bits = [f"回复「{subject}」" if subject else "回复"]
    bits.append(f"收件人 {to_line}" if to_line else "收件人 (空)")
    if cc_line:
        bits.append(f"抄送 {cc_line}")
    return _one_line(" · ".join(bits))


def _fmt_instant(iso: Optional[str]) -> str:
    """UTC ISO → 本机墙钟 ``MM-DD HH:MM``（桌面卡也是按本地时区渲染的）。

    解析不了就原样回传 —— 与 ``CalendarApprovalCard.fmtTime`` 同款兜底（宁可显示原串，
    不显示一个编出来的时间）。
    """
    if not iso:
        return ""
    try:
        dt = datetime.fromisoformat(iso)
    except ValueError:
        return iso
    if dt.tzinfo is not None:
        dt = dt.astimezone()
    return dt.strftime("%m-%d %H:%M")


# 模型提案的 scope → 中文（词表来自 ``calendarEventRescheduleSchema.scope``）。
_RESCHEDULE_SCOPE_LABEL = {
    "series": "整个系列",
    "occurrence": "这一次",
    "future": "此后",
}


def _preview_calendar_event_reschedule(
    tool_input: dict, ctx: "ServiceContext", settings: "Config"
) -> Optional[str]:
    """``calendar_event_reschedule`` —— 现标题 + 现起止（库内事实）→ 模型提案的新时间。

    「现值」查 ``calendar_event``（CalDAV 同步的本地 SSoT），不看模型 args 里的任何
    描述性字段；「提案」原样透出模型给的 ``new_start`` / ``new_end``（它已是用户可读的
    墙钟串）。事件查不到 → ``None``（回落旧文案），不编一个「现值」。
    """
    event_id = tool_input.get("event_id")
    if not isinstance(event_id, str) or not event_id.strip():
        return None
    recurrence_id = tool_input.get("recurrence_id")

    from src.calendar_sync.service import CalendarService

    svc = CalendarService(db_path=settings.sync_store_db_path, cfg=settings)
    event = svc.get_event(
        ical_uid=event_id.strip(),
        source="caldav",
        recurrence_id=recurrence_id if isinstance(recurrence_id, str) and recurrence_id else None,
    )["event"]

    summary = (event.get("summary") or "").strip() or "(无标题)"
    cur_start = _fmt_instant(event.get("dtstart_iso"))
    cur_end = _fmt_instant(event.get("dtend_iso"))
    current = f"{cur_start}→{cur_end}" if cur_start and cur_end else (cur_start or "现时间未知")

    new_start = str(tool_input.get("new_start") or "").strip()
    new_end = str(tool_input.get("new_end") or "").strip()
    proposed = f"{new_start}→{new_end}" if new_start and new_end else (new_start or "?")

    scope = _RESCHEDULE_SCOPE_LABEL.get(str(tool_input.get("scope") or "series"), "")
    tail = f"（{scope}）" if scope else ""
    return _one_line(f"改期「{summary}」 {current} 改为 {proposed}{tail}")


_DERIVERS: dict[str, Callable[[dict, "ServiceContext", "Config"], Optional[str]]] = {
    "email_draft_reply": _preview_email_draft_reply,
    "calendar_event_reschedule": _preview_calendar_event_reschedule,
}


def build_approval_preview(
    tool_name: str,
    tool_input: Any,
    *,
    ctx: "ServiceContext",
    settings: "Config",
) -> Optional[str]:
    """按工具名产出一行服务端事实摘要；无派生器 / 取不到事实 → ``None``。

    ``None`` 是**正常返回值**，不是错误：调用方（gateway）据此回落自己那份模型自述
    文案（fail-open）。任何异常（行不存在 / 库读失败 / 派生器 bug）同样收敛成 ``None``
    —— 审批卡少一行事实是降级，弹不出卡才是事故。
    """
    deriver = _DERIVERS.get(tool_name or "")
    if deriver is None or not isinstance(tool_input, dict):
        return None
    try:
        preview = deriver(tool_input, ctx, settings)
    except Exception as exc:  # noqa: BLE001 —— 降级点，任何失败都只回落
        logger.warning(f"[approval-preview] {tool_name} 派生失败，回落模型自述: {exc}")
        return None
    if not isinstance(preview, str):
        return None
    preview = preview.strip()
    return preview or None
