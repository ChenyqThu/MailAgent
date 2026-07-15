# MailAgent · 发件（Compose）重做 — Claude Code Handoff

> 目标：把这份 HTML/React demo（`compose/Compose.html` 及其 JSX）落地到生产前端。
> demo 是 React 18 + Babel standalone + TipTap(ESM) 的**单页原型**，生产端请按下面的组件边界拆成真实模块。

---

## 0. 一句话总览

重做的痛点：**收件人/抄送 chip 难编辑、富文本工具栏笨重、附件难加**。
解决方案：
- 收件人字段直接内联输入 + 带头像自动补全 + 全键盘操作 + 粘贴自动拆分 + chip 详情/编辑。
- 富文本换用 **TipTap**，并给出 **4 个工具风格方向**供产品拍板。
- 附件支持整窗拖拽 + 缩略图卡片（类型图标/角标/大小/图片预览）。
- 两种形态：**新邮件=独立浮窗**；**回复/回复全部/转发=右侧全窗编辑器**（保持现状布局）。

---

## 1. 文件结构与依赖

```
compose/
  Compose.html      # 入口：CDN 脚本、TipTap ESM 加载器、脚本装配、TWEAK_DEFAULTS
  compose.css       # 全部组件样式 + 语义色板 + demo 控制台样式
  theme-v2.css      # 复用自 mailagent-themes-v2（玻璃材质/主题/accent token）
  data.jsx          # mock 联系人、当前用户、@mention 池、回复种子数据、附件种子
  icons.jsx         # Icon（feather 风 SVG 集）+ Avatar
  recipients.jsx    # RecipientField（本次重点）
  attachments.jsx   # AttachmentTray + 卡片 + filesToItems + fmtSize
  editor.jsx        # RichEditor（TipTap 封装）+ 4 套工具栏 + bubble/slash/mention 下拉
  fauxapp.jsx       # 演示用的假 App 外壳（标题栏/导航/列表/阅读视图）——生产不需要
  app.jsx           # 形态外壳（FloatingShell / 全窗）+ ComposeCore + DemoDock 控制台
  tweaks-panel.jsx  # 启动器组件（宿主 edit-mode 时的 Tweaks 面板）
```

### 依赖（生产建议用 npm 而非 CDN）
- `react@18`, `react-dom@18`
- **TipTap v2（锁定 `2.27.2`，与 `@tiptap/pm` 同版本，务必单实例）**
  - `@tiptap/core`, `@tiptap/pm`, `@tiptap/starter-kit`, `@tiptap/suggestion`
  - `@tiptap/extension-underline`, `-link`, `-image`, `-text-style`, `-color`, `-highlight`, `-placeholder`, `-mention`

> ⚠️ **踩坑记录（重要）**：demo 用 esm.sh 加载 TipTap 时，`?bundle` 会让每个扩展各自内联一份 prosemirror，导致 `Adding different instances of a keyed plugin`。生产走 bundler 天然单实例，无此问题；但**所有 @tiptap/* 与 @tiptap/pm 版本必须一致**，否则会出现 `does not provide an export named 'canInsertNode'` 之类的版本错位。

---

## 2. 收件人 / 抄送（RecipientField）——核心重做

组件：`recipients.jsx` → `RecipientField({ label, value, onChange, autoFocus, extraRight, excludeEmails })`
`value` 是 contact 对象数组；contact 形状见 §6。

**已实现的能力（逐条对应用户诉求）：**
1. **内联编辑**：字段本身就是输入区（不再是底部单独空行）；点击空白聚焦输入。
2. **带头像自动补全**：输入即过滤 `CONTACTS`（按姓名/邮箱/团队），下拉含头像+姓名+邮箱+团队 pill；无匹配但为合法邮箱时给「添加 xxx」项。
3. **全键盘操作**：
   - 输入框空 + `←` 或 `Backspace` → 进入 chip 选择态（最后一个高亮）。
   - `←/→` 在 chip 间移动；`→` 越过末尾回到输入框。
   - `Backspace/Delete` 删除当前选中 chip 并选中邻居。
   - `Enter`（选中态）打开该 chip 详情浮层；`Esc` 退出选择态。
   - 下拉打开时 `↑/↓` 导航、`Enter/Tab` 选中。
   - 输入中 `Enter / , / ;`、或含 `@` 时空格 → 提交为 chip。
4. **粘贴自动拆分**：粘贴含多个邮箱的文本 → 正则 `EMAIL_RE` 提取并逐个成 chip。
5. **外部/内部区分**：`isInternal(email)` 按域名判断（`INTERNAL_DOMAINS`）；外部 chip 用 `--c-warn` 底色+边框，并带黄点 `ExternalDot`。
6. **chip 详情/编辑**：点击 chip 打开 `DetailPopover`（头像/姓名/邮箱/职位/内外部标识 + 编辑/复制/移除）；编辑态把 chip 换成行内 input。
7. **To/Cc/Bcc 折叠**：默认只显示「收件人」；右侧「抄送/密送」按钮展开；展开后可 `×` 收起并清空。跨字段去重通过 `excludeEmails` 传入。

**生产落地建议**：把自动补全数据源换成真实通讯录/最近联系人 API（保留 debounce）；`makeContact` 的头像 initials/配色逻辑可保留或接入真实头像。

---

## 3. 富文本编辑器（RichEditor / TipTap）

组件：`editor.jsx` → `RichEditor({ styleMode, initialContent, placeholder, onEditor })`
- `onEditor(editor)` 回传 TipTap 实例给父层（发送时取 `editor.getHTML()`）。
- 扩展在 `Compose.html` 的 `buildExtensions(placeholder)` 里集中装配。

### 支持的格式（全部已接线）
粗体 / 斜体 / 下划线 / 删除线 / 行内代码、标题 H1–H3、字号（自定义 `FontSize` 扩展，挂在 textStyle 上）、文字颜色 `Color`、高亮 `Highlight(multicolor)`、有序/无序列表、引用块、代码块、链接 `Link`、图片 `Image`、分割线 HorizontalRule、`@` 提及 `Mention`、撤销/重做。

### 4 个工具风格方向（`styleMode`，供产品选型）
| 值 | 名称 | 交互 |
|---|---|---|
| `classic` | 经典精炼 | 常驻顶部**分组**工具栏（标题/字号下拉 + 图标组 + 颜色/高亮 popover + 链接内联输入）。当前默认。 |
| `bubble` | Notion 风 | **无常驻工具栏**；选中文字浮出 `BubbleMenu`（B/I/U/S/代码/高亮/链接）；行首输入 `/` 触发 `SlashCommand` 块菜单。 |
| `minimal` | Superhuman 风 | 仅一排极简按钮 + Markdown 提示；靠输入规则（`**` `#` `>` `` ``` ``）成型。 |
| `bottom` | Gmail 风 | 同 `classic` 的控件簇，但工具栏置于正文**底部**。 |

- `Toolbar`（classic/bottom 共用）、`BubbleMenu`、`MinimalToolbar` 都在 editor.jsx。
- **Slash / Mention 桥接**：TipTap `Suggestion.render()` 是命令式的，demo 用 `window.__ttSuggest.{slash,mention}.{start,update,keydown,exit}` 把状态桥给 React 下拉（`SuggestList`）。生产建议改用官方 `@tiptap/react` 的 `ReactRenderer` + `tippy.js`（更稳、无全局桥）。
- Slash 项定义在 `Compose.html` 的 `SLASH_ITEMS`（标题/列表/引用/代码/分割线/图片）；`@mention` 池 = `MENTION_POOL`（仅内部同事）。
- 图片插入：demo 用 `window.__composeInsertImage(editor)` 弹 URL prompt；生产替换为上传流程。

> **产品决策（已定）**：生产采用 **`classic` 经典编辑器**（可发现性最好、最贴合日常邮件处理）。`bubble/minimal/bottom` 仅作 demo 对比，落地时删除；`RichEditor` 可去掉 `styleMode` 分支、只保留 `classic` 的 `Toolbar` 与 slash/mention。

---

## 4. 附件（AttachmentTray）

组件：`attachments.jsx`
- 数据：`{ id, name, size, kind, url?, uploading? }`；`kind ∈ pdf|sheet|doc|zip|image|text|file`（`kindFromName` 按扩展名判定）。
- `filesToItems(FileList)` 把拖入/选择的文件转成记录；图片生成 `URL.createObjectURL` 预览。
- 卡片：图片显缩略图，其余显类型图标 + 彩色角标（`KIND_META` 定义图标/色/角标）+ 文件名 + 大小；`uploading<100` 时显进度条（生产接真实上传进度）。
- **整窗拖拽**：`app.jsx` 的 `useAttachmentDrop` 挂在 `ComposeCore` 外层，拖拽时显示 `.cmp-dropoverlay` 覆盖层「松手添加为附件」。空态显示点击/拖拽 dropzone。
- 顶部汇总「N 个附件 · 总大小」+「添加」按钮（触发隐藏 `<input type=file multiple>`）。

**生产落地**：接上传 API、大小/类型校验、超限提示、内联图片 vs 附件区分；`uploading` 字段驱动真实进度。

---

## 5. 形态外壳（app.jsx）

- **`ComposeCore({ mode, editorStyle, onClose })`**：共享正文（收件人字段 + 主题行 + 优先级 + 编辑器 + 附件 + 引用原文 + 发送/存草稿/丢弃/签名/定时/AI 润色 动作条 + 拖拽/发送成功覆盖层）。
  - `mode='fullwindow'`（回复）：动作条在**顶部**，种子数据来自 `REPLY_META/REPLY_SEED/SEED_ATTACHMENTS`，含「引用原文」折叠。
  - `mode='floating'`（新邮件）：动作条在**底部**，空白起草。
- **`FloatingShell`**：居中浮窗，标题栏可拖动、双击/按钮最大化、关闭。
- **主题**：`App` 的 effect 把 `data-theme/data-accent/data-surface` 写到 `<html>`（`coral` = 不写 accent；`frosted` = 不写 surface）。
- **发送**：`send()` 目前只播放成功动画后关闭；生产替换为真实提交（取 `editorRef.getHTML()` + 收件人/主题/优先级/附件）。
- 优先级：`PRIORITIES`（普通/重要/紧急）→ 邮件头 `X-Priority` 之类。

### 演示专用（生产删除）
- `fauxapp.jsx`（假 App 外壳、假列表、假阅读视图）——只为让 demo 有上下文。
- `app.jsx` 里的 **`DemoDock`**（左下常驻控制台，切形态/编辑器方向/主题/配色/材质）——仅用于演示对比。
- `tweaks-panel.jsx` / `TWEAK_DEFAULTS` / `useTweaks`——demo 的可调档机制。
生产里这些都不需要；真实状态来自应用自身的主题设置与「回复/新邮件」入口。

---

## 6. 数据形状（data.jsx）

```js
// contact
{ name, email, title, team,
  internal: bool, external: bool,   // 按域名判定
  color: '#..', initials: '张三'/'XC' }

// makeContact(email) → 命中通讯录则返回该联系人，否则构造 raw contact
// INTERNAL_DOMAINS = ['omadanetworks.com','tp-link.com','tp-link.com.hk']
// MENTION_POOL = 仅内部联系人（@ 提及用）
// REPLY_META = { to:[], cc:[], subject } ；REPLY_SEED = 回复正文 HTML
// SEED_ATTACHMENTS = 回复态种子附件
```

---

## 7. 设计 token（compose.css :root + theme-v2.css）

- **表面/前景**：`--ink-0..5`、`--ink-fg / -1 / -2 / -3`；玻璃材质类 `.win-glass/.glass/.glass-2/.glass-3/.glass-bar/.glass-pop/.glass-panel`（来自 theme-v2）。
- **accent**：`--c-accent / -hi / -dim / -fg`，随 `data-accent`（cobalt/coral/teal/rose/slate/olive）+ `data-theme` 切换。
- **语义色（固定，明暗不变）**：`--c-crit/-urg/-impt/-norm/-low/-ok/-warn/-fail/-info/-ai`（本次修复：这些原在 ds.css，未被 Compose 引入导致外部黄点/优先级/AI 紫/成功绿等失效，现已补进 compose.css `:root`）。
- **动效**：`--ease-standard: cubic-bezier(.4,0,.2,1)`。
- 字体：`--font-ui`（Inter + Noto Sans SC）、`--font-mono`（JetBrains Mono）。
- 用色一律 `rgb(var(--token) / alpha)`；不要写死 hex（附件角标色 `KIND_META` 是例外，可后续 token 化）。

---

## 8. 建议的落地顺序

1. RecipientField（收益最大、独立性最强）→ 接真实通讯录补全。
2. RichEditor：**锁定 `classic` 方向**，用 `@tiptap/react` + ReactRenderer 重接 slash/mention，去掉全局桥。
3. AttachmentTray：接上传 API + 进度 + 校验。
4. 两种形态外壳按现有布局接入路由（新邮件浮窗 / 回复全窗）。
5. **发送前接 §9.1 的 sanitize + juice 管线**；发送/存草稿/定时/AI 润色 接后端。
6. 删除 fauxapp / DemoDock / tweaks 演示件。

---

## 9. 编辑器选型：TipTap vs React Email（已定 TipTap）

**结论：写信/回复编辑器用 TipTap；React Email 不引入（除非未来做营销/群发模板）。**

- MailAgent 的场景是**日常邮件处理**（人写给人、回复为主），内容 = 段落 / 加粗斜体 / 列表 / 链接 / 引用 / 偶尔图片附件。这类语义 HTML 在 Gmail/Outlook/Apple Mail 渲染无问题，**不存在**营销邮件那种「多列设计模板跨端崩坏」的痛点。
- 两者不在同一层：**TipTap = 编辑体验层**（chip、内联回复、引用折叠、经典工具栏、键盘流）；**React Email = 发送/模板生成层**（开发者用 React 组件搭事务性/营销模板 → table 内联 HTML）。用 React Email 当收件箱编辑器会丢掉这些交互、反而更重。
- 真实客户端（Superhuman / Missive / Front / Notion Mail / Gmail）都用 ProseMirror/Lexical/Slate 类编辑器，没有用 React Email 当收件箱编辑器的。
- **边界**：如果路线图出现「营销 campaign / 品牌化 HTML 模板 / 拖拽搭设计邮件」，在**那个独立模块**引入 React Email；收件箱写信仍用 TipTap。两条线各司其职。

### 9.1 发送前 HTML 处理管线（TipTap 侧，成本很低）

发送时取 `editor.getHTML()`，过两步即可覆盖日常信的兼容性，**不需要 MJML/table 化**：

1. **`sanitize-html`** — 白名单标签/属性清一遍，去脚本、去危险属性（防 XSS，也顺手规整脏 HTML）。
2. **`juice`** — 把 `<style>` / class 样式**内联化**（Outlook 对非内联样式支持差，内联后最稳）。

```js
import sanitizeHtml from 'sanitize-html';
import juice from 'juice';

function toEmailHtml(rawHtml, { baseCss = '' } = {}) {
  const clean = sanitizeHtml(rawHtml, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'h1', 'h2', 'h3', 'mark', 'hr', 'u', 's']),
    allowedAttributes: { '*': ['style', 'class'], a: ['href', 'target', 'rel'], img: ['src', 'alt', 'width', 'height'] },
    allowedSchemes: ['http', 'https', 'mailto', 'cid', 'data'],
  });
  // baseCss = 把 .rt-content 的正文排版规则收敛成一份邮件基线样式，juice 会内联进每个元素
  return juice(`<style>${baseCss}</style>${clean}`);
}
```

- `baseCss` 建议从 `.rt-content` 的排版规则派生一份「邮件基线」（字号/行高/引用条/代码块/列表缩进/链接色），保证收件方无你的 CSS 时也排版正常。
- 附件/内联图片：`cid:` 内联图 vs 普通附件在 §4 已区分，发送层按 MIME 组装。
- 只有当用户真用了代码块/复杂表格（回复框里极罕见）才需要额外 table 化——可作为后续增强，不阻塞首版。

---

## 10. 已知/待确认
- Slash/@mention 需真实键入触发（TipTap 机制），自动化点击无法模拟。
- `FontSize` 是自定义扩展（挂 textStyle）；如用官方 typography 方案可替换。
- 编辑器方向已定为 **classic**；其余 3 个分支为 demo 对比件，落地时可删。
- 附件类型色目前是 `KIND_META` 硬编码，建议纳入 token。
