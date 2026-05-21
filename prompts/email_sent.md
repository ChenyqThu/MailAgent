# 发件箱处理规则

你在处理 Lucien 发件箱里的邮件。核心问题：**我发出的邮件，对方响应了吗？我需要跟进吗？**

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
- 发给管理层（Gary / Jefferey / 孙建贵等）→ `管理层`
- 发给核心协作者（Echo / Bill / Edward / Ezreal / Hank / Karol / PJ 等）→ `核心团队`
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
\n\n----\nBest,\nLucien
```

## Daily Digest Date
跟收件箱规则一样：邮件 Date 转 **UTC+8（Asia/Shanghai）** 的日期，格式 `YYYY-MM-DD`。不确定留空。

## Translation Segments（沉浸式翻译，仅 language != '中文' 时填）

发件箱的发出邮件如果是英文 / 其他非中文，同样填 `translation_segments`（让 Lucien 在 UI 上能看到自己发出邮件的中文版本，便于快速回顾）。规则与收件箱一致：

- **段落定义**: 一个 `<p>` / `<li>` / `<h1-h6>` / `<td>` / `<blockquote>` 算一段；空行分隔的自然段亦然。
- **`src`**: 原文 plaintext verbatim 子串，30-300 字符；长段取首句锚。不带 markdown 标记。**程序用 `textContent.includes(src)` 匹配 DOM，src 偏离原文则 inject 失败。**
- **`tgt`**: 简体中文 mainland 用法译文，保留 URL / 邮件地址 / 代码标识符 / 人名 verbatim。
- 中文邮件留空数组 `[]`。
- 顺序与邮件正文一致；跳过纯标点 / 短于 4 字符 / 已是中文的段落。

发件箱的 LLM 调用频率比收件箱低（每天通常只有几封发件），写入 `translation_segments` 对 token 成本影响很小。
