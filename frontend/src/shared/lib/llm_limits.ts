// LLM 调用上限的**唯一 TS 真源**（issue #68）。
//
// 之前有三份手抄：`llm_provider_resolver.ts` / `handlers/nl_search.ts` /
// `handlers/translate.ts`，全是 64_000 且零互引。
//
// 放在零依赖的叶子模块而不是任一消费者里，是因为 `llm_provider_resolver` 顶层要拉
// `daemon_api` / `llm_settings`(keytar) —— 两个 handler 的单测正是**整体 mock 掉**它的，
// 若常量挂在那儿，每个 mock 都得再抄一遍这个数字（等于把手抄搬进测试，还会把错误值焊死）。

/** 项目 LLM 调用约定：所有调用统一 1M 上下文 + 64k max output。
 *  provider registry 路径上，per-model 行配置的上限会与它取 min()（见 `llm_provider_resolver`）。 */
export const MAX_OUTPUT_TOKENS = 64_000
