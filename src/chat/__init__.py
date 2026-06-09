"""serve-api chat 子系统。

阶段 2（本模块当前）：``db.py`` — ai_chat.db 只读访问（远程 chat 历史查看端点）。
阶段 3（B-pure-unified 后续）：LLM 透传 proxy / chat 持久化 / notion-agent spawn / KOS 代理。

ai_chat.db = 前端 owned schema（``frontend/src/electron/main/chat_db.ts``，CHAT_DB_VERSION 4），
serve-api 只读它，schema 归前端 owns（勿在 Python 侧改 ai_chat.db schema）。
"""
