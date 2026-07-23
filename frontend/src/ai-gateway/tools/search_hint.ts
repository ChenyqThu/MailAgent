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

/**
 * 搜索批次2 PR-B（D4）—— email_search_attachments 的自我收敛 hint。与 buildSearchHint 同款
 * 教学式截断/空结果引导，但措辞对齐这个工具的实际能力面：/api/attachment/search **不跑 DSL
 * 解析**（没有 from:/after: 等字段语法，只有 mailbox/since/until 三个结构化参数），命中后
 * 读全文用 email_attachment_text（不是 email_body）。不要在 hint 里承诺该端点没有的能力。
 */
export function buildAttachmentSearchHint(returned: number, hasMore: boolean): string {
  if (returned === 0) {
    return (
      '0 命中：放宽关键词、换同义词，或去掉 mailbox/since/until 缩小范围后重试一次；' +
      '本工具只搜附件抽取正文、不搜文件名也不认 DSL——要按文件名或中文子串找附件时改用 ' +
      'email_search_fulltext 的 attachment:/filename: 字段。仍空则如实回报「没找到」，不要编造。 ' +
      '/ No matches: broaden keywords, try a synonym, or drop the mailbox/since/until ' +
      'narrowing and retry once. This tool searches extracted attachment text only (no ' +
      'filename, no DSL) — to match by filename or a CJK substring, use email_search_fulltext ' +
      'with its attachment:/filename: fields. If still empty, report honestly that nothing was found.'
    )
  }
  if (hasMore) {
    return (
      `已返回 top ${returned} 条，还有更多命中：加关键词或用 mailbox/since/until 缩小范围，` +
      '或用 email_attachment_text 读命中附件的全文确认相关性后再 present_results。 ' +
      `/ Returned the top ${returned}; more matches exist — narrow with mailbox/since/until, ` +
      "or read a hit's full text via email_attachment_text to confirm before present_results."
    )
  }
  return (
    `本次查询共 ${returned} 条，已全部返回。 ` +
    `/ All ${returned} match(es) for this query were returned.`
  )
}
