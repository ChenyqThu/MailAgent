# Grill 已关闭：G1–G9 决议与实现期确认规则

> Q1–Q100 与 G1–G9 已全部回答。**当前不存在阻塞 P0–P9 的产品未决问题。** 开发 Agent 应直接按本文与 `13-accepted-decisions.md` 实施，不应重新发起泛化需求讨论。

## 1. G1–G9 最终决议

| 编号 | 决议 |
|---|---|
| G1 | `custom_agent_call` 内部固定等待 **180 秒**；第一版不提供 UI 或 Tool 参数配置。超时后返回 `running` 并继续后台执行。 |
| G2 | 在 `manual_chat` 中接受模型自报 `user_requested=true`。该字段可跳过高风险 Agent 的**外层调用确认卡**，但必须写入审计；它不能扩大目标 Agent 权限，也不能跳过子 Agent 内部 Tool 审批。缺失或 false 时，高风险主动委派仍显示调用卡。 |
| G3 | 普通写操作审批 TTL = **24 小时**；高风险外发审批 TTL = **2 小时**。过期后明确记录 `approval_expired`，不能静默执行。 |
| G4 | Compact 后送入模型的上下文目标为窗口的 **20%–30%**，实现默认取 **25%**；整体目标上限建议 `min(contextWindow × 25%, 64K tokens)`，摘要生成输出预算建议不超过 8K tokens，并受模型实际 output limit 约束。 |
| G5 | Context 使用率 **80% 提醒、90% 自动 Compact**；不做 85% 二级提醒。 |
| G6 | Agent Plugins 第一版只处理 Skill；MCP、stdio 和 MailAgent 专属 extension 留待未来。 |
| G7 | Calendar 采用 `event_id + business_content_hash` 与 **60 秒合并窗口**去重。对同一 Event，若只有开始/结束时间变化，不触发 `calendar_event_change`；但必须更新 `calendar_before_start` 的调度时间。若标题、组织者、参与人、地点/链接、议程/正文或取消状态同时变化，则正常触发。 |
| G8 | Plan Card 第一版**只读**，只允许模型通过 `plan_update` 更新；用户不能直接编辑步骤。 |
| G9 | Stop 当前 Run 后，未送达 Follow-up Queue 不清空，统一转为 `restored`；由用户编辑、删除或确认发送。第一版不提供“Stop 并清空队列”的快捷选项。 |

## 2. 实现时必须向 Owner 确认的情况

开发 Agent 只有在出现以下情况时才应暂停并询问 Owner：

1. **必须改变已冻结语义**，例如把 180 秒改成可配置、让时间变化触发会议 Agent、允许 Custom Agent 递归调用或增加 Webhook；
2. **需要降低安全地板**，例如跳过子 Tool 审批、扩大 Connector/Exec 权限、把插件安装等同于信任；
3. **需要破坏性迁移或丢失兼容性**，例如删除旧 Session、无法兼容 Trigger v1、重建表可能丢历史；
4. **第三方库限制导致产品行为降级**，例如 AI SDK 无法实现已定义的队列/Compact/审批恢复语义，且没有兼容方案；
5. **准备新增公开产品面**，例如新的长期设置、全局导航、账号体系、Runtime 抽象或 MCP Plugin 导入，而这些不在 P0–P9 内。

建议在开发文档或 PR 中使用显式标记：

```text
[OWNER_CONFIRMATION_REQUIRED]
```

并说明：当前约束、可选方案、推荐项、影响范围与回滚方式。

## 3. 实现时不需要询问的情况

以下属于工程实现细节，开发 Agent 应自行选择并用测试证明，不要打断 Owner：

- 文件名、函数名和内部模块拆分；
- additive migration 的具体 SQL 写法；
- 内部缓存、重试、日志字段和索引；
- 与现有设计一致的视觉间距、图标和微交互；
- 在不改变上述产品语义前提下的性能优化；
- 测试 fixture、mock 和 Eval case 的组织方式；
- Bug 修复和类型镜像同步。

## 4. 需求真源优先级

发生冲突时按以下顺序处理：

```text
13-accepted-decisions.md
→ 本文件 G1–G9
→ 15-development-handoff.md
→ 专题文档与附录
→ 参考仓库研究文档
```

参考仓库文档只提供设计借鉴，不能覆盖 MailAgent 已冻结的产品边界。
