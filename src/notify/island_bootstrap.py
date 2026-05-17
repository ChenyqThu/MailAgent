"""首次启用 ping-island 时把 manifest + locale 资源写到用户家目录.

目录布局（``frontend/ISLAND-PLUGIN.md`` §4.1 / §4.2 / §7）::

    ~/.mailagent/plugins/ping_island/
      manifest.json
      locales/
        zh-CN/island.json
        en-US/island.json

Idempotent：
- 文件不存在 → 写入默认内容
- 文件已存在 → 跳过（不覆盖用户自定义）

被 ``main.py`` 启动时调一次（``PING_ISLAND_ENABLED=true`` 才触发）。
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict

log = logging.getLogger(__name__)

PLUGIN_DIR = Path.home() / ".mailagent" / "plugins" / "ping_island"


MANIFEST_DEFAULT: Dict[str, Any] = {
    "name": "MailAgent",
    "version": "0.1.0",
    "brand": "mail",
    "events": [
        "MailReceived",
        "MailReceivedUrgent",
        "LLMReviewed",
        "LLMReviewedUrgent",
        "MailCompleted",
        "SyncFailed",
        "DeadLetterAccum",
        "AIDraftStart",
        "AIDraftStream",
        "AIDraftReady",
    ],
    "socket_path": "/tmp/island.sock",
    "default_locale": "system",
}


LOCALE_ZH_CN: Dict[str, str] = {
    "mail.received.title": "新邮件 / {{sender}}",
    "mail.received.title.work": "💼 新工作邮件 / {{sender}}",
    "mail.received.title.personal": "📧 新个人邮件 / {{sender}}",
    "mail.reviewed.title": "AI 审核完成 / {{sender}}",
    "mail.urgent.title": "邮件需要处理 / {{sender}}",
    "mail.urgent.message": "{{action}} · {{priority}}\n\n{{subject}}",
    "mail.completed.title": "已完成 / {{subject}}",
    "mail.syncFailed.title": "同步失败 / {{internalId}}",
    "mail.syncFailed.message": "{{error}}",
    "mail.deadLetter.title": "{{count}} 封邮件进入死信",
    "mail.action.openMail": "打开 Mail.app",
    "mail.action.openNotion": "去 Notion 处理",
    "mail.action.createDraft": "创建回复草稿",
    "mail.action.createDraft.detail": "走 Mail.app draft",
    "mail.action.snooze1h": "稍后再看 (1h)",
    "mail.action.markDone": "标记完成",
    "ai.draft.start.title": "AI 起草中 / {{sender}}",
    "ai.draft.ready.title": "AI 草稿就绪 / {{sender}}",
    "ai.draft.ready.preview": "{{preview}}",
}


LOCALE_EN_US: Dict[str, str] = {
    "mail.received.title": "New mail / {{sender}}",
    "mail.received.title.work": "💼 New work mail / {{sender}}",
    "mail.received.title.personal": "📧 New personal mail / {{sender}}",
    "mail.reviewed.title": "AI reviewed / {{sender}}",
    "mail.urgent.title": "Mail Needs Action / {{sender}}",
    "mail.urgent.message": "{{action}} · {{priority}}\n\n{{subject}}",
    "mail.completed.title": "Done / {{subject}}",
    "mail.syncFailed.title": "Sync failed / {{internalId}}",
    "mail.syncFailed.message": "{{error}}",
    "mail.deadLetter.title": "{{count}} emails in dead letter",
    "mail.action.openMail": "Open Mail.app",
    "mail.action.openNotion": "Handle in Notion",
    "mail.action.createDraft": "Create reply draft",
    "mail.action.createDraft.detail": "Mail.app draft",
    "mail.action.snooze1h": "Snooze (1h)",
    "mail.action.markDone": "Mark done",
    "ai.draft.start.title": "AI drafting / {{sender}}",
    "ai.draft.ready.title": "AI draft ready / {{sender}}",
    "ai.draft.ready.preview": "{{preview}}",
}


def _write_if_missing(path: Path, content: str) -> bool:
    if path.exists():
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return True


def ensure_plugin_assets(plugin_dir: Path = PLUGIN_DIR) -> Dict[str, bool]:
    """确保 manifest + locale 文件存在；返回 ``{path: created?}``."""
    results: Dict[str, bool] = {}

    manifest_path = plugin_dir / "manifest.json"
    results[str(manifest_path)] = _write_if_missing(
        manifest_path,
        json.dumps(MANIFEST_DEFAULT, ensure_ascii=False, indent=2) + "\n",
    )

    locale_zh = plugin_dir / "locales" / "zh-CN" / "island.json"
    results[str(locale_zh)] = _write_if_missing(
        locale_zh,
        json.dumps(LOCALE_ZH_CN, ensure_ascii=False, indent=2) + "\n",
    )

    locale_en = plugin_dir / "locales" / "en-US" / "island.json"
    results[str(locale_en)] = _write_if_missing(
        locale_en,
        json.dumps(LOCALE_EN_US, ensure_ascii=False, indent=2) + "\n",
    )

    created = [k for k, v in results.items() if v]
    if created:
        log.info("[island] plugin assets bootstrapped: %s", created)
    return results
