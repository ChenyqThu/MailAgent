// 设置页「资料库」区（design §1.5 / §8.2 / §9.1；mockup D2）：库占用 · 重扫 · 挂载列表 · 语义检索。
//
// 🔴 **这里是全应用唯一显示绝对路径的地方**（design §8.2）。判据不是自觉：树、面包屑、预览面
// 拿到的是 `GET /library/tree` 内嵌的 `LibraryMountSummary`，那个类型没有 `abs_path` 字段；
// 只有 `GET /library/mounts` 的 `LibraryMount` 有，而它只有本文件在调。
//
// 🔴 语义检索**没有 `MAILAGENT_*` 开关** —— 权重在不在就是开关（design §9.1 L17）。
// 🔴 下载完成会自动接一次建索引，所以进度必须按 `job.kind` 分两段（下载 = 字节 / 建索引 = 文件数）；
// 只按「有没有 job」渲染会让用户在建索引阶段以为下载卡住了。

import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, ExternalLink, RotateCcw } from 'lucide-react'

import type { LibraryEmbedProbeResponse, LibraryEmbedStatus } from '@shared/api/library'
import { EMBED_MODEL_APPROX_BYTES } from '@shared/libraryConstants'
import type { LibraryMount } from '@shared/api/types/library'
import { Button } from '@shared/components/ui/button'
import { useLibraryApi } from '@shared/components/library/hooks'
import { revealLibraryTarget, libraryUsageBytes } from '@shared/components/library/libraryIpc'
import { useAddMountFlow } from '@shared/components/library/useAddMountFlow'
import {
  mountErrorText,
  useLibraryMountsQuery,
  useMountMutations
} from '@shared/components/library/mountHooks'
import { Pill } from '@shared/components/library/parts'
import { formatFileSize } from '@shared/format'
import { cn } from '@shared/lib/cn'
import { toastError, toastSuccess } from '@shared/state/toast'

import { Row } from './parts/Row'
import { Section } from './parts/Section'

/** 作业跑着时约 1s 一次，跑完停（design §9.1：设置页轮询它）。 */
const JOB_POLL_MS = 1_000

export function LibrarySection(): ReactElement {
  const { t } = useTranslation()

  return (
    <>
      <Section title={t('library.settings.title')}>
        <UsageRow />
        <RescanRow />
        <Row label={t('library.settings.trashPolicy')} helper={t('library.trash.notice')}>
          {null}
        </Row>
        <Row
          label={t('library.settings.chatArchiveTitle')}
          helper={t('library.settings.chatArchiveHint')}
        >
          {null}
        </Row>
      </Section>
      <MountsSection />
      <SemanticSection />
    </>
  )
}

function UsageRow(): ReactElement {
  const { t } = useTranslation()
  const usage = useQuery({
    queryKey: ['library', 'usage'],
    queryFn: libraryUsageBytes,
    staleTime: 60_000
  })
  return (
    <Row label={t('library.settings.usage')}>
      <span className="font-mono text-aux tabular-nums text-ink-fg-1">
        {usage.data === undefined ? '—' : formatFileSize(usage.data)}
      </span>
    </Row>
  )
}

function RescanRow(): ReactElement {
  const { t } = useTranslation()
  const api = useLibraryApi()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)

  async function rescan(): Promise<void> {
    setBusy(true)
    try {
      const result = await api.rescan()
      await qc.invalidateQueries({ queryKey: ['library'] })
      // 计数是纯数字，不拼中文；四个字段的含义在按钮的 helper 里已经说清了。
      toastSuccess(
        t('library.settings.rescan'),
        `${result.scanned} · +${result.added} · ~${result.updated} · −${result.missing}`
      )
    } catch (err) {
      toastError(t('library.settings.rescan'), mountErrorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Row label={t('library.settings.rescan')} helper={t('library.settings.rescanHint')}>
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => void rescan()}>
        <RotateCcw size={13} aria-hidden />
        {t('library.settings.rescan')}
      </Button>
    </Row>
  )
}

function MountsSection(): ReactElement {
  const { t } = useTranslation()
  const mountsQuery = useLibraryMountsQuery()
  const addMount = useAddMountFlow()
  const rows = mountsQuery.data ?? []

  return (
    <Section title={t('library.settings.mounted')} helper={t('library.mount.absPathNote')}>
      {rows.map((mount) => (
        <MountRow key={mount.id} mount={mount} />
      ))}
      <div className="flex items-center gap-2 px-[var(--settings-tile-px,1rem)] py-3">
        <Button size="sm" variant="secondary" onClick={() => void addMount.begin()}>
          {t('library.mount.add')}
        </Button>
        <span className="min-w-0 flex-1 text-meta text-ink-fg-3">
          {t('library.tree.menu.unmountHint')}
        </span>
      </div>
      {addMount.dialog}
    </Section>
  )
}

function MountRow({ mount }: { mount: LibraryMount }): ReactElement {
  const { t } = useTranslation()
  const mutations = useMountMutations()
  const unavailable = mount.status !== 'ok'

  return (
    <div className="flex items-start gap-3 px-[var(--settings-tile-px,1rem)] py-3">
      <span
        className={cn(
          'mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg border',
          unavailable
            ? 'border-warn/30 bg-warn/10 text-warn'
            : 'border-ink-border bg-ink-2 text-ink-fg-2'
        )}
      >
        <ExternalLink size={13} strokeWidth={1.9} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-aux font-medium text-ink-fg">@{mount.label}</span>
          <Pill tone={mount.mode === 'rw' ? 'ok' : 'ink'}>
            {t(mount.mode === 'rw' ? 'library.mount.rw' : 'library.mount.ro')}
          </Pill>
          <span className="font-mono text-micro tabular-nums text-ink-fg-3">
            {mount.file_count}
          </span>
        </div>
        {/* 🔴 全应用唯一的绝对路径展示点。 */}
        <div
          data-testid="library-mount-abs-path"
          className="mt-0.5 break-all font-mono text-micro text-ink-fg-3"
        >
          {mount.abs_path}
        </div>
        {unavailable ? (
          <div className="mt-1 text-meta text-warn">{t('library.tree.mountUnavailable')}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          disabled={unavailable}
          onClick={() => void revealLibraryTarget({ kind: 'folder', path: `@${mount.label}` })}
        >
          {t('library.tree.menu.revealInFinder')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={mutations.busy}
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => {
            void mutations.remove(mount.id).catch((err: unknown) => {
              toastError(t('library.tree.menu.unmount'), mountErrorText(err))
            })
          }}
        >
          {t('library.tree.menu.unmount')}
        </Button>
      </div>
    </div>
  )
}

function ProgressBar({ done, total }: { done: number; total: number }): ReactElement {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  return (
    <div className="h-1.5 w-40 overflow-hidden rounded-full bg-ink-4">
      <div className="h-full rounded-full bg-coral/100" style={{ width: `${pct}%` }} />
    </div>
  )
}

function formatEta(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`
}

function SemanticSection(): ReactElement {
  const { t } = useTranslation()
  const api = useLibraryApi()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [probeBusy, setProbeBusy] = useState(false)
  const [probeData, setProbeData] = useState<LibraryEmbedProbeResponse | null>(null)
  const [selectedServerUrl, setSelectedServerUrl] = useState('')
  const [selectedLocalModel, setSelectedLocalModel] = useState('')

  const status = useQuery<LibraryEmbedStatus>({
    queryKey: ['library', 'embed', 'status'],
    queryFn: () => api.embedStatus(),
    refetchInterval: (query) => (query.state.data?.job?.running === true ? JOB_POLL_MS : false)
  })

  async function detectLocalServers(): Promise<void> {
    setProbeBusy(true)
    try {
      const res = await api.embedProbeProviders()
      setProbeData(res)
      const firstRunning = res.servers.find((s) => s.running && s.models.length > 0)
      if (firstRunning) {
        setSelectedServerUrl(firstRunning.base_url)
        setSelectedLocalModel(firstRunning.models[0]?.id ?? '')
      }
    } catch (err) {
      toastError(t('library.settings.detectServers'), mountErrorText(err))
    } finally {
      setProbeBusy(false)
    }
  }

  async function switchProvider(config: {
    kind: 'builtin_onnx' | 'openai_compat'
    base_url?: string | null
    model?: string | null
  }): Promise<void> {
    setBusy(true)
    try {
      const next = await api.embedSetProvider(config)
      qc.setQueryData(['library', 'embed', 'status'], next)
    } catch (err) {
      toastError(t('library.settings.providerTitle'), mountErrorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function run(kind: 'download' | 'rebuild'): Promise<void> {
    setBusy(true)
    try {
      const next = kind === 'download' ? await api.embedDownload() : await api.embedRebuild()
      qc.setQueryData(['library', 'embed', 'status'], next)
    } catch (err) {
      // 已下载 / 已有作业在跑 / 没模型都是 E_INVALID_STATE（HTTP 409，不是 400）。
      toastError(
        t(kind === 'download' ? 'library.settings.downloadModel' : 'library.settings.rebuildIndex'),
        mountErrorText(err)
      )
    } finally {
      setBusy(false)
    }
  }

  async function cancel(): Promise<void> {
    setBusy(true)
    try {
      const next = await api.embedCancel()
      qc.setQueryData(['library', 'embed', 'status'], next)
    } catch (err) {
      toastError(t('library.settings.cancelDownload'), mountErrorText(err))
    } finally {
      setBusy(false)
    }
  }

  const data = status.data
  const job = data?.job ?? null
  const running = job?.running === true
  const resumedDownload = !running && job?.cancelled === true && job.done > 0
  const providerKind = data?.provider?.kind ?? 'builtin_onnx'
  const approxSize = formatFileSize(data?.model.approx_bytes ?? EMBED_MODEL_APPROX_BYTES)
  const runningServers = (probeData?.servers ?? []).filter((s) => s.running && s.models.length > 0)
  const activeServer =
    runningServers.find((s) => s.base_url === selectedServerUrl) ?? runningServers[0] ?? null
  const modelChoices = activeServer?.models ?? []
  const effectiveLocalModel =
    modelChoices.find((m) => m.id === selectedLocalModel)?.id ?? modelChoices[0]?.id ?? ''

  let downloadHelper = job !== null ? `${formatFileSize(job.done)} / ${formatFileSize(job.total)}` : ''
  if (job !== null && job.speed_bps != null && job.speed_bps > 0) {
    const parts = [downloadHelper, `${formatFileSize(job.speed_bps)}/s`]
    if (job.eta_seconds != null && job.eta_seconds > 0) parts.push(formatEta(job.eta_seconds))
    if (job.mirror) parts.push(job.mirror)
    downloadHelper = parts.join(' · ')
  }

  return (
    <Section title={t('library.settings.semanticTitle')}>
      <Row
        label={t('library.settings.providerTitle')}
        helper={
          providerKind === 'openai_compat' && data?.provider?.model
            ? `${data.provider.model}${data.provider.base_url ? ` · ${data.provider.base_url}` : ''}`
            : t('library.settings.providerBuiltin')
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          {providerKind === 'openai_compat' && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void switchProvider({ kind: 'builtin_onnx' })}
            >
              {t('library.settings.providerBuiltin')}
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            disabled={probeBusy || busy}
            onClick={() => void detectLocalServers()}
          >
            {t('library.settings.detectServers')}
          </Button>
        </div>
      </Row>

      {probeData !== null && (
        <Row label={t('library.settings.providerLocalServer')}>
          {runningServers.length === 0 ? (
            <span className="text-aux text-ink-fg-3">{t('library.settings.noLocalServers')}</span>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label={t('library.settings.providerLocalServer')}
                value={activeServer?.base_url ?? ''}
                onChange={(e) => {
                  const nextUrl = e.target.value
                  setSelectedServerUrl(nextUrl)
                  const srv = runningServers.find((s) => s.base_url === nextUrl)
                  setSelectedLocalModel(srv?.models[0]?.id ?? '')
                }}
                className="h-8 rounded-md border border-ink-border bg-ink-2 px-2 text-aux text-ink-fg"
              >
                {runningServers.map((s) => (
                  <option key={s.base_url} value={s.base_url}>
                    {s.label}
                  </option>
                ))}
              </select>
              <select
                aria-label={t('library.settings.selectLocalModel')}
                value={effectiveLocalModel}
                onChange={(e) => setSelectedLocalModel(e.target.value)}
                className="h-8 max-w-[200px] rounded-md border border-ink-border bg-ink-2 px-2 text-aux text-ink-fg"
              >
                {modelChoices.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                disabled={busy || !activeServer || !effectiveLocalModel}
                onClick={() =>
                  void switchProvider({
                    kind: 'openai_compat',
                    base_url: activeServer?.base_url,
                    model: effectiveLocalModel
                  })
                }
              >
                {t('library.settings.applyProvider')}
              </Button>
            </div>
          )}
        </Row>
      )}

      {/* 下载中：done/total 是**字节**。 */}
      {running && job !== null && job.kind === 'download' ? (
        <Row label={t('library.settings.downloading')} helper={downloadHelper}>
          <div className="flex items-center gap-2">
            <ProgressBar done={job.done} total={job.total} />
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void cancel()}>
              {t('library.settings.cancelDownload')}
            </Button>
          </div>
        </Row>
      ) : null}

      {/* 建索引中：done/total 是**文件数**。下载完会自动接上这一段，所以它不只在点了「重建索引」后出现。 */}
      {running && job !== null && job.kind === 'index' ? (
        <Row
          label={t('library.settings.rebuildIndex')}
          helper={t('library.settings.indexProgress', { done: job.done, total: job.total })}
        >
          <ProgressBar done={job.done} total={job.total} />
        </Row>
      ) : null}

      {providerKind === 'builtin_onnx' && !running && data !== undefined && !data.model.available ? (
        <>
          {job?.cancelled === true ? (
            <Row label={t('library.settings.downloadCancelled')}>{null}</Row>
          ) : null}
          <Row label={t('library.settings.semanticNotReady')}>
            <Button size="sm" disabled={busy} onClick={() => void run('download')}>
              <Download size={13} aria-hidden />
              {resumedDownload
                ? t('library.settings.resumeDownload')
                : t('library.settings.downloadModel', { size: approxSize })}
            </Button>
          </Row>
        </>
      ) : null}

      {data !== undefined && data.model.available ? (
        <>
          <Row
            label={t('library.settings.modelReady')}
            helper={
              data.email_semantic
                ? t('library.settings.emailIndexProgress', {
                    done: data.email_semantic.indexed_emails,
                    total: data.email_semantic.total_emails
                  })
                : undefined
            }
          >
            {data.model.bytes_on_disk > 0 ? (
              <span className="font-mono text-meta tabular-nums text-ink-fg-2">
                {formatFileSize(data.model.bytes_on_disk)}
              </span>
            ) : null}
          </Row>
          {running ? null : (
            <Row
              label={t('library.settings.rebuildIndex')}
              helper={t('library.settings.indexProgress', {
                done: data.index.files_indexed,
                total: data.index.files_total
              })}
            >
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run('rebuild')}>
                {t('library.settings.rebuildIndex')}
              </Button>
            </Row>
          )}
        </>
      ) : null}

      {job !== null && job.error !== null ? (
        <Row label={t('library.settings.semanticTitle')}>
          <span className="max-w-[280px] break-all text-meta text-fail">{job.error}</span>
        </Row>
      ) : null}
    </Section>
  )
}
