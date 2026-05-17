// DESIGN.md §14 rule 1: No raw hex outside tailwind.config.ts / CSS variables.
// Demo rule for Sprint 0 — proves the eslint-plugin-local-rules wiring works.
// Sprint 1 hardens (allow data: URIs, fragment identifiers, kbd colour escapes).

const HEX = /#[0-9a-fA-F]{3,8}\b/

const ALLOWED_FILES = [/tailwind\.config\.ts$/, /\.css$/, /\.gen\.ts$/]

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Forbid raw hex colour literals outside config / CSS files'
    },
    messages: {
      noHex: 'Raw hex colour {{value}} found — route through Tailwind tokens (DESIGN.md §14 #1).'
    },
    schema: []
  },
  create(context) {
    const filename = context.filename ?? context.getFilename()
    if (ALLOWED_FILES.some((re) => re.test(filename))) return {}
    return {
      Literal(node) {
        if (typeof node.value !== 'string') return
        const m = node.value.match(HEX)
        if (!m) return
        context.report({ node, messageId: 'noHex', data: { value: m[0] } })
      }
    }
  }
}
