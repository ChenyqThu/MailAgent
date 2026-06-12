// MailAgent Theme v2 — Tweaks: 镜像「设置 · 通用」的外观控件
// 单一事实源是 window.MA (demo HTML 里的 store)；这里只是 Tweaks 形态的入口。
// 定稿默认值 (2026-06-12): alpha .85 / blur 30px / sat 1.8 / mix 16% / ambient .20 / grain .07

const KNOB_DEFS = [
  { key: 'alpha',   label: '不透明度',     min: 0.5, max: 0.95, step: 0.01 },
  { key: 'blur',    label: '基底模糊',     min: 8,   max: 40,   step: 1 },
  { key: 'sat',     label: '饱和增益',     min: 1,   max: 2.2,  step: 0.05 },
  { key: 'mix',     label: 'Accent 染色',  min: 0,   max: 20,   step: 1 },
  { key: 'ambient', label: '氛围光',       min: 0,   max: 0.3,  step: 0.01 },
  { key: 'grain',   label: '噪点强度',     min: 0,   max: 0.12, step: 0.005 },
];

function ThemeTweaks() {
  const [st, setSt] = React.useState(() => ({ ...window.MA.get(), knobs: { ...window.MA.get().knobs } }));
  React.useEffect(() => {
    window.MA.sub((s) => setSt({ ...s, knobs: { ...s.knobs } }));
  }, []);

  const solid = st.surface === 'solid';
  const custom = Object.keys(st.knobs).length > 0;

  return (
    <TweaksPanel title="Tweaks">
      <TweakSection label="玻璃配方 (镜像 设置→通用)" />
      {KNOB_DEFS.map((k) => (
        <TweakSlider
          key={k.key}
          label={k.label}
          value={st.knobs[k.key] ?? window.MA.effective(k.key)}
          min={k.min}
          max={k.max}
          step={k.step}
          onChange={(v) => window.MA.setKnob(k.key, v)}
        />
      ))}
      <TweakButton
        label={custom ? '恢复定稿默认值' : '未覆写 — 定稿默认值生效中'}
        onClick={() => window.MA.resetKnobs()}
      />
      <TweakSection label="说明" />
      <div style={{ fontSize: 11, lineHeight: 1.55, opacity: 0.65, padding: '2px 2px 6px' }}>
        {solid
          ? '当前为「实色」材质，玻璃配方不生效。'
          : '与应用内「设置 · 通用 → 外观」（标题栏滑杆按钮）是同一份状态。方案级切换在桌面右上控制卡。'}
      </div>
    </TweaksPanel>
  );
}

ReactDOM.createRoot(document.getElementById('tweaks-root')).render(<ThemeTweaks />);
