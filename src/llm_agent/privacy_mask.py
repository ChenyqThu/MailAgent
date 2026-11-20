"""Python direct-SDK fallback 路径的双向隐私占位符脱敏（镜像 TS ``privacyMaskMiddleware.ts``）。

当桌面端 Embedded ai-gateway loopback 不可达、后台任务退回 Python 直连 SDK 时，若对应
provider 开启了 ``privacy_mask_enabled``，仍坚持 Fail-Closed 脱敏 + 入站还原 + 本地计数审计
（绝不落匹配明文）。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Tuple

_EXISTING_TOKEN_RE = re.compile(r"\[\[PII_[A-Z][A-Z0-9_]{0,23}_\d+\]\]")
_TAG_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,23}$")
_REDOS_NESTED_RE = re.compile(r"\([^)]*[+*][^)]*\)[+*?{]")

_ID_WEIGHTS = (7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2)
_ID_CODES = ("1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2")


class PrivacyMaskError(RuntimeError):
    """Fail-Closed sentinel raised when privacy rule compilation or masking fails."""

    code = "E_PRIVACY_MASK_FAILED"


@dataclass(frozen=True)
class _CompiledRule:
    category: str
    tag: str
    pattern: re.Pattern[str]
    validate: Optional[Callable[[str], bool]] = None


def _valid_china_id18(val: str) -> bool:
    if not re.match(
        r"^[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]$",
        val,
    ):
        return False
    total = sum(int(val[i]) * _ID_WEIGHTS[i] for i in range(17))
    return val[17].upper() == _ID_CODES[total % 11]


def _valid_luhn_bank_card(raw: str) -> bool:
    digits = re.sub(r"[\s-]", "", raw)
    if len(digits) < 16 or len(digits) > 19 or not digits.isdigit():
        return False
    total = 0
    double_digit = False
    for ch in reversed(digits):
        n = int(ch)
        if double_digit:
            n *= 2
            if n > 9:
                n -= 9
        total += n
        double_digit = not double_digit
    return total % 10 == 0


def compile_rules(config: Optional[Dict[str, Any]]) -> List[_CompiledRule]:
    raw = config if isinstance(config, dict) else {}
    raw_builtin = raw.get("builtIn") if isinstance(raw.get("builtIn"), dict) else {}
    built_in = {
        "secret": True,
        "id_card": True,
        "phone": True,
        "email": True,
        "bank_card": True,
        **raw_builtin,
    }
    rules: List[_CompiledRule] = []
    if built_in.get("secret"):
        rules.append(
            _CompiledRule(
                category="secret",
                tag="SECRET",
                pattern=re.compile(
                    r"\b(?:sk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{16,}|mak_[A-Za-z0-9_-]{12,}|"
                    r"AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b"
                ),
            )
        )
    if built_in.get("id_card"):
        rules.append(
            _CompiledRule(
                category="id_card",
                tag="ID_CARD",
                pattern=re.compile(r"(?<!\d)[1-9]\d{16}[\dXx](?!\d)"),
                validate=_valid_china_id18,
            )
        )
    if built_in.get("bank_card"):
        rules.append(
            _CompiledRule(
                category="bank_card",
                tag="BANK_CARD",
                pattern=re.compile(r"(?<!\d)(?:\d[ -]?){15,18}\d(?!\d)"),
                validate=_valid_luhn_bank_card,
            )
        )
    if built_in.get("phone"):
        rules.append(
            _CompiledRule(
                category="phone",
                tag="PHONE",
                pattern=re.compile(r"(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)"),
            )
        )
    if built_in.get("email"):
        rules.append(
            _CompiledRule(
                category="email",
                tag="EMAIL",
                pattern=re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"),
            )
        )

    custom_rules = raw.get("customRules") or []
    if not isinstance(custom_rules, list) or len(custom_rules) > 32:
        raise PrivacyMaskError("customRules exceeds limit or is invalid")
    for item in custom_rules:
        if not isinstance(item, dict) or not item.get("enabled"):
            continue
        rid = str(item.get("id") or "").strip()
        pattern = item.get("pattern")
        if not isinstance(pattern, str) or not pattern or len(pattern) > 256:
            raise PrivacyMaskError(f"invalid custom rule pattern: {rid}")
        if _REDOS_NESTED_RE.search(pattern):
            raise PrivacyMaskError(f"unsafe nested quantifier in rule: {rid}")
        tag = str(item.get("tag") or "").strip().upper()
        if not _TAG_RE.match(tag):
            raise PrivacyMaskError(f"invalid custom rule tag: {tag}")
        try:
            compiled = re.compile(pattern)
        except re.error as exc:
            raise PrivacyMaskError(f"invalid privacy rule '{rid}': {exc}") from exc
        if compiled.match("") is not None:
            raise PrivacyMaskError(f"privacy rule '{rid}' matches empty string")
        rules.append(_CompiledRule(category=f"custom:{rid}", tag=tag, pattern=compiled))
    return rules


class PythonMaskVault:
    """Request-scoped outbound mask & inbound unmask vault."""

    def __init__(self, config: Optional[Dict[str, Any]]) -> None:
        self._rules = compile_rules(config)
        self._val_to_tok: Dict[str, str] = {}
        self._tok_to_val: Dict[str, str] = {}
        self._tag_counters: Dict[str, int] = {}
        self._hits: Dict[str, int] = {}

    def _intern(self, value: str, category: str, tag: str) -> str:
        tok = self._val_to_tok.get(value)
        if tok is not None:
            self._hits[category] = self._hits.get(category, 0) + 1
            return tok
        n = self._tag_counters.get(tag, 0) + 1
        self._tag_counters[tag] = n
        tok = f"[[PII_{tag}_{n}]]"
        self._val_to_tok[value] = tok
        self._tok_to_val[tok] = value
        self._hits[category] = self._hits.get(category, 0) + 1
        return tok

    def mask_string(self, text: str) -> str:
        if not text or not self._rules:
            return text
        protected: List[Tuple[int, int]] = [
            (m.start(), m.end()) for m in _EXISTING_TOKEN_RE.finditer(text)
        ]
        candidates: List[Tuple[int, int, str, str, str]] = []
        for rule in self._rules:
            for m in rule.pattern.finditer(text):
                val = m.group(0)
                if not val:
                    raise PrivacyMaskError(f"rule '{rule.category}' matched empty text")
                s, e = m.start(), m.end()
                if any(s < pe and e > ps for ps, pe in protected):
                    continue
                if rule.validate is not None and not rule.validate(val):
                    continue
                candidates.append((s, e, rule.category, rule.tag, val))
        if not candidates:
            return text
        candidates.sort(key=lambda item: (item[0], -(item[1] - item[0])))
        out: List[str] = []
        cursor = 0
        for s, e, cat, tag, val in candidates:
            if s < cursor:
                continue
            if s > cursor:
                out.append(text[cursor:s])
            out.append(self._intern(val, cat, tag))
            cursor = e
        if cursor < len(text):
            out.append(text[cursor:])
        return "".join(out)

    def mask_system_blocks(self, blocks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        masked: List[Dict[str, Any]] = []
        for b in blocks or []:
            if isinstance(b, dict) and isinstance(b.get("text"), str):
                masked.append({**b, "text": self.mask_string(b["text"])})
            else:
                masked.append(b)
        return masked

    def unmask_string(self, text: str) -> str:
        if not text or not self._tok_to_val:
            return text
        return _EXISTING_TOKEN_RE.sub(
            lambda m: self._tok_to_val.get(m.group(0), m.group(0)), text
        )

    def unmask_value(self, value: Any) -> Any:
        if isinstance(value, str):
            return self.unmask_string(value)
        if isinstance(value, list):
            return [self.unmask_value(v) for v in value]
        if isinstance(value, dict):
            return {k: self.unmask_value(v) for k, v in value.items()}
        return value

    @property
    def hits(self) -> Dict[str, int]:
        return {k: v for k, v in self._hits.items() if v > 0}
