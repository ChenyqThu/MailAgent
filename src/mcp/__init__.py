"""MCP (Model Context Protocol) 交付面 —— 把 MailAgent Skill manifest 暴露为 MCP tools。

stdio JSON-RPC wrapper（``mailagent_mcp``）：tools 从 manifest 生成（不手写第二套定义），
经 scoped Bearer key 打 serve-api ``/api/skills`` + ``/api/skills/invoke``。
"""
