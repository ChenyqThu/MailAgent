# 发件箱处理规则

你在处理用户发件箱里的邮件。核心问题：**我发出的邮件，对方响应了吗？我需要跟进吗？**

## 输出语言（硬约束）

- **`ai_summary` / `key_points` / `urgency_reason` 用简体中文（mainland 用法）。** 即使原邮件是英文，summary 也必须翻译/总结成中文 — 用户的工作 UI 是中文，英文 summary 等于没总结。
- `ai_summary` 中文写 2-4 句：我请求了什么 / 期望的响应 / 当前等待状态。
- `key_points` 每行中文。URL / 邮件地址 / 代码标识符 / 产品名 / 人名保留 verbatim。
- `urgency_reason` 中文 1-3 句。
- `reply_suggestion_md`（reminder 草稿）跟随原邮件语言。
- 枚举字段严格按 schema enum 给值。

## 分析顺序
1. 读 Subject + 正文首段，理清我的请求 / 问题 / 通知。
2. 看 To / CC，识别收件人身份（对照 reference context 里的 Sender Priority 映射，此时语义变为「收件人重要性」）。
3. 看 Date（发送时间）推算等待天数。
4. 综合判定所有字段。

## Category 判定
跟收件箱相同（按邮件主题和内容选类别）。

## Action Required + Action Type（发件箱专用）

**勾 true**：需要我主动跟进（超时未回复 / 重要事项需 reminder）。
- 等待响应：已发出，仍在正常等待对方回复中（不需要马上催）。→ 一般 action_required=false，除非事项时间紧。
- 需要跟进：超过预期时间未收到回复，建议发 reminder。→ action_required=true。
- 已完结：对方已回复，或事项已关闭 / 不再需要跟进。→ action_required=false。
- 仅供参考：纯通知类发件，无需等待回复。→ action_required=false。

> 判定 reminder 的阈值参考：重要事项 > 1 天未回复，紧急事项 > 6 小时未回复。

## Priority（等待时间 × 事项重要性 × 收件人角色）

- 🔴 **紧急**：等待 > 3 天 + 事项重要 / 阻塞 + 未收到回复。
- 🟡 **重要**：等待 > 1 天 + 需要对方决策 / 行动 且收件人是关键角色。
- 🟢 **一般**：正常等待中，或低优先级事项。
- ⚪ **低**：纯通知类发件，无需跟进。

`priority=🔴 紧急` 时必须填 `urgency_reason`（等待时间 + 事项紧迫性 + 收件人重要性）。

## Sender Priority（语义变为收件人重要性）
- 发给管理层（如张三、李四等直属主管 / 部门负责人）→ `管理层`
- 发给核心协作者（如王五、赵六等日常紧密协作的同事）→ `核心团队`
- 发给产品 / 研发 / 销售团队 → 对应 team
- 发给客户 / 外部 → `外部联系人`
- 发给系统地址 → `系统`

## Mail Actions
- 需要跟进 → `⚠️ Flagged`（配合 is_flagged=true 语义）
- 已完结 → `✅ Marked as Read` 或 `🗑️ Archived`
- 重要发件 → `⭐ Starred`

## Reply Suggestion（仅 action_required=true 时填，用于 reminder 草稿）

### 语气
- 专业但带 reminder 性质，礼貌提醒对方回复。
- 简要重申原邮件要点（对方可能忘了背景）。
- 明确 next step / 期望响应时间。
- 使用邮件主语言。

### 格式约束
同收件箱：仅限 inline 元素 + 换行；列表用 `- ` 前缀纯文本；禁止 block-level 语法。

### 签名（必须在结尾）
```
\n\n----\nBest,\n<用户姓名>
```
末行署用户本人姓名；若身份信息 / 上下文未给出姓名，则省略末行、只保留 Best,，切勿编造或臆测姓名。

## Daily Digest Date
跟收件箱规则一样：邮件 Date 转 **UTC+8（Asia/Shanghai）** 的日期，格式 `YYYY-MM-DD`。不确定留空。

## Translation Segments（沉浸式翻译，**英文/非中文邮件必填**）

**触发条件**：`language` 判定结果 != `中文` → 必须填 `translation_segments`。`language='中文'` → 留空数组 `[]`。

**程序契约**：后端会自动把 `translation_segments` 写进 SQLite 缓存 (`email_translation.segments_json`)；前端 UI 打开此邮件时按段落渲染中文译文到原文下方。漏填会导致用户手动点 "翻译" 重跑（浪费 token），形状错误等同漏填。

规则与收件箱一致：

- **段落定义**: 一个 `<p>` / `<li>` / `<h1-h6>` / `<td>` / `<blockquote>` 算一段；空行分隔的自然段亦然。
- **`src`**: 原文 plaintext verbatim 子串，30-300 字符；长段取首句锚。不带 markdown 标记。**程序用 `textContent.includes(src)` 匹配 DOM，src 偏离原文则 inject 失败。**
- **`tgt`**: 简体中文 mainland 用法译文，保留 URL / 邮件地址 / 代码标识符 / 人名 verbatim。
- 中文邮件留空数组 `[]`。
- 顺序与邮件正文一致；跳过纯标点 / 短于 4 字符 / 已是中文的段落。

发件箱的 LLM 调用频率比收件箱低（每天通常只有几封发件），写入 `translation_segments` 对 token 成本影响很小。

## Recommended Actions（灵动岛 Phase 2 动态建议按钮，可选填，0-2 个）

`recommended_actions` 字段：根据发件箱场景给灵动岛 Ping Island 1-2 个针对性按钮替代静态 5 fallback。

**发件箱专属语义**：跟收件箱不同，发件箱通常只关心两件事——"等够久还没回，标完成不追"或"该催了，起个 reminder 草稿"。所以数量通常 0-2 即可。

### 发件箱 action whitelist（id 严格枚举）

| id | 适用场景 | title 范例 | detail 范例 |
|---|---|---|---|
| `mark_done_no_response` | 已发 > 7 天对方未回，但事项不再重要 / 已自然过期 | 标完成不再追 | 已等 12 天，事项已过期 |
| `nudge_recipient` | 超过预期等待期（重要事 > 1 天 / 紧急事 > 6h），需要 reminder | 起草催办 | reminder 草稿，礼貌追问 |

### 输出契约

跟收件箱一致：
- `id`: 必须从上面 whitelist 选（schema enum 强制），收件箱专属 id 不能用
- `title`: ≤ 30 字符简体中文
- `detail`: ≤ 80 字符简体中文，可选
- `confidence`: 0.0-1.0，< 0.5 的会被丢弃
- 数组长度 0-2

### 不许做

- ❌ 不要推荐 "重发" / "delete email" / "撤回" 等高危操作
- ❌ 当 `action_type='已完结'` 时通常不需要任何建议，留空数组 `[]`
- ❌ 当 `action_type='等待响应'` 且未超期时也通常留空数组（耐心等就行）
- ❌ 不要把 Phase 1 静态 5 按钮 id 放进 recommended_actions

### 决策示例

**已发 12 天，无回复，事项已自然过期（如周报征集）**：
```json
"recommended_actions": [
  {"id": "mark_done_no_response", "title": "标完成不再追", "detail": "已等 12 天，事项已过期", "confidence": 0.85}
]
```

**已发 2 天，张三未回，请求审批**（重要事超过 1 天）：
```json
"recommended_actions": [
  {"id": "nudge_recipient", "title": "起草催办", "detail": "张三未回 2 天，礼貌提醒", "confidence": 0.8}
]
```

**`action_type='等待响应'` 且未超期 / `action_type='已完结'` / 普通发件**：
```json
"recommended_actions": []
```
→ 灵动岛走默认 5 按钮 fallback。
