// 设置-AI 里「被别处跳转到」的两个区块 id —— 零依赖叶子模块。
//
// 原本这两个值定义在 SystemCapabilitiesSection.tsx 里（它是 SYSTEM_CAP_SCROLL_TARGETS 的
// 首个消费方）。08-01 PR4 加锚点导航后出现第二个消费方（aiTabAnchors），若继续从那个
// 组件文件 import，等于为了两个字符串把 agents/hooks → env store → IPC 那一整棵依赖树
// 拉进一个纯常量模块。按 CLAUDE.md「跨边界手抄常量」一节的处置顺序：能消灭镜像就消灭
// ——**下沉常量**，而不是在第二处照抄一份再写句「同源」注释。
//
// 🔴 值本身不可改名：SystemCapabilitiesSection 的交叉引用跳转、CustomAiSection 的外裹
// wrapper、以及锚点导航都按这两个字符串对齐 DOM。

export const SYSTEM_CAP_SCROLL_TARGETS = {
  exec: 'settings-exec-policy',
  skillPacks: 'settings-skill-packs'
} as const
