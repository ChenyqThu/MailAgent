# Omada UI Prototype Playbook (`omada_prototype`)

Build authentic **TP-Link Omada Controller v6.3** interactive UI prototypes using verified exports from **`@chenyqthu/omada-ui-kit`**.

---

## 1. Mode Selection (Mode A Default vs Mode B Fallback)

- **Mode A (Default & Recommended) — Zero-Build Single-File HTML via `artifact_write`**:
  - Use `artifact_write` with `artifact_type: "app"` to produce a compact (~45–150 line, ~5–15 KB) HTML5 file loading `@chenyqthu/omada-ui-kit` CDN (`dist/style.css` + `dist/standalone.js`) and `@babel/standalone@7`.
  - Zero Vite build time, opens cleanly via Studio `libpreview://`, `file://` double-click, browser preview, and publishes instantaneously to Canvas Artifact Server (`artifact_publish_bundle`).
- **Mode B (Optional Fallback) — Local Vite TSX Build via `artifact_build_omada`**:
  - Use `artifact_build_omada` ONLY when the user explicitly requires an offline / zero-CDN self-contained bundle, custom Tailwind v4 JIT utility classes, or local TypeScript compile verification against `~/Documents/omada-ui-kit`.

---

## 2. Mandatory Catalog Lookup (`omada_catalog_query`) — Never Guess!

Before writing JSX, call `omada_catalog_query` (silent read, zero approval prompt) to inspect real Props, Figma asset slugs, Light/Dark tokens, and starter recipes:

```text
omada_catalog_query(action="info")
omada_catalog_query(action="list_components")
omada_catalog_query(action="list_components", query="emulator-v6")
omada_catalog_query(action="component", query="SEmulatorShell")
omada_catalog_query(action="component", query="SSettingsPageShell")
omada_catalog_query(action="search_icons", query="status", limit=20)
omada_catalog_query(action="search_assets", asset_group="products", query="eap", limit=20)
omada_catalog_query(action="search_assets", asset_group="illustrations", query="empty", limit=20)
omada_catalog_query(action="search_assets", asset_group="clients", query="apple", limit=20)
omada_catalog_query(action="tokens", theme="light")
omada_catalog_query(action="recipes")
```

Never invent `S*` prop names, `<SIcon name="..." />` strings, or `<SProductImage name="..." />` slugs from memory.

---

## 3. Mode A Starter Template (`artifact_write` + `@chenyqthu/omada-ui-kit` CDN)

Always use **classic `<script>` tags** (NOT `<script type="module">`) and pin Babel to **v7** on jsDelivr (`@babel/standalone@7/babel.min.js`) so Studio sandboxed iframes, `file://` opens, and `canvas.chenge.ink` share links work without CORS/module issues:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Omada PRD Demo</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@chenyqthu/omada-ui-kit@latest/dist/style.css" />
    <script src="https://cdn.jsdelivr.net/npm/@chenyqthu/omada-ui-kit@latest/dist/standalone.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/@babel/standalone@7/babel.min.js"></script>
  </head>
  <body style="margin: 0; font-family: var(--omada-font-sans);">
    <div id="root"></div>
    <script type="text/babel">
      const { useState } = OmadaUI.React;
      const {
        OmadaProvider,
        SEmulatorShell,
        SPageHeader,
        SKpiCard,
        SCard,
        STable,
        SDrawer,
        SDeviceStatus,
        SButton,
        SIcon,
        SProductImage,
        useOmadaTheme,
      } = window.OmadaUI;

      function DemoApp() {
        const [activeNav, setActiveNav] = useState('devices');
        const [selected, setSelected] = useState(null);
        const { resolvedTheme, setThemeMode } = useOmadaTheme();

        return (
          <SEmulatorShell
            activeKey={activeNav}
            onSelect={setActiveNav}
            controllerName="Headquarters Building"
          >
            <div style={{ padding: '20px 44px 24px 24px' }}>
              <SPageHeader
                title="AP Health Overview"
                extra={
                  <div style={{ display: 'flex', gap: 8 }}>
                    <SButton
                      variant="secondary"
                      onClick={() => setThemeMode(resolvedTheme === 'dark' ? 'light' : 'dark')}
                    >
                      Theme: {resolvedTheme === 'dark' ? 'Dark' : 'Light'}
                    </SButton>
                    <SButton variant="primary" icon={<SIcon name="refresh" size={14} />}>
                      Refresh
                    </SButton>
                  </div>
                }
              />
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                  gap: 16,
                  marginBottom: 16,
                }}
              >
                <SKpiCard title="Managed APs" value={3} meta="2 healthy · 1 warning" />
                <SKpiCard title="Connected Clients" value={63} meta="Across 2.4 / 5 GHz" />
                <SKpiCard title="Avg Channel Util" value="17%" meta="Peak 24% on Ch 36" />
              </div>
              <SCard title="Access Points" padding="none">
                <STable
                  rowKey="id"
                  dataSource={[{ id: '1', name: 'AP-Lobby-01', productSlug: 'eap650', status: 'connected', clients: 42 }]}
                  columns={[
                    {
                      title: 'Device',
                      dataIndex: 'name',
                      key: 'name',
                      render: (text, row) => (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <SProductImage name={row.productSlug} size={28} />
                          <span>{text}</span>
                        </div>
                      ),
                    },
                    {
                      title: 'Status',
                      dataIndex: 'status',
                      key: 'status',
                      render: (v) => <SDeviceStatus status={v} />,
                    },
                    { title: 'Clients', dataIndex: 'clients', key: 'clients' },
                  ]}
                  pagination={false}
                  onRow={(row) => ({ onClick: () => setSelected(row), style: { cursor: 'pointer' } })}
                />
              </SCard>
            </div>
            <SDrawer
              open={Boolean(selected)}
              onClose={() => setSelected(null)}
              size="sm"
              title={selected?.name ?? ''}
            >
              {selected ? <div>Clients connected: {selected.clients}</div> : null}
            </SDrawer>
          </SEmulatorShell>
        );
      }

      OmadaUI.render(
        <OmadaProvider defaultThemeMode="light">
          <DemoApp />
        </OmadaProvider>,
        '#root',
      );
    </script>
  </body>
</html>
```

All 104 Omada exports, `antd`, `AntdIcons`, `React`, `ReactDOM`, `OmadaUI.render`, and Figma assets live on `window.OmadaUI`.

---

## 4. Quick Component Map

- **Theme & Layout**: `OmadaProvider`, `useOmadaTheme`, `SEmulatorShell`, `EMULATOR_NAV_GROUPS`, `SAppShell`, `SPageHeader`
- **Data Display & Tables**: `SCard`, `SKpiCard`, `STable`, `STabs`, `STag`, `SCustomTag`, `SDeviceStatus`, `SDescriptions`, `SCollapse`, `SPortPanel`, `SDevicePortGraphic`, `STopologyCanvas`
- **Charts & Health**: `SLineChart`, `SBarChart`, `SDonutChart`, `SSparkChart`, `SDonutSummaryCard`, `SHealthGauge`, `SHealthRadar`, `SHealthTrendBar`, `SApDistributionRuler`, `SChannelUtilization`, `SDeviceHealthSummary`, `SClientOverviewStrip`, `SCategoryKpiCarousel`
- **Inputs & Settings**: `SButton`, `SInput`, `SSearchInput`, `SPasswordInput`, `SNumberInput`, `STextArea`, `SIpInput`, `SMacInput`, `SSelect`, `SSwitch`, `SSlider`, `SRadio`, `SCheckbox`, `SDatePicker`, `STimePicker`, `SSchedule`, `SForm`, `SFormSection`, `SFormItem`, `SSettingsPageShell`, `SSettingsSection`, `SSettingsRow`, `SSettingsInfoBanner`
- **Feedback & Diagnostics**: `SAlert`, `SModal`, `useOmadaConfirm`, `SDrawer`, `SEmpty`, `useOmadaFeedback`, `STerminalConsole`
- **Bundled Figma Assets**: `SIcon`, `SProductImage`, `SIllustration`, `SClientIcon`, `SBrandAsset`, `SDeviceIcon`, `OmadaLogo`
- **Ant Design 6 Re-exports**: `Row`, `Col`, `Space`, `Badge`, `Popover`, `Tooltip`, `Dropdown`, `Progress`, `Pagination`, `Divider`, `Switch`, `Select`, etc.

---

## 5. Omada v6.3, AntD 6 & Standalone Guardrails

1. **Always wrap with `<OmadaProvider>` once at the root** so Ant Design 6 tokens, `@ant-design/cssinjs` Cascade Layers (`<StyleProvider layer>`), and `--omada-*` CSS variables initialize properly. Never nest multiple providers unnecessarily.
2. **Respect Light/Dark Mode**: Use CSS variables (`var(--omada-bg-surface)`, `var(--omada-text-primary)`, `var(--omada-border-divider)`, `var(--omada-brand)`) instead of hardcoding `#fff` or `#000`. Toggle theme via `const { resolvedTheme, setThemeMode } = useOmadaTheme()`.
3. **Clear the `SEmulatorShell` quick-drawer handle**: When rendering inside `<SEmulatorShell>` with `showQuickDrawerHandle` enabled (default), leave at least `paddingRight: 40` (e.g. `style={{ padding: '20px 44px 24px 24px' }}`) on top-right toolbars and KPI strips so rightmost buttons never sit behind the floating `<||` handle.
4. **Ant Design 6 & Omada Props hygiene**: Use `classNames` / `styles` props on AntD `Drawer`, `Modal`, `Dropdown`, `Popover` (not removed v4/v5 props like `overlayClassName`, `bodyStyle`, `destroyOnClose`). Use `variant="primary" | "secondary" | "outline" | "danger"` on `<SButton>` instead of AntD's `type` prop.
5. **Layout without consumer Tailwind in Mode A**: Single-file HTML demos do NOT run a consumer Tailwind JIT compiler. Prefer `S*` layout components, AntD `Row` / `Col` / `Space` / `Flex`, standard inline `style={{ display: 'grid', gap: 16 }}`, or classes already in `dist/style.css`.
6. **ECharts concrete colors only**: **NEVER pass CSS variable strings (`var(--omada-*)`) to ECharts `color` props (`SLineChart` / `SSparkChart`)** — canvas gradients cannot parse `var(...)` and throw runtime `CanvasGradient.addColorStop` errors. Always pass concrete hex/rgb strings from `omadaChartPalette`, `useOmadaTheme().tokens`, or `omada_catalog_query(action="tokens")`.
7. **Opaque sandboxed iframe hygiene**: Studio `libpreview://` and `canvas.chenge.ink/raw/` render inside sandboxed iframes without `allow-same-origin`. Never call bare `localStorage` / `sessionStorage` / `document.cookie` — always wrap storage access in `try { ... } catch { ... }` with an in-memory fallback.

---

## 6. Mode B Local Vite Fallback (`artifact_build_omada`)

Only when the user requests an offline/no-CDN bundle or custom Tailwind JIT build via `~/Documents/omada-ui-kit`:

1. Export your root component as `export default function Demo()` (or named `export const Demo`).
2. Import from `@/omada`, `antd`, `@ant-design/icons`, `lucide-react`, or `echarts`.
3. Do **not** call `ReactDOM.createRoot` or wrap in `<OmadaProvider>` — the `artifact_build_omada` harness provides those automatically.
4. Keep the same `slug` across revisions so `v1`, `v2`, ... advance cleanly.

---

## 7. Self-Check (`browser_use`) & Cloud Publishing (`artifact_publish_bundle`)

- Both `artifact_write` and `artifact_build_omada` return `version`, `path`, and an ephemeral loopback `local_preview_url` under `agent-docs/artifacts/<slug>/vN/index.html`.
- If `browser_use` tools are active in the session, open `local_preview_url` to confirm zero console errors and verify desktop (`1440x900`) and compact (`390x844`) layouts. On revisions, pass the **exact same `slug`** to produce `v2`, `v3`, ...
- To publish/share to Canvas Artifact Server, **ALWAYS call `artifact_publish_bundle`** (with `slug`, optional `version`, `visibility`, `title`, `change_note`) — never paste HTML into `mcp__artifact_server__artifact_publish`. Return both `share_url` and `review_url` to the user.
