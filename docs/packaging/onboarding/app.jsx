/* ============================================================================
   MailAgent Onboarding · root app — state machine, tweaks, demo dock
   ============================================================================ */
const { useState: useStateA, useEffect: useEffectA } = React;

const STEPS = [
  { key: 'welcome', label: '欢迎' },
  { key: 'fda', label: '环境与权限' },
  { key: 'backend', label: '后端选择' },
  { key: 'config', label: '邮件同步配置' },
  { key: 'sync', label: '首次同步' },
  { key: 'plugins', label: '插件' },
  { key: 'done', label: '完成' },
];

const ACCENTS = [
  { name: 'teal', hex: '#2DB5A6' }, { name: 'coral', hex: '#E5654B' }, { name: 'cobalt', hex: '#4A78E5' },
  { name: 'rose', hex: '#DB5B7C' }, { name: 'slate', hex: '#7E8694' }, { name: 'olive', hex: '#9CA552' },
];

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "#2DB5A6",
  "dark": true,
  "tone": "详尽",
  "layout": "步骤条"
}/*EDITMODE-END*/;

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const tone = t.tone === '简洁' ? 'concise' : 'detailed';
  const layout = t.layout === '顶部步进' ? 'stepper' : 'rail';

  // theme + accent → documentElement
  useEffectA(() => {
    const h = document.documentElement;
    const mode = t.dark ? 'dark' : 'light';
    h.setAttribute('data-theme', mode);
    h.classList.toggle('dark', t.dark);
    const acc = ACCENTS.find((a) => a.hex.toLowerCase() === String(t.accent).toLowerCase()) || ACCENTS[0];
    h.setAttribute('data-accent', acc.name);
  }, [t.dark, t.accent]);

  // ── flow state ──
  const [mode, setMode] = useStateA('new'); // new|legacy|half|dbcorrupt|rollback|inbox
  const [step, setStep] = useStateA(0);
  const [launching, setLaunching] = useStateA(false);

  const [form, setForm] = useStateA({ SYNC_MAILBOXES: ['收件箱'] });
  const [fda, setFda] = useStateA({ results: {}, scanning: false, started: false, skipped: false });
  const [backend, setBackend] = useStateA('applescript');
  const [davAck, setDavAck] = useStateA(false);
  const [sync, setSync] = useStateA({ pct: 0, stage: 0, count: 0, done: false, running: false, background: false });
  const [plugins, setPlugins] = useStateA({});
  const [submitError, setSubmitError] = useStateA(null);

  const resetNew = () => {
    setMode('new'); setStep(0); setLaunching(false); setSubmitError(null);
    setForm({ SYNC_MAILBOXES: ['收件箱'] });
    setFda({ results: {}, scanning: false, started: false, skipped: false });
    setBackend('applescript'); setDavAck(false);
    setSync({ pct: 0, stage: 0, count: 0, done: false, running: false, background: false });
    setPlugins({});
  };

  const next = () => { setSubmitError(null); setStep((s) => Math.min(STEPS.length - 1, s + 1)); };
  const back = () => setStep((s) => Math.max(0, s - 1));

  const launch = () => { setLaunching(true); setTimeout(() => { setMode('inbox'); setLaunching(false); }, 1400); };

  const goAuthFail = () => {
    setMode('new'); setStep(3);
    setForm((f) => ({ ...f, _accountsLoaded: true, MAIL_ACCOUNT_NAME: 'Exchange', USER_EMAIL: 'you@chenge.ink', NOTION_TOKEN: 'secret_invalidtoken0000', EMAIL_DATABASE_ID: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6' }));
    setSubmitError({ title: 'Notion Token 无效或权限不足', message: '首次写 Notion 返回 401。请检查 Integration 是否已连接到该数据库，然后重试。' });
  };

  // ── demo dock ──
  const dockItems = [
    { id: 'new', label: '新用户向导', on: mode === 'new' && step <= 6 && !submitError, act: resetNew },
    { id: 'legacy', label: '老用户迁移', on: mode === 'legacy', act: () => setMode('legacy') },
    { id: 'half', label: '半装捷径', on: mode === 'half', act: () => setMode('half') },
    { id: 'authfail', label: '鉴权失败', on: !!submitError, act: goAuthFail },
    { id: 'dbcorrupt', label: 'DB 损坏', on: mode === 'dbcorrupt', act: () => setMode('dbcorrupt') },
    { id: 'rollback', label: '迁移回滚', on: mode === 'rollback', act: () => setMode('rollback') },
    { id: 'inbox', label: '主窗口', on: mode === 'inbox', act: () => setMode('inbox') },
  ];

  // ── titles ──
  const titleMap = { new: '设置 · MailAgent', legacy: '数据迁移 · MailAgent', half: '恢复 · MailAgent', dbcorrupt: '诊断 · MailAgent', rollback: '诊断 · MailAgent', inbox: 'MailAgent' };

  // ── render the active NEW step (body + footer) ──
  function renderStep() {
    switch (STEPS[step].key) {
      case 'welcome': return (<>
        <StepWelcome tone={tone} onNext={next} onLegacy={() => setMode('legacy')} />
        <WizFooter onNext={next} nextLabel="开始设置"
          left={<button className="btn-link ml-2" onClick={() => setMode('legacy')}><Icon name="folder" size={13} /> 我已有旧版数据，从旧目录导入</button>} />
      </>);
      case 'fda': return <StepFDA tone={tone} fda={fda} setFda={setFda} onNext={next} onBack={back} />;
      case 'backend': return <StepBackend tone={tone} backend={backend} setBackend={setBackend} davAck={davAck} setDavAck={setDavAck} onNext={next} onBack={back} />;
      case 'config': return <StepConfig tone={tone} form={form} setForm={setForm} submitError={submitError} onNext={() => { setSubmitError(null); next(); }} onBack={back} />;
      case 'sync': return <StepSync tone={tone} sync={sync} setSync={setSync} onNext={next} onBack={back} />;
      case 'plugins': return <StepPlugins tone={tone} plugins={plugins} setPlugins={setPlugins} backend={backend} onNext={next} onBack={back} />;
      case 'done': return <StepDone tone={tone} sync={sync} fda={fda} onLaunch={launch} busy={launching} />;
      default: return null;
    }
  }

  // ── inbox banners ──
  const inboxBanners = (
    <>
      {sync.background && !sync.done && (
        <div className="flex items-center gap-2.5 px-4 py-2" style={{ background: 'rgb(var(--c-accent)/0.1)', borderBottom: '1px solid rgb(var(--c-accent)/0.25)' }}>
          <Icon name="refresh" size={13} cls="spin" style={{ color: 'rgb(var(--c-accent))' }} />
          <span className="text-[12.5px] text-ink-fg">正在后台同步邮件… 历史邮件会逐步出现</span>
          <span className="ml-auto"><div style={{ width: 90 }}><ProgressBar value={62} /></div></span>
        </div>
      )}
      {fda.skipped && (
        <div className="flex items-center gap-2.5 px-4 py-2" style={{ background: 'rgb(var(--c-warn)/0.1)', borderBottom: '1px solid rgb(var(--c-warn)/0.25)' }}>
          <Icon name="alert" size={13} style={{ color: 'rgb(var(--c-warn))' }} />
          <span className="text-[12.5px] text-ink-fg">完全磁盘访问未授权 · 邮件读取功能受限</span>
          <button className="ml-auto btn-sec" style={{ padding: '3px 9px', fontSize: 12 }}><Icon name="external" size={12} /> 打开系统设置</button>
        </div>
      )}
    </>
  );

  return (
    <>
      <MacWindow title={titleMap[mode]}>
        {mode === 'new' && (
          layout === 'rail' ? (
            <div className="flex flex-1 min-h-0">
              <StepRail steps={STEPS} current={step} />
              <div className="wiz-content">{renderStep()}</div>
            </div>
          ) : (
            <div className="wiz-content">
              <TopStepper steps={STEPS} current={step} />
              {renderStep()}
            </div>
          )
        )}
        {mode === 'legacy' && <LegacyFlow tone={tone} onComplete={() => { setMode('inbox'); }} onRollback={() => setMode('rollback')} />}
        {mode === 'half' && <HalfFlow tone={tone} onComplete={() => setMode('inbox')} />}
        {mode === 'dbcorrupt' && <DBCorruptScreen onRetry={resetNew} />}
        {mode === 'rollback' && <RollbackScreen onRetry={() => setMode('legacy')} onBack={resetNew} />}
        {mode === 'inbox' && <InboxMock banners={inboxBanners} />}
      </MacWindow>

      {/* demo scenario dock (review aid — not part of the product chrome) */}
      <div className="demo-dock">
        <span className="dd-label">演示场景</span>
        {dockItems.map((d) => (
          <button key={d.id} className={`dd-btn ${d.on ? 'on' : ''}`} onClick={d.act}>{d.label}</button>
        ))}
      </div>

      <TweaksPanel>
        <TweakSection label="主题" />
        <TweakToggle label="深色模式" value={t.dark} onChange={(v) => setTweak('dark', v)} />
        <TweakColor label="强调色 Accent" value={t.accent} options={ACCENTS.map((a) => a.hex)} onChange={(v) => setTweak('accent', v)} />
        <TweakSection label="向导" />
        <TweakRadio label="布局" value={t.layout} options={['步骤条', '顶部步进']} onChange={(v) => setTweak('layout', v)} />
        <TweakRadio label="文案语气" value={t.tone} options={['详尽', '简洁']} onChange={(v) => setTweak('tone', v)} />
      </TweaksPanel>
    </>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
