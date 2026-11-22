// Onboarding steps 5.5 & 6: Optional AI provider setup and completion screen.

import { useEffect, useRef, useState } from 'react'

import { ProviderBrandIcon } from '@shared/components/icons/providers'
import { errorMessage } from '@shared/lib/ipcErrors'
import {
  findOnboardingLlmTemplate,
  invalidCustomBaseUrlReason,
  ONBOARDING_LLM_TEMPLATES
} from '@shared/onboarding/llmProviderTemplates'

import { Banner, Field, Icon, WizFooter } from '../components'
import * as ipc from '../ipc'

/* ─── Step 5.5 · AI 模型 (可选, 07-12 P3b) ─────────────────────────────────────
   provider registry flag on (onboarding:llmProviderStatus → /chat/config
   .providerRegistryEnabled) 时才由 OnboardingRoot 插入本步 (plugins 步之前 —— 此时
   commitConfig 已起后端, provider REST 可用)。极简 provider 表单: 模板 + apiKey
   (+ 仅 custom 模板的 baseURL) + 保存/连通性测试。与 Settings 的 provider 管理组件
   有意隔离 (onboarding Chinese-only 无 i18n、零共用组件约定), 但共用同一 REST 端点
   (经 main 的 daemon 转发, 本地 token 不进 renderer)。跳过 = 零写入。

   批 2 review HIGH-3: 模板单源在 @shared/onboarding/llmProviderTemplates (main 侧
   llmProviderSave 以它为权威解析 id/protocol/displayName/baseUrl, renderer 这里只
   投影下拉列表 + 传 templateKey); 非 custom 模板的 baseUrl 只读展示, custom 模板
   的 baseUrl 由 main 校验 http/https + 拒 userinfo (这里复用同一校验做即时反馈)。 */

export interface StepAiModelProps {
  onNext: () => void
  onBack: () => void
}

export function StepAiModel({ onNext, onBack }: StepAiModelProps): React.JSX.Element {
  const [tplKey, setTplKey] = useState<string>(ONBOARDING_LLM_TEMPLATES[0].key)
  const tpl = findOnboardingLlmTemplate(tplKey) ?? ONBOARDING_LLM_TEMPLATES[0]
  const [customBaseUrl, setCustomBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<ipc.LlmProviderTestResult | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const pickTemplate = (key: string): void => {
    const next = findOnboardingLlmTemplate(key)
    if (!next) return
    setTplKey(key)
    setCustomBaseUrl('')
    setSaveError(null)
    setTestResult(null)
  }

  // 即时校验 (main 侧 llmProviderSave 是权威, 这里只提前反馈)。
  const customBaseUrlProblem =
    tpl.allowCustomBaseUrl && customBaseUrl.trim() !== ''
      ? invalidCustomBaseUrlReason(customBaseUrl.trim())
      : null
  // 保存前置条件: key 必填; custom openai-compatible 还需合法 baseURL (服务端无默认端点)。
  const canSave =
    apiKey.trim() !== '' &&
    customBaseUrlProblem === null &&
    (!tpl.baseUrlRequired || customBaseUrl.trim() !== '')

  /** 创建/upsert provider 行; 失败 → saveError, 返回 false。 */
  const doSave = async (): Promise<boolean> => {
    setSaveError(null)
    try {
      const res = await ipc.llmProviderSave({
        templateKey: tpl.key,
        ...(tpl.allowCustomBaseUrl && customBaseUrl.trim() !== ''
          ? { baseUrl: customBaseUrl.trim() }
          : {}),
        apiKey: apiKey.trim()
      })
      if (!res?.ok) {
        if (alive.current) setSaveError(res?.error?.message ?? '保存失败，请重试。')
        return false
      }
      return true
    } catch (err) {
      if (alive.current) setSaveError(errorMessage(err))
      return false
    }
  }

  const testConnection = (): void => {
    if (!canSave || busy) return
    setBusy(true)
    setTestResult(null)
    void (async () => {
      const saved = await doSave()
      if (!saved) {
        if (alive.current) setBusy(false)
        return
      }
      try {
        const r = await ipc.llmProviderTest(tpl.key)
        if (alive.current) setTestResult(r ?? { ok: false, error: '测试无响应' })
      } catch (err) {
        if (alive.current) setTestResult({ ok: false, error: errorMessage(err) })
      } finally {
        if (alive.current) setBusy(false)
      }
    })()
  }

  const saveAndNext = (): void => {
    if (!canSave || busy) return
    setBusy(true)
    void (async () => {
      const saved = await doSave()
      if (alive.current) setBusy(false)
      if (saved) onNext()
    })()
  }

  return (
    <>
      <div className="wiz-body scrollbar-thin step-enter">
        <div className="eyebrow">Step — AI 模型（可选）</div>
        <h1 className="wiz-h1">接入你的模型服务</h1>
        <p className="wiz-lede">
          为 AI 分类与对话配置一个模型服务商（官方 API 或自建中转）。此步可跳过 —— 稍后在「设置 →
          AI」里随时添加与管理。
        </p>

        {saveError && (
          <div className="mt-4">
            <Banner kind="fail">
              <div className="font-semibold text-[13px] mb-0.5">保存失败</div>
              <div className="text-[12.5px] text-ink-fg-1">{saveError}</div>
            </Banner>
          </div>
        )}
        {testResult && !saveError && (
          <div className="mt-4">
            {testResult.ok ? (
              <Banner kind="info" icon="check">
                连接正常
                {typeof testResult.latencyMs === 'number' ? `（${testResult.latencyMs}ms）` : ''}
                ，配置已保存。
              </Banner>
            ) : (
              <Banner kind="warn">
                <div className="font-semibold text-[13px] mb-0.5">连接测试未通过</div>
                <div className="text-[12.5px] text-ink-fg-1">
                  {testResult.error ?? '未知错误'} —— 配置已保存，可修正后重测或稍后在设置里排查。
                </div>
              </Banner>
            )}
          </div>
        )}

        <div className="flex flex-col gap-4 mt-5">
          <Field label="服务商" icon="spark" hint="模板固定协议与端点，凭证由你提供">
            <div className="flex items-center gap-2">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-ink-border bg-ink-2">
                <ProviderBrandIcon
                  providerId={tpl.key}
                  protocol={tpl.protocol}
                  variant="color"
                  className="size-4"
                />
              </div>
              <div className="selwrap min-w-0 flex-1">
                <select
                  className="fld"
                  value={tplKey}
                  onChange={(e) => pickTemplate(e.target.value)}
                >
                  {ONBOARDING_LLM_TEMPLATES.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </Field>

          {tpl.allowCustomBaseUrl ? (
            <Field
              label="API 地址 (Base URL)"
              icon="server"
              required={Boolean(tpl.baseUrlRequired)}
              hint={
                customBaseUrlProblem ??
                (tpl.baseUrlRequired
                  ? '自定义服务必填，例如 https://your-relay.example.com/v1'
                  : '留空使用官方默认端点')
              }
            >
              <input
                className="fld mono"
                placeholder={tpl.baseUrlRequired ? 'https://…/v1' : '留空 = 官方默认'}
                value={customBaseUrl}
                onChange={(e) => setCustomBaseUrl(e.target.value)}
              />
            </Field>
          ) : (
            <Field
              label="API 地址 (Base URL)"
              icon="server"
              hint="内置模板端点固定；要接自建中转请选「自定义」模板"
            >
              <input className="fld mono" value={tpl.baseUrl || '官方默认端点'} disabled />
            </Field>
          )}

          <Field label="API Key" icon="key" required hint="仅存本机（加密落盘），不上传第三方">
            <input
              className="fld mono"
              type="password"
              placeholder="sk-…"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
            />
          </Field>

          <div>
            <button
              type="button"
              className="btn-sec"
              onClick={testConnection}
              disabled={!canSave || busy}
            >
              {busy ? (
                <Icon name="refresh" size={14} cls="spin" />
              ) : (
                <Icon name="spark" size={14} />
              )}
              测试连接
            </button>
          </div>
        </div>
      </div>
      <WizFooter
        onBack={busy ? null : onBack}
        secondary={
          <button className="btn-link" onClick={onNext} disabled={busy}>
            跳过此步
          </button>
        }
        onNext={saveAndNext}
        nextDisabled={!canSave}
        nextLabel="保存并继续"
        nextIcon="arrowRight"
        busy={busy}
      />
    </>
  )
}

/* ─── Step 6 · Done (writes plugin flags + reloads via finalize()) ─────────── */
export interface StepDoneProps {
  /** 仅插件勾选 (核心配置 + 后端已在 StepConfig 的 commitConfig 提交/起过)。 */
  plugins: Record<string, boolean>
  fdaSkipped: boolean
  background: boolean
  /** main reloads the window into the app on success */
  onLaunched: () => void
}

/** 可切换的插件 key (核心 'notion' 恒开、无 flag)。key → .env flag 的权威映射
 *  只存在于主进程 (handlers/onboarding.ts PLUGIN_FLAG_MAP, 单测已 pin); 渲染层
 *  只需把勾选状态按 key 透传, 不复制 flag 名以免 SSoT 漂移。 */

export function StepDone({
  plugins,
  fdaSkipped,
  background,
  onLaunched
}: StepDoneProps): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // If complete() succeeds but the main-process window reload never arrives
  // (handler bug / non-Electron harness / reload not triggered), the button
  // would stay disabled "正在启动…" forever — this surfaces a retry escape.
  const [slow, setSlow] = useState(false)
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // attemptId: 标记本次 finalize 提交, settle 时不匹配 (超时已 fire / 重提) 则忽略
  // 迟到结果 (BLOCKER 2)。
  const attemptId = useRef(0)

  useEffect(() => {
    return () => {
      if (reloadTimer.current) clearTimeout(reloadTimer.current)
    }
  }, [])

  const launch = (): void => {
    const id = ++attemptId.current
    setError(null)
    setSlow(false)
    setBusy(true)
    // 核心配置 + 后端已在 StepConfig 的 commitConfig 写过/起过; 这里只写 plugin
    // flag + reload 进 app (finalize)。BLOCKER 2: reload-timeout arm 在调用前;
    // attemptId 丢弃迟到结果。
    if (reloadTimer.current) clearTimeout(reloadTimer.current)
    reloadTimer.current = setTimeout(() => {
      if (id !== attemptId.current) return
      reloadTimer.current = null
      setSlow(true)
      setBusy(false)
    }, 9000)
    void ipc
      .finalize(plugins)
      .then((res) => {
        if (id !== attemptId.current) return // 迟到结果 (超时已 fire / 重提): 忽略
        if (!res?.ok) {
          if (reloadTimer.current) {
            clearTimeout(reloadTimer.current)
            reloadTimer.current = null
          }
          setError(res?.error?.message ?? '配置失败，请重试。')
          setBusy(false)
          return
        }
        // On ok the main process reloads the window into the main app — keep the
        // busy "正在启动…" state until that happens (reloadTimer above is the
        // safety net if the reload never arrives).
        onLaunched()
      })
      .catch((err: unknown) => {
        if (id !== attemptId.current) return
        if (reloadTimer.current) {
          clearTimeout(reloadTimer.current)
          reloadTimer.current = null
        }
        setError(`提交出错：${errorMessage(err)}`)
        setBusy(false)
      })
  }

  return (
    <div
      className="wiz-body scrollbar-thin step-enter flex flex-col items-center justify-center text-center"
      style={{ minHeight: '100%' }}
    >
      <span
        className="grid place-items-center w-16 h-16 rounded-2xl mb-5"
        style={{
          background: 'rgb(var(--c-accent)/0.12)',
          border: '1px solid rgb(var(--c-accent)/0.3)',
          color: 'rgb(var(--c-accent))'
        }}
      >
        <Icon name="rocket" size={30} />
      </span>
      <div className="eyebrow">Done</div>
      <h1 className="wiz-h1">设置完成！</h1>
      <p className="wiz-lede" style={{ textAlign: 'center' }}>
        {background
          ? 'MailAgent 正在后台继续同步你的邮件，主窗口顶部会显示进度。'
          : 'MailAgent 已准备就绪，正在打开收件箱。'}
      </p>
      <div className="flex flex-col gap-2 mt-6 w-full" style={{ maxWidth: 360 }}>
        {fdaSkipped && (
          <Banner kind="warn">FDA 未授权 —— 主窗口将持续显示授权横幅，邮件读取功能受限。</Banner>
        )}
        {error && (
          <Banner kind="fail">
            <div className="font-semibold text-[13px] mb-0.5">启动失败</div>
            <div className="text-[12.5px] text-ink-fg-1">{error}</div>
          </Banner>
        )}
        {slow && !error && (
          <Banner kind="warn" icon="clock">
            <div className="font-semibold text-[13px] mb-0.5">启动较慢</div>
            <div className="text-[12.5px] text-ink-fg-1">
              配置已写入，后端可能正在后台启动（大库迁移会更久）。可点下方按钮重试，或稍候主窗口会自动打开。
            </div>
          </Banner>
        )}
        <div className="ds-card" style={{ padding: '12px 14px' }}>
          <div className="flex items-center justify-between text-[13px]">
            <span className="text-ink-fg-1">onboarding_done</span>
            <span className="font-mono text-ok flex items-center gap-1.5">
              <Icon name="check" size={13} sw={3} /> true
            </span>
          </div>
        </div>
      </div>
      <button
        className="btn-primary mt-7"
        style={{ padding: '10px 22px' }}
        onClick={launch}
        disabled={busy}
      >
        {busy ? (
          <>
            <Icon name="refresh" size={15} cls="spin" /> 正在启动…
          </>
        ) : (
          <>
            {error || slow ? '重试' : '进入收件箱'} <Icon name="arrowRight" size={15} />
          </>
        )}
      </button>
    </div>
  )
}
