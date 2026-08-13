"""通讯录 Contact Directory 域 (task 08-13)。

以邮箱为身份锚、以人为聚合单位的本地联系人事实库: matters 干系人与未来任何
需要「人」的域都引用它 (PRD `.trellis/tasks/08-13-contact-directory/prd.md`)。

模块:
- ``taxonomy``: 枚举单源 (contact 表 CHECK 值域) + function/seniority 词表派生
- ``repository``: SQLite 连接 (schema 由 sync_store v54 migration 拥有, 此处不建表)
- ``service``: 写面单源 (upsert / 合并 / 隐藏 / 改 kind / is_self / 曾用邮箱守卫
  / 聚合缓存校准) —— matters 侧经薄包装调用, 不各写一份
- ``scanner``: L0+L1 增量扫描器 (watermark 消化 email_metadata → 账本/锚点/聚合)

刻意保持轻 import: 顶层不 re-export 任何符号, 调用方按需 import 子模块
(new_watcher 的 flag-off 字节级 inert 依赖「不 import 就零成本」)。
"""
