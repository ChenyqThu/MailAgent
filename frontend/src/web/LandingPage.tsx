import {
  ArrowRight,
  Bell,
  Brain,
  CalendarDays,
  CheckCircle2,
  DatabaseZap,
  Mail,
  ShieldCheck,
  Sparkles,
  Workflow
} from 'lucide-react'

const baseUrl = import.meta.env.BASE_URL

const featureRows = [
  {
    icon: Mail,
    title: 'Mail.app 实时同步',
    body: 'SQLite 雷达发现新邮件后，用 internal_id 快速抓取正文、附件和线程关系，再同步到 Notion。'
  },
  {
    icon: Brain,
    title: '本地 LLM 分类',
    body: '按收件箱和发件箱规则判断优先级、动作类型、摘要和后续处理状态，失败时走重试队列。'
  },
  {
    icon: CalendarDays,
    title: '会议邀请入库',
    body: '识别 iCalendar、Teams 链接、组织者和时间范围，把关键日程同步到 Notion Calendar 数据库。'
  },
  {
    icon: Bell,
    title: '飞书与灵动岛通知',
    body: '重要邮件会触发可操作通知，支持起草回复、优化回复、完成闭环和本机状态反馈。'
  }
] as const

const systemPillars = [
  ['SQLite-First', 'ROWID 与 AppleScript id 对齐，查询耗时从百秒级降到秒级。'],
  ['双向闭环', 'Notion、Mail.app、飞书按钮和本地状态机保持同一处理语义。'],
  ['可观察运行', 'PM2/日志/看板/死信队列把同步、反向同步和 LLM 处理状态摊开。']
] as const

function LandingPage(): React.ReactElement {
  const appHref = baseUrl
  const inboxImage = `${baseUrl}landing/inbox.png`
  const logoImage = `${baseUrl}landing/logo.png`

  return (
    <main className="min-h-screen overflow-x-clip bg-ink-0 text-ink-fg">
      <section className="relative min-h-[92vh] overflow-hidden border-b border-ink-border bg-ink-0">
        <img
          src={inboxImage}
          alt="MailAgent inbox interface"
          className="absolute inset-y-0 right-[-24rem] hidden h-full w-auto max-w-none object-cover opacity-55 lg:block xl:right-[-12rem] 2xl:right-0"
        />
        <div className="absolute inset-0 bg-ink-0/72 lg:bg-ink-0/38" />

        <div className="relative mx-auto flex min-h-[92vh] w-full max-w-7xl flex-col px-5 py-5 sm:px-8 lg:px-10">
          <header className="flex items-center justify-between">
            <a
              href={appHref}
              className="flex items-center gap-3 rounded focus-visible:outline-coral"
            >
              <img src={logoImage} alt="" className="h-8 w-8 rounded-md" />
              <span className="font-display text-lead font-semibold text-ink-fg">MailAgent</span>
            </a>
            <nav className="hidden items-center gap-6 text-body text-ink-fg-1 md:flex">
              <a href="#system" className="rounded hover:text-ink-fg">
                架构
              </a>
              <a href="#features" className="rounded hover:text-ink-fg">
                功能
              </a>
              <a href={appHref} className="rounded hover:text-ink-fg">
                工作台
              </a>
            </nav>
          </header>

          <div className="flex flex-1 items-center py-14 sm:py-20">
            <div className="max-w-2xl">
              <div className="mb-5 inline-flex items-center gap-2 rounded border border-coral/30 bg-coral/10 px-3 py-1 text-body text-coral">
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                macOS 邮件实时同步系统
              </div>
              <h1 className="font-display text-4xl font-semibold leading-[1.08] text-ink-fg sm:text-5xl lg:text-6xl">
                MailAgent
              </h1>
              <p className="mt-6 max-w-xl text-lead text-ink-fg-1 sm:text-[17px] sm:leading-7">
                把 Mail.app、SQLite、Notion、LLM
                分类、日程和飞书通知接成一条本机优先的邮件处理流水线。
                重点邮件被看见，普通邮件被归档，状态在每个系统里对齐。
              </p>

              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <a
                  href={appHref}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded bg-[rgb(var(--c-cta-bg))] px-4 text-body font-semibold text-[rgb(var(--c-cta-fg))] transition hover:bg-[rgb(var(--c-cta-bg-hover))]"
                >
                  进入工作台
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </a>
                <a
                  href="#features"
                  className="inline-flex h-10 items-center justify-center rounded border border-ink-border bg-ink-2/80 px-4 text-body text-ink-fg-1 transition hover:bg-ink-3 hover:text-ink-fg"
                >
                  查看能力
                </a>
              </div>

              <img
                src={inboxImage}
                alt="MailAgent inbox interface"
                className="mt-8 block aspect-[16/10] w-full rounded border border-ink-border object-cover object-left-top lg:hidden"
              />

              <div className="mt-10 grid max-w-xl grid-cols-3 gap-2 text-body text-ink-fg-2">
                <div className="rounded border border-ink-border bg-ink-1/70 p-3">
                  <div className="font-mono text-xl text-ink-fg">127x</div>
                  <div className="mt-1">AppleScript 查询提升</div>
                </div>
                <div className="rounded border border-ink-border bg-ink-1/70 p-3">
                  <div className="font-mono text-xl text-ink-fg">5s</div>
                  <div className="mt-1">默认雷达轮询</div>
                </div>
                <div className="rounded border border-ink-border bg-ink-1/70 p-3">
                  <div className="font-mono text-xl text-ink-fg">v3</div>
                  <div className="mt-1">SQLite-First 架构</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="system" className="border-b border-ink-border bg-ink-1">
        <div className="mx-auto grid max-w-7xl gap-8 px-5 py-14 sm:px-8 lg:grid-cols-[0.9fr_1.1fr] lg:px-10 lg:py-20">
          <div>
            <div className="mb-4 flex items-center gap-2 text-body text-coral">
              <DatabaseZap className="h-4 w-4" aria-hidden="true" />
              SQLite SSoT
            </div>
            <h2 className="font-display text-3xl font-semibold leading-tight text-ink-fg sm:text-4xl">
              为大邮箱和真实工作流设计。
            </h2>
            <p className="mt-5 text-lead text-ink-fg-1">
              MailAgent 不把邮件当成一次性 API 导入任务。它把 Mail.app 的本机数据库作为变化源，用
              SQLite 记录可重试状态，再把完整正文、附件、AI 字段和处理状态推向 Notion。
            </p>
          </div>

          <div className="grid gap-3">
            {systemPillars.map(([title, body]) => (
              <div key={title} className="rounded border border-ink-border bg-ink-2 p-4">
                <div className="flex items-center gap-2 text-body font-semibold text-ink-fg">
                  <CheckCircle2 className="h-4 w-4 text-ok" aria-hidden="true" />
                  {title}
                </div>
                <p className="mt-2 text-body text-ink-fg-1">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="features" className="bg-ink-0">
        <div className="mx-auto max-w-7xl px-5 py-14 sm:px-8 lg:px-10 lg:py-20">
          <div className="mb-8 flex flex-col justify-between gap-4 md:flex-row md:items-end">
            <div>
              <div className="mb-3 flex items-center gap-2 text-body text-coral">
                <Workflow className="h-4 w-4" aria-hidden="true" />
                Workflow
              </div>
              <h2 className="font-display text-3xl font-semibold text-ink-fg sm:text-4xl">
                从收件到处理完成，少一步都不算闭环。
              </h2>
            </div>
            <p className="max-w-md text-body text-ink-fg-1">
              这里的每个模块都围绕一个目标：让邮件状态在 Mail.app、Notion 和通知端保持一致。
            </p>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {featureRows.map((feature) => {
              const Icon = feature.icon
              return (
                <article
                  key={feature.title}
                  className="rounded border border-ink-border bg-ink-2 p-4"
                >
                  <div className="mb-4 flex h-9 w-9 items-center justify-center rounded bg-coral/10 text-coral">
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </div>
                  <h3 className="text-lead font-semibold text-ink-fg">{feature.title}</h3>
                  <p className="mt-3 text-body text-ink-fg-1">{feature.body}</p>
                </article>
              )
            })}
          </div>
        </div>
      </section>

      <section className="border-t border-ink-border bg-ink-1">
        <div className="mx-auto flex max-w-7xl flex-col gap-6 px-5 py-10 sm:px-8 md:flex-row md:items-center md:justify-between lg:px-10">
          <div>
            <div className="mb-2 flex items-center gap-2 text-meta text-ink-fg-2">
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              Local-first by default
            </div>
            <h2 className="font-display text-2xl font-semibold text-ink-fg">
              打开工作台，继续处理真实邮件。
            </h2>
          </div>
          <a
            href={appHref}
            className="inline-flex h-10 items-center justify-center gap-2 rounded bg-[rgb(var(--c-cta-bg))] px-4 text-body font-semibold text-[rgb(var(--c-cta-fg))] transition hover:bg-[rgb(var(--c-cta-bg-hover))]"
          >
            进入 MailAgent
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </a>
        </div>
      </section>
    </main>
  )
}

export default LandingPage
