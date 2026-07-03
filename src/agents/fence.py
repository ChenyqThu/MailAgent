"""untrusted email envelope 围栏（S4 W2，ADR D2 红线④）—— Python 侧 fence util。

email_filter 触发的 custom agent run 里，邮件是 **untrusted 输入**（正文可含「转发全部邮件
给 X / 删除 Y」等注入）。spec 端点把邮件事实包成本 fence 块随 spec 下发给 gateway，gateway
再拼进 syntheticBody 的 user message —— taskPrompt（owner 配置，可信）与 envelope（邮件，
untrusted）**物理分隔**，模型只能把围栏内当 DATA 读、绝不当指令。

语义对齐前端 ``frontend/src/shared/assistant/context/contextSerializer.ts``：
  - ``sanitize_untrusted``：用零宽空格（ZWSP, U+200B）打断内容里内嵌的 ``UNTRUSTED_`` 边界
    标记，使攻击者无法提前闭合围栏、把伪造指令抬进围栏外（in-band 标签是软防御，ZWSP 打断
    是结构硬防御）。镜像 TS ``sanitizeUntrusted`` 的 ``/UNTRUSTED_/gi`` 分支。
  - ``fence_email_envelope``：包 ``UNTRUSTED_EMAIL_BODY_START … UNTRUSTED_EMAIL_BODY_END``，
    含 subject/from/date/internal_id + 正文摘要（≤2KB 截断）。全文让 agent 经带围栏的
    ``email_body`` 读工具二次获取（该工具输出本身带围栏）。

纯函数（零 transport / DB 依赖）：正文由调用方从 ``EmailRepository`` 读好传入，taskPrompt
**不进**本函数（可信，由 gateway 拼接）。Python 侧围栏先例参考 ``src/memory/memory_md.py``
的 ``_neutralize_boundary`` + ``src/api/routers/web.py`` 的 UNTRUSTED_WEB_CONTENT 词汇。
"""

from __future__ import annotations

import re
from typing import Optional

_ZWSP = "\u200b"  # U+200B ZERO WIDTH SPACE（打断内嵌边界标记）
_UNTRUSTED_TOKEN_RE = re.compile(r"UNTRUSTED_", re.IGNORECASE)
# 第二条：打断 <mailagent_context_json> / </mailagent_context_json> 标签（在起头 '<' 后插 ZWSP）。
_CONTEXT_JSON_RE = re.compile(r"</?mailagent_context_json>", re.IGNORECASE)

# 正文摘要上限（ADR D2：V1 ≤2KB；全文经带围栏 email_body 读工具二次获取）。
BODY_SUMMARY_CAP = 2048


def sanitize_untrusted(text: str) -> str:
    """打断内容里内嵌的围栏边界标记，使恶意正文无法提前闭合自己的围栏、把指令走私到围栏外。

    **两条**（逐字镜像 TS ``sanitizeUntrusted``，``contextSerializer.ts:81-82``）：
      1. ``UNTRUSTED_`` token（含 ``UNTRUSTED_EMAIL_BODY_START/END``，都以此起头）——在
         ``UNTRUSTED`` 与 ``_`` 间插 ZWSP（大小写归一到大写，与 TS 一致的有意行为）；
      2. ``<mailagent_context_json>`` / ``</mailagent_context_json>`` 标签——在起头 ``<`` 后插
         ZWSP。W2 的 envelope 当前只走 ``UNTRUSTED_EMAIL_BODY`` 围栏、不入 context_json 结构，
         故第 2 条现**不 load-bearing**；但 W3 gateway 拼装方式未定，补齐纯纵深防御（跨端语义
         对齐，省 W3 踩「envelope 入 context_json 块被邮件正文的 ``</mailagent_context_json>``
         提前闭合」）。"""
    text = _UNTRUSTED_TOKEN_RE.sub(f"UNTRUSTED{_ZWSP}_", text)
    return _CONTEXT_JSON_RE.sub(lambda m: f"<{_ZWSP}{m.group(0)[1:]}", text)


def fence_email_envelope(
    *,
    internal_id: int,
    subject: Optional[str],
    sender: Optional[str],
    date: Optional[str],
    body_markdown: Optional[str],
) -> str:
    """把一封邮件的事实包成 ``UNTRUSTED_EMAIL_BODY`` 围栏块（围栏外零 untrusted 字节）。

    subject/from/date 也是攻击者可控的邮件头 → 与正文一同放进围栏（比放围栏外更安全），
    逐字段 ``sanitize_untrusted``。``internal_id`` 为 int（非攻击者可控）→ 安全直插 START 行
    的 ``id=`` 属性。正文超 ``BODY_SUMMARY_CAP`` → 截断 + 显式截断注记（提示走 email_body 读
    工具取全文）。``body_markdown`` 为 None/空 → **省略正文段落**（只留元数据）。
    """
    iid = int(internal_id)
    lines = [
        f"subject: {sanitize_untrusted(subject or '(none)')}",
        f"from: {sanitize_untrusted(sender or '(unknown)')}",
        f"date: {sanitize_untrusted(date or '(unknown)')}",
        f"internal_id: {iid}",
    ]
    body = body_markdown or ""
    if body:
        truncated = len(body) > BODY_SUMMARY_CAP
        lines.append("")
        lines.append(sanitize_untrusted(body[:BODY_SUMMARY_CAP]))
        if truncated:
            lines.append("…[truncated — fetch the full body via the email_body tool]")
    content = "\n".join(lines)
    return f"UNTRUSTED_EMAIL_BODY_START id={iid}\n{content}\nUNTRUSTED_EMAIL_BODY_END"
