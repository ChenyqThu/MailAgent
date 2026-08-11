# Eval、可观测性与可靠性

## 1. 继续扩展现有 Agent Eval

不建立第二套 Eval。继续使用：

- Task；
- Trace；
- Rubric；
- Tool Catalog；
- 硬规则；
- Baseline。

## 2. P0 Plan Eval

新增：

- 复杂跨源任务必须出现 plan_update；
- 简单任务禁止无意义 Plan；
- Plan step 状态可更新；
- 不存在 `plan_update` 幻觉失败。

## 3. Session Query Eval

覆盖：

- 按 agent_id 查询自己的运行；
- 按时间范围；
- 按 trigger kind；
- FTS + 结构化筛选；
- 权限关闭时不能查全部历史；
- 运行状态正确投影；
- 无命中诚实返回。

## 4. Agent Call Eval

### 硬规则

- 主 Agent 只能调用现有 Agent；
- instruction 不扩大权限；
- 父子 Session 关系完整；
- 同 tool call 重放不重复创建子 Agent Run；
- 子 Agent 审批只在子 Session；
- 结果卡不谎报 completed；
- 超时后返回 running；
- Custom Agent 不能调用其他 Custom Agent。
- `user_requested=true` 只跳过外层调用卡并进入审计，不跳过子 Tool 审批；
- 同步等待固定 180 秒，Tool schema 不暴露等待时间；
- 普通写审批 24h、高风险外发 2h，过期后只能进入 `approval_expired`。

### 场景

- 快速只读 Agent；
- 慢 Agent 转后台；
- 等待审批；
- 失败；
- 停止子运行；
- Connector 不可用；
- 主 Agent 引用子结果。

## 5. Compact Eval

### 质量

摘要必须保留：

- 用户目标；
- 事实；
- 决定；
- 来源；
- 副作用；
- 审批；
- 待办。

### 硬规则

- 旧消息不删除；
- 有效边界正确；
- 最新 Compact 生效；
- 失败不切换边界；
- 80% 提醒、90% 触发，且不存在 85% 二级提醒；
- Overflow 最多重试一次；
- Compact 调用没有工具。

### 回归任务

将同一长 Session 在 Compact 前后运行关键问题，比较：

- 事实正确性；
- 引用；
- 用户约束；
- 已执行动作；
- 待处理事项。

## 6. Follow-up Queue Eval

- Run active 时可排队；
- 逐条删除；
- 编辑取回 Composer；
- 顺序保持；
- Run 完成后只发送一次；
- Session 切换不丢；
- 应用重启后不自动发送；
- 等待审批时不误判批准/拒绝；
- Stop 不清空尚未发送队列；队列转为 `restored`，等待用户确认。

## 7. Trigger Eval

### 多 Trigger

- 旧 v1 可读；
- v2 多 Trigger OR；
- 单 Trigger 条件 AND；
- 稳定 ID；
- 单独启停；
- 未知 kind 拒绝。

### Email Thread

- 正确 Thread 命中；
- 相同邮件幂等；
- 不同 Thread 不误触发；
- Thread + sender/subject/folder 组合。

### Calendar

- 创建触发；
- 标题、组织者、参与人、地点/链接、议程/正文、取消状态变化触发；
- 同一 Event 仅开始/结束时间变化不触发 change run；
- 时间变化会重排 before_start；
- 仅 ETag 变化不触发；
- 60 秒窗口内相同业务内容 hash 合并；
- before_start 正确计算时区和 lead_time；
- 重复 occurrence 幂等。

## 8. Skill Creator Eval

- 生成合法 SKILL.md；
- 描述能触发正确场景；
- 负例不触发；
- 脚本必要性说明；
- 脚本权限声明；
- 草稿不自动执行；
- 发布后 hash 正确；
- 版本变化撤销信任；
- Headless 三锁/四锁生效。

## 9. Agent Plugins Eval

- 合法 plugin.json；
- 目录逃逸拒绝；
- Symlink 逃逸拒绝；
- 单个坏 Skill 不阻塞其他；
- mcp.json 只展示；
- Secret 不导出；
- 导入后进入草稿区。

## 10. 可观测字段

建议日志/指标：

```text
plan.created / plan.updated
compact.started / completed / failed
compact.tokens_before / estimated_after
queue.enqueued / edited / canceled / delivered / restored
agent_call.started / backgrounded / completed / failed
trigger.id / kind / dedupe_key
skill.trust_granted / revoked
plugin.import_component_result
```

## 11. SLO 建议

不是商业 SLA，仅作为本地质量目标：

- Session 查询 P95 < 500ms（不含完整内容读取）；
- Queue 写入 < 100ms；
- Agent Call 创建 job < 1s；
- 重复 Tool Call 不产生第二个子 Run；
- Compact 失败 0 数据损坏；
- Trigger 重复同步 0 重复副作用；
- 安全关键 Eval 100% 通过。

## 12. Dogfood 清单

每个阶段至少由真实用户完成：

- 一个普通邮件场景；
- 一个 Notion 跨源场景；
- 一个审批场景；
- 一个失败场景；
- 一个应用重启或 Session 切换场景。
