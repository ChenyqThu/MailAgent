"""资料库（library）—— 受管多根文件树 + ``library.db`` 索引 + 领域写面。

设计 SSoT：``.trellis/tasks/09-02-library-knowledge-base/design.md``。
分层与 ``src/matters/`` 同形：``db``（开库 / DDL）→ ``paths``（多根 jail）→ ``repository``（查询）
→ ``service``（唯一写面）→ ``extract``（按需抽取）；serve-api 面在 ``src/api/routers/library.py``。
子模块各自 lazy import，包本身零副作用（``constants`` 是零依赖叶子，可被任何地方 import）。
"""
