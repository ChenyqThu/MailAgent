"""事项导出（P7）：一份机器读的 JSON + 一份人读的 Markdown。

两条纪律：

1. **链接资源只导出引用，不导出正文。** 外部系统仍是资料内容的权威，事项只持有指针与摘录；
   把正文复制进导出文件既会让文件无边界膨胀，也会把「按不可信数据处理」的资料正文
   搬到一个没有围栏的地方。
2. **导出不是备份。** 它是给人看 / 给别的工具吃的快照，不承诺能原样导回（没有 id、没有版本号
   的往返保证）。真正的备份走 SQLite 库文件本身。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Mapping

from .service import MatterService

#: v2（2026-08-19）：`matter.goal` 由「背景与目标合体」变成只有目标，另起
#: `matter.background`。消费方按 export_version 分流，别对 v1 的 `goal` 按新语义解读。
EXPORT_VERSION = 2


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    try:
        return datetime.fromtimestamp(int(value) / 1000, tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError):
        return None


def _resource_reference(item: Mapping[str, Any]) -> dict[str, Any]:
    """资料一律导出成引用。摘录/正文/缓存内容有意不含在内。"""
    resource = item.get("resource") if isinstance(item.get("resource"), Mapping) else item
    link = item.get("link") if isinstance(item.get("link"), Mapping) else {}
    return {
        "kind": resource.get("kind"),
        "provider": resource.get("provider"),
        "external_key": resource.get("external_key"),
        "title": resource.get("title"),
        "url": resource.get("canonical_url"),
        "pinned": bool(link.get("pinned")),
        "linked_at": _iso(link.get("created_at")),
    }


def export_matter(service: MatterService, public_id: str) -> dict[str, Any]:
    """机器读的完整快照（不含资料正文，不含时间线原始 payload）。"""
    matter = service.get_matter(public_id)["matter"]
    items = service.list_items(public_id)
    stakeholders = service.list_stakeholders(public_id)
    resources = service.list_resources(public_id)

    return {
        "export_version": EXPORT_VERSION,
        "exported_at": _iso(service.clock_ms()),
        "matter": {
            "public_id": matter["public_id"],
            "title": matter["title"],
            "background": matter["background"],
            "goal": matter["goal"],
            "goal_checks": matter.get("goal_checks", []),
            "type": matter["matter_type"],
            "tags": matter.get("tags", []),
            "status": matter["status"],
            "health": matter["health"],
            "priority": matter["priority"],
            "due_at": _iso(matter["due_at"]),
            "current_summary": matter["current_summary"],
            "summary_at": _iso(matter["summary_at"]),
            "summary_by": matter["summary_by_kind"],
            "created_at": _iso(matter["created_at"]),
            "updated_at": _iso(matter["updated_at"]),
        },
        "items": [
            {
                "kind": item["kind"],
                "title": item["title"],
                "description": item.get("description"),
                "status": item.get("status"),
                "due_at": _iso(item.get("due_at")),
            }
            for item in items
        ],
        "stakeholders": [
            {
                "name": person.get("display_name"),
                "email": person.get("email_normalized"),
                "organization": person.get("organization"),
                "role": person.get("role"),
                "waiting_on": bool(person.get("is_waiting_on")),
            }
            for person in stakeholders
        ],
        "resources": [_resource_reference(item) for item in resources],
    }


def _md_escape(value: Any) -> str:
    return str(value or "").replace("|", "\\|").replace("\n", " ")


def export_matter_markdown(service: MatterService, public_id: str) -> str:
    """人读版。结构跟着详情页走，读的人不用再学一套组织方式。"""
    data = export_matter(service, public_id)
    matter = data["matter"]
    lines: list[str] = [f"# {matter['title']}", ""]

    meta = [
        f"**{matter['public_id']}**",
        f"状态 {matter['status']}",
        f"健康度 {matter['health']}",
        f"优先级 {matter['priority']}",
    ]
    if matter["due_at"]:
        meta.append(f"截止 {matter['due_at'][:10]}")
    lines += [" · ".join(meta), ""]
    if matter["tags"]:
        lines += ["标签：" + "、".join(str(tag) for tag in matter["tags"]), ""]

    if matter["current_summary"]:
        stamp = f"（{matter['summary_at'][:16]}）" if matter["summary_at"] else ""
        lines += [f"## 当前状态{stamp}", "", matter["current_summary"], ""]

    # v61：背景与目标是两个独立字段，各占一个平级小节。老方案（合存一段，外面再套
    # 一层「## 背景与目标」）会让正文里的同级小标题与外层标题平起平坐，层级是塌的。
    if matter["background"]:
        lines += ["## 背景", "", matter["background"], ""]
    if matter["goal"]:
        lines += ["## 目标", "", matter["goal"], ""]
    checks = matter["goal_checks"] or []
    if checks:
        lines += ["### 完成标志", ""]
        lines += [f"- [{'x' if check.get('done') else ' '}] {check.get('t', '')}" for check in checks]
        lines += [""]

    if data["items"]:
        lines += ["## 条目", ""]
        for item in data["items"]:
            status = f" — {item['status']}" if item.get("status") else ""
            due = f"（截止 {item['due_at'][:10]}）" if item.get("due_at") else ""
            lines.append(f"- **{item['kind']}** {item['title']}{status}{due}")
        lines.append("")

    if data["stakeholders"]:
        lines += ["## 干系人", "", "| 姓名 | 邮箱 | 角色 | 等待中 |", "| --- | --- | --- | --- |"]
        for person in data["stakeholders"]:
            lines.append(
                f"| {_md_escape(person['name'])} | {_md_escape(person['email'])} "
                f"| {_md_escape(person['role'])} | {'是' if person['waiting_on'] else ''} |"
            )
        lines.append("")

    if data["resources"]:
        lines += ["## 关联资料", ""]
        for resource in data["resources"]:
            title = _md_escape(resource["title"]) or resource["external_key"]
            pin = "📌 " if resource["pinned"] else ""
            lines.append(
                f"- {pin}[{title}]({resource['url']})"
                if resource["url"]
                else f"- {pin}{title}（{resource['kind']}）"
            )
        lines += [
            "",
            "> 资料只导出引用。内容权威仍在来源系统，这份文件不复制正文。",
            "",
        ]

    return "\n".join(lines).rstrip() + "\n"
