/* ============================================================================
   MailAgent Onboarding · NEW-user wizard steps (7)
   tone: 'detailed' | 'concise' swaps copy density.
   ============================================================================ */
const { useState: useStateW, useEffect: useEffectW, useRef: useRefW } = React;

function tn(tone, detailed, concise) { return tone === 'concise' ? concise : detailed; }

/* ─── Step 0 · Welcome ───────────────────────────────────────────────────── */
function StepWelcome({ tone, onNext, onLegacy }) {
  return (
    <div className="wiz-body scrollbar-thin step-enter">
      <div className="flex flex-col items-center text-center pt-3">
        <span className="grid place-items-center w-16 h-16 rounded-2xl mb-5" style={{ background: 'rgb(var(--c-accent)/0.12)', border: '1px solid rgb(var(--c-accent)/0.3)', color: 'rgb(var(--c-accent))' }}>
          <Icon name="spark" size={30} fill />
        </span>
        <div className="eyebrow">Welcome</div>
        <h1 className="wiz-h1">欢迎使用 MailAgent</h1>
        <p className="wiz-lede" style={{ textAlign: 'center' }}>
          {tn(tone,
            '把你的邮件实时同步到 Notion，并用 AI 帮你分类、起草回复。接下来约 5 分钟完成设置 —— 全程无需终端命令。',
            '邮件实时同步到 Notion + AI 分类、起草回复。约 5 分钟完成设置。')}
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3 mt-8">
        {[
          { ic: 'mail', t: '实时同步', d: '邮件镜像进 Notion 数据库' },
          { ic: 'spark', t: 'AI 分类', d: '优先级 · 动作项 · 起草回复' },
          { ic: 'lock', t: '本地优先', d: '数据存本机，不上传第三方' },
        ].map((c) => (
          <div key={c.t} className="ds-card" style={{ padding: '14px 13px' }}>
            <span className="text-ink-fg-1" style={{ color: 'rgb(var(--c-accent))' }}><Icon name={c.ic} size={18} fill={c.ic === 'spark'} /></span>
            <div className="text-[14px] font-semibold text-ink-fg mt-2.5">{c.t}</div>
            <div className="text-[12px] text-ink-fg-2 mt-1 leading-snug">{c.d}</div>
          </div>
        ))}
      </div>

      {tone === 'detailed' && (
        <div className="mt-5">
          <Banner kind="info" icon="folder">
            你的所有数据保存在本机 <span className="font-mono text-[12px] text-ink-fg">~/Library/Application Support/MailAgent</span>，不上传到第三方服务器（除你自己配置的 Notion）。
          </Banner>
        </div>
      )}
    </div>
  );
}

/* ─── Step 1 · Environment & permissions (FDA) ───────────────────────────── */
const FDA_CHECKS = [
  { key: 'os', label: 'macOS 版本', detail: '需要 macOS 12 (Monterey) 或更高', kind: 'system' },
  { key: 'py', label: '嵌入式 Python 运行时', detail: 'MAILAGENT_BIN 可执行', kind: 'system' },
  { key: 'data', label: 'DATA_ROOT 可写', detail: '数据目录可创建 / 写入', kind: 'system' },
  { key: 'fda', label: '完全磁盘访问 (FDA)', detail: '读取 Mail.app 邮件数据', kind: 'perm' },
  { key: 'auto', label: '自动化 · 控制 Mail.app', detail: '草稿 / 回复需 Apple Events 权限', kind: 'perm' },
];
function StepFDA({ tone, onNext, onBack, fda, setFda }) {
  // fda: { results: {key:'pending'|'pass'|'fail'}, scanning, skipped }
  const runScan = (grantPerms) => {
    setFda((f) => ({ ...f, scanning: true, results: Object.fromEntries(FDA_CHECKS.map((c) => [c.key, 'pending'])) }));
    FDA_CHECKS.forEach((c, i) => {
      setTimeout(() => {
        setFda((f) => {
          const r = { ...f.results };
          r[c.key] = c.kind === 'perm' && !grantPerms ? (c.key === 'fda' ? 'fail' : 'warn') : 'pass';
          const done = i === FDA_CHECKS.length - 1;
          return { ...f, results: r, scanning: done ? false : f.scanning };
        });
      }, 350 + i * 320);
    });
  };
  useEffectW(() => {
    if (!fda.started) { setFda((f) => ({ ...f, started: true })); runScan(false); }
  }, []);

  const r = fda.results || {};
  const allDone = FDA_CHECKS.every((c) => r[c.key] && r[c.key] !== 'pending') && !fda.scanning;
  const systemBlocked = FDA_CHECKS.some((c) => c.kind === 'system' && r[c.key] === 'fail');
  const fdaOk = r.fda === 'pass';
  const canProceed = allDone && !systemBlocked;

  const iconFor = (st) => st === 'pass' ? <Icon name="check" size={13} sw={3} style={{ color: 'rgb(var(--c-ok))' }} />
    : st === 'fail' ? <Icon name="x" size={13} sw={3} style={{ color: 'rgb(var(--c-fail))' }} />
    : st === 'warn' ? <Icon name="alert" size={13} style={{ color: 'rgb(var(--c-warn))' }} />
    : <Icon name="refresh" size={13} cls="spin" style={{ color: 'rgb(var(--ink-fg-2))' }} />;
  const boxClass = (st) => st === 'pass' ? 'chk-pass' : st === 'fail' ? 'chk-fail' : st === 'warn' ? 'chk-warn' : 'chk-pending';

  return (
    <>
      <div className="wiz-body scrollbar-thin step-enter">
        <div className="eyebrow">Step 1 — 环境与权限</div>
        <h1 className="wiz-h1">检查运行环境</h1>
        <p className="wiz-lede">{tn(tone, 'MailAgent 正在检测系统环境与所需权限。完全磁盘访问是读取 Mail.app 邮件的前提。', '检测系统环境与权限。')}</p>

        <div className="flex flex-col gap-2 mt-6">
          {FDA_CHECKS.map((c) => {
            const st = r[c.key] || 'pending';
            return (
              <div key={c.key} className="chk-row">
                <span className={`chk-icon ${boxClass(st)}`}>{iconFor(st)}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] text-ink-fg flex items-center gap-2">{c.label}
                    {c.kind === 'perm' && <span className="pill pill-muted">需授权</span>}</div>
                  <div className="text-[12px] text-ink-fg-2 mt-0.5">{c.detail}</div>
                </div>
                {st === 'fail' && c.key === 'fda' && (
                  <button className="btn-sec" style={{ padding: '5px 10px', fontSize: 13 }} onClick={() => runScan(true)}>
                    <Icon name="external" size={13} /> 打开系统设置
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {!fdaOk && allDone && (
          <div className="mt-5">
            <Banner kind="warn">
              <div className="font-semibold text-[13px] mb-1">完全磁盘访问未授权</div>
              {tn(tone,
                <span>请点击「打开系统设置」→ 隐私与安全 → 完全磁盘访问 → 勾选 MailAgent，然后回来点「重新检测」。你也可以「稍后设置」，但邮件读取功能会受限。</span>,
                <span>到系统设置勾选 MailAgent 后「重新检测」，或「稍后设置」。</span>)}
            </Banner>
          </div>
        )}
        {fdaOk && allDone && (
          <div className="mt-5"><Banner kind="info" icon="check">环境检查全部通过，可以继续。</Banner></div>
        )}
      </div>
      <WizFooter
        onBack={onBack}
        secondary={!fdaOk && allDone ? <button className="btn-link" onClick={() => { setFda((f) => ({ ...f, skipped: true })); onNext(); }}>稍后设置</button> : null}
        left={allDone ? <button className="btn-link ml-3" onClick={() => runScan(fdaOk)}><Icon name="refresh" size={13} /> 重新检测</button> : null}
        onNext={onNext} nextDisabled={!canProceed} busy={fda.scanning}
        nextLabel={fdaOk ? '下一步' : '仍要继续'} />
    </>
  );
}

/* ─── Step 2 · Backend selection ─────────────────────────────────────────── */
function StepBackend({ tone, backend, setBackend, davAck, setDavAck, onNext, onBack }) {
  const [advOpen, setAdvOpen] = useStateW(false);
  const canNext = backend === 'applescript' || (backend === 'davmail' && davAck);
  return (
    <>
      <div className="wiz-body scrollbar-thin step-enter">
        <div className="eyebrow">Step 2 — 后端选择</div>
        <h1 className="wiz-h1">选择邮件后端</h1>
        <p className="wiz-lede">{tn(tone, '决定 MailAgent 如何读写你的邮件。个人用户推荐 AppleScript —— 零配置、零合规风险。', '个人推荐 AppleScript（零配置）。')}</p>

        <div className="flex flex-col gap-3 mt-6">
          <button className={`opt-card ${backend === 'applescript' ? 'on' : ''}`} onClick={() => setBackend('applescript')}>
            <div className="flex items-start gap-3">
              <span className="opt-radio mt-0.5"></span>
              <span className="text-ink-fg-1 mt-0.5" style={{ color: backend === 'applescript' ? 'rgb(var(--c-accent))' : undefined }}><Icon name="mail" size={18} /></span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[15px] font-semibold text-ink-fg">AppleScript</span>
                  <span className="pill pill-ok">推荐</span>
                </div>
                <div className="text-[13px] text-ink-fg-1 mt-1 leading-snug">使用你 Mail.app 里已登录的账户读写邮件。零配置，需要上一步授予完全磁盘访问。</div>
              </div>
            </div>
          </button>

          <button className={`opt-card ${backend === 'davmail' ? 'on' : ''}`} onClick={() => { setBackend('davmail'); setAdvOpen(true); }}>
            <div className="flex items-start gap-3">
              <span className="opt-radio mt-0.5"></span>
              <span className="text-ink-fg-1 mt-0.5" style={{ color: backend === 'davmail' ? 'rgb(var(--c-accent))' : undefined }}><Icon name="server" size={18} /></span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[15px] font-semibold text-ink-fg">DavMail</span>
                  <span className="pill pill-info">企业 · Outlook/EWS</span>
                  <span className="pill pill-warn">Beta</span>
                </div>
                <div className="text-[13px] text-ink-fg-1 mt-1 leading-snug">用于 Outlook / Exchange 企业邮箱。需系统 Java + 引导式配置，有合规前提。</div>
              </div>
            </div>
          </button>
        </div>

        {backend === 'davmail' && (
          <div className="mt-3 step-enter">
            <button className="flex items-center gap-1.5 text-[13px] text-ink-fg-2 hover:text-ink-fg transition" onClick={() => setAdvOpen(!advOpen)}>
              <Icon name={advOpen ? 'x' : 'alert'} size={13} /> {advOpen ? '收起合规说明' : '展开合规说明（必读）'}
            </button>
            {advOpen && (
              <div className="mt-3">
                <Banner kind="warn">
                  <div className="font-semibold text-[13px] mb-1.5">重要提示 · 请仔细阅读</div>
                  <ul className="text-[12.5px] text-ink-fg-1 leading-relaxed space-y-1.5" style={{ listStyle: 'disc', paddingLeft: 16 }}>
                    <li>DavMail 当前使用 Outlook 的 well-known client_id 进行身份伪装，属概念验证（PoC），<span className="text-ink-fg">未经公司 IT 审批</span>，不可用于正式分发。</li>
                    <li>EWS 协议将于 <span className="font-mono text-[12px]">2026-10-01</span> 关停，长期方案需申请独立 Microsoft Graph API 应用注册。</li>
                    <li>OAuth 初次授权需手动操作，本向导不在此处自动化，请参阅《DavMail 高级配置》文档。</li>
                  </ul>
                  <label className="flex items-center gap-2.5 mt-3 cursor-pointer select-none">
                    <span className={`cb ${davAck ? 'cb-on' : ''}`} onClick={(e) => { e.preventDefault(); setDavAck(!davAck); }}></span>
                    <span className="text-[13px] text-ink-fg">我已了解上述风险，仍要继续配置 DavMail（仅限个人评估用途）</span>
                  </label>
                </Banner>
              </div>
            )}
          </div>
        )}
      </div>
      <WizFooter onBack={onBack} onNext={onNext} nextDisabled={!canNext} />
    </>
  );
}

/* ─── Step 3 · Mail sync config (real validation) ────────────────────────── */
const HEX32 = /^[0-9a-f]{32}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function StepConfig({ tone, form, setForm, onNext, onBack, submitError }) {
  const [accounts, setAccounts] = useStateW(null); // null = loading
  const [touched, setTouched] = useStateW({});
  useEffectW(() => {
    if (form._accountsLoaded) { setAccounts(['Exchange', 'iCloud', 'Gmail · chenge.ink']); return; }
    const t = setTimeout(() => { setAccounts(['Exchange', 'iCloud', 'Gmail · chenge.ink']); setForm((f) => ({ ...f, _accountsLoaded: true })); }, 1100);
    return () => clearTimeout(t);
  }, []);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const blur = (k) => setTouched((t) => ({ ...t, [k]: true }));

  const errs = {};
  if (!form.USER_EMAIL) errs.USER_EMAIL = '必填项';
  else if (!EMAIL_RE.test(form.USER_EMAIL)) errs.USER_EMAIL = '邮箱格式不正确';
  if (!form.NOTION_TOKEN) errs.NOTION_TOKEN = '必填项';
  if (!form.EMAIL_DATABASE_ID) errs.EMAIL_DATABASE_ID = '必填项';
  if (!form.MAIL_ACCOUNT_NAME) errs.MAIL_ACCOUNT_NAME = '请选择账户';

  const warns = {};
  if (form.NOTION_TOKEN && !/^(secret_|ntn_)/.test(form.NOTION_TOKEN)) warns.NOTION_TOKEN = 'Token 通常以 secret_ 或 ntn_ 开头，请确认';
  if (form.EMAIL_DATABASE_ID && !HEX32.test(form.EMAIL_DATABASE_ID.replace(/-/g, ''))) warns.EMAIL_DATABASE_ID = '数据库 ID 通常为 32 位十六进制';
  if (form.CALENDAR_DATABASE_ID && !HEX32.test(form.CALENDAR_DATABASE_ID.replace(/-/g, ''))) warns.CALENDAR_DATABASE_ID = '日历 DB ID 通常为 32 位十六进制';

  const valid = Object.keys(errs).length === 0;
  const showErr = (k) => touched[k] && errs[k];

  return (
    <>
      <div className="wiz-body scrollbar-thin step-enter">
        <div className="eyebrow">Step 3 — 邮件同步配置</div>
        <h1 className="wiz-h1">连接 Notion 与邮箱</h1>
        <p className="wiz-lede">{tn(tone, '填写后写入 DATA_ROOT/.env（行级原子写，不破坏注释）。Token 会镜像到系统钥匙串。', '配置写入 .env，Token 入钥匙串。')}</p>

        {submitError && <div className="mt-4"><Banner kind="fail"><div className="font-semibold text-[13px] mb-0.5">{submitError.title}</div><div className="text-[12.5px] text-ink-fg-1">{submitError.message}</div></Banner></div>}

        <div className="flex flex-col gap-4 mt-5">
          <Field label="Mail.app 账户名" icon="mail" required error={showErr('MAIL_ACCOUNT_NAME')}
            hint={accounts === null ? '正在检测 Mail.app 账户…' : '来自 mailagent debug mail-structure'}>
            <div className="selwrap">
              {accounts === null ? (
                <div className="fld flex items-center gap-2 text-ink-fg-2"><Icon name="refresh" size={14} cls="spin" /> 检测中…</div>
              ) : (
                <select className={`fld ${showErr('MAIL_ACCOUNT_NAME') ? 'err' : ''}`} value={form.MAIL_ACCOUNT_NAME || ''}
                  onChange={(e) => { set('MAIL_ACCOUNT_NAME', e.target.value); blur('MAIL_ACCOUNT_NAME'); }} onBlur={() => blur('MAIL_ACCOUNT_NAME')}>
                  <option value="" disabled>请选择要同步的账户</option>
                  {accounts.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              )}
            </div>
          </Field>

          <Field label="同步邮箱" icon="archive" hint="默认收件箱，可多选">
            <ChipSelect options={['收件箱', '发件箱', '已发送', '归档', '重要']} value={form.SYNC_MAILBOXES || ['收件箱']} onChange={(v) => set('SYNC_MAILBOXES', v.length ? v : ['收件箱'])} />
          </Field>

          <Field label="用户邮箱 (USER_EMAIL)" icon="mail" required error={showErr('USER_EMAIL')}>
            <input className={`fld ${showErr('USER_EMAIL') ? 'err' : ''}`} placeholder="you@company.com" value={form.USER_EMAIL || ''}
              onChange={(e) => set('USER_EMAIL', e.target.value)} onBlur={() => blur('USER_EMAIL')} />
          </Field>

          <Field label="Notion Token" icon="key" required error={showErr('NOTION_TOKEN')} warn={warns.NOTION_TOKEN}
            hint={<span>在 Notion → Settings → Connections 创建 Integration，粘贴 secret。<span className="help-link">如何创建？</span></span>}>
            <input className={`fld mono ${showErr('NOTION_TOKEN') ? 'err' : ''}`} placeholder="secret_xxxxxxxx…" value={form.NOTION_TOKEN || ''}
              onChange={(e) => set('NOTION_TOKEN', e.target.value)} onBlur={() => blur('NOTION_TOKEN')} type="text" autoComplete="off" />
          </Field>

          <Field label="邮件数据库 ID" icon="database" required error={showErr('EMAIL_DATABASE_ID')} warn={warns.EMAIL_DATABASE_ID}
            hint="打开你的邮件数据库 → 复制 URL 里的 32 位 ID">
            <input className={`fld mono ${showErr('EMAIL_DATABASE_ID') ? 'err' : ''}`} placeholder="a1b2c3d4e5f6…（32 位）" value={form.EMAIL_DATABASE_ID || ''}
              onChange={(e) => set('EMAIL_DATABASE_ID', e.target.value)} onBlur={() => blur('EMAIL_DATABASE_ID')} />
          </Field>

          <Field label="日历数据库 ID" icon="calendar" warn={warns.CALENDAR_DATABASE_ID}
            hint="选填 · 如需同步会议到日历再填，可稍后在设置补">
            <input className="fld mono" placeholder="选填" value={form.CALENDAR_DATABASE_ID || ''}
              onChange={(e) => set('CALENDAR_DATABASE_ID', e.target.value)} />
          </Field>
        </div>
      </div>
      <WizFooter onBack={onBack} onNext={() => { setTouched({ USER_EMAIL: 1, NOTION_TOKEN: 1, EMAIL_DATABASE_ID: 1, MAIL_ACCOUNT_NAME: 1 }); if (valid) onNext(); }}
        nextDisabled={!valid} nextLabel="开始同步" nextIcon="arrowRight" />
    </>
  );
}

/* ─── Step 4 · First init sync (progress polling) ────────────────────────── */
const SYNC_STAGES = [
  { key: 'db', label: '建表 · 初始化数据库', sub: 'sync_store.db → v17' },
  { key: 'fetch', label: '拉取邮件缓存', sub: 'AppleScript 读取 Mail.app' },
  { key: 'notion', label: '写入 Notion', sub: '镜像到邮件数据库' },
];
function StepSync({ tone, sync, setSync, onNext, onBack }) {
  const timer = useRefW(null);
  const TOTAL = 6184;
  useEffectW(() => {
    if (sync.done || sync.background) return;
    if (!sync.running) setSync((s) => ({ ...s, running: true }));
    timer.current = setInterval(() => {
      setSync((s) => {
        if (s.done) return s;
        let pct = s.pct + (s.stage === 1 ? 2.1 : 3.2);
        let stage = s.stage;
        if (pct >= 100) { pct = 100; if (stage < 2) { stage += 1; pct = stage === 1 ? 1 : 60; } }
        const count = Math.min(TOTAL, Math.round((stage === 0 ? 0 : (stage - 1 + pct / 100) / 2) * TOTAL));
        const done = stage === 2 && pct >= 100;
        return { ...s, pct, stage, count, done };
      });
    }, 240);
    return () => clearInterval(timer.current);
  }, [sync.running, sync.background, sync.done]);

  const stageObj = SYNC_STAGES[sync.stage] || SYNC_STAGES[0];
  return (
    <>
      <div className="wiz-body scrollbar-thin step-enter">
        <div className="eyebrow">Step 4 — 首次同步</div>
        <h1 className="wiz-h1">{sync.done ? '首次同步完成' : '正在初始化并同步邮件'}</h1>
        <p className="wiz-lede">{sync.done ? '数据库已就绪，邮件已开始镜像到 Notion。' : tn(tone, '后端正在建表并拉取你的邮件。向导直读 sync_state 表轮询就绪状态。', '后端建表并拉取邮件中。')}</p>

        <div className="ds-card ds-card-pad mt-6">
          <div className="flex items-center justify-between mb-2.5">
            <div className="flex items-center gap-2.5">
              {sync.done ? <span style={{ color: 'rgb(var(--c-ok))' }}><Icon name="check" size={18} sw={3} /></span>
                : <span style={{ color: 'rgb(var(--c-accent))' }}><Icon name="refresh" size={18} cls="spin" /></span>}
              <span className="text-[15px] font-semibold text-ink-fg">{sync.done ? '同步就绪' : stageObj.label}</span>
            </div>
            <span className="font-mono text-[12px] text-ink-fg-2 tabular-nums">已同步 {sync.count.toLocaleString()} / {TOTAL.toLocaleString()}</span>
          </div>
          <ProgressBar value={sync.done ? 100 : (sync.stage * 100 + sync.pct) / 3} />
          <div className="flex items-center justify-between mt-3">
            <span className="font-mono text-[11px] text-ink-fg-2">{sync.done ? 'sync_state.db_version = 17 ✓' : stageObj.sub}</span>
            <span className="font-mono text-[11px] text-ink-fg-2">{Math.round(sync.done ? 100 : (sync.stage * 100 + sync.pct) / 3)}%</span>
          </div>

          <div className="flex items-center gap-2 mt-4">
            {SYNC_STAGES.map((st, i) => (
              <div key={st.key} className="flex items-center gap-1.5 text-[11px] font-mono"
                style={{ color: i < sync.stage || sync.done ? 'rgb(var(--c-ok))' : i === sync.stage ? 'rgb(var(--c-accent))' : 'rgb(var(--ink-fg-3))' }}>
                <span style={{ width: 6, height: 6, borderRadius: 99, background: 'currentColor', display: 'inline-block' }}></span>
                {st.key}
              </div>
            ))}
          </div>
        </div>

        {!sync.done && (
          <div className="mt-4">
            <Banner kind="info" icon="clock">
              {tn(tone, '邮箱较大（约 6 万封）时，首次同步可能需要数分钟到数小时。你可以让它在后台继续，先去配置插件。', '大邮箱首次同步较久，可转入后台继续。')}
            </Banner>
          </div>
        )}
        {sync.done && <div className="mt-4"><Banner kind="info" icon="check">数据库版本校验通过，前端只读连接已打开。</Banner></div>}
      </div>
      <WizFooter onBack={sync.done ? null : onBack}
        secondary={!sync.done ? <button className="btn-link" onClick={() => { clearInterval(timer.current); setSync((s) => ({ ...s, background: true })); onNext(); }}>转入后台并继续</button> : null}
        onNext={onNext} nextDisabled={!sync.done && !sync.background} nextLabel={sync.done ? '下一步' : '请稍候…'} busy={!sync.done && !sync.background} />
    </>
  );
}

/* ─── Step 5 · Plugins (feature bundles) ─────────────────────────────────── */
const PLUGINS = [
  { key: 'notion', icon: 'database', name: 'Notion 同步', desc: '邮件镜像到 Notion 数据库（核心）', core: true, restart: 'mail-sync' },
  { key: 'agent', icon: 'brain', name: 'Notion Agent CLI', desc: '在 chat 里调用 notion-agent 操作 Notion', needs: 'notion', needCred: true, credLabel: 'notion-agent 授权', restart: 'Electron' },
  { key: 'island', icon: 'bell', name: '灵动岛通知', desc: '新邮件 / AI 结果推送到灵动岛', extDep: 'ping-island.app', restart: '免重启' },
  { key: 'llm', icon: 'spark', name: 'LLM AI 智能', desc: '本地大模型分类 · 起草回复', needCred: true, credLabel: 'API key', restart: 'mail-sync' },
  { key: 'digest', icon: 'clock', name: '每日巡检', desc: '每天定时汇总未读 / 待办', needs: 'island', restart: 'mail-sync' },
  { key: 'calendar', icon: 'calendar', name: '日历同步', desc: '会议事件双向同步（仅 DavMail）', needsBackend: 'davmail', restart: 'mail-sync' },
];
function StepPlugins({ tone, plugins, setPlugins, backend, onNext, onBack }) {
  const toggle = (k) => setPlugins((p) => ({ ...p, [k]: !p[k] }));
  const isGrayed = (pl) => (pl.needs && !plugins[pl.needs]) || (pl.needsBackend && backend !== pl.needsBackend);
  const grayReason = (pl) => pl.needsBackend && backend !== pl.needsBackend ? `需 ${pl.needsBackend} 后端`
    : pl.needs ? `需先开启「${PLUGINS.find((x) => x.key === pl.needs).name}」` : '';
  return (
    <>
      <div className="wiz-body scrollbar-thin step-enter">
        <div className="eyebrow">Step 5 — 插件</div>
        <h1 className="wiz-h1">按需开启功能</h1>
        <p className="wiz-lede">{tn(tone, '以下是可选功能，现在开启或稍后在设置里随时调整。缺凭证不会阻断 —— 标橙色「未配置」引导补全。', '可选功能，可稍后在设置调整。')}</p>

        <div className="flex flex-col gap-2.5 mt-6">
          {PLUGINS.map((pl) => {
            const on = pl.core || plugins[pl.key];
            const grayed = isGrayed(pl);
            const unconfigured = on && !pl.core && pl.needCred && !plugins[pl.key + '_cred'];
            return (
              <div key={pl.key} className="ds-card" style={{ padding: '13px 15px', opacity: grayed ? 0.5 : 1 }}>
                <div className="flex items-center gap-3">
                  <span style={{ color: on && !grayed ? 'rgb(var(--c-accent))' : 'rgb(var(--ink-fg-2))', flexShrink: 0 }}><Icon name={pl.icon} size={18} fill={pl.icon === 'spark'} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[14px] font-semibold text-ink-fg">{pl.name}</span>
                      {pl.core && <span className="pill pill-ok">核心</span>}
                      {unconfigured && <span className="pill pill-warn"><Icon name="alert" size={10} /> 未配置</span>}
                      {pl.extDep && on && !plugins[pl.key + '_cred'] && !pl.core && <span className="pill pill-info">安装引导</span>}
                      <span className="pill pill-muted">{pl.restart === '免重启' ? '免重启' : `重启 ${pl.restart}`}</span>
                    </div>
                    <div className="text-[12px] text-ink-fg-2 mt-1 leading-snug">
                      {grayed ? <span className="text-warn">{grayReason(pl)}</span> : pl.desc}
                    </div>
                  </div>
                  <div className="flex items-center gap-2.5 shrink-0">
                    {unconfigured && <button className="btn-sec" style={{ padding: '4px 9px', fontSize: 12 }} onClick={() => setPlugins((p) => ({ ...p, [pl.key + '_cred']: true }))}>配置</button>}
                    <Toggle on={on} disabled={pl.core || grayed} onChange={() => toggle(pl.key)} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {tone === 'detailed' && (
          <div className="mt-4"><Banner kind="info">两类重启已标注：改后端开关重启 mail-sync 进程；Notion Agent 需重启 Electron；灵动岛免重启。</Banner></div>
        )}
      </div>
      <WizFooter onBack={onBack} onNext={onNext} nextLabel="完成设置" nextIcon="arrowRight" />
    </>
  );
}

/* ─── Step 6 · Done ──────────────────────────────────────────────────────── */
function StepDone({ tone, sync, fda, onLaunch, busy }) {
  return (
    <div className="wiz-body scrollbar-thin step-enter flex flex-col items-center justify-center text-center" style={{ minHeight: '100%' }}>
      <span className="grid place-items-center w-16 h-16 rounded-2xl mb-5" style={{ background: 'rgb(var(--c-accent)/0.12)', border: '1px solid rgb(var(--c-accent)/0.3)', color: 'rgb(var(--c-accent))' }}>
        <Icon name="rocket" size={30} />
      </span>
      <div className="eyebrow">Done</div>
      <h1 className="wiz-h1">设置完成！</h1>
      <p className="wiz-lede" style={{ textAlign: 'center' }}>
        {sync.background ? 'MailAgent 正在后台继续同步你的邮件，主窗口顶部会显示进度。' : 'MailAgent 已准备就绪，正在打开收件箱。'}
      </p>
      <div className="flex flex-col gap-2 mt-6 w-full" style={{ maxWidth: 360 }}>
        {fda.skipped && <Banner kind="warn">FDA 未授权 —— 主窗口将持续显示授权横幅，邮件读取功能受限。</Banner>}
        <div className="ds-card" style={{ padding: '12px 14px' }}>
          <div className="flex items-center justify-between text-[13px]">
            <span className="text-ink-fg-1">onboarding_done</span>
            <span className="font-mono text-ok flex items-center gap-1.5"><Icon name="check" size={13} sw={3} /> true</span>
          </div>
        </div>
      </div>
      <button className="btn-primary mt-7" style={{ padding: '10px 22px' }} onClick={onLaunch} disabled={busy}>
        {busy ? <><Icon name="refresh" size={15} cls="spin" /> 正在启动…</> : <>进入收件箱 <Icon name="arrowRight" size={15} /></>}
      </button>
    </div>
  );
}

Object.assign(window, { StepWelcome, StepFDA, StepBackend, StepConfig, StepSync, StepPlugins, StepDone, FDA_CHECKS, tn });
