/**
 * Tailwind v3 is wired through PostCSS (NOT @astrojs/tailwind).
 *
 * Why: on Astro 6 the @astrojs/tailwind integration's peer range stops at
 * astro ^5 (it is deprecated). PostCSS is the supported, version-agnostic way
 * to run Tailwind v3 — and Tailwind v3 is what we want for the product's
 * `rgb(var(--x) / <alpha-value>)` channel-triplet token approach. Tailwind v4
 * changed the config model and would not mirror tailwind.config.ts cleanly.
 *
 * Astro auto-detects this postcss.config.mjs and runs it over every stylesheet
 * (global.css carries the @tailwind directives).
 */
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
