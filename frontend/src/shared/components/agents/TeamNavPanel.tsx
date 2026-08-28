// 「团队」域的二级栏 —— 简版智能体清单（task 08-27-l4-tab-workspace P1 过渡）。
//
// /agents 页现在还是卡片网格 + tablist、没有页面自管左列，团队域走 'nav' 档由本
// 组件出二级栏（否则切到团队域左列只剩 56px 导轨，破「切域边界不动」）。
//
// 简版边界（P1 有意不做的）：
//  · 不按状态分组（正在干活 / 在线待命 / 待触发）—— 那要 P4 的 run 状态查询面；
//  · 不做 per-agent 深链 —— /agents 页的配置抽屉是组件内 state，没有 URL；
//    点任意行 = 落到 /agents?tab=agents（落点经 registry，路径字面量不出它）。
// 数据源 = /agents 页同一份 useReportConfig（react-query 共享缓存，零新端点）。
// P4 团队页重做出自管清单列后本组件退役（NAV_DOMAINS.agents 注释）。

import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import { navEntry, navigateToNavEntry } from '@shared/navigation/registry'

import { useReportConfig } from './hooks'

export function TeamNavPanel(): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { agents, isLoading } = useReportConfig()

  const goTeam = (): void => navigateToNavEntry(navigate, navEntry('agents'))

  const rowClass =
    'row relative w-full flex items-center gap-2 h-[30px] px-2 rounded-[var(--r-ctl)] ' +
    'text-body text-left transition-colors duration-fast ' +
    'text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg active:bg-ink-4'

  return (
    <nav
      className="flex-1 overflow-y-auto scrollbar-thin px-1.5 pb-2 pt-1.5 space-y-px"
      data-team-nav
      aria-label={t('nav.domain.team')}
    >
      {agents.map((cfg) => (
        <button key={cfg.id} type="button" className={rowClass} onClick={goTeam}>
          <span className="flex-1 truncate">{cfg.title}</span>
          {cfg.description ? (
            <span className="max-w-[45%] shrink-0 truncate text-micro text-ink-fg-3">
              {cfg.description}
            </span>
          ) : null}
        </button>
      ))}
      {/* 配置读不到 / 一个 agent 都没有时给一个入口行，面板不留白。 */}
      {!isLoading && agents.length === 0 && (
        <button type="button" className={rowClass} onClick={goTeam}>
          <span className="flex-1 truncate">{t('agents.nav.allAgents')}</span>
        </button>
      )}
    </nav>
  )
}
