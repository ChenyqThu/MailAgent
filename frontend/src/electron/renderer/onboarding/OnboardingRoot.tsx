// Onboarding root — state machine ported from docs/packaging/onboarding/app.jsx,
// MINUS the demo dock and Tweaks panel (those were review aids, not product chrome).
//
// On mount:
//   - set documentElement dataset theme='dark' if unset (tokens resolve dark by
//     default; we never force an accent — index.html's bootstrap already handles
//     stored theme/accent, this is just a floor).
//   - status(): 'new' / 'config-incomplete' → mode 'new'. 'configured' shouldn't
//     normally render here, but if it does we still allow re-config (mode 'new').
//   - detectLegacy() once: if found, Welcome's secondary entry switches to 'legacy'.

import { useEffect, useMemo, useRef, useState } from 'react'

import './onboarding.css'

import { LegacyFlow, HalfFlow, DBCorruptScreen, RollbackScreen } from './branches'
import { OnboardingShell, StepRail, type StepDef } from './components'
import * as ipc from './ipc'
import type { BackendKind, CompleteConfig, DetectLegacyResult } from './ipc'
import {
  StepAiModel,
  StepBackend,
  StepConfig,
  StepDone,
  StepFDA,
  StepFolders,
  StepPlugins,
  StepSync,
  StepWelcome,
  buildCompleteConfig,
  type ConfigForm,
  type SubmitError
} from './steps'

type Mode = 'new' | 'legacy' | 'half' | 'dbcorrupt' | 'rollback'

/** 多文件夹同步 (P4): 「选择文件夹」步仅 davmail 后端插入 (邮箱配置后、首次同步前)。
 *  applescript 后端无多文件夹概念 → 不展示, 保持原 7 步。STEPS 随 backend 动态生成,
 *  rail + step 索引 + renderNewStep switch 都据此自适应。
 *
 *  「AI 模型 (可选)」步 (07-12 P3b): provider registry flag on 时插在 sync 之后、
 *  plugins 之前 (commitConfig 已起后端, provider REST 可用的时序窗口)。flag 在进入
 *  sync 步时经 IPC 查询 (更早时后端未起, 查询必失败); 插入点在当前步之后 → 现有
 *  索引不漂移。 */
function buildSteps(backend: BackendKind, aiStep: boolean): StepDef[] {
  const steps: StepDef[] = [
    { key: 'welcome', label: '欢迎' },
    { key: 'fda', label: '环境与权限' },
    { key: 'backend', label: '后端选择' },
    { key: 'config', label: '邮件同步配置' }
  ]
  if (backend === 'davmail') steps.push({ key: 'folders', label: '选择文件夹' })
  steps.push({ key: 'sync', label: '首次同步' })
  if (aiStep) steps.push({ key: 'ai', label: 'AI 模型' })
  steps.push({ key: 'plugins', label: '插件' }, { key: 'done', label: '完成' })
  return steps
}

const TITLE_MAP: Record<Mode, string> = {
  new: '设置 · MailAgent',
  legacy: '数据迁移 · MailAgent',
  half: '恢复 · MailAgent',
  dbcorrupt: '诊断 · MailAgent',
  rollback: '诊断 · MailAgent'
}

/** On success the main process reloads the window into the main app (loadFile
 *  index.html with no ?onboarding=1 search). This is a no-op safety net for
 *  dev / non-Electron harnesses where the reload never arrives. */
function reloadToApp(): void {
  // The main process drives the real reload; nothing to do here. Kept as the
  // single onComplete sink so every branch routes through one place.
}

export default function OnboardingRoot(): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('new')
  const [step, setStep] = useState(0)
  const [legacyDetect, setLegacyDetect] = useState<DetectLegacyResult | null>(null)

  // shared NEW-wizard state (collected across steps; committed once at StepDone)
  const [form, setForm] = useState<ConfigForm>({ SYNC_MAILBOXES: ['收件箱'] })
  const [backend, setBackend] = useState<BackendKind>('applescript')
  const [davAck, setDavAck] = useState(false)
  const [plugins, setPlugins] = useState<Record<string, boolean>>({})
  const [fdaSkipped, setFdaSkipped] = useState(false)
  const [background, setBackground] = useState(false)
  const [submitError, setSubmitError] = useState<SubmitError | null>(null)
  // 「AI 模型 (可选)」步显隐 (07-12 P3b): 进入 sync 步 (后端已起) 时查 provider
  // registry flag; off / 查询失败 → false = 该步不出现。
  const [aiStepEnabled, setAiStepEnabled] = useState(false)

  // STEPS 随 backend 动态生成 (davmail 多一步「选择文件夹」)。backend 在 'backend' 步
  // (索引 2) 选定, 早于 config/folders, 所以 STEPS 增长时用户尚未走过 → 索引不漂移。
  // aiStepEnabled 翻 true 时: 用户在插入位之前/之上 → 插入点在当前步之后, 索引不漂移;
  // 用户正停在 plugins (超时放行后迟到 true, 发版终审 M1) → 当前索引原地变成 'ai'
  // (plugins 顺移一位) = 有意的「跳转到 AI 步」, plugins 仍是下一步。done 步不采纳。
  const STEPS = useMemo<StepDef[]>(
    () => buildSteps(backend, aiStepEnabled),
    [backend, aiStepEnabled]
  )

  // theme floor + status/legacy detection
  useEffect(() => {
    const h = document.documentElement
    if (!h.getAttribute('data-theme')) {
      h.setAttribute('data-theme', 'dark')
      h.classList.add('dark')
    }

    let alive = true
    void ipc
      .status()
      .then((res) => {
        if (!alive) return
        // 'configured' shouldn't normally land here; allow re-config either way.
        // 'new' / 'config-incomplete' → mode 'new' (default already).
        if (res?.state === 'configured') setMode('new')
      })
      .catch(() => undefined)

    void ipc
      .detectLegacy()
      .then((res) => {
        if (!alive) return
        if (res?.found) setLegacyDetect(res)
      })
      .catch(() => undefined)

    return () => {
      alive = false
    }
  }, [])

  // 进入 'sync' 步 (commitConfig 已起后端) 时立即查 provider registry flag (批 2
  // review MEDIUM-5 + 发版终审 M1)。结果不丢弃：
  //   - 用户还停在插入位之前/之上 (ai 步插在 sync 之后) → 到达即采纳, 当前索引不漂移;
  //   - 用户点「下一步」离开 sync 时查询仍 in-flight → await (上限 3s, 超时按 off 先
  //     放行) 再算下一步, 保证 flag on 的用户不会因为点得快而看不到 AI 步;
  //   - 超时放行后真实结果才到 (M1: serve-api 冷启动 / seed 慢过 3s) → 只要 onboarding
  //     还没走到 'done' 就采纳: 用户停在 plugins 时插步 = 当前索引原地变成 'ai' (等价
  //     跳转, plugins 仍是下一步); 更早的步 → 正常插在后面。'done' 才永久放弃。
  const stepKeyRef = useRef<string>('welcome')
  useEffect(() => {
    stepKeyRef.current = STEPS[step]?.key ?? 'welcome'
  })
  const aiFlagRef = useRef<{ promise: Promise<boolean> | null; result: boolean | null }>({
    promise: null,
    result: null
  })
  const advancingRef = useRef(false)
  // M1 — 迟到 true 的采纳窗口 = 尚未到 'done' (StepDone 提交/启动, 那之后不再动步序)。
  // 'ai' 不可能是未插入时的当前步; 'plugins' 时采纳即原地跳转 (见上)。
  const canAdoptAiStep = (): boolean => stepKeyRef.current !== 'done'
  useEffect(() => {
    if (aiStepEnabled) return
    // 迟到结果的回补采纳 (超时放行后, 用户仍未提交完成)。
    if (aiFlagRef.current.result === true && canAdoptAiStep()) {
      setAiStepEnabled(true)
      return
    }
    if (STEPS[step]?.key !== 'sync' || aiFlagRef.current.promise !== null) return
    const promise = ipc
      .llmProviderStatus()
      .then((r) => r?.enabled === true)
      .catch(() => false)
    aiFlagRef.current.promise = promise
    void promise.then((enabled) => {
      aiFlagRef.current.result = enabled
      if (enabled && canAdoptAiStep()) setAiStepEnabled(true)
    })
  }, [step, STEPS, aiStepEnabled])

  const next = (): void => {
    setSubmitError(null)
    const flag = aiFlagRef.current
    if (
      STEPS[step]?.key === 'sync' &&
      !aiStepEnabled &&
      flag.result === null &&
      flag.promise !== null
    ) {
      // 离开 sync 时查询未决 → 等它 (上限 3s, 超时按 off) 再算下一步 key。
      if (advancingRef.current) return
      advancingRef.current = true
      void Promise.race([
        flag.promise,
        new Promise<boolean>((res) => setTimeout(() => res(false), 3_000))
      ])
        .then((enabled) => {
          if (enabled) setAiStepEnabled(true)
          setStep((s) => s + 1)
        })
        .finally(() => {
          advancingRef.current = false
        })
      return
    }
    setStep((s) => Math.min(STEPS.length - 1, s + 1))
  }
  const back = (): void => setStep((s) => Math.max(0, s - 1))

  /** Config the legacy/half flows reuse if the user also filled the NEW form.
   *  07-12 P3b: Notion 两键改可选 —— 仅 USER_EMAIL 判「表单已填」。 */
  const assembledCfg = (): CompleteConfig | undefined => {
    if (!form.USER_EMAIL) return undefined
    return buildCompleteConfig(form, backend, plugins)
  }

  function renderNewStep(): React.JSX.Element | null {
    switch (STEPS[step].key) {
      case 'welcome':
        return (
          <StepWelcome
            onNext={next}
            onLegacy={() => setMode('legacy')}
            legacyFound={legacyDetect !== null}
          />
        )
      case 'fda':
        return <StepFDA onNext={next} onBack={back} onSkip={() => setFdaSkipped(true)} />
      case 'backend':
        return (
          <StepBackend
            backend={backend}
            setBackend={setBackend}
            davAck={davAck}
            setDavAck={setDavAck}
            onNext={next}
            onBack={back}
          />
        )
      case 'config':
        return (
          <StepConfig
            form={form}
            setForm={setForm}
            backend={backend}
            submitError={submitError}
            setCommitError={setSubmitError}
            onNext={next}
            onBack={back}
          />
        )
      case 'folders':
        // 多文件夹同步 (P4, davmail-only)。whitelist 由 StepFolders 直接经 IPC 写
        // (folder:setWhitelist), 不进 form / StepDone 提交。跳过 = 不写白名单 (空 =
        // 仅同步收件箱/发件箱)。
        return <StepFolders onNext={next} onBack={back} onSkip={() => undefined} />
      case 'sync':
        return <StepSync onNext={next} onBack={back} setBackground={setBackground} />
      case 'ai':
        // AI 模型 (可选, 07-12 P3b): provider registry flag on 时才在 STEPS 里。
        // 跳过 = 零写入; 保存经 IPC → daemon → serve-api /api/llm/providers。
        return <StepAiModel onNext={next} onBack={back} />
      case 'plugins':
        return (
          <StepPlugins
            plugins={plugins}
            setPlugins={setPlugins}
            backend={backend}
            onNext={next}
            onBack={back}
          />
        )
      case 'done':
        return (
          <StepDone
            plugins={plugins}
            fdaSkipped={fdaSkipped}
            background={background}
            onLaunched={reloadToApp}
          />
        )
      default:
        return null
    }
  }

  return (
    <OnboardingShell title={TITLE_MAP[mode]}>
      {mode === 'new' && (
        <div className="flex flex-1 min-h-0">
          <StepRail steps={STEPS} current={step} />
          <div className="wiz-content">{renderNewStep()}</div>
        </div>
      )}
      {mode === 'legacy' && (
        <LegacyFlow
          detect={legacyDetect}
          cfg={assembledCfg()}
          onComplete={reloadToApp}
          onRollback={() => setMode('rollback')}
        />
      )}
      {mode === 'half' && <HalfFlow onComplete={reloadToApp} />}
      {mode === 'dbcorrupt' && <DBCorruptScreen onRetry={() => setMode('new')} />}
      {mode === 'rollback' && (
        <RollbackScreen onRetry={() => setMode('legacy')} onBack={() => setMode('new')} />
      )}
    </OnboardingShell>
  )
}
