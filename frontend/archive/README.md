# Archive — 早期前端规划文档（2026-05-16 归档）

这 7 份文档是 claude design 出 mockup + DESIGN.md 之前的早期前端规划。**2026-05-16
归档**，原因：信息密度被 `frontend/{DESIGN,ARCHITECTURE,PROJECT-PLAN,ISLAND-PLUGIN,BACKEND-INTERFACES,REMOTE-ACCESS,README}.md`
7 份新文档完全覆盖且更准。归档 ≠ 删除 —— 留作历史脉络与决策溯源。

## 7 份文档命运

| 文档 | 新归属 | 状态 |
|---|---|---|
| `frontend-design-handoff.md` | designer 已交付（即 `frontend/DESIGN.md` + mockup） | 任务包完成，归档 |
| `frontend-v1-feature-spec.md` | §1-3 V1 范围 + §8 信息架构 → 融入 `frontend/PROJECT-PLAN.md`；§9 动效 → 融入 `frontend/DESIGN.md`（已被 claude design 重写） | 信息已抽取，归档 |
| `frontend-v1-implementation-plan.md` | 7 Sprint → 被 `frontend/PROJECT-PLAN.md` 替代（含扩大后的 V1 + 并行开发指引） | 替代，归档 |
| `frontend-v1-tech-tradeoffs.md` | 12 个选型评分 → 决策已定 → `frontend/ARCHITECTURE.md` §2 引用结论；详细 trade-off 评分**不再需要** | 决策定稿，归档 |
| `frontend-integration-spec.md` | 4 个后端接口面 → 精简成 `frontend/BACKEND-INTERFACES.md` | 精简后归档原文（保留 §1-§7 详细命令组 / schema 索引） |
| `frontend-ping-island-integration.md` | Stage A/B 评估 → 被 `frontend/ISLAND-PLUGIN.md`（Hybrid 方案）取代 | 决策升级，归档 |
| `frontend-v2-remote-access.md` | V2 远程架构 → 精简成 `frontend/REMOTE-ACCESS.md`（保留全部架构决策） | 精简后归档原文 |

## 何时回到 archive 查

- 想看**为什么没选某技术**（如为什么不用 Tauri / Postgres / 自研 menubar app）
  → `frontend-v1-tech-tradeoffs.md` / `frontend-v2-remote-access.md` §1 / `frontend-ping-island-integration.md` §8
- 想看**早期 Sprint 拆分思路**（V1 单机版本计划，未含 designer 的 AI panel 扩大）
  → `frontend-v1-implementation-plan.md` §5
- 想看**ping-island 协议层细节**（BridgeEnvelope JSON schema / wire format / Swift Date 编码陷阱 / Python PoC 代码）
  → `frontend-ping-island-integration.md` §3 / §6
- 想看**早期决策时机**（每份文档头部的 "状态：调研稿 / 起草日期"）
  → 各文档头部 frontmatter

## 与新文档的引用关系

新文档**不会**反向引用 archive/ 里的文件（避免依赖归档）。如果新文档需要某段具体细节
（如某个 schema），直接复制粘贴或重写，archive 只是**历史只读快照**。

---

> Don't modify files in this folder. If you need to update info that lives here,
> update the corresponding new doc in `frontend/` instead, and leave the archive intact.
