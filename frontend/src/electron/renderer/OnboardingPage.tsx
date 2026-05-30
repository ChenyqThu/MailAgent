// Onboarding 配置向导 (打包 P2/P3 MVP, 单页)。
//
// 何时渲染: main.tsx 检测到 ?onboarding=1 (主进程在 new/config-incomplete 用户上以此
// query 开窗) → 渲染本页而非主 App。
//
// 流程: 用户填 Notion token + DB id + 邮箱 → onboarding:complete → 主进程写 DATA_ROOT/.env
// + 起后端 + 等就绪 + reload 窗口 (去掉 ?onboarding=1) → 进主 App。
//
// 自包含: 不依赖 router / 主 App 任何东西 (隔离, 即使主 App 有问题也能配置); 直接走
// window.electron.ipcRenderer.invoke。完整多步向导 (FDA/backend 选择/插件) 见
// docs/packaging/03-onboarding-prd.md, 后续迭代。
import { useState } from 'react'

interface FieldDef {
  key: string
  label: string
  required: boolean
  placeholder: string
  secret?: boolean
  help?: string
}

const FIELDS: FieldDef[] = [
  {
    key: 'NOTION_TOKEN',
    label: 'Notion Integration Token',
    required: true,
    secret: true,
    placeholder: 'ntn_xxx / secret_xxx',
    help: 'Notion → Settings → Connections → 你的 integration 的 Internal Token'
  },
  {
    key: 'EMAIL_DATABASE_ID',
    label: '邮件数据库 ID',
    required: true,
    placeholder: '32 位 hex',
    help: '邮件 Notion 数据库的 ID (URL 里那段)'
  },
  {
    key: 'USER_EMAIL',
    label: '你的邮箱',
    required: true,
    placeholder: 'you@company.com'
  },
  {
    key: 'MAIL_ACCOUNT_NAME',
    label: 'Mail.app 账户名',
    required: false,
    placeholder: 'Exchange (默认)',
    help: 'Mail.app 里该邮箱账户的名称; 留空默认 Exchange'
  },
  {
    key: 'CALENDAR_DATABASE_ID',
    label: '日历数据库 ID (可选)',
    required: false,
    placeholder: '启用日历同步时填'
  }
]

type IpcInvoke = (channel: string, ...args: unknown[]) => Promise<unknown>

function getInvoke(): IpcInvoke | null {
  const w = window as unknown as { electron?: { ipcRenderer?: { invoke?: IpcInvoke } } }
  return w.electron?.ipcRenderer?.invoke ?? null
}

export default function OnboardingPage(): React.JSX.Element {
  const [values, setValues] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const set = (key: string, v: string): void => setValues((prev) => ({ ...prev, [key]: v }))

  const missingRequired = FIELDS.filter((f) => f.required && !(values[f.key] ?? '').trim())

  async function submit(): Promise<void> {
    setError(null)
    if (missingRequired.length > 0) {
      setError(`请填写: ${missingRequired.map((f) => f.label).join('、')}`)
      return
    }
    const invoke = getInvoke()
    if (!invoke) {
      setError('IPC 不可用 (preload 未加载?)')
      return
    }
    setSubmitting(true)
    try {
      const res = (await invoke('onboarding:complete', values)) as {
        ok: boolean
        ready?: boolean
        error?: { message?: string }
      }
      if (!res?.ok) {
        setError(res?.error?.message ?? '配置失败, 请重试')
        setSubmitting(false)
        return
      }
      // 成功: 主进程会 reload 窗口进主界面。保持 submitting 态 (显示"正在启动…")。
      if (res.ready === false) {
        setError('配置已保存, 但后端启动较慢 (大库迁移?) — 稍候将自动进入, 或重启应用。')
      }
    } catch (err) {
      setError(`提交出错: ${(err as Error).message}`)
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0E1013] p-8 text-slate-100">
      <div className="w-full max-w-lg">
        <h1 className="mb-1 text-2xl font-semibold">欢迎使用 MailAgent</h1>
        <p className="mb-6 text-sm text-slate-400">
          填写下面几项即可开始。默认使用 Mail.app (AppleScript) 同步, 无需额外配置。
        </p>

        <div className="space-y-4">
          {FIELDS.map((f) => (
            <div key={f.key}>
              <label className="mb-1 block text-sm font-medium">
                {f.label}
                {f.required && <span className="ml-1 text-rose-400">*</span>}
              </label>
              <input
                type={f.secret ? 'password' : 'text'}
                value={values[f.key] ?? ''}
                placeholder={f.placeholder}
                onChange={(e) => set(f.key, e.target.value)}
                disabled={submitting}
                className="w-full rounded-md border border-slate-700 bg-[#16191F] px-3 py-2 text-sm outline-none focus:border-sky-500 disabled:opacity-50"
              />
              {f.help && <p className="mt-1 text-xs text-slate-500">{f.help}</p>}
            </div>
          ))}
        </div>

        {error && (
          <p className="mt-4 rounded-md bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</p>
        )}

        <button
          type="button"
          onClick={() => void submit()}
          disabled={submitting}
          className="mt-6 w-full rounded-md bg-sky-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? '正在保存配置并启动后端…' : '保存并开始'}
        </button>

        <p className="mt-4 text-center text-xs text-slate-600">
          配置写入 ~/Library/Application Support/MailAgent/.env, 之后可在「设置」里随时修改。
        </p>
      </div>
    </div>
  )
}
