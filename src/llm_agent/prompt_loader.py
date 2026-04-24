"""PromptLoader: load per-mailbox prompt .md with mtime-based hot-reload.

Inbox / sent prompts are separate files; path configured in .env. If file is
missing, returns empty string (processor will still call LLM but without
mailbox-specific rules beyond the hardcoded constraints).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Dict

from loguru import logger

from src.config import config as cfg


@dataclass
class _Cached:
    text: str
    mtime_ns: int
    path: str


class PromptLoader:
    def __init__(self):
        self._cache: Dict[str, _Cached] = {}

    def get_for_mailbox(self, mailbox: str) -> str:
        path = (
            cfg.llm_sent_prompt_path
            if mailbox == "发件箱"
            else cfg.llm_inbox_prompt_path
        )
        return self._load(path)

    def _load(self, path: str) -> str:
        if not path:
            return ""
        abs_path = os.path.abspath(path)
        try:
            st = os.stat(abs_path)
        except FileNotFoundError:
            logger.warning(
                f"[llm-prompt] file not found: {abs_path}; using empty prompt"
            )
            return ""
        cached = self._cache.get(abs_path)
        if cached is not None and cached.mtime_ns == st.st_mtime_ns:
            return cached.text
        try:
            text = Path(abs_path).read_text(encoding="utf-8")
        except Exception as e:
            logger.warning(f"[llm-prompt] read failed {abs_path}: {e}")
            return ""
        self._cache[abs_path] = _Cached(
            text=text, mtime_ns=st.st_mtime_ns, path=abs_path
        )
        logger.info(f"[llm-prompt] loaded {abs_path} chars={len(text)}")
        return text
