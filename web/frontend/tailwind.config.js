/** @type {import('tailwindcss').Config} */

function cssVar(name) {
  return ({ opacityValue }) => {
    if (opacityValue !== undefined) {
      return `rgb(var(${name}) / ${opacityValue})`;
    }
    return `rgb(var(${name}))`;
  };
}

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          primary: cssVar("--color-bg-primary"),
          secondary: cssVar("--color-bg-secondary"),
          tertiary: cssVar("--color-bg-tertiary"),
          hover: cssVar("--color-bg-hover"),
          active: cssVar("--color-bg-active"),
        },
        fg: {
          primary: cssVar("--color-fg-primary"),
          secondary: cssVar("--color-fg-secondary"),
          tertiary: cssVar("--color-fg-tertiary"),
          muted: cssVar("--color-fg-muted"),
          faint: cssVar("--color-fg-faint"),
        },
        border: cssVar("--color-border"),
        accent: {
          DEFAULT: cssVar("--color-accent"),
          dim: cssVar("--color-accent-dim"),
        },
        status: {
          danger: cssVar("--color-status-danger"),
          warning: cssVar("--color-status-warning"),
          success: cssVar("--color-status-success"),
          info: cssVar("--color-status-info"),
          caution: cssVar("--color-status-caution"),
          purple: cssVar("--color-status-purple"),
        },
        overlay: "var(--color-overlay)",
        "chart-bar": cssVar("--color-chart-bar"),
      },
    },
  },
  plugins: [],
};
