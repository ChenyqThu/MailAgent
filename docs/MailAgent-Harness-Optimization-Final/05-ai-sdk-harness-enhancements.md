# AI SDK Harness 核心增强

## 1. 原则

继续使用现有 Vercel AI SDK。近期增强聚焦：

- Plan；
- Compact；
- 运行中 Follow-up Queue；
- 确定性失败检测的小补强；
- 保持 ToolTrace、审批和 Detached Run 稳定。

不做：

- Runtime SPI；
- 替换 Agent Loop；
- 自研完整 Loop；
- Pi Runtime；
- Graph Runtime。

## 2. 恢复 `plan_update`

### 2.1 问题

系统 Prompt 仍要求复杂任务调用 `plan_update`，但 AI SDK 工具面已经没有可调用实现。

### 2.2 最小工具

```ts
interface PlanUpdateInput {
  goal: string;
  steps: Array<{
    id: string;
    title: string;
    status: 'pending' | 'in_progress' | 'done' | 'blocked' | 'unavailable';
    note?: string;
  }>;
}
```

属性：

- local；
- silent；
- 无审批；
- 无外部副作用；
- 不新增 plan 表；
- 作为 UIMessage Tool Part 持久化；
- 人工与 Headless Session 都可用；
- 第一版 Plan Card 只读，只允许模型通过 `plan_update` 更新。

### 2.3 使用规则

需要计划：

- 跨邮件、Notion、Calendar；
- 预计多个 Tool Call；
- 三个以上步骤；
- 长时间运行。

不需要计划：

- 单次检索；
- 简单总结；
- 翻译；
- 单封草稿。

## 3. Context Compact

### 3.1 用户入口

- Slash Command：`/compact`；
- 上下文环菜单：手动压缩；
- 已知 context window 达到 90%：当前 Run 完成后自动压缩；
- 80% 以上给出接近上限提醒；
- 用户可关闭自动 Compact。

模型 context window 未知时：

- 不自动触发；
- 保留手动 `/compact`。

### 3.2 模型选择

第一版：

```text
当前 Session 模型
+ tools disabled
+ thinking/effort = none 或 minimal
```

原因：当前模型已证明能接收这个 Session 的上下文规模。

后续可增加独立 Compact Model；若窗口不足，回退当前模型。

压缩后的模型输入目标为当前模型 context window 的 20%–30%，默认按 25% 计算，并设置 64K tokens 的整体绝对上限。摘要自身的生成预算建议不超过 8K tokens，并继续受模型实际 output limit 约束。

### 3.3 摘要结构

```markdown
## User goal
## Stable facts
## Decisions made
## Constraints and preferences
## Work completed
## Open questions
## Pending actions
## Important source references
## Tool side effects already performed
## Rejected or expired approvals
```

必须保留：

- 邮件 ID、Thread ID；
- Calendar Event ID；
- Notion 页面/Database；
- Report ID；
- 已经发送或写入的动作；
- 用户拒绝的动作；
- 未完成审批；
- 用户明确限制。

### 3.4 持久化

Compact 作为特殊 system message：

```json
{
  "kind": "compact",
  "compacted_through_message_id": 86,
  "first_kept_message_id": 87,
  "tokens_before": 91000,
  "estimated_tokens_after": 28000,
  "model": "..."
}
```

UI 显示专门卡片，不伪装为 Assistant 回答。

完整历史不删。

### 3.5 上下文装配

下轮送模型：

```text
System Prompt
+ 最新有效 Compact Summary
+ first_kept_message_id 之后的原始消息
```

旧 Compact 卡本身不重复送进模型，只使用最新边界。

### 3.6 Overflow Recovery

Provider 返回 context overflow：

```text
按安全窗口分块旧消息
→ 每块生成部分摘要
→ 合并摘要
→ 写 Compact 记录
→ 自动重试原请求一次
```

再失败则结束，不循环。

## 4. Follow-up Steering Queue

### 4.1 第一阶段语义

不尝试中断 AI SDK 当前 Tool Loop：

```text
Agent 运行中
→ 用户仍可输入
→ Enter 加入 Follow-up Queue
→ 当前 Run 完成
→ 队列内容作为下一轮用户消息自动发送
```

Stop 继续立即取消当前 Run。未送达队列不会被清空，而是统一转为 `restored`，等待用户编辑、删除或确认发送；第一版不提供“Stop 并清空队列”的快捷选项。

### 4.2 UI

队列位于 Composer 上方、靠右侧用户消息方向。

每条：

- 显示文本；
- 单独删除；
- 单独编辑；
- 编辑时取回 Composer；
- 顺序可见；
- 标明“将在当前任务完成后发送”。

### 4.3 持久化

使用 `ai_chat.db` 专门队列表：

```text
queued
claimed
sent
canceled
restored
```

理由：Detached Run 期间用户可能切换 Session 或卸载组件。

应用重启后，若旧 Run 已不存在：

- 不自动发送；
- 恢复为“待发送补充”；
- 由用户编辑、删除或确认发送。

### 4.4 多条消息

默认在下一轮按时间顺序合并，但保留逐条边界：

```xml
<queued_followups>
  <message>先不要写入 Notion。</message>
  <message>还要检查上周会议纪要。</message>
</queued_followups>
```

### 4.5 等待审批时

用户输入不代表批准或拒绝：

- 仍进入队列；
- 审批必须明确处理；
- UI 提示将在审批解决后送达。

### 4.6 第二阶段 Tool-boundary Steering

等待 AI SDK 提供更可靠支持后再实现：

```text
当前工具完成
→ 同批尚未执行工具 skipped_by_steering
→ 注入 Steering
→ 模型重新规划
```

## 5. 失败循环补强

已有 Prompt discipline 要求相同失败 2–3 次停止。可小步增加确定性 guard：

```text
tool_name
+ 规范化 input hash
+ error code
```

相同三元组连续达到 3 次：

- 不再自动执行第四次；
- 产生 Tool Result：`E_REPEATED_TOOL_FAILURE`；
- 要求模型换方法或报告未完成。

此功能可后置，不能修改现有错误语义或把不同输入误判为同一次失败。

## 6. 现有能力保持不动

- ToolTraceCard；
- Tool Approval Card；
- Detached Run；
- Stop endpoint；
- ActiveRunRegistry；
- UIMessage persistence；
- Smooth stream；
- A2UI card；
- AG-UI mirror。
