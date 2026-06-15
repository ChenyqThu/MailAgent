# Chat 流式 Markdown 渲染调研 (Sprint 19 Todo 2)

> **Status**: 第一稿, 2026-05-23 (next-session handoff §A 任务)
> **Owner**: chenyqthu
> **关联文件**: `frontend/src/shared/components/email/TranslatedBody.tsx` (~150 LOC, 当前自写实现)
> **关联 handoff**: `frontend/SPRINT19-NEXT-SESSION-HANDOFF.md` §A

---

## TL;DR (决策摘要)

User concern (handoff 引述): 当前 `TranslatedBody.tsx` 自写 regex + DOMPurify + auto-balance preprocess hacky, 不支持 nested list / table / triple ` ``` ` code block / single `*` italic。

调研结论:

| 选项 | 推荐度 | 一句话 |
|---|---|---|
| **(b) 切 Vercel Streamdown** | ⭐⭐⭐⭐⭐ | 2026 业界 de facto, 专为 AI streaming 设计, drop-in 替代 react-markdown, GFM + unterminated block styling + tree-shakeable plugins, **直接 fix handoff 提到的所有痛点 + bonus syntax highlight + math + mermaid 全套** |
| (c) Vercel ai-sdk useChat | ⭐ | 跟 Streamdown 是不同的层 (协议 vs 渲染), useChat 我们用不上 (我们有自己的 IPC harness + chat_db SQLite), 调研中**这不是替代项, 是 streamdown 的姊妹包**, 撤销原 handoff 误判 |
| (a) 保持现状 + 补 single `*` italic / triple ` ``` ` | ⭐⭐ | 工作量小 (~30 LOC), 但 nested list / table 永远做不出来, 自写 markdown 维护成本永远在身上 |

**推荐**: 直接上 **(b) Vercel Streamdown** (~2-3h 实施 + ~30 min review)。理由见 §6。

---

## 1. 当前实现盘点

文件: `frontend/src/shared/components/email/TranslatedBody.tsx` (150 LOC)
被两处用: `MessageList.tsx:260` (邮件正文) + `MessageList.tsx:733` (chat AssistantBubble)

**支持的语法**:
- inline: `**bold**` / `*italic*` (但有 caveat, 见下) / `` `code` `` / `~~strike~~` (代码里实际只匹配 strong + em, 没看到 strike?需核验) / `[text](http(s)://...)` / 裸 URL linkify
- block: heading (`# ~ ######`) / unordered list (`-` / `*`) / ordered list (`1.`) / blockquote (`>`)
- 段落: 双换行 → `<p>`; 单换行 → `<br>`

**不支持**:
- ❌ Triple ` ``` ` fenced code block (单 `` ` `` inline only)
- ❌ Nested list (lists 算法用 `every` 检查, 不允许混合层级)
- ❌ Table (GFM)
- ❌ Task list `- [ ]` / `- [x]`
- ❌ Image / footnote / definition list
- ❌ HTML pass-through
- ❌ Math (KaTeX)
- ❌ Code syntax highlight
- ❌ Strikethrough `~~text~~` (代码注释里写了但 inline replace 路径里实际没看到)

**流式 partial chunk 处理**: `autoBalanceTrailingMarkers` — 数 `**` 个数, 奇数补一个; 数 `` ` `` 个数, 奇数补一个。**故意不补 single `*` italic** (避免跟 `**` 半截冲突)。triple ` ``` ` 完全没处理。

**Sanitize**: DOMPurify 3.4.3, 11 个 ALLOWED_TAGS, URL 白名单 `^https?://`。

---

## 2. 调研对象与来源

| # | 候选 | 数据来源 | 状态 |
|---|---|---|---|
| 1 | **Vercel Streamdown** | [github.com/vercel/streamdown](https://github.com/vercel/streamdown), [streamdown.ai](https://streamdown.ai/), package.json fetch | ✅ 2026 active, 5.2k★, 最新 release 2026-03-17 |
| 2 | react-markdown (base) | [github.com/remarkjs/react-markdown](https://github.com/remarkjs/react-markdown) | ✅ 标准 base, 但流式要自己处理 partial |
| 3 | **llm-ui** | [llm-ui.com](https://llm-ui.com/), [github.com/llm-ui-kit/llm-ui](https://github.com/llm-ui-kit/llm-ui) | ❌ 1.7k★ 但**最后 release 2024-06**, ~2 年没动, dead |
| 4 | streaming-markdown (Frantísek Hodás) | HN 讨论 + Chrome docs 引用 | △ vanilla JS lib, 不是 React 组件; Streamdown 内部已用同思路 (`remend`) |
| 5 | Vercel ai-sdk `@ai-sdk/react` useChat | [vercel.com/changelog/introducing-streamdown](https://vercel.com/changelog/introducing-streamdown), [AI Elements](https://vercel.com/academy/ai-sdk/ai-elements) | △ **协议层**库 (transport + state), 不是 markdown 渲染; Streamdown 是它的姊妹渲染包。两层不冲突也不可替代 |
| 6 | claude.ai / ChatGPT web | F12 reverse-eng | (未做) HN 讨论没爆料具体方案 |
| 7 | Cursor / Continue / Aider | open source code | (未做) IDE 集成场景跟 chat panel 差别大, 优先级低 |
| 8 | shadcn/ai chat template | shadcn registry | (未做) UI template, 渲染层往往就是 react-markdown 或 streamdown |
| 9 | Karpathy nanochat | github | (未做) demo 性质, 不是生产级方案 |

**结论**: 真候选只剩 (a) 保持现状 / (b) Streamdown / (c) react-markdown base + 自己写 partial 处理。

---

## 3. 比较矩阵

| 维度 | (a) 保持现状 + 小修 | (b) **Streamdown v2.5** | (c) react-markdown v10 base |
|---|---|---|---|
| **新 deps** | 0 | **streamdown** (+ 间接 remark-gfm 4 / remark-parse 11 / remark-rehype 11.1 / rehype-raw 7 / rehype-sanitize 6 / rehype-harden 1.1 / hast-util-to-jsx-runtime 2.3 / marked 17 / unified 11 / mermaid 11 / tailwind-merge 3 / clsx 2) | react-markdown 10 + remark-gfm + rehype-sanitize + 自己补 partial 处理 |
| **bundle 增量** (估计 gzipped) | 0 KB | **~80-150 KB** (核心), +mermaid plugin ~500 KB, +shiki ~200 KB (按需 import) | ~50 KB (react-markdown + remark-gfm + rehype-sanitize) |
| **自维护 LOC** | 150 + 补 ~30 → ~180 | **~30** (薄包装, props 转发) | ~80 (renderer + 自写 buffer / unterminated 处理) |
| **GFM table** | ❌ 永远做不出 | ✅ 默认 | ✅ + remark-gfm |
| **Nested list** | ❌ | ✅ | ✅ |
| **Triple ` ``` ` code block** | ❌ (要重写 block parser) | ✅ 默认, +shiki plugin 出语法高亮 | ✅ + 自己接 shiki / hljs |
| **Task list / strikethrough** | ❌ | ✅ | ✅ + remark-gfm |
| **Math (KaTeX)** | ❌ | ✅ +`@streamdown/math` plugin | + remark-math + rehype-katex (自己装) |
| **Mermaid 图** | ❌ | ✅ +`@streamdown/mermaid` plugin | 自己 fork 实现 |
| **Partial chunk 视觉跳动** | △ 仅补 `**` + 单 `` ` ``, single `*` 不补, triple ` ``` ` 不处理 (流式期间字面 raw 显示) | **✅ unterminated block styling** (内置 `remend` 增量 parser, **未闭合 fence/bold/code 自动 prettify**), 有 caret indicator | ❌ 默认行为是直接渲染当前 string, 半截 `` ```python `` 会作为内联 ` ``` ` 闪烁。需要自己写 buffer/state machine |
| **XSS sanitize** | DOMPurify (3.4) | **rehype-harden** + rehype-sanitize 双层内置 | rehype-sanitize 内置, 自己配 schema |
| **React 19 兼容** | ✅ (没用) | ✅ (peer `^18.0.0 \|\| ^19.0.0`) | ✅ |
| **流式性能** (chunk 频率高) | 自写 regex 每 chunk 全量 re-parse | **增量 parse + append render** (避免 re-render full tree) | 默认 re-parse 全量, 高频 chunk 会卡 |
| **License** | MIT (自己写) | **Apache-2.0** | MIT |
| **Maintenance** | 自己背 | Vercel 出品, active (2026-03 release) | remarkjs (Titus Wormer, active 10 年+) |
| **跟 ai-sdk 强绑定** | / | ❌ **完全独立可用**, ai-sdk 是姊妹包不强制 | / |
| **Tailwind typography 默认样式** | 自己 CSS | **✅ 默认内置** | ❌ 自己写 |

---

## 4. Streamdown 详细评估 (推荐方案)

### 4.1 真实用法 (最小 snippet)

```tsx
// 替换 TranslatedBody 内部, props 接口不变, 调用方零改动
import { Streamdown } from 'streamdown'

interface Props { text: string }

export function TranslatedBody({ text }: Props): React.ReactElement {
  return (
    <div className="mail-body break-words">
      <Streamdown parseIncompleteMarkdown>
        {text}
      </Streamdown>
    </div>
  )
}
```

按需加 plugin:
```tsx
// 想要 code 语法高亮 + math:
import { Streamdown } from 'streamdown'
import code from '@streamdown/code'   // shiki-based syntax highlight
import math from '@streamdown/math'   // KaTeX
// (mermaid / cjk 都 tree-shakeable 单独 import)

<Streamdown plugins={{ code, math }} isAnimating={isStreaming}>
  {text}
</Streamdown>
```

### 4.2 核心机制 (业界推荐做法)

1. **增量 parse** (`remend` 驱动): 每次 chunk 不重新 parse 全量 markdown, 而是在上次 hast tree 上 patch
2. **Unterminated block styling**: 半截 `` ```py\n def foo`` 期间显示为半透明 / 灰色 code block, 不显示 raw ` ``` ` 字符
3. **Caret indicator**: stream 中的句末闪烁光标, 视觉提示"还在生成"
4. **rehype-harden**: XSS 防护比 DOMPurify allow list 更严, 还 strip auto-redirect URI / data URI / javascript URI

### 4.3 痛点解决映射

handoff 列的痛点 → Streamdown 解决方式:

| handoff 痛点 | Streamdown 处理 |
|---|---|
| 自写 regex hacky | 删 ~120 LOC, 留 ~30 LOC props 转发 |
| auto-balance preprocess | 不再需要, unterminated 由 lib 内部增量 parser 处理 |
| 不支持 nested list | GFM + remark-rehype 默认支持 |
| 不支持 table | GFM 默认 |
| 不支持 triple ` ``` ` code block | 默认; +shiki plugin 出语法高亮 |
| 不支持 single `*` italic | GFM 默认 (区别 italic / bold 由 remark-parse 状态机正确处理) |

### 4.4 风险 / 顾虑

| 风险 | 缓解 |
|---|---|
| **bundle 增量 80-150 KB** (Electron app 不太敏感, 但 ~3x 起步) | mermaid / shiki 是单独 plugin 不默认拉; 核心 ~80 KB 可接受 |
| Vercel 新出 (~10 月历史), API 可能变 | 已 v2.5, Vercel 自己 ai-sdk 重度依赖, 倒车风险低; Apache-2.0 出问题可 fork |
| 跟当前 DOMPurify 双重 sanitize 浪费 | TranslatedBody 用 Streamdown 后, 删 DOMPurify import (chat 路径); 邮件正文路径仍可保留 DOMPurify (邮件 HTML 来自外部, 不走 markdown) |
| 跟我们 Tailwind 主题色冲突 | Streamdown 内置 Tailwind typography classes, 可 override 或加 `className` |
| ESM-only? | npm 上 Streamdown 是 ESM, 我们 frontend Vite + Electron 都已 ESM, OK |
| 跟 React 19 强模式 / Suspense 行为冲突 | peerDep `^18.0.0 \|\| ^19.0.0`, 官方已宣 React 19, 风险低 |

### 4.5 不带来的能力 / out-of-scope

- ✗ 不带 chat state 管理 (那是 ai-sdk 的 useChat 的事; 我们有自己的 dispatcher + chat_db)
- ✗ 不带 message list virtualization (我们已用 react-window)
- ✗ 不带 tool call audit 渲染 (handoff M1 polish #3 待办)

**含义**: Streamdown 只替换 TranslatedBody 内部, 其他不动, blast radius 最小。

---

## 5. 备选 (c) react-markdown base — 不推荐

如果团队对 Vercel 新出的库不放心, 仍可走 react-markdown:

```tsx
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'

// 但需自己写 partial buffering — 这是关键缺点
function bufferIncomplete(s: string): string {
  // 至少要处理 unterminated ``` / **/`/*/[, 比当前 autoBalance 复杂
  // ...
}

export function TranslatedBody({ text }: Props) {
  const safe = useMemo(() => bufferIncomplete(text), [text])
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
      {safe}
    </ReactMarkdown>
  )
}
```

**问题**:
- 自己写 partial buffer ≈ 重新实现 Streamdown 内部 30% 的事
- 每 chunk 全量 re-parse, 高频 stream 可能卡 (Streamdown 不会)
- 不带 caret indicator / unterminated styling, 视觉跳动跟现状差不多

**结论**: 拿来当 fallback "如果 Streamdown 不可用" 的预案, 不主推。

---

## 6. 推荐方案 + 实施计划

### 推荐: (b) Vercel Streamdown

理由:
1. **2026 业界 de facto** — 5.2k★, Vercel 出品, AI Elements 整套 chat UI 内核
2. **直接 fix handoff 所有痛点** — table / nested list / triple ` ``` ` / single `*` / unterminated 全自动处理
3. **维护成本归零** — TranslatedBody 删 ~120 LOC 留 ~30 LOC
4. **risk 可控** — bundle 增量 80-150 KB (Electron 不敏感); peer React 18/19; 独立于 ai-sdk 可单用
5. **倒车容易** — props 接口不变, 出问题 git revert 一次, ~30 min

### 实施步骤 (估计 ~2-3 h)

```
[step 1, ~15 min]
cd frontend && pnpm add streamdown
# 不加 mermaid/shiki/math/cjk plugin, 等 v0 + dogfood 反馈再说

[step 2, ~15 min]
改 frontend/src/shared/components/email/TranslatedBody.tsx (150 → ~30 LOC):
- 删 escapeHtml / renderInline / renderBlock / autoBalanceTrailingMarkers /
  markdownToSafeHtml / ALLOWED_TAGS / HTTP_URI
- 删 DOMPurify import (chat 路径)
- 留 props 接口 + className 不变
- 内部走 <Streamdown parseIncompleteMarkdown>{text}</Streamdown>

[step 3, ~20 min]
保留 __testing export 给现有 vitest:
- 把 autoBalanceTrailingMarkers / markdownToSafeHtml 改 deprecation no-op
  或直接删 + 改测试
- 跑 pnpm test → 找到所有 TranslatedBody related test 看哪些断言要更新

[step 4, ~30 min]
跑 typecheck:web + typecheck:node + vitest 全套:
- 修任何 import / type 报错
- 确认 vitest 109 pass 没退化

[step 5, ~30 min]
本机 pnpm dev 启 Electron, 手测:
- 打开邮件 → chat 发 user message → 看 assistant streaming
- 测 markdown 三大 case:
  (a) bullet 嵌套
  (b) triple ``` code block (中间停顿期间 unterminated styling 表现)
  (c) GFM table
- 邮件正文路径也回看 (TranslatedBody:260 还在用)

[step 6, ~15 min]
commit:
git add frontend/src/shared/components/email/TranslatedBody.tsx \
        frontend/src/shared/components/email/TranslatedBody.test.tsx \
        frontend/package.json frontend/pnpm-lock.yaml \
        docs/chat-markdown-streaming-research.md
git commit -m "..."

[step 7, ~15 min] (可选)
若 dogfood 觉得需要 code 语法高亮, 加 @streamdown/code plugin:
pnpm add @streamdown/code
import code from '@streamdown/code'
<Streamdown plugins={{ code }}>...
```

**注意事项**:
- 邮件正文路径 (MessageList:260) 也用 TranslatedBody — 邮件 markdown 通常完整不流式, Streamdown 跑 non-streaming 也是 OK 的 (parseIncompleteMarkdown 默认 ON 时, 完整 markdown 也正常 render)
- DraftReply 那路也用同一 component (line 237), 一并 benefit
- 如要保留 `<div className="mail-body break-words">` wrapper, Streamdown 接受 `className` prop 透传给根 div

---

## 7. 决策项 (open question, 用户 review 时定)

1. **shiki code highlight 一期就加还是 v2 再说**?
   - 优点: chat agent 经常 dump code, 高亮提升大
   - 缺点: +200 KB bundle, 需要 import language pack
   - 建议: **v1 不加**, dogfood 一周看用户是否提需求再加

2. **mermaid plugin 加不加**?
   - 用户 chat 场景几乎不会出 mermaid (邮件分析任务), **不加**

3. **math (KaTeX) plugin 加不加**?
   - 邮件场景 0 需求, **不加**

4. **是否同时清掉邮件路径的 DOMPurify**?
   - MessageList:260 渲染邮件正文也用 TranslatedBody, 但邮件 body 来自远程, 走 Streamdown 的 rehype-harden 应该够
   - **建议: 一期一起换**, 邮件 markdown 路径其实就是 ai-translated body (markdown 文本不是原 HTML), 跟 chat 同质

5. **要不要并行做 handoff §B (25 scenario eval)**?
   - eval 跑 1 h, 跟 markdown 改造正交无冲突
   - **建议: eval 优先级更高** (决定是否翻 default flag), 先 eval 再 markdown 改造

---

## 8. 决策

(待用户 review 后填)

- [ ] 选 (a) / (b) / (c)
- [ ] 一期是否加 `@streamdown/code` plugin
- [ ] 一期是否同时清 DOMPurify (邮件路径)
- [ ] markdown 改造 vs §B eval 顺序

---

## 9. Sources

- [Vercel Streamdown — GitHub](https://github.com/vercel/streamdown)
- [Streamdown 官方文档](https://streamdown.ai/)
- [Vercel changelog — Introducing Streamdown](https://vercel.com/changelog/introducing-streamdown)
- [Vercel changelog — Chat SDK adds table rendering and streaming markdown](https://vercel.com/changelog/chat-sdk-adds-table-rendering-and-streaming-markdown)
- [Vercel AI Elements](https://vercel.com/academy/ai-sdk/ai-elements)
- [react-markdown — GitHub](https://github.com/remarkjs/react-markdown)
- [llm-ui (dead since 2024-06)](https://github.com/llm-ui-kit/llm-ui)
- [Chrome dev — Best practices to render streamed LLM responses](https://developer.chrome.com/docs/ai/render-llm-responses)
- [HN — Preventing Flash of Incomplete Markdown when streaming AI responses](https://news.ycombinator.com/item?id=44182941)
- [LogRocket — Build interactive React UIs for LLM outputs using llm-ui](https://blog.logrocket.com/react-llm-ui/)
