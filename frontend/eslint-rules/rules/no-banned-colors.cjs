// DESIGN.md §14 #3 — Tailwind default blue/purple/indigo break the coral-led
// palette. Cover both text and background variants (bg-blue-500, text-purple-300,
// ring-indigo-400, border-blue-200, etc.) by checking against the Tailwind
// prefix list — generic enough to also catch hover:bg-blue-500 / focus:text-purple-200.

const BANNED = ['blue', 'purple', 'indigo', 'violet', 'fuchsia']
const PREFIXES = ['bg', 'text', 'border', 'ring', 'from', 'to', 'via', 'shadow', 'fill', 'stroke', 'caret', 'accent']
// e.g. `bg-blue-500`, `hover:text-purple-300`, `dark:ring-indigo-400`. Global
// flag so a single className string with multiple violations reports each one
// (`bg-blue-500 text-purple-300` → two errors).
const PATTERN = new RegExp(
  `(?:^|[\\s:!/])(?:${PREFIXES.join('|')})-(?:${BANNED.join('|')})-\\d+`,
  'gi'
)

module.exports = {
  meta: {
    type: 'problem',
    docs: { description: 'Forbid Tailwind blue/purple/indigo families (DESIGN.md §14 #3).' },
    messages: { banned: 'Banned color family `{{match}}` — route through ink-*, coral, or status tokens.' },
    schema: []
  },
  create(context) {
    function check(node, value) {
      for (const m of value.matchAll(PATTERN)) {
        context.report({ node, messageId: 'banned', data: { match: m[0].trim() } })
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
