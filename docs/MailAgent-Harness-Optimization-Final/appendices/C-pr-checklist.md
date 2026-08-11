# 附录 C：逐 PR 验收清单

## C.1 通用

- [ ] 目标与非目标明确。
- [ ] 不顺带引入 Runtime/Workspace/Workflow 抽象。
- [ ] Feature Flag off 保持旧行为。
- [ ] TypeScript typecheck 全绿。
- [ ] Python tests 全绿。
- [ ] migration 幂等。
- [ ] TS/Python wire type mirror 同批更新。
- [ ] i18n 中英文完整。
- [ ] Tool Catalog 完整。
- [ ] Agent Eval hard gates 全绿。
- [ ] 安全关键通过率 100%。
- [ ] 有 Dogfood 记录。
- [ ] 有回滚方法。
- [ ] 审批 TTL：普通写 24h，高风险外发 2h。

## C.2 新工具

- [ ] 工具名称唯一。
- [ ] Tool Class 明确。
- [ ] Context Mode 明确。
- [ ] Skill gating 明确。
- [ ] approval tier 明确。
- [ ] 工具描述诚实说明自动/审批。
- [ ] 输入 schema strict。
- [ ] 外部输出有 fence。
- [ ] 审计行完整。
- [ ] UI fallback 可用。

## C.3 Session Schema

- [ ] `CHAT_DB_VERSION` bump。
- [ ] `src/chat/db.py` 头注释同步。
- [ ] 两份 TS 类型同步。
- [ ] Python读侧兼容缺列场景。
- [ ] 旧会话可正常显示。
- [ ] list/query 投影字段完整。
- [ ] 时间戳单位明确为 ms。

## C.4 Plan

- [ ] Prompt 与 Tool 同时上线。
- [ ] 复杂任务可更新 Plan。
- [ ] 简单任务不强制。
- [ ] Plan 无副作用。
- [ ] Headless 历史可查看。
- [ ] Plan Card 只读，用户编辑路径不存在。

## C.5 Agent Call

- [ ] 仅 manual_chat 注册。
- [ ] 目标 Agent 权威读取。
- [ ] instruction 不改配置。
- [ ] 子 Agent ToolSet 不扩大。
- [ ] idempotency。
- [ ] 等待固定 180 秒，schema/UI 无 wait 配置。
- [ ] `user_requested` 只影响外层卡并进入审计。
- [ ] result 内容有界。
- [ ] parent metadata。
- [ ] 子审批单一入口。
- [ ] Custom Agent 不能调用。

## C.6 Compact

- [ ] 无工具调用。
- [ ] 当前模型 minimal effort。
- [ ] 摘要固定结构。
- [ ] 旧消息不删。
- [ ] 最新边界生效。
- [ ] 引用和副作用保留。
- [ ] 失败不切边界。
- [ ] overflow 只重试一次。
- [ ] auto 仅在窗口已知时。
- [ ] 80%/90% 阈值，无 85% 二级提醒。
- [ ] 压缩后上下文目标 25%，整体不超过 64K。

## C.7 Follow-up Queue

- [ ] enqueue 不发模型请求。
- [ ] UI 可编辑/删除。
- [ ] Session 切换不丢。
- [ ] CAS claim。
- [ ] 重复 onFinish 不双发。
- [ ] 重启后 restored。
- [ ] 审批中不改变审批状态。
- [ ] Stop 后未送达队列转 `restored`，不清空。

## C.8 Trigger

- [ ] v1 兼容。
- [ ] v2 ID 唯一。
- [ ] OR/AND 语义正确。
- [ ] disabled 不触发。
- [ ] dedupe 正确。
- [ ] per-Agent 串行。
- [ ] firedAt 与 Session createdAt 区分。
- [ ] external payload fenced。
- [ ] Calendar 纯时间变化不触发 change run。
- [ ] 时间变化重排 before_start。
- [ ] Event ID + business hash 在 60 秒内合并。

## C.9 Skill Creator/Trust

- [ ] 草稿不执行。
- [ ] 文件路径 containment。
- [ ] 文件 hash。
- [ ] Script permission summary。
- [ ] 正例/负例测试。
- [ ] 发布确认。
- [ ] package hash trust。
- [ ] 修改撤销。
- [ ] Headless 条件全满足。
- [ ] Secret 不出日志。

## C.10 Agent Plugins

- [ ] plugin.json validation。
- [ ] ZIP bomb / traversal 防护。
- [ ] symlink containment。
- [ ] 组件独立失败。
- [ ] mcp.json 不自动连接。
- [ ] 导入进入 Draft。
- [ ] 导出无 Secret。
- [ ] License/NOTICE 保留。
