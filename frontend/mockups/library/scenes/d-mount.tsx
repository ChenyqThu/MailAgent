// D 挂载本地文件夹与设置（design §8.2 §1.5 §9.1）

import * as React from 'react'
import { Download, ExternalLink, HardDrive, RotateCcw, TriangleAlert } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { Button } from '@shared/components/ui/button'
import { SegmentedControl } from '@shared/components/ui/segmented'
import { Switch } from '@shared/components/ui/switch'
import { Input } from '@shared/components/ui/input'
import { Separator } from '@shared/components/ui/separator'

import { MOUNTS } from '../fixtures'
import { S } from '../strings'
import {
  Demo,
  Notice,
  Pill,
  SceneHead,
  StateBar,
  StateSwitch,
  SystemDialogCard
} from '../parts/kit'

/* ── D1 添加文件夹流程 ─────────────────────────────────────────── */

type D1Step = 'trigger' | 'confirm' | 'tooMany' | 'refused'

const REFUSED_CASES = [
  { path: '/', why: '根目录' },
  { path: '~', why: '家目录本身' },
  { path: '~/Library', why: '系统与应用数据' },
  { path: '~/Library/Application Support/mailagent-frontend', why: 'DATA_ROOT（自己的库）' },
  { path: '/Users/chenyuanquan/Documents/Omada', why: '已有挂载 @工作区 的祖先' },
  { path: '/Users/chenyuanquan/Documents/Omada/工作区/2026-Q3', why: '已有挂载 @工作区 的后代' }
]

export function D1(): React.ReactElement {
  const [step, setStep] = React.useState<D1Step>('trigger')
  const [label, setLabel] = React.useState('招投标')
  const [mode, setMode] = React.useState<'ro' | 'rw'>('rw')

  return (
    <>
      <StateBar>
        <StateSwitch
          label="步骤"
          value={step}
          options={[
            { value: 'trigger', label: '① 触发系统对话框' },
            { value: 'confirm', label: '② 确认面板' },
            { value: 'tooMany', label: '③ 超 2 万文件' },
            { value: 'refused', label: '③ 拒挂' }
          ]}
          onChange={(v) => setStep(v as D1Step)}
        />
      </StateBar>

      <div className="mk-stage-body">
        <SceneHead
          id="D1"
          title="添加挂载文件夹"
          design="§8.2"
          note="App 不是沙盒（entitlements 里没有 app-sandbox），所以持久化只要存绝对路径，不需要 security-scoped bookmark。用户经系统目录对话框主动选中即视为同意。renderer 与模型永不拿到绝对路径 —— 界面里一律 @label 开头的虚拟路径，绝对路径只在设置页那一处显示（场景 D2）。"
        />

        {step === 'trigger' ? (
          <Demo title="① 点「添加文件夹」" hint="树底部那一行 / 设置页的按钮，两处同一条路径">
            <SystemDialogCard
              action="dialog.showOpenDialog({ properties: ['openDirectory'] })"
              detail="主进程弹系统目录选择器。这一步不 mock —— 它是 macOS 自己的窗口，我们没有任何可设计的地方。选完把绝对路径经 IPC 交给 POST /library/mounts。"
              onDone={() => setStep('confirm')}
              doneLabel="用户选了 ~/Documents/Omada/工作区/招投标"
            />
          </Demo>
        ) : null}

        {step === 'confirm' ? (
          <Demo title="② 确认面板" hint="选完目录后我们自己的面板">
            <div className="max-w-[560px] space-y-3">
              <div className="rounded-[var(--r-ctl)] border border-ink-border-soft bg-ink-2 px-3 py-2">
                <div className="text-micro font-mono uppercase tracking-widest text-ink-fg-3">
                  选中的目录
                </div>
                <div className="mt-0.5 break-all font-mono text-meta text-ink-fg-1">
                  /Users/chenyuanquan/Documents/Omada/工作区/招投标
                </div>
              </div>

              <label className="block">
                <span className="mb-1 block text-aux text-ink-fg-1">{S.mount.label}</span>
                <Input value={label} onChange={(e) => setLabel(e.target.value)} />
                <span className="mt-1 block text-meta text-ink-fg-3">
                  树里显示成 <code className="font-mono text-ink-fg-2">@{label || '招投标'}</code>；
                  agent 看到的路径也是这个前缀。默认取目录名。
                </span>
              </label>

              <div>
                <span className="mb-1 block text-aux text-ink-fg-1">{S.mount.mode}</span>
                <SegmentedControl
                  value={mode}
                  onChange={setMode}
                  ariaLabel={S.mount.mode}
                  options={[
                    { value: 'ro', label: S.mount.ro },
                    { value: 'rw', label: S.mount.rw }
                  ]}
                />
                <p className="mt-1 text-meta leading-relaxed text-ink-fg-3">
                  {mode === 'ro'
                    ? '只读：人和 agent 都只能看，不能改。随时可以改回可写。'
                    : '可写：人可以改；agent 在 manual 对话里按能力卡的 write 档可以改（与 Agents 文档同档、出厂 auto）。🔴 无人值守（headless）对挂载根**恒只读**。'}
                </p>
              </div>

              <div className="rounded-[var(--r-ctl)] border border-ink-border-soft bg-ink-2 px-3 py-2">
                <div className="flex items-center gap-2 text-aux text-ink-fg-1">
                  <HardDrive size={14} strokeWidth={1.9} aria-hidden className="text-ink-fg-2" />
                  {S.mount.estimate(1284)}
                </div>
                <div className="mt-0.5 text-meta text-ink-fg-3">{S.mount.skipHint}</div>
                <div className="mt-0.5 text-meta text-ink-fg-3">
                  只走目录树建行（stat）；文本抽取是后台低速队列，打开或搜索时优先。
                </div>
              </div>

              <div className="flex justify-end gap-1.5">
                <Button variant="ghost" size="sm" onClick={() => setStep('trigger')}>
                  {S.act.cancel}
                </Button>
                <Button size="sm">{S.mount.add}</Button>
              </div>
            </div>
          </Demo>
        ) : null}

        {step === 'tooMany' ? (
          <Demo title="③ 超过 2 万文件">
            <div className="max-w-[560px] space-y-2">
              <Notice tone="warn">
                <span className="font-medium">{S.mount.tooManyTitle}</span>
                <span className="ml-1.5">{S.mount.tooMany(84_207)}</span>
              </Notice>
              <div className="rounded-[var(--r-ctl)] border border-ink-border-soft bg-ink-2 px-3 py-2 text-meta leading-relaxed text-ink-fg-2">
                这是硬拦不是警告 —— 挂载的代价不在磁盘而在索引与抽取队列：8 万个文件的 stat
                建行、FTS 与（P3 的）嵌入都要排队，且没有 watcher 时对账全靠打开目录时的增量
                重扫。选一个更小的子目录，或者分成两个挂载。
              </div>
              <div className="flex justify-end gap-1.5">
                <Button variant="ghost" size="sm" onClick={() => setStep('trigger')}>
                  重新选
                </Button>
              </div>
            </div>
          </Demo>
        ) : null}

        {step === 'refused' ? (
          <Demo title="③ 拒挂的六种目录">
            <div className="max-w-[680px] space-y-2">
              <Notice tone="fail">
                <span className="font-medium">{S.mount.refusedTitle}</span>
              </Notice>
              <ul className="divide-y divide-ink-border-soft overflow-hidden rounded-[var(--r-ctl)] border border-ink-border">
                {REFUSED_CASES.map((c) => (
                  <li key={c.path} className="flex items-center gap-3 px-3 py-2">
                    <TriangleAlert
                      size={13}
                      strokeWidth={2}
                      className="shrink-0 text-fail"
                      aria-hidden
                    />
                    <code className="min-w-0 flex-1 truncate font-mono text-meta text-ink-fg-1">
                      {c.path}
                    </code>
                    <span className="shrink-0 text-meta text-ink-fg-3">{c.why}</span>
                  </li>
                ))}
              </ul>
              <div className="text-meta leading-relaxed text-ink-fg-3">
                嵌套（祖先 / 后代）拒挂是为了避免同一份文件出现在两棵树里、拿到两个 id。 exec 的
                deny 地板照常生效：挂 ~ 也读不到 .ssh / .env / 三个库；挂载内额外拒
                <code className="mx-1 font-mono">.env* .pem .key .db</code> 与
                <code className="mx-1 font-mono">.git/</code>。
              </div>
            </div>
          </Demo>
        ) : null}
      </div>
    </>
  )
}

/* ── D2 设置页「资料库」区 ─────────────────────────────────────── */

type SemanticState = 'off' | 'downloading' | 'ready' | 'indexing'

function SettingsRow({
  title,
  helper,
  children
}: {
  title: string
  helper?: React.ReactNode
  children?: React.ReactNode
}): React.ReactElement {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="text-aux font-medium text-ink-fg">{title}</div>
        {helper ? (
          <div className="mt-0.5 text-meta leading-relaxed text-ink-fg-2">{helper}</div>
        ) : null}
      </div>
      {children ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </div>
  )
}

function SettingsSection({
  title,
  helper,
  children
}: {
  title: string
  helper?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <section className="mb-4">
      <div className="px-1 pb-1.5">
        <h2 className="text-body font-medium text-ink-fg">{title}</h2>
        {helper ? <p className="mt-0.5 text-meta text-ink-fg-3">{helper}</p> : null}
      </div>
      <div className="divide-y divide-ink-border-soft overflow-hidden rounded-[var(--r-card)] border border-ink-border bg-ink-1">
        {children}
      </div>
    </section>
  )
}

export function D2(): React.ReactElement {
  const [semantic, setSemantic] = React.useState<SemanticState>('off')
  const [trashOn, setTrashOn] = React.useState(true)

  return (
    <>
      <StateBar>
        <StateSwitch
          label="语义检索"
          value={semantic}
          options={[
            { value: 'off', label: '未下载' },
            { value: 'downloading', label: '下载中' },
            { value: 'ready', label: '已就绪' },
            { value: 'indexing', label: '重建索引中' }
          ]}
          onChange={setSemantic}
        />
      </StateBar>

      <div className="mk-stage-body">
        <SceneHead
          id="D2"
          title="设置页「资料库」区"
          design="§1.5 §8.2 §9.1"
          note="🔴 绝对路径只在这一处显示 —— 树、面包屑、agent 看到的全是 @label 虚拟路径。语义检索没有 MAILAGENT_* 开关：模型在不在就是开关（design L17）。"
        />

        <div className="mx-auto max-w-[720px]">
          <SettingsSection title={S.settings.mounted} helper={S.mount.absPathNote}>
            {MOUNTS.map((m) => (
              <div key={m.id} className="flex items-start gap-3 px-4 py-3">
                <span
                  className={cn(
                    'mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg border',
                    m.status === 'ok'
                      ? 'border-ink-border bg-ink-2 text-ink-fg-2'
                      : 'border-warn/30 bg-warn/10 text-warn'
                  )}
                >
                  <ExternalLink size={13} strokeWidth={1.9} aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-aux font-medium text-ink-fg">@{m.label}</span>
                    <Pill tone={m.mode === 'rw' ? 'ok' : 'ink'}>
                      {m.mode === 'rw' ? S.mount.rw : S.mount.ro}
                    </Pill>
                    {m.status === 'unavailable' ? <Pill tone="warn">不可用</Pill> : null}
                    <span className="font-mono text-micro tabular-nums text-ink-fg-3">
                      {m.fileCount.toLocaleString('zh-CN')} 个文件
                    </span>
                  </div>
                  <div className="mt-0.5 break-all font-mono text-micro text-ink-fg-3">
                    {m.abs_path}
                  </div>
                  {m.status === 'unavailable' ? (
                    <div className="mt-1 text-meta text-warn">{S.mountUnavailable}</div>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button size="sm" variant="ghost">
                    {S.menu.revealInFinder}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-fail hover:bg-fail/10 hover:text-fail"
                  >
                    {S.menu.unmount}
                  </Button>
                </div>
              </div>
            ))}
            <div className="px-4 py-3">
              <Button size="sm" variant="secondary">
                {S.mount.add}
              </Button>
              <span className="ml-2 text-meta text-ink-fg-3">{S.menu.unmountHint}</span>
            </div>
          </SettingsSection>

          <SettingsSection title="库与对账">
            <SettingsRow
              title={S.settings.usage}
              helper="库根 data/library/ 与索引 library.db（含 wal/shm）。投影区不占空间。"
            >
              <span className="font-mono text-aux tabular-nums text-ink-fg-1">1.84 GB</span>
            </SettingsRow>
            <SettingsRow title={S.settings.rescan} helper={S.settings.rescanHint}>
              <Button size="sm" variant="secondary">
                <RotateCcw size={13} aria-hidden />
                {S.settings.rescan}
              </Button>
            </SettingsRow>
            <SettingsRow
              title={S.settings.trashPolicy}
              helper="删除的文件先进 .trash，30 天后自动清理。关掉 = 只保留到手动清空。"
            >
              <Switch checked={trashOn} onCheckedChange={setTrashOn} />
            </SettingsRow>
            <SettingsRow title={S.settings.chatArchiveTitle} helper={S.settings.chatArchiveHint}>
              <Pill tone="ok">恒开</Pill>
            </SettingsRow>
          </SettingsSection>

          <SettingsSection
            title={S.settings.semanticTitle}
            helper="P3 交付。全本地，除首次下载权重外零网络。"
          >
            {semantic === 'off' ? (
              <SettingsRow title="下载语义模型" helper={S.settings.semanticNotReady}>
                <Button size="sm" onClick={() => setSemantic('downloading')}>
                  <Download size={13} aria-hidden />
                  {S.settings.downloadModel}
                </Button>
              </SettingsRow>
            ) : null}

            {semantic === 'downloading' ? (
              <SettingsRow
                title={S.settings.downloading}
                helper="Qwen3-Embedding-0.6B int8 ONNX · 落 DATA_ROOT/library/embed_cache/（与 mem0 的 fastembed_cache 同姿态，离线可用）"
              >
                <div className="w-56">
                  <div className="mb-1 flex items-center justify-between font-mono text-micro tabular-nums text-ink-fg-2">
                    <span>218 MB / 614 MB</span>
                    <span>35%</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-ink-4">
                    <div className="h-full w-[35%] rounded-full bg-coral" />
                  </div>
                </div>
              </SettingsRow>
            ) : null}

            {semantic === 'ready' || semantic === 'indexing' ? (
              <>
                <SettingsRow
                  title={S.settings.modelReady}
                  helper="1024 维 · last-token 池化 + L2 归一化 · 直接调 onnxruntime（fastembed 的 PoolingType 没有 last-token）"
                >
                  <Pill tone="ok">已就绪</Pill>
                </SettingsRow>
                <SettingsRow
                  title={S.settings.rebuildIndex}
                  helper={
                    semantic === 'indexing'
                      ? S.settings.indexProgress(1_820, 4_412)
                      : '只嵌 text_status=extracted 的文件；新写入 / hash 变化自动入队。'
                  }
                >
                  {semantic === 'indexing' ? (
                    <div className="w-56">
                      <div className="mb-1 flex items-center justify-between font-mono text-micro tabular-nums text-ink-fg-2">
                        <span>1,820 / 4,412</span>
                        <span>41%</span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-ink-4">
                        <div className="h-full w-[41%] rounded-full bg-coral" />
                      </div>
                    </div>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => setSemantic('indexing')}>
                      {S.settings.rebuildIndex}
                    </Button>
                  )}
                </SettingsRow>
              </>
            ) : null}

            <div className="px-4 py-3">
              <Separator className="mb-2" />
              <div className="text-meta leading-relaxed text-ink-fg-3">
                检索模式：模型没下 = 纯 FTS5（关键词）；下了 = FTS top-50 ∪ 向量 top-50 → RRF(k=60)
                混合，结果带 <code className="font-mono">match: fts | vec | both</code> 标记。
                切块约 400 token / 15% 重叠，向量 int8 存 library_chunk（1 KB / 块）。
              </div>
            </div>
          </SettingsSection>
        </div>
      </div>
    </>
  )
}
