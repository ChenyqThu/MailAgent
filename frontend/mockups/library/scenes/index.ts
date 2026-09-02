// 场景注册表。id / 分组 / 标题与 README 的场景表逐条对应。

import type { ComponentType } from 'react'

import * as A from './a-shell'
import * as B from './b-folder'
import * as C from './c-preview'
import * as D from './d-mount'
import * as E from './e-search'
import * as F from './f-agent'
import * as G from './g-cross'

export interface Scene {
  id: string
  group: string
  title: string
  Component: ComponentType
}

const GA = 'A 域外壳与文件夹树'
const GB = 'B 文件夹视图'
const GC = 'C 文件预览面'
const GD = 'D 挂载与设置'
const GE = 'E 搜索'
const GF = 'F Agent 侧'
const GG = 'G 跨模块'

export const SCENES: Scene[] = [
  { id: 'A1', group: GA, title: '一级域整体', Component: A.A1 },
  { id: 'A2', group: GA, title: '多根树', Component: A.A2 },
  { id: 'A3', group: GA, title: '节点菜单', Component: A.A3 },
  { id: 'A4', group: GA, title: '折叠态 peek', Component: A.A4 },

  { id: 'B1', group: GB, title: '网格 / 列表双视图', Component: B.B1 },
  { id: 'B2', group: GB, title: '空 / 拖入 / 扫描中', Component: B.B2 },
  { id: 'B3', group: GB, title: '文件夹过滤 vs 全库搜索', Component: B.B3 },

  { id: 'C1', group: GC, title: '文件头与动作', Component: C.C1 },
  { id: 'C2', group: GC, title: 'markdown 只读 / 编辑 / 冲突', Component: C.C2 },
  { id: 'C3', group: GC, title: 'html 无脚本沙箱', Component: C.C3 },
  { id: 'C4', group: GC, title: '图片 + lightbox + OCR', Component: C.C4 },
  { id: 'C5', group: GC, title: 'PDF 解析视图 / 原件', Component: C.C5 },
  { id: 'C6', group: GC, title: 'office / csv 三态', Component: C.C6 },
  { id: 'C7', group: GC, title: 'video / 大文件 / 其他', Component: C.C7 },
  { id: 'C8', group: GC, title: 'missing / trashed / 挂载不可用', Component: C.C8 },
  { id: 'C9', group: GC, title: '历史抽屉与回滚', Component: C.C9 },
  { id: 'C10', group: GC, title: '关联事项与来源跳转', Component: C.C10 },
  { id: 'C11', group: GC, title: '另存到资料库', Component: C.C11 },
  { id: 'C12', group: GC, title: '移到…', Component: C.C12 },
  { id: 'C13', group: GC, title: '删除确认与废纸篓', Component: C.C13 },

  { id: 'D1', group: GD, title: '添加挂载文件夹', Component: D.D1 },
  { id: 'D2', group: GD, title: '设置页「资料库」区', Component: D.D2 },

  { id: 'E1', group: GE, title: '全库搜索面', Component: E.E1 },
  { id: 'E2', group: GE, title: '⌘K 第五 lane', Component: E.E2 },
  { id: 'E3', group: GE, title: '/search 页结果组', Component: E.E3 },

  { id: 'F1', group: GF, title: '第 8 张能力卡', Component: F.F1 },
  { id: 'F2', group: GF, title: '工具审批档 7 行', Component: F.F2 },
  { id: 'F3', group: GF, title: '对话里的工具卡', Component: F.F3 },
  { id: 'F4', group: GF, title: 'data-library chip 与 composer 提示', Component: F.F4 },
  { id: 'F5', group: GF, title: '@ 提及（对话 / 群聊）', Component: F.F5 },
  { id: 'F6', group: GF, title: 'library 型通知', Component: F.F6 },
  { id: 'F7', group: GF, title: 'custom_agent_call 带引用', Component: F.F7 },

  { id: 'G1', group: GG, title: '事项关联与提案', Component: G.G1 },
  { id: 'G2', group: GG, title: 'compose 从资料库选附件', Component: G.G2 },
  { id: 'G3', group: GG, title: '邮件附件行「另存到资料库」', Component: G.G3 },
  { id: 'G4', group: GG, title: '深链落地', Component: G.G4 },
  { id: 'G5', group: GG, title: '报告「导出到资料库」', Component: G.G5 }
]
