// DESIGN.md §14 #4 — radius > 18px belongs to the Dynamic Island only; the
// rest of the app stays in the rounded-sm/md/lg/xl/2xl ≤ 16px range so the
// "professional instrument" feel stays close to Mimestream/Linear.
//
// Banned tailwind utilities:
//   - rounded-3xl (24px), rounded-full when paired with arbitrary >18px sizes
//   - rounded-[20px] / rounded-[28px] / any arbitrary >18 numeric
// `rounded-full` itself is fine for pills/dots — they're not visual radius
// bloat unless paired with explicit width that flags them as panels.

const RAW_BIG = new Set(['rounded-3xl'])
// Match rounded-[<n>px] / rounded-tl-[<n>px] / etc.
const ARBITRARY = /\brounded(?:-[a-z]+)?-\[(\d+)(px|rem)?\]/g

module.exports = {
  meta: {
    type: 'problem',
    docs: { description: 'Forbid radius > 18px outside Dynamic Island (DESIGN.md §14 #4).' },
    messages: {
      named: 'Radius utility `{{cls}}` exceeds the 18px ceiling — use rounded-sm/md/lg.',
      arbitrary:
        'Radius `rounded-[{{value}}{{unit}}]` exceeds 18px (DESIGN.md §14 #4). Reserved for Dynamic Island.'
    },
    schema: []
  },
  create(context) {
    function check(node, value) {
      for (const big of RAW_BIG) {
        if (value.includes(big)) {
          context.report({ node, messageId: 'named', data: { cls: big } })
        }
      }
      for (const m of value.matchAll(ARBITRARY)) {
        const num = Number(m[1])
        const unit = m[2] ?? 'px'
        const px = unit === 'rem' ? num * 16 : num
        if (px > 18) {
          context.report({
            node,
            messageId: 'arbitrary',
            data: { value: m[1], unit }
          })
        }
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
