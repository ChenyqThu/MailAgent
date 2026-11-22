// 设置 →「MCP 服务」：把 MailAgent 的能力经 `/mcp` 交给外部 Agent（Notion Custom Agent 等）。
//
// 四块：连接地址 / 访问密钥 / 对外工具 / 最近调用。数据全部来自 serve-api
// `/api/mcp-service/*`（mcp_service_api.ts）；公网地址存 `.env` 的
// `MAILAGENT_MCP_PUBLIC_URL`（只用于展示与生成配置，后端不据此改变行为 → 保存不标「需重启」）。
//
// serve-api 是否在跑：没有专属探针 IPC（RemoteAccessTab 也只能拿 mail-sync 近似），所以直接用
// `GET /status` 本身判定 —— 远程访问开关显式关 = 不发请求；请求以 `E_NETWORK` 失败 = 没在跑。
// 两种情况都只出一条提示和去「远程访问」的入口，其余三块的请求恒 `enabled: false`。
//
// 🔴 明文密钥只活在「密钥已生成」弹窗的组件 state 里：关闭即置 null，列表接口永不返回明文，
// 所以关掉之后没有任何路径能再取回。复制出去的三份配置都在这一刻用真实明文拼出。

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'

import type { McpKeyWithPlaintext } from '@shared/api/types'
import { Button } from '@shared/components/ui/button'
import { useMailApi } from '@shared/hooks/useMailApi'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { navigateToSettingsTab } from '@shared/navigation/registry'

import { PageHeader } from '../parts/PageHeader'
import { Row } from '../parts/Row'
import { Section } from '../parts/Section'
import { ConnectionSection } from './mcp-service/McpConnectionSection'
import { KeysSection } from './mcp-service/McpKeysSection'
import { ClientConfigDialog, KeyRevealedDialog } from './mcp-service/McpKeyModals'
import { AuditSection, ToolsSection } from './mcp-service/McpToolsAndAudit'
import {
  deriveSseUrl,
  isNetworkError,
  isReachable,
  isToggleOn,
  PUBLIC_URL_ENV_KEY,
  useEnvValue,
  type ProbeState
} from './mcp-service/mcpServiceUtils'

export function McpServiceTab(): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const navigate = useNavigate()

  const remoteEnabled = isToggleOn(useEnvValue('MAILAGENT_REMOTE_ACCESS_ENABLED'))

  const statusQuery = useQuery({
    queryKey: qk.mcpService.status(),
    queryFn: () => api.mcpService.status(),
    enabled: remoteEnabled,
    retry: false
  })
  const running = remoteEnabled && statusQuery.isSuccess
  const notRunning = !remoteEnabled || (statusQuery.isError && isNetworkError(statusQuery.error))

  return (
    <>
      <PageHeader
        eyebrow={t('settings.mcp.page.eyebrow')}
        title={t('settings.mcp.page.title')}
        description={t('settings.mcp.page.intro')}
      />

      {notRunning ? (
        <Section title={t('settings.mcp.connection.title')}>
          <Row label={t('settings.mcp.offline.label')} helper={t('settings.mcp.offline.hint')}>
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigateToSettingsTab(navigate, 'remote')}
            >
              {t('settings.mcp.offline.cta')}
            </Button>
          </Row>
        </Section>
      ) : statusQuery.isError ? (
        <Section title={t('settings.mcp.connection.title')}>
          <Row
            label={t('settings.mcp.loadFailed')}
            helper={<span className="text-fail">{errorMessage(statusQuery.error)}</span>}
          >
            <Button size="sm" variant="outline" onClick={() => void statusQuery.refetch()}>
              {t('settings.mcp.retry')}
            </Button>
          </Row>
        </Section>
      ) : !running || !statusQuery.data ? (
        <div className="flex justify-center py-10">
          <Loader2 className="size-4 animate-spin text-ink-fg-3" aria-label="loading" />
        </div>
      ) : (
        <RunningSections
          localUrl={statusQuery.data.local_url}
          streamableHttpUrl={
            statusQuery.data.streamable_http_url?.trim() || statusQuery.data.local_url
          }
          sseUrl={deriveSseUrl(statusQuery.data.local_url, statusQuery.data.sse_url)}
          statusPublicUrl={statusQuery.data.public_url ?? ''}
          activeKeyCount={statusQuery.data.active_key_count}
        />
      )}
    </>
  )
}

function RunningSections({
  localUrl,
  streamableHttpUrl,
  sseUrl,
  statusPublicUrl,
  activeKeyCount
}: {
  localUrl: string
  streamableHttpUrl: string
  sseUrl: string
  statusPublicUrl: string
  activeKeyCount: number
}): React.ReactElement {
  const envPublicUrl = useEnvValue(PUBLIC_URL_ENV_KEY).trim()
  // env store 是保存后立即可见的那一份（乐观更新）；env 没读到时退回 status 里的值。
  const savedPublicUrl = envPublicUrl || statusPublicUrl.trim()

  const [revealed, setRevealed] = React.useState<McpKeyWithPlaintext | null>(null)
  const [probe, setProbe] = React.useState<ProbeState | null>(null)
  const [guideOpen, setGuideOpen] = React.useState(false)
  const [clientConfigKey, setClientConfigKey] = React.useState<string | null>(null)
  const [clientConfigOpen, setClientConfigOpen] = React.useState(false)

  return (
    <>
      <ConnectionSection
        localUrl={localUrl}
        streamableHttpUrl={streamableHttpUrl}
        sseUrl={sseUrl}
        savedPublicUrl={savedPublicUrl}
        activeKeyCount={activeKeyCount}
        probe={probe}
        onProbe={setProbe}
        guideOpen={guideOpen}
        onGuideOpenChange={setGuideOpen}
        onOpenClientInstaller={() => {
          setClientConfigKey(null)
          setClientConfigOpen(true)
        }}
      />
      <KeysSection onRevealed={setRevealed} />
      <ToolsSection />
      <AuditSection />
      <KeyRevealedDialog
        revealed={revealed}
        localUrl={streamableHttpUrl}
        sseUrl={sseUrl}
        publicUrl={savedPublicUrl}
        publicUrlUnverified={
          savedPublicUrl !== '' && probe?.url === savedPublicUrl && !isReachable(probe)
        }
        onNeedPublicUrl={() => setGuideOpen(true)}
        onOpenClientInstaller={(plaintext) => {
          setClientConfigKey(plaintext)
          setClientConfigOpen(true)
        }}
        onClose={() => setRevealed(null)}
      />
      <ClientConfigDialog
        open={clientConfigOpen}
        initialApiKey={clientConfigKey ?? undefined}
        onClose={() => setClientConfigOpen(false)}
      />
    </>
  )
}
