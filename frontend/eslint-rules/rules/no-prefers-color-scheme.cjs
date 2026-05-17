// DESIGN.md §17 + §16.6 — the single source of truth for the resolved theme
// is the `data-theme` attribute on <html> driven by appearance.ts; the CSS
// `@media (prefers-color-scheme)` query forms a second source and creates
// state-vs-CSS drift. Block its appearance in any TS/CSS-in-JS string
// literal — the system signal is read once in JS and surfaces as
// `data-theme`, never re-read in stylesheets.

// We only scan string literals + template strings. Stylelint covers actual
// .css files; here we catch the JS/TS shape (e.g. CSS-in-JS, inline styles).
const PATTERN = /@media\s*\(\s*prefers-color-scheme/i

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Forbid @media (prefers-color-scheme) in component code (DESIGN.md §17 + §16.6).'
    },
    messages: {
      media:
        '`@media (prefers-color-scheme)` competes with data-theme SoT — read the system value once in appearance.ts.'
    },
    schema: []
  },
  create(context) {
    function check(node, value) {
      if (PATTERN.test(value)) context.report({ node, messageId: 'media' })
    }
    return {
      Literal(node) {
        if (typeof node.value === 'string') check(node, node.value)
      },
      TemplateElement(node) {
        check(node, node.value?.cooked ?? '')
      }
    }
  }
}
