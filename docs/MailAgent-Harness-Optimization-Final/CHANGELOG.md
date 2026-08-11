# 文档体系变更记录

## 2.1-final — 2026-08-07

完成 G1–G9 最后一轮 Grill，并消除开发文档中的剩余默认值冲突。

### 冻结默认值

- `custom_agent_call` 固定等待 **180 秒**，第一版不向用户暴露 `wait_seconds`；
- 接受模型在 `manual_chat` 中自报 `user_requested=true`，用于跳过高风险 Agent 的**外层调用卡**；该标记必须审计，且不能改变子 Agent 的工具权限或内部审批；
- 普通写审批 TTL 为 **24 小时**，高风险外发审批 TTL 为 **2 小时**；
- Compact 在 80% 提醒、90% 自动，不增加 85% 二级提醒；压缩后上下文目标为模型窗口约 25%，并设置绝对上限；
- Agent Plugins 第一版只导入/导出 Skill，不导入 MCP；
- Calendar 以 Event ID + 业务内容 hash 去重；同一 Event 仅时间变化不触发 `calendar_event_change`，但必须重排 `calendar_before_start`；
- Plan Card 第一版只读，仅由模型更新；
- Stop 当前 Run 后保留 Follow-up Queue，并转为 `restored`，等待用户确认发送。

### 文档维护

- `grill.md` 改为“Grill 已关闭 + 实现期确认规则”；
- 更新 Handoff、契约、路线图、安全、Eval 与源码修改地图；
- 修复并生成 `docs-manifest.yaml`；
- 重新生成合并版与发布压缩包。

## 2.0-final — 2026-08-07

基于 Q1–Q100 Grill 重写。

### 删除近期主线

- Runtime SPI、Pi Runtime、Graph Runtime；
- CompiledRunPlan 与 Canonical AgentEvent 大重构；
- Durable Operation 平台；
- Workspace、Project、WorkItem 和 Work Inbox；
- 团队账号、多租户与 SaaS 控制面；
- 通用 Workflow/Automation Builder；
- 第一阶段 Webhook Trigger。

### 新增或强化

- Session-centered 产品边界；
- `plan_update` 最小恢复；
- `/compact`、90% 自动 Compact 和 Overflow Recovery；
- 持久 Follow-up Queue；
- Custom Agent Description、多 Trigger v2、Thread 与 Calendar Trigger；
- Trusted Agent Identity 与组合 Session Query；
- 主 Agent `custom_agent_call` 与父子 Session；
- Skill Creator、可信 Skill 版本；
- Vercel Agent Plugins 外部兼容层；
- P0–P9 开发 Handoff；
- 无阻塞项的独立 `grill.md`。

### 研究文档

新增独立：

- Vercel Agent Plugins；
- Anthropic Skill Creator。

Pi、Craft 和 LobeHub 文档改为最终决策下的“借鉴而不替换”版本。
