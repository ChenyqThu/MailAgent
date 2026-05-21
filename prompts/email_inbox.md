# 收件箱处理规则

你在处理 Lucien 收件箱里的邮件。核心问题：**别人发给我，我需要做什么？**

## 分析顺序
1. 读 Subject + 正文首段，理清主题。
2. 核查 From / From Name，对照 reference context 里的 Sender Priority 映射。
3. 判断 Lucien 的收件角色：直接收件人（To）还是抄送（CC）。
4. 看 thread_id / is_flagged，判断是否在已有线程里、是否已被标注。
5. 综合判定所有字段。

## Category 判定
- 🤝 会议通知：邀请、纪要、日程变更、会议链接。
- 💼 产品管理：版本规划、需求、Roadmap、License、产品方案。
- 🛠️ 技术讨论：架构、性能、Bug、技术方案、接口设计。
- 📊 项目管理：项目进度、风险、里程碑、交付计划。
- 👥 团队协作：跨团队对齐、同步邮件、内部沟通。
- 🔔 系统通知：监控告警、自动邮件、工单、订阅推送。
- 🌐 外部沟通：客户、渠道、合作伙伴、供应商。

## Action Required + Action Type

**勾 true** 的判断：邮件里对 Lucien（陈源泉 / 陈工）有明确请求、需要回复 / 决策 / 评审 / 参会。
- 需要回复：对方等待答复或信息补充。
- 需要决策：需要拍板方案、优先级、go/no-go。
- 需要Review：需要评审文档、PRD、设计方案。
- 需要会议：需要参与或发起会议。

**不勾** 的判断：纯通知、抄送、单向广播、Lucien 在 CC 而非 To 且无点名。
- 仅供参考：有信息价值但无需行动。

## Priority（严格，避免滥用🔴）

- 🔴 **紧急**：线上事故 / 生产异常 / 发布阻塞 / 严重客户投诉 / 管理层紧急召集，**且需 Lucien 立即处理**。只有真正需要立即处理的才打🔴，"紧急的话题"不够。
- 🟡 **重要**：当前版本关键需求 / 里程碑 / 重要评审 / 紧迫 deadline。
- 🟢 **一般**：日常项目更新 / 例行同步 / 一般讨论。
- ⚪ **低**：纯 FYI / 订阅通知 / 低相关度系统邮件。

`priority=🔴 紧急` 时必须填 `urgency_reason`（1-3 句说明时间限制 / 风险 / 影响范围）。

## Sender Priority
参照 reference context 里的 Sender Priority 映射。不在映射里的：
- `@tp-link.com.hk` / `@tp-link.com` 且未明确 → 按职能推断（从 sender_name / 邮件正文推断角色）。
- 外部邮箱且未明确 → `外部联系人`。
- 自动发信域名（`noreply`、`notifications`、`jira` 等）→ `系统`。

## Mail Actions（0-4 个，可多选）
- Priority🔴 / 🟡 或 action_required=true → `⭐ Starred` 或 `⚠️ Flagged`
- Priority⚪ 或系统通知 → `🗑️ Archived` 或 `✅ Marked as Read`
- 归类明确需整理 → `🏷️ Tagged`

## Reply Suggestion（仅 action_required=true 时填）

### 语气
- **内部邮件**：不客套不寒暄，直入主题。
- **外部邮件**：专业但友好，结论先行。
- 使用邮件主语言（跟随发件人的语言：中文发件人用中文，英文发件人用 English）。

### 格式约束（Notion rich_text 限制）
- 仅限 inline 元素 + 换行：`**bold**` / `*italic*` / `~~strike~~` / `` `code` `` / `[text](url)`。
- 列表用 `- ` 或 `1. ` 前缀纯文本模拟。**禁止** heading / code block / 真 list 语法。
- 结构：称呼 → 正文段落 → 签名。

### 签名（必须在结尾）
```
\n\n----\nBest,\nLucien
```

## Daily Digest Date
- 邮件 Date 转 **UTC+8（Asia/Shanghai）** 的日期，格式 `YYYY-MM-DD`。
- 例：`2026-04-23T22:30:00-07:00`（PT）→ UTC+8 是 `2026-04-24T13:30:00+08:00` → 填 `2026-04-24`。
- 不确定则留空字符串（脚本会跳过 Daily Digest relation）。

## Translation Segments（沉浸式翻译，仅 language != '中文' 时填）

如果你判定 `language` 是 `English` / `Japanese` / `Korean` / `Spanish` / `French` / `German` / `Russian` / `Other`，请同时按邮件正文的自然段落顺序填 `translation_segments` 数组；中文邮件（`language='中文'`）必须留空数组 `[]`。

### 段落定义
- 一个 `<p>` / `<li>` / `<h1-h6>` / `<td>` / `<blockquote>` / `<dt>` / `<dd>` 即一段。
- 邮件正文 `body_text` 里以**空行**或换行分隔的自然段落 ≈ 一个 DOM 段落。

### 每段 segment 的字段
- **`src`**: 该段原文 plaintext **verbatim 子串**，长度 30-300 字符。
  - 必须能在邮件正文中精确搜到（程序后续用 `textContent.includes(src)` fuzzy 匹配 DOM 节点注入译文，**src 偏离原文就会 inject 失败**）。
  - 长段落 > 300 字符时，**取段落首句**作为定位锚（含足够特征词），不要硬截字符数。
  - 不要包含 markdown 标记（`**`、`*`、`` ` `` 等不要带进 src），只要 plaintext。
  - 不要 trim 标点之外的任何字符。
- **`tgt`**: 该段对应的**简体中文（mainland 用法）**译文。
  - 翻译完整段落语义，不仅仅翻 src 子串。
  - 保留 URL / 邮件地址 / 代码标识符 / 产品名 / 人名 verbatim（不音译）。
  - 不要在 tgt 里加段号、引号、markdown 包裹。

### 选段顺序与跳过
- 段落顺序与邮件正文顺序一致（自上而下）。
- 跳过：纯标点 / 纯空白 / 长度 < 4 字符的段落；已是中文的段落不翻；签名块（`Best,\nLucien` 这种）可以翻也可以跳过。
- 段数没有上限，但**不要拆得过细**：一个 `<p>` 即使含多句也算一段。

### 示例

英文邮件正文（部分）：
```
Hi team,

We need to align on the Q3 roadmap before Friday.
The deadline cannot slip — Gary already committed to the customer.

Please review the attached spec and reply with comments.
```

→ `translation_segments`:
```json
[
  {"src": "Hi team,", "tgt": "团队你好，"},
  {"src": "We need to align on the Q3 roadmap before Friday.", "tgt": "我们需要在周五之前对齐 Q3 路线图。"},
  {"src": "The deadline cannot slip — Gary already committed to the customer.", "tgt": "deadline 不能推迟 —— Gary 已经向客户承诺过了。"},
  {"src": "Please review the attached spec and reply with comments.", "tgt": "请评审附件中的规格说明并回复意见。"}
]
```
