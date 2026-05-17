// DESIGN.md §14 #7 — slate/zinc/neutral/stone Tailwind grays leak the
// default-Tailwind look. Surfaces must use ink-*; foreground text uses
// ink-fg-* ramp. We block bg-/text-/border-/ring- of those families.

const BANNED_FAMILIES = ['slate', 'zinc', 'neutral', 'stone', 'gray']
const PREFIXES = ['bg', 'text', 'border', 'ring', 'from', 'to', 'via', 'fill', 'stroke']
const PATTERN = new RegExp(
  `(?:^|[\\s:!/])(?:${PREFIXES.join('|')})-(?:${BANNED_FAMILIES.join('|')})-\\d+`,
  'i'
)

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Forbid Tailwind slate/zinc/neutral/stone/gray families (DESIGN.md §14 #7).'
    },
    messages: { gray: 'Generic gray `{{match}}` — surfaces use ink-*, fg ramp uses ink-fg-*.' },
    schema: []
  },
  create(context) {
    function check(node, value) {
      const m = value.match(PATTERN)
      if (m) context.report({ node, messageId: 'gray', data: { match: m[0].trim() } })
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
