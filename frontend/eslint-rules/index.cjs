// Local ESLint v9 plugin holding the design-system non-negotiables
// (DESIGN.md §14 + §16.6 + §17 — see REVIEW-LOG H-08). Each rule has a
// fixture-test in `eslint-rules/tests/rules.test.cjs` driven by
// ESLint's RuleTester so the rules themselves cannot regress silently.

module.exports = {
  meta: { name: 'mailagent-local-rules', version: '0.1.0' },
  rules: {
    'no-raw-hex': require('./rules/no-raw-hex.cjs'),
    'no-banned-colors': require('./rules/no-banned-colors.cjs'),
    'no-large-radius': require('./rules/no-large-radius.cjs'),
    'no-gradient-bg': require('./rules/no-gradient-bg.cjs'),
    'no-heavy-shadow': require('./rules/no-heavy-shadow.cjs'),
    'no-grayscale-surface': require('./rules/no-grayscale-surface.cjs'),
    'no-coral-flood': require('./rules/no-coral-flood.cjs'),
    'no-cjk-in-mono-size': require('./rules/no-cjk-in-mono-size.cjs'),
    'no-prefers-color-scheme': require('./rules/no-prefers-color-scheme.cjs')
  }
}
