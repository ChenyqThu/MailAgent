# 同步任务

> 主链路之外的一次性 / 补偿性同步任务。

> 常青参考文档。过程产物（PRD/设计/执行计划）见 `.trellis/tasks/`。

## 何时读哪篇

| 文件 | 何时读 | 内容 |
|---|---|---|
| [`history-sync.md`](./history-sync.md) | 动 `src/sync/history_sync.py` / backend 的 `scan_history_window` / `/api/history-sync` / 设置-同步「历史邮件」前 | 同步历史邮件：两段式执行 / 与收新邮件并行的四条规则 / provenance 钩子门控 / 状态存放 / 终态语义 / 已知限制 |
