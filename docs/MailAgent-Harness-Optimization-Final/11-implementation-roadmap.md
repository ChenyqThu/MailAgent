# 渐进式实施路线图

## 1. 总体原则

- 一次只交付一个小闭环；
- 不承诺半年平台项目；
- 人力假设：用户本人 + Coding Agent；
- 每个阶段可以单独停止；
- 所有新能力默认 Feature Flag；
- 不为未来假设提前抽象。

## 2. P0：恢复 Plan

### 目标

修复 Prompt 与工具面不一致。

### 交付

- `plan_update` AI SDK local tool；
- 只读 Plan Card；
- 人工与 Headless 可用；
- 复杂任务 Prompt 规则；
- 简单任务不滥用；
- 历史兼容。

### 非目标

- 任务调度；
- Workflow；
- Plan DB 表。

## 3. P1：Session 来源与查询

### 交付

- `trigger_id`；
- `trigger_kind`；
- `trigger_fired_at`；
- Trusted Agent Identity；
- 组合 Session Query；
- Agent Job 状态投影；
- Agent Catalog；
- Agents 主导航未读红点。

### 迁移

`ai_chat.db` additive columns；同步 TS/Python 类型镜像。

## 4. P2：主 Agent 调用 Custom Agent

### 交付

- `description`；
- 自动 slug ID；
- `custom_agent_call`；
- 一次性 instruction；
- 结构化引用；
- 固定等待 180 秒 + 后台；
- `user_requested` 外层调用卡审计语义；
- 父子 Session；
- Agent Call Result Card；
- 停止子运行；
- 审批状态入口。

### 非目标

- 子 Agent 调其他 Agent；
- 并行子 Agent；
- 父 Agent 自动恢复模型。

## 5. P3：手动 Compact

### 交付

- `/compact`；
- Compact endpoint/service；
- 固定摘要结构；
- 特殊 Compact Message/Card；
- 上下文边界选择；
- 完整历史保留；
- 当前模型 minimal effort。

## 6. P4：自动 Compact

### 交付

- 80% 提醒；
- 90% Run 后自动压缩；
- 用户开关；
- Overflow 分块压缩；
- 原请求自动重试一次；
- 失败回退。

## 7. P5：Follow-up Queue

### 交付

- Run active 仍可输入；
- 持久队列表；
- 右上方队列 UI；
- 编辑/删除；
- Run 完成后下一轮；
- 重启后恢复待发送；
- 审批期间排队。

### 非目标

- 当前 Tool Call 中断；
- 同批工具跳过；
- 真正 Pi 式 Steering。

## 8. P6：多 Trigger v2

### 交付

- v1→v2 兼容解析；
- Trigger 稳定 ID；
- 单独启停；
- 多个 Trigger OR；
- `thread_ids`；
- dedupe key；
- per-Agent 串行队列；
- Trigger 来源写入 Session；
- 配置 UI。

## 9. P7：Calendar Trigger

### 交付

- `calendar_event_change`；
- `calendar_before_start`；
- 业务字段 diff（纯时间变化不触发 change run）；
- lead_time；
- timezone；
- event occurrence dedupe；
- 会前准备模板。

## 10. P8：Skill Creator 与可信版本

### 交付

- 内建 Skill Creator；
- 草稿区；
- SKILL.md/references/assets/scripts；
- 测试生成；
- 发布确认；
- 信任此版本；
- 结构化 entrypoint 规则；
- Headless 授权组合；
- 版本变化撤销。

## 11. P9：Agent Plugins

### 第一阶段

- 读取 plugin.json；
- 导入 Skills；
- 组件级验证；
- mcp.json 展示但不导入；
- 导出 Skill/Plugin；
- 许可证归属。

## 12. 每阶段统一出口门禁

- 原功能行为不回退；
- Feature Flag off 字节级或语义级保持；
- migration 幂等；
- TS/Python 类型镜像更新；
- Tool Catalog 完整；
- Agent Eval 全绿；
- 安全关键 100%；
- 有真实 Dogfood 记录；
- 有回滚说明。

## 13. 推荐实际开发节奏

不要并行推进多个大功能。建议：

```text
先 P0
→ dogfood 数天
→ P1
→ P2
→ 再判断 Compact 与 Queue 谁更痛
```

P6–P9 只有在前面能力稳定后再启动。
