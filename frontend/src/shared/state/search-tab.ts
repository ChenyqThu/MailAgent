// 「新标签页」搜索页的会话内状态（task 08-27-l4-tab-workspace P2 补批 Lane S 续改 1）。
//
// query 与 AI 深度搜索的结果态原先是 SearchTabPage 的组件本地 useState —— 单挂载切换
// 下切走（点结果开对象标签）再切回是 remount，输入与 AI 结果全丢。提升到模块级 store
// 之后：FTS 结果视图由 query + react-query 缓存（qk.palette.*，与 ⌘K 共享）自然回放，
// AI 结果态直接存活；agentic run 也因此可以**离场续跑**（切走不 abort，回来看结果）。
//
// 🔴 有意不持久化（无 localStorage）：需求是「会话内保持」，刷新 / 重启回空态即可。
// 也因此这里没有形状版本与迁移负担。
//
// 这次提升顺带修掉 dev 下的「首次输入被重置」：并行改动落在 router-instance 的
// import 图（registry.ts 等）时，router-instance 因导出非组件值不能 Fast Refresh，
// HMR 会重建 router 单例 ⇒ 整棵路由树 remount，组件本地 state 全丢。模块级 store
// 不在那条失效链里（本文件不 import registry / router），remount 后组件回读即恢复。

import { create } from 'zustand'

import type { SearchAgentPhase, SearchHit } from '@shared/api/types'

/** AI 态的静止形状。`setQuery` / `beginAiRun` 都从它重置 —— palette 的 onChange
 *  同规则（改 query 即清上一轮 agentic 结果，让普通 FTS 干净接管）。 */
const AI_IDLE = {
  aiSearching: false,
  aiHits: [] as SearchHit[],
  aiSummary: null as string | null,
  aiError: null as string | null,
  aiCompleted: false,
  aiPhase: 'searching' as SearchAgentPhase
}

/** 在途 agentic run 的 AbortController —— 模块级而非组件 ref：页面 remount 之后
 *  「新输入要能掐掉旧 run」这条语义仍然成立。 */
let currentRun: AbortController | null = null

function abortCurrentRun(): void {
  currentRun?.abort()
  currentRun = null
}

interface SearchTabPageState {
  readonly query: string
  readonly aiSearching: boolean
  readonly aiHits: SearchHit[]
  readonly aiSummary: string | null
  readonly aiError: string | null
  readonly aiCompleted: boolean
  readonly aiPhase: SearchAgentPhase

  /** 输入 / chip / 历史回放的唯一写入口：写 query + 清 AI 态 + abort 在途 run。 */
  setQuery(next: string): void
  /** 开始一次 agentic run。已在途 → null（并发由这里拦，调用方直接 return）；
   *  否则重置 AI 态并返回新 controller —— 后续状态写入由调用方按 `signal.aborted`
   *  闸（被 setQuery / 新 run 顶掉的旧 run 不许再写）。 */
  beginAiRun(): AbortController | null
  setAiPhase(phase: SearchAgentPhase): void
  /** run 正常收官（含诚实 0 命中 —— aiCompleted 标记空态可渲染）。 */
  resolveAiRun(hits: SearchHit[], summary: string | null): void
  failAiRun(message: string): void
  /** finally 腿：searching 归位 + 释放 controller。 */
  endAiRun(): void
  dismissAiError(): void
}

export const useSearchTabPage = create<SearchTabPageState>((set, get) => ({
  query: '',
  ...AI_IDLE,

  setQuery(next) {
    abortCurrentRun()
    set({ query: next, ...AI_IDLE })
  },

  beginAiRun() {
    if (get().aiSearching) return null
    abortCurrentRun()
    const ac = new AbortController()
    currentRun = ac
    set({ ...AI_IDLE, aiSearching: true })
    return ac
  },

  setAiPhase(phase) {
    set({ aiPhase: phase })
  },

  resolveAiRun(hits, summary) {
    set({ aiHits: hits, aiSummary: summary, aiCompleted: true })
  },

  failAiRun(message) {
    set({ aiError: message })
  },

  endAiRun() {
    currentRun = null
    set({ aiSearching: false })
  },

  dismissAiError() {
    set({ aiError: null })
  }
}))

/** 测试用复位（模块级 controller + store 一起归零）。生产代码不要调。 */
export function _resetSearchTabForTest(): void {
  abortCurrentRun()
  useSearchTabPage.setState({ query: '', ...AI_IDLE })
}
