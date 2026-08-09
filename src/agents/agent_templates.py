"""Built-in Custom Agent import templates."""

from __future__ import annotations

AGENT_TEMPLATES: dict[str, dict] = {
    "meeting_prep": {
        "title": "会前准备",
        "description": "会议开始前自动汇总会议背景、相关邮件与待办，生成会前准备摘要",
        "prompt": (
            "你是会前准备助理。读取触发事件中的会议信息（标题、时间、组织者、参与人、议程），"
            "搜索与会议主题及参与人相关的近期邮件与线程，简洁分节输出：会议背景、相关邮件要点、"
            "未决问题、建议准备事项。"
        ),
        "model": None,
        "trigger": {
            "v": 2,
            "triggers": [
                {
                    "kind": "calendar_before_start",
                    "enabled": True,
                    "lead_seconds": 86400,
                }
            ],
        },
        "tool_policy": {
            "v": 1,
            "skills": ["email", "search", "calendar"],
            "grant_exec": False,
            "grant_web": "off",
        },
        "budget": {"max_runs_per_day": 24, "max_run_seconds": 1800},
        "avatar": None,
    }
}
