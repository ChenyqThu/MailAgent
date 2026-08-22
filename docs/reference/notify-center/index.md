# 统一通知中心

> 铃铛 + 持久化通知面：后台任务完成/待办/系统告警的第一公民载体（区别于 3 秒即逝的 toast）。

> 常青参考文档。过程产物（PRD/设计/执行计划）见 `.trellis/tasks/08-20-notification-center/`
> （local-only）。

## 何时读哪篇

| 文件 | 何时读 | 内容 |
|---|---|---|
| [`notification-center.md`](./notification-center.md) | 动 `src/notify/center*` / `notification` 表 / 通知铃铛面板前 | 数据模型（v68）/ `NotifyCenter` 写面契约 / SSE 事件 / REST 端点 / 已接信源 / 前端消费 / M2-M3 展望 / 运维 SQL |
