// harness-chat lane A B3 (task 07-15) — shared relative-age formatter ("刚刚 / N 分钟前 / N 小时前 /
// N 天前"), split out of AgentRecordView so both the record banner and the shared
// PendingApprovalPanel import one source (react-refresh/only-export-components keeps helper
// functions out of component files). Keys live under agents.custom.runs.* (their original home).

export function ageLabel(
  t: (k: string, o?: Record<string, unknown>) => string,
  ms: number
): string {
  const mins = Math.max(0, Math.floor(ms / 60000))
  if (mins < 1) return t('agents.custom.runs.ageJustNow')
  if (mins < 60) return t('agents.custom.runs.ageMinutes', { n: mins })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t('agents.custom.runs.ageHours', { n: hours })
  return t('agents.custom.runs.ageDays', { n: Math.floor(hours / 24) })
}
