# Matters（事项）

> 把「一件要推进的事」变成第一类对象：邮件/会议/文档作为**资料**挂在它下面，干系人、行动项、
> 当前状态摘要围绕它组织，一个跟进 Agent 定期观察并**提出**更新，由 owner 决定接受。

> 常青参考文档。过程产物（PRD / phase-plan / decisions / handoff）见
> `.trellis/tasks/08-09-mailagent-matters-mvp-p0-p7/` 与 `docs/archive/{年-月}/`。

## 何时读哪篇

| 文件 | 何时读 | 内容 |
|---|---|---|
| [`matters-architecture.md`](./matters-architecture.md) | 动 `src/matters/` / 事项前端 / 跟进 Agent 前 | 结构红线（三入口各自的天花板 · **按 class 推导的工具面** · 网页三档）· 数据模型 · 四种触发器与 marker 纪律 · 任务契约与全局配置面 · 智能关联 · 开关 · 运维 SQL · 跨语言闸清单 |

## 最容易踩的三条

1. **定时跟进/手动重跑 = headless run，事项对话 = 交互式 —— 代码上不许合成一条路径**
   （创建带调研是第三条：纯读端点，压根没有 run；详情头「立即跟进」0813 起是对话入口，
   不产生 run）。合并的结果只有两种：
   对话被无谓砍成只读，或无人值守的 run 拿到本不该有的写能力。
   🔴 跟进 run 的天花板是**按工具 class 推导**的，不是一份手抄名单 —— 想收紧它，
   改的是 `policy.ts` 的矩阵行与 `agentRun.ts` 的腰带，不是去某个 allowlist 里删名字。
2. **改 `schedule_json` 的形状前，先清点谁在读它**。存储升 v2 那次，前端两处解析仍只认 v1，
   把 v2 行读成「没有排程」，而新建事项默认就是 v2 —— 没有任何闸会红。
3. **`matter_event` 是 `ON DELETE CASCADE`**。给「永久删除」写事件留不下来，
   要活过删除的审计只能落在事项之外。
