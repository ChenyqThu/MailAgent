/* ============================================================================
   MailAgent Onboarding · branch scenarios
   LEGACY migration · HALF shortcut · error/diagnostic screens · inbox landing
   ============================================================================ */
const { useState: useStateS, useEffect: useEffectS, useRef: useRefS } = React;

/* ─── LEGACY migration flow (mini state machine) ─────────────────────────── */
const MIG_CHAIN = ['v13 → 新增 imap_uid 列', 'v14 → folder_email 索引', 'v15 → calendar_event 表', 'v16 → email_body SSoT', 'v17 → outbox 去重键'];
const VERIFY_CHECKS = [
  { key: 'ver', label: 'sync_state.db_version == 17' },
  { key: 'tables', label: '关键表存在（metadata/body/outbox/calendar/folder）' },
  { key: 'rows', label: 'email_metadata 行数不减少（6,184）' },
  { key: 'read', label: '前端 getDb() 只读连接成功' },
];
function LegacyFlow({ tone, onComplete, onRollback }) {
  const [phase, setPhase] = useStateS('detect'); // detect|backup|migrate|verify|backfill|done
  const [pct, setPct] = useStateS(0);
  const [migStep, setMigStep] = useStateS(0);
  const [verify, setVerify] = useStateS({});
  const [backfill, setBackfill] = useStateS({});
  const timer = useRefS(null);

  // backup progress → migrate
  useEffectS(() => {
    if (phase !== 'backup') return;
    setPct(0);
    timer.current = setInterval(() => setPct((p) => { if (p >= 100) { clearInterval(timer.current); setTimeout(() => setPhase('migrate'), 350); return 100; } return p + 6; }), 90);
    return () => clearInterval(timer.current);
  }, [phase]);

  // migrate progress through chain
  useEffectS(() => {
    if (phase !== 'migrate') return;
    setPct(0); setMigStep(0);
    let step = 0;
    timer.current = setInterval(() => {
      setPct((p) => {
        const np = p + 3.2;
        const targetStep = Math.min(MIG_CHAIN.length - 1, Math.floor(np / (100 / MIG_CHAIN.length)));
        if (targetStep !== step) { step = targetStep; setMigStep(step); }
        if (np >= 100) { clearInterval(timer.current); setTimeout(() => setPhase('verify'), 400); return 100; }
        return np;
      });
    }, 95);
    return () => clearInterval(timer.current);
  }, [phase]);

  // verify checks animate
  useEffectS(() => {
    if (phase !== 'verify') return;
    setVerify({});
    VERIFY_CHECKS.forEach((c, i) => setTimeout(() => setVerify((v) => ({ ...v, [c.key]: true })), 400 + i * 450));
  }, [phase]);

  const titleFor = { detect: '检测到旧版本数据', backup: '正在备份数据库', migrate: '升级数据库 Schema', verify: '校验迁移结果', backfill: '推荐补全任务' };

  return (
    <div className="wiz-content">
      <div className="wiz-body scrollbar-thin step-enter">
        <div className="eyebrow">老用户迁移 · LEGACY</div>
        <h1 className="wiz-h1">{titleFor[phase]}</h1>

        {phase === 'detect' && (
          <>
            <p className="wiz-lede">{tn(tone, '在旧目录发现历史数据。升级前会强制备份，迁移单向不可降级 —— 备份是唯一的后悔药。', '发现旧数据，迁移前强制备份。')}</p>
            <div className="ds-card ds-card-pad mt-6">
              <div className="grid grid-cols-2 gap-y-3 gap-x-4 text-[13px]">
                <div className="text-ink-fg-2">数据目录</div><div className="font-mono text-[12px] text-ink-fg text-right">~/Documents/MailAgent</div>
                <div className="text-ink-fg-2">当前版本</div><div className="text-right"><span className="pill pill-warn">db_version v13</span></div>
                <div className="text-ink-fg-2">目标版本</div><div className="text-right"><span className="pill pill-ok">v17</span></div>
                <div className="text-ink-fg-2">历史邮件</div><div className="font-mono text-[12px] text-ink-fg text-right">6,184 封</div>
              </div>
            </div>
            <div className="mt-4"><Banner kind="warn">升级后旧版后端 / PM2 将无法再使用此数据库。请确认旧后端已停止（单一 writer），避免并发写冲突。</Banner></div>
          </>
        )}

        {(phase === 'backup' || phase === 'migrate') && (
          <>
            <p className="wiz-lede">{phase === 'backup' ? '复制到 sync_store.db.bak.<时间戳>，不可跳过。' : tn(tone, '从 v13 一路升到 v17，幂等迁移。大库 CREATE INDEX 会锁表数秒，请勿关闭。', '从 v13 升级到 v17，请勿关闭。')}</p>
            <div className="ds-card ds-card-pad mt-6">
              <div className="flex items-center justify-between mb-2.5">
                <span className="text-[14px] font-semibold text-ink-fg flex items-center gap-2">
                  <Icon name={phase === 'backup' ? 'archive' : 'layers'} size={16} style={{ color: 'rgb(var(--c-accent))' }} />
                  {phase === 'backup' ? '备份中' : MIG_CHAIN[migStep]}
                </span>
                <span className="font-mono text-[12px] text-ink-fg-2">{Math.round(pct)}%</span>
              </div>
              <ProgressBar value={pct} />
              {phase === 'migrate' && (
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {MIG_CHAIN.map((m, i) => (
                    <span key={i} className="pill" style={{ color: i < migStep ? 'rgb(var(--c-ok))' : i === migStep ? 'rgb(var(--c-accent))' : 'rgb(var(--ink-fg-3))', background: 'rgb(var(--ink-3))', border: '1px solid rgb(var(--ink-border))' }}>v{13 + i + 1}</span>
                  ))}
                </div>
              )}
            </div>
            {phase === 'migrate' && <div className="mt-4"><Banner kind="warn" icon="lock">升级中，请勿关闭应用。</Banner></div>}
          </>
        )}

        {phase === 'verify' && (
          <>
            <p className="wiz-lede">迁移完成，正在自动校验数据完整性。</p>
            <div className="flex flex-col gap-2 mt-6">
              {VERIFY_CHECKS.map((c) => (
                <div key={c.key} className="chk-row">
                  <span className={`chk-icon ${verify[c.key] ? 'chk-pass' : 'chk-pending'}`}>
                    {verify[c.key] ? <Icon name="check" size={13} sw={3} style={{ color: 'rgb(var(--c-ok))' }} /> : <Icon name="refresh" size={13} cls="spin" style={{ color: 'rgb(var(--ink-fg-2))' }} />}
                  </span>
                  <span className="text-[13.5px] text-ink-fg flex-1">{c.label}</span>
                </div>
              ))}
            </div>
            {VERIFY_CHECKS.every((c) => verify[c.key]) && <div className="mt-4"><Banner kind="info" icon="check">校验全部通过，0 数据丢失。</Banner></div>}
          </>
        )}

        {phase === 'backfill' && (
          <>
            <p className="wiz-lede">{tn(tone, '这些是后台补全任务，不影响现在使用。新邮件正常同步，历史邮件缺失字段会逐步补齐。', '可选后台补全任务，不影响使用。')}</p>
            <div className="flex flex-col gap-2.5 mt-6">
              {[
                { key: 'body', name: '邮件正文 + 附件', sub: '~1.5–2h · AppleScript', warn: '与主同步争用 AppleScript' },
                { key: 'metadata', name: 'To / CC / 发件人', sub: '~15–25 min · Notion', warn: null },
                { key: 'labels', name: 'AI 优先级 / 动作项', sub: '~15–25 min · 从 Notion 反拉', warn: null },
              ].map((b) => (
                <label key={b.key} className="ds-card flex items-center gap-3 cursor-pointer" style={{ padding: '12px 14px' }}>
                  <span className={`cb ${backfill[b.key] ? 'cb-on' : ''}`} onClick={(e) => { e.preventDefault(); setBackfill((s) => ({ ...s, [b.key]: !s[b.key] })); }}></span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] text-ink-fg">{b.name}</div>
                    <div className="text-[12px] text-ink-fg-2 mt-0.5 font-mono">{b.sub}{b.warn && <span className="text-warn"> · {b.warn}</span>}</div>
                  </div>
                </label>
              ))}
            </div>
            <div className="mt-4"><Banner kind="info">顺序约束：先 body / metadata 填满 SSoT，再启用 NOTION_READ_FROM_SQLITE，否则会用空值覆写 Notion。</Banner></div>
          </>
        )}
      </div>

      <div className="wiz-footer">
        {phase === 'detect' && <>
          <button className="btn-sec" onClick={onComplete}>就地继承（指向旧路径）</button>
          <div className="ml-auto"><button className="btn-primary" onClick={() => setPhase('backup')}>备份并迁移 <Icon name="arrowRight" size={14} /></button></div>
        </>}
        {(phase === 'backup' || phase === 'migrate') && <>
          <button className="btn-link" style={{ color: 'rgb(var(--c-fail)/0.7)' }} onClick={() => { clearInterval(timer.current); onRollback(); }}>模拟迁移失败</button>
          <div className="ml-auto"><button className="btn-primary" disabled>{phase === 'backup' ? '备份中…' : '迁移中…'}</button></div>
        </>}
        {phase === 'verify' && <div className="ml-auto"><button className="btn-primary" disabled={!VERIFY_CHECKS.every((c) => verify[c.key])} onClick={() => setPhase('backfill')}>查看补全建议 <Icon name="arrowRight" size={14} /></button></div>}
        {phase === 'backfill' && <>
          <button className="btn-sec" onClick={onComplete}>跳过</button>
          <div className="ml-auto"><button className="btn-primary" onClick={onComplete}>完成（后台运行）<Icon name="check" size={14} sw={3} /></button></div>
        </>}
      </div>
    </div>
  );
}

/* ─── HALF shortcut (boot backend + poll DB) ─────────────────────────────── */
function HalfFlow({ tone, onComplete }) {
  const [state, setState] = useStateS('idle'); // idle|booting|done
  const [pct, setPct] = useStateS(0);
  const timer = useRefS(null);
  const boot = () => {
    setState('booting'); setPct(0);
    timer.current = setInterval(() => setPct((p) => { if (p >= 100) { clearInterval(timer.current); setState('done'); return 100; } return p + 4; }), 110);
  };
  useEffectS(() => () => clearInterval(timer.current), []);
  return (
    <div className="wiz-content">
      <div className="wiz-body scrollbar-thin step-enter flex flex-col items-center justify-center text-center" style={{ minHeight: '100%' }}>
        <span className="grid place-items-center w-16 h-16 rounded-2xl mb-5" style={{ background: 'rgb(var(--c-accent)/0.12)', border: '1px solid rgb(var(--c-accent)/0.3)', color: 'rgb(var(--c-accent))' }}>
          <Icon name={state === 'done' ? 'check' : 'server'} size={28} sw={state === 'done' ? 3 : 2} />
        </span>
        <div className="eyebrow">半装捷径 · HALF</div>
        <h1 className="wiz-h1">{state === 'done' ? '后端已就绪' : '检测到未完成的安装'}</h1>
        <p className="wiz-lede" style={{ textAlign: 'center' }}>
          {state === 'done' ? '数据库已出现，db_version = 17。正在进入主窗口。'
            : tn(tone, '你已配置好账户，但后端还没成功运行过。点击下方按钮启动同步，向导会轮询数据库就绪。', '已配置但后端未跑过，启动同步即可。')}
        </p>
        {state === 'booting' && (
          <div className="w-full mt-7" style={{ maxWidth: 360 }}>
            <div className="flex items-center justify-between mb-2 text-[12px] font-mono text-ink-fg-2">
              <span className="flex items-center gap-2"><Icon name="refresh" size={13} cls="spin" /> 轮询 sync_state…</span><span>{pct}%</span>
            </div>
            <ProgressBar value={pct} />
          </div>
        )}
        <button className="btn-primary mt-7" style={{ padding: '10px 22px' }} onClick={state === 'done' ? onComplete : state === 'idle' ? boot : undefined} disabled={state === 'booting'}>
          {state === 'done' ? <>进入收件箱 <Icon name="arrowRight" size={15} /></> : state === 'booting' ? <><Icon name="refresh" size={15} cls="spin" /> 启动中…</> : <>启动同步 <Icon name="arrowRight" size={15} /></>}
        </button>
      </div>
    </div>
  );
}

/* ─── Diagnostic: DB corrupt ─────────────────────────────────────────────── */
function DBCorruptScreen({ onRetry }) {
  return (
    <div className="wiz-content">
      <div className="wiz-body scrollbar-thin step-enter">
        <span className="grid place-items-center w-14 h-14 rounded-2xl mb-4" style={{ background: 'rgb(var(--c-fail)/0.12)', border: '1px solid rgb(var(--c-fail)/0.3)', color: 'rgb(var(--c-fail))' }}>
          <Icon name="fileWarn" size={26} />
        </span>
        <div className="eyebrow" style={{ color: 'rgb(var(--c-fail))' }}>异常 · DB 损坏</div>
        <h1 className="wiz-h1">数据库文件损坏</h1>
        <p className="wiz-lede">getDb() 抛 SQLITE_CORRUPT，无法打开 sync_store.db。请选择恢复方式 —— 优先从最近备份恢复。</p>
        <div className="flex flex-col gap-2.5 mt-6">
          {[
            { ic: 'archive', t: '从最近备份恢复', d: 'sync_store.db.bak.20260515 · 6,184 封', primary: true },
            { ic: 'refresh', t: '重新初始化（清空重建）', d: '会丢历史 SSoT，需重新 init 同步' },
            { ic: 'download', t: '导出损坏文件供排查', d: '复制到桌面，附日志' },
          ].map((o) => (
            <button key={o.t} className="ds-card flex items-center gap-3 text-left" style={{ padding: '13px 15px', borderColor: o.primary ? 'rgb(var(--c-accent)/0.4)' : undefined }}>
              <span style={{ color: o.primary ? 'rgb(var(--c-accent))' : 'rgb(var(--ink-fg-2))' }}><Icon name={o.ic} size={18} /></span>
              <div className="min-w-0 flex-1"><div className="text-[14px] text-ink-fg">{o.t}</div><div className="text-[12px] text-ink-fg-2 mt-0.5">{o.d}</div></div>
              <Icon name="arrowRight" size={15} style={{ color: 'rgb(var(--ink-fg-3))' }} />
            </button>
          ))}
        </div>
      </div>
      <div className="wiz-footer"><button className="btn-link" onClick={onRetry}><Icon name="arrowLeft" size={13} /> 返回演示首页</button></div>
    </div>
  );
}

/* ─── Diagnostic: migration rollback ─────────────────────────────────────── */
function RollbackScreen({ onRetry, onBack }) {
  return (
    <div className="wiz-content">
      <div className="wiz-body scrollbar-thin step-enter">
        <span className="grid place-items-center w-14 h-14 rounded-2xl mb-4" style={{ background: 'rgb(var(--c-fail)/0.12)', border: '1px solid rgb(var(--c-fail)/0.3)', color: 'rgb(var(--c-fail))' }}>
          <Icon name="alert" size={26} />
        </span>
        <div className="eyebrow" style={{ color: 'rgb(var(--c-fail))' }}>异常 · 迁移回滚</div>
        <h1 className="wiz-h1">迁移校验未通过</h1>
        <p className="wiz-lede">已停止后端并用备份 sync_store.db.bak.20260529 覆盖回原库。你的数据已还原到迁移前状态，0 丢失。</p>
        <div className="ds-card ds-card-pad mt-6">
          <div className="flex items-center gap-2.5 text-[13px]">
            <Icon name="archive" size={16} style={{ color: 'rgb(var(--c-ok))' }} />
            <span className="text-ink-fg">已回滚到备份</span>
            <span className="pill pill-ok ml-auto">行数一致 6,184</span>
          </div>
        </div>
        <div className="mt-4"><Banner kind="fail">单向不可降级：若新版本 DB_VERSION 高于备份且无法兼容，请用与备份匹配的旧版本应用打开。</Banner></div>
      </div>
      <div className="wiz-footer">
        <button className="btn-link" onClick={onBack}><Icon name="arrowLeft" size={13} /> 返回演示首页</button>
        <div className="ml-auto flex items-center gap-2.5">
          <button className="btn-sec">查看日志</button>
          <button className="btn-primary" onClick={onRetry}><Icon name="refresh" size={14} /> 重试迁移</button>
        </div>
      </div>
    </div>
  );
}

/* ─── Main-window landing (faux inbox) ───────────────────────────────────── */
function InboxMock({ banners }) {
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {banners}
      <div className="flex-1 min-h-0 flex">
        <div style={{ width: 168, flexShrink: 0, background: 'rgb(var(--ink-1))', borderRight: '1px solid rgb(var(--ink-border-soft))' }} className="p-3">
          <div className="text-[11px] font-mono uppercase tracking-wider text-ink-fg-2 px-2 mb-2">Mailboxes</div>
          {[['收件箱', 32, true], ['已标旗', 4], ['草稿', 2], ['已发送', 0]].map(([n, c, on]) => (
            <div key={n} className="flex items-center justify-between px-2.5 py-1.5 rounded-md text-[13px] mb-0.5" style={{ background: on ? 'rgb(var(--ink-4))' : 'transparent', color: on ? 'rgb(var(--ink-fg))' : 'rgb(var(--ink-fg-1))' }}>
              <span className="flex items-center gap-2"><Icon name={n === '收件箱' ? 'mail' : n === '已标旗' ? 'archive' : 'folder'} size={14} /> {n}</span>
              {c > 0 && <span className="font-mono text-[11px] text-ink-fg-2">{c}</span>}
            </div>
          ))}
          <div className="text-[11px] font-mono uppercase tracking-wider text-ink-fg-2 px-2 mt-4 mb-2">AI Agents</div>
          <div className="flex items-center gap-2 px-2.5 py-1.5 text-[13px] text-ink-fg-1"><span style={{ color: 'rgb(var(--c-accent))' }}><Icon name="spark" size={14} fill /></span> Jarvis</div>
        </div>
        <div className="flex-1 min-w-0" style={{ background: 'rgb(var(--ink-2))' }}>
          {[
            { from: 'Sentry · alerts@sentry.io', subj: '[Alert] prod: TimeoutError (Notion API)', pri: 'urg', priL: 'Urgent', t: '14:23', unread: true },
            { from: 'PagerDuty · noreply@pagerduty.com', subj: '[P1] webhook-server 8100: HTTP 502', pri: 'crit', priL: 'Critical', t: '14:08', unread: true },
            { from: '张敏 · zhang.min@chenge.ink', subj: 'Re: [飞书] 周报 — w20 项目进度对齐', pri: 'norm', priL: 'Normal', t: '10:55' },
          ].map((m, i) => (
            <div key={i} className="px-4 py-3" style={{ borderBottom: '1px solid rgb(var(--ink-border-soft))' }}>
              <div className="flex items-start gap-2.5">
                <span style={{ width: 6, height: 6, marginTop: 6, borderRadius: 99, flexShrink: 0, background: m.unread ? 'rgb(var(--c-accent))' : 'transparent' }}></span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-[13px] truncate flex-1" style={{ color: m.unread ? 'rgb(var(--ink-fg))' : 'rgb(var(--ink-fg-1))', fontWeight: m.unread ? 500 : 400 }}>{m.from}</span>
                    <span className="font-mono text-[11px] text-ink-fg-2 tabular-nums">{m.t}</span>
                  </div>
                  <div className="text-[13.5px] truncate" style={{ color: m.unread ? 'rgb(var(--ink-fg))' : 'rgb(var(--ink-fg-1))', fontWeight: m.unread ? 600 : 400 }}>{m.subj}</div>
                  <div className="flex items-center gap-1.5 mt-2">
                    <span className="pill" style={{ color: `rgb(var(--c-${m.pri}))`, background: `rgb(var(--c-${m.pri})/0.15)`, border: `1px solid rgb(var(--c-${m.pri})/0.3)`, textTransform: 'uppercase' }}>{m.priL}</span>
                    <span className="pill pill-muted">Reply&nbsp;Needed</span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { LegacyFlow, HalfFlow, DBCorruptScreen, RollbackScreen, InboxMock });
