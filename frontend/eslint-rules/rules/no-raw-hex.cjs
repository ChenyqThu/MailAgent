// DESIGN.md §14 #1 — every color in the design system flows through Tailwind
// tokens (`coral` reads `--c-accent`, `ink-*` reads the surface tier). The
// rule applies to renderer code; carve-outs are platform APIs that don't
// participate in the renderer pipeline:
//   - tailwind.config.ts: token definitions themselves
//   - .css: CSS variable seeds (the bootstrap rgb triples)
//   - .gen.ts: codegen output, never hand-edited
//   - src/electron/main/**: Electron BrowserWindow / nativeTheme APIs accept
//     hex literals and have no Tailwind context

const HEX = /#[0-9a-fA-F]{3,8}\b/

const ALLOWED_FILES = [
  /tailwind\.config\.ts$/,
  /\.css$/,
  /\.gen\.ts$/,
  /src\/electron\/main\//
]

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
