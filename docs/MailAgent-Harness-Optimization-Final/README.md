# MailAgent Harness 渐进式优化体系

> 状态：**Q1–Q100 与 G1–G9 已冻结，可直接进入开发 Handoff**  
> 版本：2.1-final  
> 最后审阅：2026-08-07  
> 适用仓库：`ChenyqThu/MailAgent`  
> 评估基线：仓库 `main`，重点代码快照约为 `3cd1bc898f0d62c88520e37e6e9d5049890c1447`

这套文档是 MailAgent Harness 优化方案的收敛版。它吸收 Pi Mono、Craft Agents OSS、LobeHub、Anthropic Skill Creator 与 Vercel Agent Plugins 的优秀设计，但严格遵守以下产品边界：

1. **单用户、本地优先**：面向以邮件沟通为主的企业办公人员，当前核心画像是产品经理。
2. **Session 中心**：继续以收件箱、邮件详情和 AI Session 为主要工作载体，不建设 Workspace、WorkItem、团队账号或项目管理平台。
3. **AI SDK 单运行时**：继续使用 Vercel AI SDK，不建设 Runtime SPI，不引入 Pi/Craft/Lobe 作为第二运行时。
4. **渐进式增强**：不重写 Harness，不一次性重构工具系统；所有能力独立 Feature Flag、独立测试、可单独回滚。
5. **Custom Agent 是主扩展单元**：Prompt 表达工作方法，Skill 提供可复用方法与脚本，Connector 提供外部工具，Trigger 决定何时运行。
6. **Notion 是重要知识与执行源**：通过 MCP Connector 检索、读取和写入，不在 MailAgent 内复制项目管理数据模型。
7. **安全底线不回退**：工具 `auto / ask / off`、服务端二次授权、审批绑定、外部内容围栏、Skill 供应链与 Exec 结构化规则继续有效。

## 快速入口

- [单文件合并版](./MAILAGENT_HARNESS_OPTIMIZATION_MASTER.md)
- [开发 Handoff](./15-development-handoff.md)
- [已接受决策](./13-accepted-decisions.md)
- [Grill 结论与实现期确认规则](./grill.md)
- [文档 Manifest](./docs-manifest.yaml)

## 文档导航

| 文档 | 用途 |
|---|---|
| [CHANGELOG.md](./CHANGELOG.md) | 从旧版平台化方案到最终渐进方案的变化 |
| [00-executive-summary.md](./00-executive-summary.md) | 最终结论、范围、近期主线与非目标 |
| [01-current-state-assessment.md](./01-current-state-assessment.md) | 当前实现盘点、已具备能力与真实缺口 |
| [02-product-vision-and-scope.md](./02-product-vision-and-scope.md) | 产品定位、用户场景和范围边界 |
| [03-target-architecture.md](./03-target-architecture.md) | 不换框架前提下的目标架构 |
| [04-custom-agent-2.md](./04-custom-agent-2.md) | Custom Agent 2.0、多 Trigger、委派与模板 |
| [05-ai-sdk-harness-enhancements.md](./05-ai-sdk-harness-enhancements.md) | Plan、Compact、Steering 和运行体验 |
| [06-connectors-skills-plugins.md](./06-connectors-skills-plugins.md) | Connector、Skill Creator、可信脚本、Agent Plugins |
| [07-session-context-compaction.md](./07-session-context-compaction.md) | Session 查询、来源字段、跨 Session 与压缩 |
| [08-office-scenarios-and-templates.md](./08-office-scenarios-and-templates.md) | 标案、会前准备、项目跟进等模板场景 |
| [09-security-policy-governance.md](./09-security-policy-governance.md) | 权限、审批、委派、Trigger 与 Skill 安全 |
| [10-eval-observability-reliability.md](./10-eval-observability-reliability.md) | Eval、日志、可靠性与回归门禁 |
| [11-implementation-roadmap.md](./11-implementation-roadmap.md) | P0–P9 小步实施顺序 |
| [12-code-change-map.md](./12-code-change-map.md) | 现有源码到每个 PR 的修改点 |
| [13-accepted-decisions.md](./13-accepted-decisions.md) | Grill Q1–Q100 的已接受决策 |
| [14-comparison-matrix.md](./14-comparison-matrix.md) | 对 Pi、Craft、LobeHub 等的最终借鉴结论 |
| [15-development-handoff.md](./15-development-handoff.md) | 可直接交给 Coding Agent 的开发 Handoff |
| [grill.md](./grill.md) | G1–G9 最终决议，以及开发 Agent 何时必须向 Owner 确认 |

## 独立参考研究

- [references/01-pi-mono.md](./references/01-pi-mono.md)
- [references/02-craft-agents-oss.md](./references/02-craft-agents-oss.md)
- [references/03-lobehub.md](./references/03-lobehub.md)
- [references/04-vercel-agent-plugins.md](./references/04-vercel-agent-plugins.md)
- [references/05-anthropic-skill-creator.md](./references/05-anthropic-skill-creator.md)

## 附录

- [appendices/A-contracts.md](./appendices/A-contracts.md)：建议类型与 API 契约
- [appendices/B-data-model.md](./appendices/B-data-model.md)：最小数据库变更草案
- [appendices/C-pr-checklist.md](./appendices/C-pr-checklist.md)：逐 PR 验收门禁
- [appendices/D-glossary.md](./appendices/D-glossary.md)：术语表
- [appendices/E-source-index.md](./appendices/E-source-index.md)：源码索引

## 推荐阅读顺序

开发负责人：`00 → 01 → 11 → 12 → 15 → appendices/C`  
产品与交互：`02 → 04 → 05 → 08 → 13`  
安全评审：`06 → 09 → appendices/A/B`  
参考研究：先读 `14`，再按需进入 `references/`。

## 核心 Handoff 结论

```text
不换 AI SDK
不建 Runtime 抽象
不建 WorkItem/Workspace
不做团队账号
不做通用 Workflow Engine

先修 plan_update 不一致
→ 强化 Session 来源与查询
→ 增加主 Agent 调用 Custom Agent
→ 增加 /compact 与自动 Compact
→ 增加运行中 Follow-up Queue
→ 升级多 Trigger、线程和日历触发
→ 引入 Skill Creator 与可信 Skill 版本
→ 最后支持 Agent Plugins 的 Skill 导入/导出
```
