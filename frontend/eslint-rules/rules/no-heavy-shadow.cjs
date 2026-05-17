// DESIGN.md §14 #6 — shadow-lg / shadow-xl / shadow-2xl are reserved for
// Toast and Dynamic Island components. Everywhere else the surface tiers
// (ink-0..5 + ink-border) carry the depth; heavy shadows compete with the
// hairline + flat aesthetic.
//
// Allowlist: files whose path includes `/Toast` or `/island/` (case-insensitive)
// where the shadow utilities are legitimate. The path test is intentionally
// generous so future re-orgs don't silently break the rule.

const BAD = new Set(['shadow-lg', 'shadow-xl', 'shadow-2xl'])
const ALLOWED_PATH = /(?:\/toast|\/island)/i

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid shadow-lg/xl/2xl outside Toast and Island components (DESIGN.md §14 #6).'
    },
    messages: { heavy: 'Heavy shadow `{{cls}}` — surface tiers should carry depth.' },
    schema: []
  },
  create(context) {
    const filename = context.filename ?? context.getFilename()
    if (ALLOWED_PATH.test(filename)) return {}
    function check(node, value) {
      for (const cls of BAD) {
        // `\b` doesn't treat `-` as word boundary — use explicit edge match.
        const re = new RegExp(`(?:^|[\\s:!])(${cls})(?:$|[\\s:!])`)
        const m = value.match(re)
        if (m) context.report({ node, messageId: 'heavy', data: { cls: m[1] } })
      }
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
