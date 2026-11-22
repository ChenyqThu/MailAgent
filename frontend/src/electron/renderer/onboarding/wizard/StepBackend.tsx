// Onboarding step 2: Mail backend selection (DavMail vs AppleScript).

import { useState } from 'react'

import { detectUiPlatform } from '@shared/lib/mailBackend'

import { Banner, Icon, WizFooter } from '../components'
import type { BackendKind } from '../ipc'

/* ─── Step 2 · Backend selection ───────────────────────────────────────────── */
export interface StepBackendProps {
  backend: BackendKind
  setBackend: (b: BackendKind) => void
  davAck: boolean
  setDavAck: (v: boolean) => void
  /** outlook_com (Windows) 前提确认勾选 — 镜像 davAck 的角色。 */
  comAck: boolean
  setComAck: (v: boolean) => void
  onNext: () => void
  onBack: () => void
}

export function StepBackend({
  backend,
  setBackend,
  davAck,
  setDavAck,
  comAck,
  setComAck,
  onNext,
  onBack
}: StepBackendProps): React.JSX.Element {
  const [advOpen, setAdvOpen] = useState(false)
  // 平台双卡 (owner 2026-08-13 拍板, 单源 @shared/lib/mailBackend):
  //   mac = AppleScript(推荐) + DavMail; win = Outlook 本机(推荐) + DavMail。
  const isWin = detectUiPlatform() === 'win32'
  const canNext =
    backend === 'applescript' ||
    (backend === 'davmail' && davAck) ||
    (backend === 'outlook_com' && comAck)

  // DavMail 卡两平台共用同一 JSX (mac 渲染树零变化)。
  const davmailCard = (
    <button
      type="button"
      className={`opt-card ${backend === 'davmail' ? 'on' : ''}`}
      onClick={() => {
        setBackend('davmail')
        setAdvOpen(true)
      }}
    >
      <div className="flex items-start gap-3">
        <span className="opt-radio mt-0.5" />
        <span
          className="text-ink-fg-1 mt-0.5"
          style={{ color: backend === 'davmail' ? 'rgb(var(--c-accent))' : undefined }}
        >
          <Icon name="server" size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-semibold text-ink-fg">DavMail</span>
            <span className="pill pill-info">企业 · Outlook/EWS</span>
            <span className="pill pill-warn">Beta</span>
          </div>
          <div className="text-[13px] text-ink-fg-1 mt-1 leading-snug">
            用于 Outlook / Exchange 企业邮箱。需系统 Java + 引导式配置，有合规前提。
          </div>
        </div>
      </div>
    </button>
  )

  return (
    <>
      <div className="wiz-body scrollbar-thin step-enter">
        <div className="eyebrow">Step 2 — 后端选择</div>
        <h1 className="wiz-h1">选择邮件后端</h1>
        <p className="wiz-lede">
          {isWin
            ? '决定 MailAgent 如何读写你的邮件。推荐使用本机 Outlook —— 零外部依赖。'
            : '决定 MailAgent 如何读写你的邮件。个人用户推荐 AppleScript —— 零配置、零合规风险。'}
        </p>

        <div className="flex flex-col gap-3 mt-6">
          {isWin ? (
            <button
              type="button"
              className={`opt-card ${backend === 'outlook_com' ? 'on' : ''}`}
              onClick={() => setBackend('outlook_com')}
            >
              <div className="flex items-start gap-3">
                <span className="opt-radio mt-0.5" />
                <span
                  className="text-ink-fg-1 mt-0.5"
                  style={{
                    color: backend === 'outlook_com' ? 'rgb(var(--c-accent))' : undefined
                  }}
                >
                  <Icon name="mail" size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[15px] font-semibold text-ink-fg">Outlook（本机）</span>
                    <span className="pill pill-ok">推荐</span>
                  </div>
                  <div className="text-[13px] text-ink-fg-1 mt-1 leading-snug">
                    使用本机 Outlook 里已登录的账户读写邮件。零外部依赖，需已安装并登录 classic
                    Outlook。
                  </div>
                </div>
              </div>
            </button>
          ) : (
            <button
              type="button"
              className={`opt-card ${backend === 'applescript' ? 'on' : ''}`}
              onClick={() => setBackend('applescript')}
            >
              <div className="flex items-start gap-3">
                <span className="opt-radio mt-0.5" />
                <span
                  className="text-ink-fg-1 mt-0.5"
                  style={{
                    color: backend === 'applescript' ? 'rgb(var(--c-accent))' : undefined
                  }}
                >
                  <Icon name="mail" size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[15px] font-semibold text-ink-fg">AppleScript</span>
                    <span className="pill pill-ok">推荐</span>
                  </div>
                  <div className="text-[13px] text-ink-fg-1 mt-1 leading-snug">
                    使用你 Mail.app 里已登录的账户读写邮件。零配置，需要上一步授予完全磁盘访问。
                  </div>
                </div>
              </div>
            </button>
          )}

          {davmailCard}
        </div>

        {backend === 'outlook_com' && (
          <div className="mt-3 step-enter">
            <Banner kind="info">
              <div className="font-semibold text-[13px] mb-1.5">使用前请确认</div>
              <ul
                className="text-[12.5px] text-ink-fg-1 leading-relaxed space-y-1.5"
                style={{ listStyle: 'disc', paddingLeft: 16 }}
              >
                <li>
                  需要 <span className="text-ink-fg">classic Outlook</span>（经典版）—— 新版「New
                  Outlook」已移除自动化接口，不受支持。
                </li>
                <li>同步期间请保持 Outlook 运行并已登录邮箱账户。</li>
                <li>
                  首次运行时 Outlook 会弹出「有程序正尝试访问」授权提示（Programmatic
                  Access），请点「允许访问」并选择最长时长。
                </li>
              </ul>
              {/* 整行单 button — 镜像 davmail 合规勾选的可点性修复 (方块+文字都可点)。 */}
              <button
                type="button"
                className="flex w-full items-center gap-2.5 mt-3 cursor-pointer select-none text-left"
                onClick={() => setComAck(!comAck)}
                aria-pressed={comAck}
              >
                <span className={`cb ${comAck ? 'cb-on' : ''}`} />
                <span className="text-[13px] text-ink-fg">
                  我已确认本机安装的是 classic Outlook，并了解上述运行前提
                </span>
              </button>
            </Banner>
          </div>
        )}

        {backend === 'davmail' && (
          <div className="mt-3 step-enter">
            <button
              type="button"
              className="flex items-center gap-1.5 text-[13px] text-ink-fg-2 hover:text-ink-fg transition"
              onClick={() => setAdvOpen(!advOpen)}
            >
              <Icon name={advOpen ? 'x' : 'alert'} size={13} />{' '}
              {advOpen ? '收起合规说明' : '展开合规说明（必读）'}
            </button>
            {advOpen && (
              <div className="mt-3">
                <Banner kind="warn">
                  <div className="font-semibold text-[13px] mb-1.5">重要提示 · 请仔细阅读</div>
                  <ul
                    className="text-[12.5px] text-ink-fg-1 leading-relaxed space-y-1.5"
                    style={{ listStyle: 'disc', paddingLeft: 16 }}
                  >
                    <li>
                      DavMail 当前使用 Outlook 的 well-known client_id
                      进行身份伪装，属概念验证（PoC），
                      <span className="text-ink-fg">未经公司 IT 审批</span>，不可用于正式分发。
                    </li>
                    <li>
                      EWS 协议将于 <span className="font-mono text-[12px]">2026-10-01</span>{' '}
                      关停，长期方案需申请独立 Microsoft Graph API 应用注册。
                    </li>
                    <li>
                      OAuth 初次授权需手动操作，本向导不在此处自动化，请参阅《DavMail
                      高级配置》文档。
                    </li>
                  </ul>
                  {/* 整行单 button: 点方块或文字都能勾 (原 label+span 只有 14px 方块
                      可点、文字无反应 → 勾不上 → canNext 永 false 卡死)。 */}
                  <button
                    type="button"
                    className="flex w-full items-center gap-2.5 mt-3 cursor-pointer select-none text-left"
                    onClick={() => setDavAck(!davAck)}
                    aria-pressed={davAck}
                  >
                    <span className={`cb ${davAck ? 'cb-on' : ''}`} />
                    <span className="text-[13px] text-ink-fg">
                      我已了解上述风险，仍要继续配置 DavMail（仅限个人评估用途）
                    </span>
                  </button>
                </Banner>
              </div>
            )}
          </div>
        )}
      </div>
      <WizFooter onBack={onBack} onNext={onNext} nextDisabled={!canNext} />
    </>
  )
}
