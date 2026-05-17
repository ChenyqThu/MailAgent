// DESIGN.md §14 #5 — no `from-* to-*` gradient backgrounds. The whole design
// system is flat ink + accent pixels; gradients drift into "AI productivity
// SaaS slop" territory. Detect Tailwind gradient utility usage by looking
// for `bg-gradient-to-*` or `from-<color>-<n>` adjacency.

// `bg-gradient-to-tr` etc. — Tailwind's gradient starter
const STARTER = /\bbg-gradient-to-[a-z]+\b/
// `from-{color}-{shade}` / `to-{color}-{shade}` / `via-{color}-{shade}`
const STOPS = /\b(?:from|to|via)-[a-z]+-\d{2,3}\b/

module.exports = {
  meta: {
    type: 'problem',
    docs: { description: 'Forbid Tailwind gradient backgrounds (DESIGN.md §14 #5).' },
    messages: {
      gradient: 'Gradient utility `{{match}}` is banned — flat fills only.'
    },
    schema: []
  },
  create(context) {
    function check(node, value) {
      const starter = value.match(STARTER)
      if (starter) {
        context.report({ node, messageId: 'gradient', data: { match: starter[0] } })
        return
      }
      const stop = value.match(STOPS)
      if (stop) context.report({ node, messageId: 'gradient', data: { match: stop[0] } })
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
