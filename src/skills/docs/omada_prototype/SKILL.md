# Omada UI Prototype Playbook (`omada_prototype`)

Build real, compile-tested React + TypeScript product prototypes using the local `omada-ui-kit` component library instead of static mock HTML.

## 1. When to Use `artifact_build_omada` vs `artifact_write`

- **Use `artifact_build_omada`** when designing Omada SDN / cloud controller consoles, device management workflows, multi-tab telemetry pages, drawers/step-modals, or any UI that should reuse real `omada-ui-kit` components and tokens.
- **Use `artifact_write`** for bespoke standalone editorial reports, slide decks, architecture diagrams, or single-file HTML5 visualizations outside Omada's UI system.

## 2. Harness & Auto-Provided Environment

When you pass `code` (saved to `src/demos/<slug>/Demo.tsx`) to `artifact_build_omada`, the build harness automatically wraps your component with:

- `OmadaProvider` (`defaultThemeMode="light"` or `"dark"` per `theme_mode`)
- Manrope webfont (`400`, `500`, `600`, `700`)
- `src/styles/tokens.css` (Tailwind v4 + Omada CSS variables)
- `src/styles/omada-antd-overrides.css` and all `src/styles/modules/*.css` stylesheets
- Vite 8 + React 19 + `@tailwindcss/vite` + `@` alias pointing to `omada-ui-kit/src`

### Component File Requirements

1. Export your root component as `export default function Demo()` (named `export const Demo` is also supported).
2. Do **not** mount `ReactDOM.createRoot` or wrap in another `<OmadaProvider>` (unless intentionally nesting an isolated theme override).
3. Do **not** leave `// TODO` placeholders or broken imports — every symbol imported from `@/omada`, `antd`, `@ant-design/icons`, `lucide-react`, or `echarts` must resolve cleanly at Vite bundle time.

## 3. Core `@/omada` Component Building Blocks

If unsure of an exact prop signature, read `~/Documents/omada-ui-kit/src/omada/index.ts` or `COMPONENTS.md` via local search/read before compiling:

- **Layout & Navigation**: `SAppShell`, `SPageHeader`, `SCard`, `SKpiCard`, `STabs`, `STag`, `SCustomTag`, `SCustomTagDot`, `SButton`
- **Data Display & Visualization**: `STable`, `SLineChart` (built on ECharts), `SIcon`, `SIllustration`, `SProductImage`, `SClientIcon`, `SBrandAsset`
- **Forms & Network Inputs**: `SForm`, `SFormItem`, `SInput`, `SNumberInput`, `SPasswordInput`, `SSearchInput`, `STextArea`, `SIpInput`, `SMacInput`, `SSelect`, `SCascader`, `STreeSelect`, `SCheckbox`, `SRadio`, `SSwitch`, `SSlider`, `SDatePicker`, `SRangePicker`, `STimePicker`, `SColorPicker`, `SSchedule`
- **Overlays**: `SModal`, `SStepModal`, `SDrawer`
- **Theming Hook**: `useOmadaTheme`

## 4. Crafting High-Fidelity Omada Product Prototypes

- **Authentic Domain State**: Populate tables and charts with realistic site names (e.g., `HQ-Core-Switch`, `Floor2-EAP670-West`), valid IPv4/CIDR ranges, MAC addresses (`1C-61-B4-...`), firmware versions, channel utilization percentages, and client counts — grounded in user requirements.
- **Interactive Flows, Not Static Mockups**:
  - Wire `SSearchInput` / `SSelect` / `STabs` filters directly to live filtered table rows and summary KPIs.
  - Wire row clicks to `SDrawer` detail inspectors (radio channels, client RSSI, port PoE budget, quick actions).
  - Use `SStepModal` for multi-step provisioning wizards (SSID setup, VLAN ACL, QoS policy).
- **Theme Hygiene**: Respect Omada tokens (`--omada-brand` `#00A870`, slate ink hierarchy, hairline borders, 8px spacing rhythm) and avoid jarring unstyled raw browser controls.

## 5. Self-Check & Visual Verification with `browser_use`

`artifact_build_omada` returns `version`, `file_count`, `size_bytes`, `build_ms`, `source_demo`, and an ephemeral loopback `local_preview_url`.

If `browser_use` tools are active in the session:
1. Open `local_preview_url` (served over `127.0.0.1` without touching renderer CSP).
2. Verify zero uncaught page/console errors and verify interactive tabs, drawers, tables, and charts render at both desktop (`1440x900`) and compact (`390x844`) viewports.
3. If any visual overlap, clipping, or layout issue appears, edit the `code` and call `artifact_build_omada` with the **same `slug`** to produce `v2`, `v3`, ... cleanly.

## 6. Sharing & Collaboration

- The compiled bundle (`index.html` + `assets/*`) lives in the Workspace Artifacts Studio (`agent-docs/artifacts/<slug>/vN/`) for immediate side-by-side preview in MailAgent.
- The user can click **Publish** in Studio (or ask to publish via the `artifact_server` MCP connector when connected) to upload the entire multi-file bundle to Canvas Artifact Server for external review and versioned comments.
