// S3 (07-02) — buildSearchHint, MOVED VERBATIM out of the legacy
// shared/chat/tools/builtin/email.ts before the legacy engine was deleted.
// Consumers: the gateway fulltext tool (tools/email.ts) + the headless
// search-agent loop (searchAgentRun.ts, via tools/email.ts).

/**
 * Phase A G-A2 — 教学式截断/空结果引导（给搜索 agent 自我收敛用）。
 *
 * 行业最佳实践（Anthropic「writing tools for agents」/ Claude Code）：工具结果绝不静默
 * 截断，要「教 agent 下一步」。空结果引导放宽、溢出引导缩小，并提示用 email_body 精读
 * top 几条确认。bilingual（中文为主用户 + 英文模型都可读）。
 */
export function buildSearchHint(returned: number, hasMore: boolean): string {
  if (returned === 0) {
    return (
      '0 命中：放宽关键词、去掉一个 filter（from:/after:/in: 等）、或换同义词，重试一次；' +
      '仍空则如实回报「没找到」，不要编造。 ' +
      '/ No matches: broaden keywords, drop one filter, or try a synonym and retry once; ' +
      'if still empty, report honestly that nothing was found.'
    )
  }
  if (hasMore) {
    return (
      `已返回 top ${returned} 条，还有更多命中：用 from:/after:/before:/subject:/in: 等 ` +
      'filter 缩小范围，或用 email_body 读 top 几条正文确认相关性后再 present_results。 ' +
      `/ Returned the top ${returned}; more matches exist — narrow with filters or open the ` +
      'top results via email_body to confirm before present_results.'
    )
  }
  return (
    `本次查询共 ${returned} 条，已全部返回。 ` +
    `/ All ${returned} match(es) for this query were returned.`
  )
}
