// DESIGN.md §14 #2 + §16.6 — text-micro (11px mono) and text-meta (12px mono)
// are English-only by design. CJK at those sizes turns into the banned
// "韩式糊字号" muddiness. We catch the JSX-literal case here — JSX node
// whose className includes one of the mono sizes AND has CJK text as a
// direct child. The deeper case (JSX child is `{t('key')}` whose zh-CN value
// contains CJK) requires resolving the locale JSON; for that we keep this
// rule scoped to the visually obvious literal case and rely on the Sprint
// 1.10 i18n review + visual spot-check to catch the indirect form.

const MONO_CLASSES = ['text-micro', 'text-meta']
const CJK_RANGE = /[　-〿぀-ゟ゠-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/

function getClassNameValue(node) {
  // <span className="text-micro">…</span>
  if (node.value?.type === 'Literal' && typeof node.value.value === 'string')
    return node.value.value
  // <span className={`text-micro ${foo}`}>…</span>
  if (node.value?.type === 'JSXExpressionContainer') {
    const expr = node.value.expression
    if (expr.type === 'TemplateLiteral') {
      return expr.quasis.map((q) => q.value?.cooked ?? '').join(' ')
    }
    if (expr.type === 'Literal' && typeof expr.value === 'string') return expr.value
    // cn('text-micro', …) — pull the string args
    if (expr.type === 'CallExpression') {
      return expr.arguments
        .filter((a) => a.type === 'Literal' && typeof a.value === 'string')
        .map((a) => a.value)
        .join(' ')
    }
  }
  return ''
}

function hasMonoSize(classValue) {
  for (const cls of MONO_CLASSES) {
    const re = new RegExp(`(?:^|\\s)${cls}(?:$|\\s)`)
    if (re.test(classValue)) return cls
  }
  return null
}

function childContainsCjk(child) {
  if (child.type === 'JSXText') return CJK_RANGE.test(child.value)
  if (child.type === 'Literal' && typeof child.value === 'string')
    return CJK_RANGE.test(child.value)
  if (child.type === 'JSXExpressionContainer') {
    const e = child.expression
    if (e.type === 'Literal' && typeof e.value === 'string') return CJK_RANGE.test(e.value)
    if (e.type === 'TemplateLiteral') {
      return e.quasis.some((q) => CJK_RANGE.test(q.value?.cooked ?? ''))
    }
  }
  return false
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Forbid CJK glyphs at text-micro/text-meta sizes (DESIGN.md §14 #2 / §16.6).'
    },
    messages: {
      cjk: 'CJK glyph rendered at `{{cls}}` (11–12px mono) — use text-aux (14px) for CN content.'
    },
    schema: []
  },
  create(context) {
    return {
      JSXOpeningElement(opening) {
        const classNameAttr = opening.attributes.find(
          (a) => a.type === 'JSXAttribute' && a.name?.name === 'className'
        )
        if (!classNameAttr) return
        const value = getClassNameValue(classNameAttr)
        const monoCls = hasMonoSize(value)
        if (!monoCls) return
        const parent = opening.parent
        if (!parent || !parent.children) return
        for (const child of parent.children) {
          if (childContainsCjk(child)) {
            context.report({
              node: child,
              messageId: 'cjk',
              data: { cls: monoCls }
            })
            return
          }
        }
      }
    }
  }
}
