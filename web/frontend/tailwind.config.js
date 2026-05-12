/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          primary: "#0f0f0f",
          secondary: "#1a1a1a",
          tertiary: "#242424",
          hover: "#2a2a2a",
          active: "#1e2a3a",
        },
        border: "#2e2e2e",
        accent: {
          DEFAULT: "#4a9eff",
          dim: "#1e3a5f",
        },
      },
    },
  },
  plugins: [],
};
