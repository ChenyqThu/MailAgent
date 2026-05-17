"""ping-island envelope 字符串 i18n loader.

来源：``frontend/ISLAND-PLUGIN.md`` §7.3 + REVIEW-LOG M-14（mtime 失效）.

- 文件位置：``~/.mailagent/plugins/ping_island/locales/{lang}/island.json``
- 缓存策略：按 ``lang`` 缓存 ``(mtime, dict)``；mtime 变化（用户改 locale 文件）自动重载
- 占位符：i18next 风格 ``{{name}}`` → 转 ``str.format`` 友好的 ``{name}``，同时对原文里的 ``{}`` 字面量做 escape，避免邮件主题里出现 ``{Order #123}`` 时 ``.format`` 抛 KeyError
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Dict, Optional, Tuple

LOCALES_DIR = Path.home() / ".mailagent" / "plugins" / "ping_island" / "locales"
_SUPPORTED_LANGS = {"zh-CN", "en-US"}
_DEFAULT_LANG = "en-US"

# cache: lang -> (mtime, dict)
_cache: Dict[str, Tuple[float, Dict[str, str]]] = {}


def _resolve_lang(override: Optional[str] = None) -> str:
    """决定 active locale；``override`` 优先，其次 env ``PING_ISLAND_LANG``，再 ``LANG``，兜底 en-US."""
    candidate = override or os.environ.get("PING_ISLAND_LANG", "system")
    if candidate and candidate != "system" and candidate in _SUPPORTED_LANGS:
        return candidate

    env_lang = os.environ.get("LANG", "")
    # macOS: zh_CN.UTF-8 / en_US.UTF-8
    base = env_lang.split(".")[0].replace("_", "-")
    if base in _SUPPORTED_LANGS:
        return base
    # 兼容仅前缀（``zh`` / ``en``）
    if base.startswith("zh"):
        return "zh-CN"
    if base.startswith("en"):
        return "en-US"
    return _DEFAULT_LANG


def _load(lang: str) -> Dict[str, str]:
    path = LOCALES_DIR / lang / "island.json"
    if not path.exists():
        return {}
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return _cache.get(lang, (0.0, {}))[1]

    cached = _cache.get(lang)
    if cached is not None and cached[0] == mtime:
        return cached[1]

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return {}
        _cache[lang] = (mtime, data)
        return data
    except (OSError, json.JSONDecodeError):
        # 文件损坏；返回上次成功缓存的内容（如果有）避免 t() 全 fallback 到 key
        return cached[1] if cached else {}


_VAR_RE = re.compile(r"\{\{\s*(\w+)\s*\}\}")


def _format_template(tmpl: str, kwargs: Dict[str, object]) -> str:
    """渲染 ``{{name}}`` 模板，对原文的 ``{}`` 字面量做 escape 防 KeyError."""

    # 第一步：把 i18next ``{{name}}`` 替换成一个不可能与字面量冲突的占位 ``\x01name\x02``
    def _to_marker(match: "re.Match[str]") -> str:
        return f"\x01{match.group(1)}\x02"

    marked = _VAR_RE.sub(_to_marker, tmpl)
    # 第二步：将原文里残留的 ``{``/``}`` 字面量 escape
    marked = marked.replace("{", "{{").replace("}", "}}")
    # 第三步：还原占位为 Python ``{name}`` 形态
    marked = marked.replace("\x01", "{").replace("\x02", "}")

    try:
        return marked.format(**{k: str(v) for k, v in kwargs.items()})
    except (KeyError, IndexError):
        # 模板有 ``{{x}}`` 但 kwargs 没传 x → 退回原模板（避免 envelope 编码失败）
        return tmpl


def t(key: str, *, lang: Optional[str] = None, **kwargs: object) -> str:
    """主入口：按 ``lang`` 取模板并渲染；缺失返回 ``key`` 自身（便于排查）."""
    active = _resolve_lang(lang)
    tmpl = _load(active).get(key)
    if tmpl is None and active != _DEFAULT_LANG:
        # 退化到默认语言
        tmpl = _load(_DEFAULT_LANG).get(key)
    if tmpl is None:
        return key
    if not kwargs:
        return tmpl
    return _format_template(tmpl, kwargs)


def reload_locale(lang: Optional[str] = None) -> None:
    """主动失效缓存。用户切语言或编辑 locale 文件后可调用."""
    if lang is None:
        _cache.clear()
    else:
        _cache.pop(lang, None)


def resolve_lang(override: Optional[str] = None) -> str:
    """暴露给其他模块用，便于把 ``mailagent.lang`` 写进 envelope metadata."""
    return _resolve_lang(override)
