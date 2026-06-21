"""MailAgent Skill 层 —— Python 权威 manifest（Phase 1 对外交付面单一真源）。

一个 Skill = tool schema + prompt fragment + SKILL.md + handler binding + auth/effect
policy。同一份 manifest 同时喂给 REST(``/api/skills``) / MCP(``src/mcp``) / skill pack，
未来也喂 Custom AI TS registry（Phase 2）—— 避免「第二套真源」。

执行铁律：handler 一律调 ``src/services`` / ``EmailRepository`` / ``ReportStore`` /
``run_report_once`` / ``src/chat/notion_agent.py``，**绝不 fork mailagent CLI**
（Phase 0 BASE-1 no-new-fork）。
"""
