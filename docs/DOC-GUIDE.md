# 文档规范（DOC-GUIDE）

> 本项目文档体系的约定。目的：文档可导航、渐进式加载、可持续扩展，且新文档有明确落点。
> 借鉴 Trellis spec 的三个范式：① 常青/过程两轴分离 ② index + "何时读"驱动 ③ 按子系统分层。

---

## 1. 两类文档（一切的根）

| 类型 | 定义 | 落点 |
|---|---|---|
| **常青参考** | 描述"系统**现在**如何"，随演进被更新，会被反复读 | `docs/reference/<子系统>/` |
| **过程产物** | 描述"某次**怎么做的**"，写完即冻结，价值随时间衰减 | 不进 `docs/`；见 §3 |

**一句话判据**：*半年后还会有人为了"现在怎么回事"来读它吗？*
- 是 → 常青 → `docs/reference/`
- 只是"当时的交接 / 里程碑 / 验收快照" → 过程 → 归档

过程产物的命名特征（用到这些词基本就是过程产物）：`handoff` / `complete` / `phaseN` / `prN` / `sprintN` / `next-session` / 验收 `matrix` / `dogfood` / `review-log` / `progress`。

---

## 2. 常青参考：`docs/reference/<子系统>/`

- 每篇常青文档**必属某个子系统目录**。现有子系统见 [`reference/index.md`](./reference/index.md)。
- 子系统不存在就新建目录，并**补一行 index**（见 §4）。
- 子系统粒度参照 `src/` 模块地图（architecture / cli / llm-agent / calendar / folder-sync / remote-chat-report / project-progress / packaging / web-remote / integrations / search / ops）。单文件小主题就近并入相近子系统，别为 1 个文件建目录。
- **不在 `reference/` 用过程词命名**（没有 `xxx-handoff.md` / `phaseN-complete.md`）。

---

## 3. 过程产物：优先 `.trellis/tasks/`，历史的进 `docs/archive/`

- **进行中的工作**：交接 / 调研 / 决策记录写进 `.trellis/tasks/<task>/`（prd.md / research/ / info.md），**不要写进 `docs/`**。
- **已成历史的过程产物**：归 `docs/archive/{年-月}/`（按 git 最后提交月分桶）。`git mv` 保历史，**不删除**。
- 归档是**冻结快照**：不是当前真相，不保证内部链接随后续迁移更新。引用它时标注"(已归档)"。
- 前端过程产物归 `frontend/archive/{年-月}/`（前端半自治，归档留在 frontend 下）。

---

## 4. index.md + "何时读"（渐进式加载的入口）

- 每个 `docs/reference/<子系统>/` **必须有 `index.md`**，含一张表：`文件 | 何时读 | 内容`。
- 这是 agent / 人按需加载的入口 —— 先读 index 决定读哪篇，不全量塞 context。
- 顶层 [`reference/index.md`](./reference/index.md) 列出所有子系统。

---

## 5. 全局总索引 = `CLAUDE.md`「文档地图」

- 仓库根 [`CLAUDE.md`](../CLAUDE.md) 是 agent 导航的**唯一真相**，其「文档地图」表是参考层的 SSoT 入口。
- 🔴 **新增常青文档 ⟹ 必须在 CLAUDE.md「文档地图」加一行**，否则没人发现它。
- `AGENTS.md`（Codex）/ `README.md`（人类）只做**指针**，不复制 CLAUDE.md 内容（防漂移）。

---

## 6. 文档头部约定（常青）

- 首段写**定位 + 交叉指引**（"想看 X 去 Y"），范例见 [`../ARCHITECTURE.md`](../ARCHITECTURE.md) 顶部。
- 推荐 frontmatter / 头部标注：`status: living`、`last-verified: YYYY-MM-DD`。
- 化石文档归档时，头部加一行：`> ⚠️ 已归档存史：本文描述的 X 已被 Y 取代，当前真相见 Z`。

---

## 7. 何时拆分

- 单文件 **>400 行且多主题** → 拆子主题文件 + 一个 index 收口（`docs/reference/architecture/` 即范例）。
- 拆分后旧引用要同步更新（见 §8）。

---

## 8. 移动文档不破链

- 移动用 `git mv`（保历史）。**保留原文件名**，只挪目录 —— 链接修复=纯路径前缀替换。
- 移动后必做：
  1. 改 `CLAUDE.md` / `README.md` / `MIGRATION.md` / `ARCHITECTURE.md` 里的指针；
  2. 改 `src/**` / `frontend/src/**` 代码注释里硬编码的 `docs/...` 路径；
  3. 改其它文档里的相对链接；
  4. `grep` 校验无残留旧路径 + 链接存在性扫描（脚本见 [`.trellis/tasks/06-15-docs-system-restructure/research/relink.py`](../.trellis/tasks/06-15-docs-system-restructure/research/relink.py)，按 git rename 自动重算 markdown 相对链接）。

---

## 9. 目录速览

```
docs/
  DOC-GUIDE.md          本文件
  reference/            常青参考（唯一真相层）
    index.md            子系统总索引
    <子系统>/index.md   每个子系统的"何时读"表 + 该子系统常青文档
  archive/{年-月}/      过程产物 + 化石（冻结存史）
  cli-schema/           机器产物（CLI JSON Schema）
  eval/ mockups/ plans/ 专项产物（自洽子目录）
frontend/
  *.md                  前端常青（ARCHITECTURE / DESIGN / BACKEND-INTERFACES …）
  docs/motion-gsap.md   前端深度常青
  archive/{年-月}/      前端过程产物
  ref/                  设计 mockup 素材 + designer 原版 DESIGN（非工程 SSoT）
```
