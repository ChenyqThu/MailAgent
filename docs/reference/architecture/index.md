# 架构内核

> MailAgent 的系统级架构、状态机、SSoT 演进与后端服务化。

> 常青参考文档。过程产物（handoff/phase/complete）见 `docs/archive/{年-月}/`。

## 何时读哪篇

| 文件 | 何时读 | 内容 |
|---|---|---|
| [`architecture-internals.md`](./architecture-internals.md) | 改正/反向 sync、webhook、状态机、线程、多文件夹同步前 | 代码级架构内核：v3 流程 / 重试 / Processing Status / webhook / Sprint15 outbox / Sprint16 dual-backend |
| [`architecture_v4_sqlite_ssot.md`](./architecture_v4_sqlite_ssot.md) | 动 body/附件 SSoT 设计前 | v4 SQLite-SSoT 架构设计（Notion 退化为镜像，Phase 1-5） |
| [`v4-ssot-ops.md`](./v4-ssot-ops.md) | 做 v4 回填 / 灰度 / 运维前 | v4 SSoT 运维手册（双写开关、回填配方、运维 SQL） |
| [`service-layer-architecture.md`](./service-layer-architecture.md) | 改写操作 / 加传输端 / 动 src/services 前 | 后端服务层：统一写面 + CLI/serve-api in-process + async-jobs + 双层鉴权 + 前端 daemon 转发 |
| [`backend-service-migration-matrix.md`](./backend-service-migration-matrix.md) | 查写操作×传输端迁移状态 | 后端服务化迁移能力矩阵（活看板） |
| [`roadmap-post-cutover.md`](./roadmap-post-cutover.md) | 看短中长期规划 / EWS 关停应对前 | DavMail 切换后 Roadmap（含 EWS 2026-10 退役、Graph 路线） |
| [`davmail-write-path-trace.md`](./davmail-write-path-trace.md) | 退役 Notion 反向链路(B1) / 清 outbox 灰度死分支前 | davmail 写op×路径 trace + B1 反向链路现状判定 + AppleScript fallback 链 + B1 退役决策选项（人工介入点 + STOP 清单） |
