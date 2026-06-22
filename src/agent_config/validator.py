"""RULES.md 安全 validator（PR6）—— 拦截明显的安全 floor 颠覆尝试。

设计纪律（Plan review §5）：**不做语义级「弱化」检测**（tar pit + 假安全感）。真正的安全保证是
**结构性**的 —— ``PRODUCT_SAFETY_FLOOR``（前端 TS 常量）始终 prepend 在用户文档之前，用户/agent
改 ``RULES.md`` 物理上无法删掉 floor 的字节；且 confirmation tier 在 dispatch loop 里强制（模型
prompt 文本控制不了 ConfirmToolDialog）。

本 validator 是 **belt-and-suspenders**：一个 deny-list，拦截把「忽略前文 / 绕过确认 / 无需确认
直接发删」等**明显越权指令**写进 RULES.md 的尝试，命中即拒 + 记 audit。它不能证明安全，只能挡住
最露骨的颠覆。
"""

from __future__ import annotations

import re
from typing import Optional

# 明显的 override / jailbreak 短语（小写匹配）。命中即拒 —— 这些写进 RULES.md 没有正当用途。
# 覆盖中英两类常见表述。保持「露骨越权」边界，不试图判定语义弱化。
_DENY_PATTERNS: tuple[str, ...] = (
    r"ignore (all |any )?(previous|prior|above|the) (instruction|rule|prompt|safety)",
    r"disregard (all |any |the )?(previous|safety|product|built-?in) (rule|instruction|floor)",
    r"override (the )?(safety|product|built-?in|system) (rule|floor|prompt|instruction)",
    r"bypass (the )?(confirmation|approval|safety|consent)",
    r"(no|without|skip(ping)?) (confirmation|approval|consent) (needed|required|necessary)",
    r"(send|delete|archive|reply-?all|forward) .{0,40}(without|no) (confirm|approval|asking)",
    r"you (may|can|should) (now )?(silently |automatically )?(send|delete|bulk|wipe)",
    r"(disable|turn off|ignore) (the )?(safety|guardrail|safety floor|product safety)",
    r"act as (an? )?(unrestricted|jailbroken|dan|developer mode)",
    r"these rules (supersede|override|take precedence over) (the )?(product|built-?in|safety)",
    r"忽略.{0,8}(安全|规则|指令|提示|前文|前述|限制)",
    r"无需(确认|批准|授权)",
    r"(直接|自动|静默)(发送|删除|归档|群发)",
    r"(绕过|跳过)(确认|审批|安全)",
    r"(关闭|禁用|忽略)(安全|护栏|安全底线)",
)

_COMPILED = tuple(re.compile(p, re.IGNORECASE) for p in _DENY_PATTERNS)

# R8（GPT-5.5 review）—— negation-aware 例外。一条**禁止**越权的规则（「禁止无需确认直接发送」
# 「不允许绕过确认删除」）本身是安全的，却含 deny-list 短语。命中越权 pattern 后，若同一行该匹配
# 之前的近窗里出现否定/禁止前缀，则视为安全 prohibition 放行（belt-and-suspenders，可容少量
# false-negative —— 真正的安全保证是结构性 floor + confirmation tier）。
_NEGATION_MARKERS: tuple[str, ...] = (
    "不允许", "不要", "不得", "不能", "不可", "禁止", "严禁", "请勿", "切勿", "拒绝", "杜绝",
    "never", "do not", "don't", "must not", "should not", "cannot", "can't", "won't",
    "forbid", "prohibit",
)
# 否定前缀与越权短语之间允许的最大间隔（字符）。够覆盖「不允许[无需确认]直接发送」这类整句。
_NEGATION_WINDOW = 40


def _has_negation_prefix(text: str, match_start: int) -> bool:
    """匹配点之前（同一行、限 _NEGATION_WINDOW 窗口）是否有否定/禁止前缀。"""
    line_start = text.rfind("\n", 0, match_start) + 1  # 无换行 → 0
    window = text[max(line_start, match_start - _NEGATION_WINDOW) : match_start].lower()
    return any(mark in window for mark in _NEGATION_MARKERS)


def validate_rules_content(content: str) -> Optional[str]:
    """检查 RULES.md 拟写内容是否含露骨的安全颠覆指令。

    返回 None = 通过；返回字符串 = 拒绝原因（命中的 deny-list 类别，供 audit / 报错）。
    仅当某个越权短语的匹配点之前**没有**否定/禁止前缀时才拒绝（R8：放行安全的 prohibition）。
    """
    text = content or ""
    for rx in _COMPILED:
        for m in rx.finditer(text):
            if _has_negation_prefix(text, m.start()):
                continue  # 安全的禁止句（「禁止无需确认发送」）→ 放行此匹配
            return (
                "RULES.md may not contain instructions that override or bypass the product "
                f"safety floor (matched a disallowed pattern near: '{m.group(0)[:60]}'). The "
                "built-in safety rules always take precedence and cannot be weakened here."
            )
    return None
