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

import { useEffect, useMemo, useState } from 'react'

import './onboarding.css'

import { LegacyFlow, HalfFlow, DBCorruptScreen, RollbackScreen } from './branches'
import { OnboardingShell, StepRail, type StepDef } from './components'
import * as ipc from './ipc'
import type { BackendKind, CompleteConfig, DetectLegacyResult } from './ipc'
import {
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
 *  rail + step 索引 + renderNewStep switch 都据此自适应。 */
function buildSteps(backend: BackendKind): StepDef[] {
  const steps: StepDef[] = [
    { key: 'welcome', label: '欢迎' },
    { key: 'fda', label: '环境与权限' },
    { key: 'backend', label: '后端选择' },
    { key: 'config', label: '邮件同步配置' }
  ]
  if (backend === 'davmail') steps.push({ key: 'folders', label: '选择文件夹' })
  steps.push(
    { key: 'sync', label: '首次同步' },
    { key: 'plugins', label: '插件' },
    { key: 'done', label: '完成' }
  )
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

  // STEPS 随 backend 动态生成 (davmail 多一步「选择文件夹」)。backend 在 'backend' 步
  // (索引 2) 选定, 早于 config/folders, 所以 STEPS 增长时用户尚未走过 → 索引不漂移。
  const STEPS = useMemo<StepDef[]>(() => buildSteps(backend), [backend])

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

  const next = (): void => {
    setSubmitError(null)
    setStep((s) => Math.min(STEPS.length - 1, s + 1))
  }
  const back = (): void => setStep((s) => Math.max(0, s - 1))

  /** Config the legacy/half flows reuse if the user also filled the NEW form. */
  const assembledCfg = (): CompleteConfig | undefined => {
    if (!form.NOTION_TOKEN || !form.EMAIL_DATABASE_ID || !form.USER_EMAIL) return undefined
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
