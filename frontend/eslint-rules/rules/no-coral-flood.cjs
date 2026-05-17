// DESIGN.md §14 #8 — coral as a full panel background is banned ("Always
// pixels."). Static analysis can't see element size, so we draw a softer
// line: bare `bg-coral` requires an explicit alpha suffix to act as the
// reviewer-acknowledged opt-in. `bg-coral/15` (pill bg) is fine; the rare
// solid CTA writes `bg-coral/100` to make the choice explicit.
//
// Allowed: bg-coral/<N>, bg-coral-hover (hover state on solid fills),
// bg-coral-dim (disabled / overlay).

const BARE = /\bbg-coral\b(?!\/|\s*-)/

module.exports = {
  meta: {
    type: 'problem',
    docs: { description: 'Forbid raw bg-coral; require explicit alpha (DESIGN.md §14 #8).' },
    messages: {
      bare: 'Bare `bg-coral` reads as a flood fill — use `bg-coral/100` for the one CTA per surface or `bg-coral/<N>` for pills.'
    },
    schema: []
  },
  create(context) {
    function check(node, value) {
      if (BARE.test(value)) context.report({ node, messageId: 'bare' })
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
