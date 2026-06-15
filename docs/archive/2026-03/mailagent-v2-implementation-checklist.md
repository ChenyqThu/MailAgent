> ⚠️ **已归档存史（2026-03）**：本 v2 实施清单（Notion 为核心 + Jarvis 巡检模式）已被后续架构取代。当前见 `docs/reference/`。

# MailAgent v2 实施清单（Jarvis + Notion Agent + MailAgent）

## 目标
构建“邮件闭环工作流”：
1) Mail.app → Notion（已完成）
2) Notion Agent 自动处理（已完成）
3) Jarvis 定时巡检 + 提醒 + 处理建议（本次上线）
4) 处理结果反向同步到邮件客户端草稿/状态（待实现）

---

## A. 巡检与提醒（已规划，先上线）
- [ ] 工作日固定两次巡检（早上/下午）
- [ ] 巡检范围：`Email Inbox`
- [ ] 关键过滤：
  - `Processing Status = pending` 视为未处理
  - `Action Required = true` 或 `Priority in (🟡重要, 🔴紧急)`
- [ ] 输出：
  - Top N 待处理邮件
  - 每封建议动作（回复/转发/延后/建日程）
  - 建议回复草稿（必要时）
- [ ] 节假日策略：巡检任务内先判断“是否节假日”，若是则跳过提醒

---

## B. 字段与语义统一（Schema Contract）
> 解决历史字段与现行流程不一致问题（如 `AI Review Status` vs `Processing Status`）

- [ ] 定义 V2 统一字段契约（Notion Email Inbox）
  - 处理状态：`Processing Status`（pending/AI Reviewed/...）
  - 是否需动作：`Action Required`
  - 优先级：`Priority`
  - 动作类型：`Action Type`
  - 建议回复：`Reply Suggestion`
  - 终稿回复：`Final Reply`（建议新增）
  - 回写状态：`Synced to Mail` / `Mail Sync Time`
- [ ] 在代码中做兼容映射（旧字段可读，新字段优先）
- [ ] 更新 README/CLAUDE 文档中的字段说明

---

## C. 反向同步接线（Notion -> Mail 客户端）

### C1. 调度接入
- [ ] 将 `NotionToMailSync.check_and_sync()` 接入主循环（`main.py` 或 `new_watcher.py`）
- [ ] 增加独立轮询间隔配置（例如每 2-5 分钟）
- [ ] 增加错误隔离，避免影响正向同步

### C2. 触发条件升级
- [ ] 当前条件（Reviewed + Synced=false）改为 V2 条件：
  - `Processing Status != pending`
  - 且存在 `Action Type` 或 `Final Reply`
  - 且 `Synced to Mail = false`

### C3. 动作能力扩展
- [ ] 保留：Mark Read / Flag / Archive
- [ ] 新增：Create Draft（核心）
  - 来源字段：`Final Reply`（无则退化使用 `Reply Suggestion`）
  - 目标：Outlook/Mail 草稿箱
  - 结果：回写草稿 ID/链接（若可行）到 Notion

---

## D. 草稿箱回写方案（建议优先）

### D1. 最小可行版本（MVP）
- [ ] 用 AppleScript 在 Mail.app 创建草稿（收件人/主题/正文）
- [ ] 支持 reply-to 原邮件线程（尽量保持 thread）
- [ ] 成功后更新 `Synced to Mail=true` + `Mail Sync Time`

### D2. 增强版
- [ ] 支持 Outlook for Mac 草稿创建（若 AppleScript 能力允许）
- [ ] 支持中英模板与签名
- [ ] 支持失败回退到 Mail.app 草稿

---

## E. 观测与可靠性
- [ ] 日志分层：forward-sync / reverse-sync / draft-sync
- [ ] 关键指标：
  - 正向同步成功率
  - 反向同步成功率
  - 草稿创建成功率
  - dead_letter 数量
  - 平均处理时延（邮件入库 -> 可回复）
- [ ] 告警规则：
  - dead_letter > 0
  - 反向同步连续失败 >= N

---

## F. Jarvis 在流程中的角色（固化）
- 角色 1：巡检官（定时发现“重要未处理”）
- 角色 2：决策助理（给优先级与处理建议）
- 角色 3：质量把关（输出可发送终稿）
- 角色 4：流程协调（推动 Notion Agent / MailAgent / 自动化任务联动）

---

## G. 建议实施顺序（两周）

### Week 1
- [ ] 上线定时巡检提醒（工作日早/下午）
- [ ] 完成字段契约与兼容映射
- [ ] 将 reverse sync 调度接入主循环（仅状态动作）

### Week 2
- [ ] 上线 Create Draft（Mail.app MVP）
- [ ] 打通 Notion `Final Reply` -> 草稿箱
- [ ] 加入指标看板与告警
- [ ] 文档与SOP收敛，形成稳定运行手册

---

## 验收标准（Done Definition）
- [ ] Lucien 每天仅需查看“待处理重点清单”即可掌握邮件风险
- [ ] 重要邮件可在 Notion 完成“审阅 -> 终稿 -> 草稿回写”闭环
- [ ] 99% 邮件处理无需在多系统间重复搬运
- [ ] 工作流在工作日可稳定自动运行（含失败重试与告警）
