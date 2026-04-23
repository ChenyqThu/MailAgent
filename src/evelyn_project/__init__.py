"""Evelyn 周项目同步模块

消费 Evelyn (evelyn.wei@tp-link.com) 每周一晚转发的
"【项目进度】项目deadline汇报MMDD_市场产品"邮件,
抽取 xlsx 附件, 过滤 BU == TPS-ENBU 的项目, 按 Project Name 聚合,
upsert 到 Notion 项目进度库。

参见 docs/notion_markdown_api.md 和 CLAUDE.md 的 "Evelyn 项目同步" 章节。
"""
