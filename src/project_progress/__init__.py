"""项目周报同步模块.

消费每周一定期发出的《【项目进度】研发项目deadline汇报_市场产品采购》邮件,
抽取 xlsx 附件中三个 sheet (Ongoing / Shipped / Suspended) 的项目, 过滤
BU == TPS-ENBU, upsert 到 Notion 项目进度库; 用 Sheet 2/3 的"已出货 / 已暂停"
作为状态权威信号, 替代 v1 时代的 diff 推断.

历史: v1 消费某转发版邮件 (单 sheet, 15 列); v2 起切到直接发件人版
(4 sheet, 信息更全, 状态更准).

参见 docs/reference/integrations/notion_markdown_api.md 和 CLAUDE.md 的 "项目周报同步" 章节.
"""
