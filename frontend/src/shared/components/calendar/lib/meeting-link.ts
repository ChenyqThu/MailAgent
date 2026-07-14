// 阶段2·2.5 (UX-P0②) — 会议链接提取 + Join 打开.
//
// 从 occurrence 的 url / location / description 三字段按序扫 https URL, 识别
// Teams / Zoom / Meet 三家常见变体. Teams 输出 msteams:// deeplink (桌面直拉
// Teams app, 跳过浏览器中转页) + https fallback; Zoom / Meet 恒 https (zoommtg://
// 需要额外确认弹窗且网页入会体验完整, 不引 deeplink).
//
// 打开走仓内既有安全外链方式: Electron 下 `shell:openExternal` IPC (main 端
// isExternalNavUrl scheme 白名单, 已含 msteams); 远程 web 无 ipc → window.open
// https (网页端恒 https).

export type MeetingProvider = 'teams' | 'zoom' | 'meet'

export interface MeetingLink {
  provider: MeetingProvider
  /** 原始 https URL — 网页端 / fallback 用. */
  httpsUrl: string
  /** 桌面 deeplink — Teams=msteams://…; Zoom/Meet 与 httpsUrl 相同. */
  deeplinkUrl: string
}

/** 按钮 title/tooltip 用的品牌名 (专有名词不 i18n). */
export const MEETING_PROVIDER_LABEL: Record<MeetingProvider, string> = {
  teams: 'Teams',
  zoom: 'Zoom',
  meet: 'Google Meet'
}

// https URL 粗扫 (description 可能是含 <> / 引号包裹链接的纯文本或 HTML 源).
const URL_RE = /https:\/\/[^\s<>"'`]+/gi

/** 单个候选 URL → provider 判定. 尾随标点 (纯文本里 "…链接: https://xx." 常见)
 *  先剥掉再解析. 不识别返回 null. */
function classify(raw: string): MeetingLink | null {
  const cleaned = raw.replace(/[)\]}>.,;:!?]+$/, '')
  let u: URL
  try {
    u = new URL(cleaned)
  } catch {
    return null
  }
  const host = u.hostname.toLowerCase()
  const path = u.pathname

  // Teams: 经典 /l/meetup-join/… + 新式 meeting-id 短链 /meet/<id>;
  // teams.live.com = 个人版同形. msteams: 换 scheme 即为官方 deeplink 形态.
  if (
    (host === 'teams.microsoft.com' || host === 'teams.live.com') &&
    (path.startsWith('/l/meetup-join') || path.startsWith('/meet'))
  ) {
    return {
      provider: 'teams',
      httpsUrl: cleaned,
      deeplinkUrl: 'msteams://' + cleaned.slice('https://'.length)
    }
  }

  // Zoom: zoom.us 及企业/区域子域 (company.zoom.us / us02web.zoom.us);
  // /j/<id> 常规入会, /w/ webinar, /s/ SSO 签发, /my/<name> 个人会议室.
  if ((host === 'zoom.us' || host.endsWith('.zoom.us')) && /^\/(j|w|s|my)\//.test(path)) {
    return { provider: 'zoom', httpsUrl: cleaned, deeplinkUrl: cleaned }
  }

  // Meet: meet.google.com/xxx-yyyy-zzz (+ /lookup/<alias>).
  if (host === 'meet.google.com' && path.length > 1) {
    return { provider: 'meet', httpsUrl: cleaned, deeplinkUrl: cleaned }
  }

  return null
}

/** url → location → description 按序取第一个可识别的会议链接. */
export function extractMeetingLink(fields: {
  url?: string | null
  location?: string | null
  description?: string | null
}): MeetingLink | null {
  for (const text of [fields.url, fields.location, fields.description]) {
    if (!text) continue
    for (const candidate of text.match(URL_RE) ?? []) {
      const link = classify(candidate)
      if (link) return link
    }
  }
  return null
}

/** 打开会议链接 — Electron 走 shell:openExternal(deeplink), web 走 window.open(https).
 *  探针照 EmailSourcePanel.openExternal: window.electron 有无即桌面/网页判定. */
export function openMeetingLink(link: MeetingLink): void {
  const w = window as unknown as {
    electron?: { ipcRenderer?: { invoke?: (c: string, ...a: unknown[]) => Promise<unknown> } }
  }
  const invoke = w.electron?.ipcRenderer?.invoke
  if (invoke) void invoke('shell:openExternal', link.deeplinkUrl)
  else window.open(link.httpsUrl, '_blank', 'noopener')
}
