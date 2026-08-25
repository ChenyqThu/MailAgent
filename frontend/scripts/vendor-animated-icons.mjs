#!/usr/bin/env node
// 批量 vendor pqoqubbw/icons（lucide-animated）→ src/shared/components/icons/animated/。
//
//   用法:
//     pnpm icon:vendor                     # 拉上游全量，转换后写入（已存在的仓内版不覆盖）
//     pnpm icon:vendor --source <dir>      # 用本地 checkout（含 icons/ 与 LICENSE）代替 clone
//     pnpm icon:vendor --only bell,rocket  # 只处理指定图标
//     pnpm icon:vendor --dry-run           # 只出报告不落盘
//     pnpm icon:vendor --overwrite         # 连仓内已有的手工改造版一起重写（默认不动）
//     pnpm icon:vendor --json report.json  # 报告落文件
//
// 单图辅助脚本 `pnpm icon:fetch <name>` 保留 —— 它服务「本脚本转换不了、要人工套壳」的
// 那批（见报告的 skipped 段）。
//
// ── 为什么要 codemod 而不是照抄 ───────────────────────────────────────────────
// 上游 467 个文件样板 100% 统一（"use client" + forwardRef + useImperativeHandle +
// useAnimation + 外层 <div>），但动画参数**当场违反本仓 docs/motion-gsap.md §10 红线**：
// 97 个 spring、91 个不写 duration（吃 motion 默认 = spring）、45 个 repeat: Infinity
// （常驻 rAF，与 DESIGN.md §8 克制哲学冲突）、77 个 duration > 0.8s。所以转换是必须的：
//   1. 剥壳：forwardRef / useAnimation / useImperativeHandle / handleMouseEnter / 外层 div
//      / cn / HTMLAttributes / XxxIconHandle 全删，统一套 IconShell（触发走 Context，
//      理由见 ../src/shared/components/icons/AnimatedIcon.tsx 头注）。
//   2. spring（type/stiffness/damping/mass/bounce）→ 显式 tween + ICON_EASE。
//   3. 每个 animate variant 都补显式 transition —— IconShell 的 transition 挂在
//      motion.svg 上**不会 cascade 给子 motion.path**，不补就是静默吃 motion 默认 spring。
//   4. repeat/repeatType/repeatDelay 一律删（无限循环 → 单次播放）。
//   5. duration > 0.8s 收敛到 0.6s；ease 一律 ICON_EASE。
//
// ── 🔴 抽取失败必须红，不许「部分抽取」 ────────────────────────────────────────
// 任何一步认不出的文件**整份跳过**并进报告，绝不半转半留：一个「装着动画其实不动」的图标
// 比缺这个图标毒得多（没有任何闸抓得到它）。跳过的常见原因：上游用 useState /
// AnimatePresence / <defs>、多阶段 variant 标签无法机械映射、svg 非 24 网格。
// 生成后还会对每个产物自查三道红线（spring / repeat:Infinity / duration>0.8），
// 命中即判失败不落盘 —— 与 tests/shared/animatedIconsDiscipline.test.ts 同一套判据。

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import prettier from 'prettier'
import tsMod from 'typescript'

const ts = tsMod.default ?? tsMod

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(ROOT, 'src/shared/components/icons/animated')
const UPSTREAM_REPO = 'https://github.com/pqoqubbw/icons.git'

/** 图标级微交互默认时长，与 AnimatedIcon.tsx 的 ICON_DUR 同值。 */
const DEFAULT_DUR = 0.4
/** 三道闸之一：产物里任何 duration 不得超过它。 */
const MAX_DUR = 0.8
/** 超出上限时收敛到的值（研究结论 0.4–0.6 区间的上沿）。 */
const CLAMP_DUR = 0.6
/** 合成多阶段关键帧（上游 await 序列）时用的时长。 */
const SEQ_DUR = 0.5
/** 机器生成标记 —— 重跑时据它区分「可覆盖的生成物」与「人工改造版」。 */
const GENERATED_MARKER = '由 scripts/vendor-animated-icons.mjs 机器生成'

/** spring 专属参数：转 tween 时必须删掉（留着 motion 会当 spring 用）。 */
const SPRING_KEYS = new Set(['stiffness', 'damping', 'mass', 'bounce', 'velocity', 'restDelta', 'restSpeed'])
/** 循环参数：一律删（§8 克制哲学 + 常驻 rAF）。 */
const REPEAT_KEYS = new Set(['repeat', 'repeatType', 'repeatDelay'])
/** 根 svg 上由 IconShell 统一提供、直接丢弃的属性。 */
const ROOT_DROP_ATTRS = new Set([
  'fill',
  'height',
  'width',
  'stroke',
  'strokeWidth',
  'strokeLinecap',
  'strokeLinejoin',
  'viewBox',
  'xmlns',
  'animate',
  'initial'
])

// ─────────────────────────────── 通用小工具 ───────────────────────────────

const toPascal = (s) =>
  s
    .split('-')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('')

function parseArgs(argv) {
  const args = { only: null, source: null, dryRun: false, overwrite: false, json: null }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--dry-run') args.dryRun = true
    else if (a === '--overwrite') args.overwrite = true
    else if (a === '--source') args.source = argv[++i]
    else if (a === '--only') args.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--json') args.json = argv[++i]
    else throw new Error(`未知参数: ${a}`)
  }
  return args
}

/** 拉上游到临时目录（浅 clone）。返回 { dir, commit }。 */
function fetchUpstream(source) {
  if (source) {
    const dir = path.resolve(source)
    if (!fs.existsSync(path.join(dir, 'icons'))) throw new Error(`--source 下没有 icons/: ${dir}`)
    let commit = 'unknown'
    try {
      commit = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    } catch {
      /* 本地目录不是 git 仓库时保持 unknown */
    }
    return { dir, commit }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucide-animated-'))
  console.log(`→ clone ${UPSTREAM_REPO} …`)
  execFileSync('git', ['clone', '--depth', '1', UPSTREAM_REPO, dir], { stdio: 'inherit' })
  const commit = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  return { dir, commit }
}

// ─────────────────── 对象模型：够用的 AST → 可改写 → 打印 ───────────────────
//
// 只建模「需要改写」的形状（对象 / (i) => ({...}) 的 TargetResolver），其余原样带上
// 源码文本（raw）。这样既能精确改 transition，又不会把 `index === 0 ? 1 : 0` 这类
// 表达式重写坏。

function modelOf(node, sf) {
  if (ts.isObjectLiteralExpression(node)) {
    return {
      k: 'obj',
      entries: node.properties.map((p) => {
        if (ts.isPropertyAssignment(p)) {
          const keyText = p.name.getText(sf)
          return {
            kind: 'prop',
            key: keyText.replace(/^['"]|['"]$/g, ''),
            keyText,
            value: modelOf(p.initializer, sf)
          }
        }
        if (ts.isSpreadAssignment(p)) {
          return {
            kind: 'spread',
            text: p.getText(sf),
            ref: ts.isIdentifier(p.expression) ? p.expression.text : null
          }
        }
        return { kind: 'other', text: p.getText(sf) }
      })
    }
  }
  if (ts.isArrowFunction(node)) {
    const body = ts.isParenthesizedExpression(node.body) ? node.body.expression : node.body
    if (ts.isObjectLiteralExpression(body)) {
      return {
        k: 'resolver',
        params: node.parameters.map((p) => p.getText(sf)).join(', '),
        body: modelOf(body, sf)
      }
    }
    // 带块体的 TargetResolver（`(i) => { const d = …; return {…} }`，grip 家族）：
    // 前后原样带走，只把 return 的对象接进模型 —— 否则里面的 spring / 超长 duration
    // 全都摸不到（自查会红，整份被跳过）。
    if (ts.isBlock(body)) {
      const returns = body.statements.filter(ts.isReturnStatement)
      const obj = returns.length === 1 ? returns[0].expression : null
      if (obj && ts.isObjectLiteralExpression(obj)) {
        const base = node.getStart(sf)
        const text = node.getText(sf)
        return {
          k: 'wrap',
          pre: text.slice(0, obj.getStart(sf) - base),
          body: modelOf(obj, sf),
          post: text.slice(obj.getEnd() - base)
        }
      }
    }
  }
  return { k: 'raw', text: node.getText(sf) }
}

function printModel(m) {
  if (m.k === 'raw') return m.text
  if (m.k === 'resolver') return `(${m.params}) => (${printModel(m.body)})`
  if (m.k === 'wrap') return `${m.pre}${printModel(m.body)}${m.post}`
  const parts = m.entries.map((e) =>
    e.kind === 'prop' ? `${e.keyText}: ${printModel(e.value)}` : e.text
  )
  return `{ ${parts.join(', ')} }`
}

const propEntry = (m, key) =>
  m.k === 'obj' ? m.entries.find((e) => e.kind === 'prop' && e.key === key) ?? null : null
const propValue = (m, key) => propEntry(m, key)?.value ?? null
const hasSpread = (m) => m.k === 'obj' && m.entries.some((e) => e.kind === 'spread')
const objKeys = (m) =>
  m.k === 'obj' ? m.entries.filter((e) => e.kind === 'prop').map((e) => e.key) : []

function ensureProp(m, key, rawText) {
  if (propEntry(m, key)) return
  m.entries.push({ kind: 'prop', key, keyText: key, value: { k: 'raw', text: rawText } })
}

const tweenModel = (duration) => ({
  k: 'obj',
  entries: [
    { kind: 'prop', key: 'type', keyText: 'type', value: { k: 'raw', text: `'tween' as const` } },
    { kind: 'prop', key: 'duration', keyText: 'duration', value: { k: 'raw', text: String(duration) } },
    { kind: 'prop', key: 'ease', keyText: 'ease', value: { k: 'raw', text: 'ICON_EASE' } }
  ]
})

/**
 * 每份文件里的数值常量（`const DURATION = 0.3`），用来把 `duration: DURATION * 2`
 * 这类表达式算成真数字 —— 产物里 duration 一律落成字面量，闸才验得动上界（一个
 * 算不出的表达式 = 上界形同虚设）。
 */
let numericConsts = new Map()

/** 表达式 → 数字；认不出返回 null（调用方回落默认时长）。 */
function numericValue(text) {
  const expr = text.trim()
  const substituted = expr.replace(/[A-Za-z_$][\w$]*/g, (id) =>
    numericConsts.has(id) ? String(numericConsts.get(id)) : ' '
  )
  if (!/^[\d.+\-*/() ]+$/.test(substituted)) return null
  try {
    // eslint-disable-next-line no-new-func -- 上一行已把字符集限死在数字与四则运算
    const v = Function(`return (${substituted})`)()
    return Number.isFinite(v) ? v : null
  } catch {
    return null
  }
}

/** transition 对象归一：spring→tween、去循环、补 duration/ease、收敛超长时长。 */
function fixTransition(m, stats) {
  if (m.k !== 'obj') return m
  const kept = []
  let sawSpring = false
  for (const e of m.entries) {
    if (e.kind !== 'prop') {
      kept.push(e)
      continue
    }
    if (SPRING_KEYS.has(e.key)) {
      sawSpring = true
      continue
    }
    if (REPEAT_KEYS.has(e.key)) {
      if (e.key === 'repeat') stats.repeat += 1
      continue
    }
    if (e.key === 'type') {
      const t = e.value.k === 'raw' ? e.value.text.replace(/['"]/g, '') : ''
      if (t !== 'tween') sawSpring = sawSpring || t === 'spring' || t === 'inertia'
      kept.push({ ...e, value: { k: 'raw', text: `'tween' as const` } })
      continue
    }
    if (e.key === 'ease') {
      if (e.value.k !== 'raw' || e.value.text !== 'ICON_EASE') stats.ease += 1
      kept.push({ ...e, value: { k: 'raw', text: 'ICON_EASE' } })
      continue
    }
    if (e.key === 'duration') {
      const n = e.value.k === 'raw' ? numericValue(e.value.text) : null
      // 算不出的表达式（`1.05 + index * 0.06` 这类循环错峰）一律回落默认时长：循环
      // 本身已经被删掉，逐帧变速没有了消费点，留着只会让上界没法验。
      const value = n === null ? DEFAULT_DUR : n > MAX_DUR ? CLAMP_DUR : n
      if (n === null || n > MAX_DUR) stats.clamped += 1
      kept.push({ ...e, value: { k: 'raw', text: String(value) } })
      continue
    }
    // 逐属性子 transition（`opacity: { duration: 0.1 }`）同样归一。
    kept.push(e.value.k === 'obj' ? { ...e, value: fixTransition(e.value, stats) } : e)
  }
  if (sawSpring) stats.spring += 1
  const out = { k: 'obj', entries: kept }
  ensureProp(out, 'type', `'tween' as const`)
  if (!propEntry(out, 'duration')) stats.durationAdded += 1
  ensureProp(out, 'duration', String(DEFAULT_DUR))
  ensureProp(out, 'ease', 'ICON_EASE')
  return out
}

/** 单个 variant 目标（normal / animate 的值）归一。needsTransition=false 时不补。 */
function fixVariantTarget(m, stats, needsTransition) {
  if (m.k === 'resolver' || m.k === 'wrap') {
    m.body = fixVariantTarget(m.body, stats, needsTransition)
    return m
  }
  if (m.k !== 'obj') return m
  const tr = propEntry(m, 'transition')
  if (tr) tr.value = fixTransition(tr.value, stats)
  else if (needsTransition && !hasSpread(m)) {
    stats.transitionAdded += 1
    m.entries.push({
      kind: 'prop',
      key: 'transition',
      keyText: 'transition',
      value: tweenModel(DEFAULT_DUR)
    })
  }
  return m
}

/**
 * 能不能进关键帧数组：标量（含 `index === 0 ? 1 : 0` 这类表达式）可以，已经是
 * 数组 / 对象 / 函数的不行 —— 那些是嵌套关键帧或子 transition，压进去会静默变形。
 */
const isKeyframeable = (v) =>
  Boolean(v) && v.k === 'raw' && !/^[[{]/.test(v.text.trim()) && !v.text.includes('=>')

/**
 * variant 标签映射：本仓 IconShell 只认 normal / animate 两个标签（controls 作为
 * variant root 递归下发），上游有 415 个文件天生就是这两个，其余靠 useImperativeHandle
 * 里 startAnimation / stopAnimation 实际 start 的标签名反推 —— 那是「哪个是 hover 态、
 * 哪个是静止态」的第一手证据，不是猜。
 */
function decideMapping(keys, rest, phases) {
  const K = keys.filter((k) => k !== undefined)
  if (K.every((k) => k === 'normal' || k === 'animate')) return { mode: 'identity' }
  const set = new Set(K)
  const restLabel =
    rest && set.has(rest)
      ? rest
      : ['normal', 'visible', 'initial', 'default'].find((c) => set.has(c)) ?? null
  if (!restLabel) return { mode: 'bail', reason: `variant 标签 ${K.join('/')} 认不出静止态` }
  let seq = (phases ?? []).filter((l) => set.has(l))
  if (seq.length === 0) {
    const others = K.filter((k) => k !== restLabel)
    if (others.length !== 1)
      return { mode: 'bail', reason: `variant 标签 ${K.join('/')} 无法机械映射到 normal/animate` }
    // 上游是「静止 → other → 回静止」的两段式（fadeOut/fadeIn、hidden/visible）。
    seq = [others[0], restLabel]
  }
  if (seq.length === 1) return { mode: 'rename', rest: restLabel, animate: seq[0] }
  return { mode: 'keyframes', rest: restLabel, phases: seq }
}

/**
 * 把上游的多阶段 await 序列（`start("fadeOut")` → `start("fadeIn")`）压成一条
 * animate 关键帧：[静止值, 阶段1, 阶段2…]。IconShell 只有 normal/animate 两个标签，
 * 序列本身在剥壳时消失了，不压就等于把动画丢了。
 */
function synthesizeKeyframes(m, restLabel, phaseLabels, stats) {
  const rest = propValue(m, restLabel)
  if (!rest || rest.k !== 'obj') return null
  // 阶段可能是 TargetResolver（`fadeIn: (i) => ({…})`，per-index 错峰）：拆出参数，
  // 合成出来的 animate 也做成同参数的 resolver，delay 表达式才还引用得到。
  let params = null
  const phases = []
  for (const label of phaseLabels) {
    const raw = propValue(m, label)
    if (!raw) return null
    if (raw.k === 'resolver') {
      params = params ?? raw.params
      phases.push(raw.body)
    } else if (raw.k === 'obj') phases.push(raw)
    else return null
  }
  const keys = new Set()
  for (const src of [rest, ...phases])
    for (const e of src.entries) {
      if (e.kind !== 'prop') return null
      if (e.key !== 'transition') keys.add(e.key)
    }
  const animate = { k: 'obj', entries: [] }
  for (const key of keys) {
    const base = propValue(rest, key)
    const seq = [base, ...phases.map((p) => propValue(p, key) ?? base)]
    if (!seq.every(isKeyframeable)) return null
    animate.entries.push({
      kind: 'prop',
      key,
      keyText: key,
      value: { k: 'raw', text: `[${seq.map((v) => v.text.trim()).join(', ')}]` }
    })
  }
  if (animate.entries.length === 0) return null
  const transition = tweenModel(SEQ_DUR)
  // 阶段自带的 delay（多为 `i * 0.1` 的错峰）留下来 —— 它是动画形状的一部分。
  for (const p of phases) {
    const delay = propValue(propValue(p, 'transition') ?? { k: 'raw', text: '' }, 'delay')
    if (delay && isKeyframeable(delay)) ensureProp(transition, 'delay', delay.text.trim())
  }
  animate.entries.push({ kind: 'prop', key: 'transition', keyText: 'transition', value: transition })
  const normal = { k: 'obj', entries: rest.entries.filter((e) => e.key !== 'transition') }
  stats.synthesized += 1
  return {
    k: 'obj',
    entries: [
      { kind: 'prop', key: 'normal', keyText: 'normal', value: normal },
      {
        kind: 'prop',
        key: 'animate',
        keyText: 'animate',
        value: params ? { k: 'resolver', params, body: animate } : animate
      }
    ]
  }
}

/** 整个 variants 对象归一（标签映射 + 各 target 的 transition 归一）。 */
function transformVariants(model, labels, stats, hasElementTransition) {
  if (model.k !== 'obj') return { ok: false, reason: 'variants 不是对象字面量' }
  const keys = objKeys(model)
  const decision = decideMapping(keys, labels.rest, labels.phases)
  if (decision.mode === 'bail') return { ok: false, reason: decision.reason }
  if (decision.mode !== 'identity' && hasSpread(model))
    return { ok: false, reason: 'variants 带 spread 且标签需重映射' }

  if (decision.mode === 'identity') {
    for (const e of model.entries) {
      if (e.kind !== 'prop') continue
      e.value = fixVariantTarget(e.value, stats, e.key === 'animate' && !hasElementTransition)
    }
    return { ok: true, model }
  }
  if (decision.mode === 'rename') {
    const rest = propValue(model, decision.rest)
    const animate = propValue(model, decision.animate)
    if (!rest || !animate) return { ok: false, reason: '重命名标签时取不到 variant 目标' }
    stats.renamed += 1
    const out = {
      k: 'obj',
      entries: [
        {
          kind: 'prop',
          key: 'normal',
          keyText: 'normal',
          value: fixVariantTarget(rest, stats, false)
        },
        {
          kind: 'prop',
          key: 'animate',
          keyText: 'animate',
          value: fixVariantTarget(animate, stats, !hasElementTransition)
        }
      ]
    }
    return { ok: true, model: out }
  }
  const out = synthesizeKeyframes(model, decision.rest, decision.phases, stats)
  if (!out) return { ok: false, reason: '多阶段序列含非字面量值，压不成关键帧' }
  return { ok: true, model: out }
}

// ─────────────────────────────── 单文件转换 ───────────────────────────────

/**
 * 读出每个 controls 的 variant 标签：hover 时 start 哪个、离开时回哪个。
 *
 * 这是「哪个标签是 hover 态、哪个是静止态」的第一手证据（不是猜）。取证顺序：
 * useImperativeHandle 的 startAnimation / stopAnimation → 同名局部函数 →
 * handleMouseEnter / handleMouseLeave；调到局部函数时**跟进去一层**（上游常把序列
 * 写在 runPathIntro / startAll 这类 helper 里，只看 handler 会漏掉整段序列）。
 */
function readHandlerLabels(sf) {
  const locals = new Map()
  const collectLocals = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      locals.set(n.name.text, n.initializer)
    }
    ts.forEachChild(n, collectLocals)
  }
  collectLocals(sf)

  const collect = (node, into, seen) => {
    const walk = (n) => {
      if (ts.isCallExpression(n)) {
        const callee = n.expression
        if (
          ts.isPropertyAccessExpression(callee) &&
          callee.name.text === 'start' &&
          ts.isIdentifier(callee.expression)
        ) {
          const arg = n.arguments[0]
          const list = into.get(callee.expression.text) ?? []
          list.push(arg && ts.isStringLiteralLike(arg) ? arg.text : null)
          into.set(callee.expression.text, list)
        } else if (ts.isIdentifier(callee) && locals.has(callee.text) && !seen.has(callee.text)) {
          collect(locals.get(callee.text), into, new Set([...seen, callee.text]))
        }
      }
      ts.forEachChild(n, walk)
    }
    walk(node)
  }

  const handleProps = new Map()
  const visit = (n) => {
    if (ts.isPropertyAssignment(n)) handleProps.set(n.name.getText(sf), n.initializer)
    ts.forEachChild(n, visit)
  }
  visit(sf)

  const readFrom = (names) => {
    for (const name of names) {
      for (const node of [handleProps.get(name), locals.get(name)]) {
        if (!node) continue
        const into = new Map()
        collect(node, into, new Set([name]))
        if (into.size > 0) return into
      }
    }
    return new Map()
  }
  return {
    start: readFrom(['startAnimation', 'handleMouseEnter']),
    stop: readFrom(['stopAnimation', 'handleMouseLeave'])
  }
}

function convertIcon({ name, src, exportName }) {
  const stats = {
    spring: 0,
    repeat: 0,
    clamped: 0,
    ease: 0,
    durationAdded: 0,
    transitionAdded: 0,
    renamed: 0,
    synthesized: 0
  }
  const bail = (reason) => ({ ok: false, name, reason })
  const sf = ts.createSourceFile(`${name}.tsx`, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

  numericConsts = new Map()
  const collectNumbers = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const v = Number(n.initializer.getText(sf))
      if (Number.isFinite(v)) numericConsts.set(n.name.text, v)
    }
    ts.forEachChild(n, collectNumbers)
  }
  collectNumbers(sf)

  if (/AnimatePresence|useState|useEffect|useMemo|useTime|useTransform|<defs/.test(src))
    return bail('上游用了 state / AnimatePresence / <defs>，需人工套壳')

  // 组件本体（forwardRef 的第一个参数）。
  let comp = null
  const consts = [] // { name, typeText, node(初始化表达式), stmt }
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue
    for (const d of st.declarationList.declarations) {
      const init = d.initializer
      if (!init) continue
      if (ts.isCallExpression(init) && init.expression.getText(sf) === 'forwardRef') {
        comp = init.arguments[0]
      } else {
        consts.push({
          name: d.name.getText(sf),
          typeText: d.type ? d.type.getText(sf) : null,
          init
        })
      }
    }
  }
  if (!comp || !ts.isArrowFunction(comp) || !ts.isBlock(comp.body))
    return bail('认不出 forwardRef 组件形状')

  // 组件体里的局部 const（笑脸家族的 faceVariants 等）——非 hook 的一律上提到模块级。
  for (const st of comp.body.statements) {
    if (!ts.isVariableStatement(st)) continue
    for (const d of st.declarationList.declarations) {
      const init = d.initializer
      if (!init) continue
      const head = init.getText(sf).split('(')[0]
      if (/^use[A-Z]/.test(head)) continue
      consts.push({ name: d.name.getText(sf), typeText: d.type ? d.type.getText(sf) : null, init })
    }
  }

  // 根 svg。
  let root = null
  const findRoot = (n) => {
    if (root) return
    if (ts.isJsxElement(n)) {
      const tag = n.openingElement.tagName.getText(sf)
      if (tag === 'svg' || tag === 'motion.svg') {
        root = n
        return
      }
    }
    ts.forEachChild(n, findRoot)
  }
  findRoot(comp)
  if (!root) return bail('找不到根 svg（上游可能整份是静态图标）')

  const handler = readHandlerLabels(sf)
  const allControls = new Set([...handler.start.keys(), ...handler.stop.keys()])
  const labelsFor = (ctrl) => {
    const key = ctrl ?? (allControls.size === 1 ? [...allControls][0] : null)
    if (!key) return { rest: null, phases: null }
    const startList = handler.start.get(key) ?? null
    return {
      rest: (handler.stop.get(key) ?? []).find((l) => l) ?? null,
      phases: startList && startList.every((l) => l) ? startList : null
    }
  }

  // 根属性 → IconShell props。
  let svgVariants = null
  let svgTransition = null
  let svgStyle = null
  const transitionConsts = new Set()
  // `transition: SOME_CONST` —— 上游也会把过渡抽成模块级常量再从 variants 里引用
  // （rabbit 的 `transition: TRANSITION`）。这类引用点不在 JSX 属性上，不先收集就
  // 会走到下面的「原样带过来」分支：spring / 超长时长有产物自查兜底，但 `ease` 没有
  // 闸 —— 结果是一份看着转好了、曲线却还是上游 cubic-bezier 的文件（半转半留）。
  const collectTransitionRefs = (n) => {
    if (
      ts.isPropertyAssignment(n) &&
      n.name.getText(sf).replace(/^['"]|['"]$/g, '') === 'transition' &&
      ts.isIdentifier(n.initializer)
    ) {
      transitionConsts.add(n.initializer.text)
    }
    ts.forEachChild(n, collectTransitionRefs)
  }
  collectTransitionRefs(sf)
  const constUsage = new Map() // variants 常量名 → [{ ctrl, hasTransition }]
  // 先取根 svg 的 controls 名（下面会把 animate 属性丢掉，标签映射还得靠它）。
  let rootCtrl = null
  for (const attr of root.openingElement.attributes.properties) {
    if (!ts.isJsxAttribute(attr) || attr.name.getText(sf) !== 'animate') continue
    const e = attr.initializer && ts.isJsxExpression(attr.initializer) ? attr.initializer.expression : null
    if (e && ts.isIdentifier(e)) rootCtrl = e.text
  }
  for (const attr of root.openingElement.attributes.properties) {
    if (!ts.isJsxAttribute(attr)) return bail('根 svg 上有 spread 属性')
    const an = attr.name.getText(sf)
    const initTxt = attr.initializer ? attr.initializer.getText(sf) : ''
    const exprOf = () =>
      attr.initializer && ts.isJsxExpression(attr.initializer) ? attr.initializer.expression : null
    if (an === 'viewBox' && !/"0 0 24 24"/.test(initTxt)) return bail(`根 svg 非 24 网格: ${initTxt}`)
    if (an === 'fill' && !/"none"/.test(initTxt)) return bail(`根 svg fill=${initTxt}（非描边图标）`)
    if (ROOT_DROP_ATTRS.has(an)) continue
    if (an === 'variants') {
      const e = exprOf()
      if (!e) return bail('根 svg 的 variants 认不出')
      svgVariants = ts.isIdentifier(e) ? { ref: e.text } : { model: modelOf(e, sf) }
      continue
    }
    if (an === 'transition') {
      const e = exprOf()
      if (!e) return bail('根 svg 的 transition 认不出')
      if (ts.isIdentifier(e)) transitionConsts.add(e.text)
      svgTransition = fixTransition(modelOf(e, sf), stats)
      continue
    }
    if (an === 'style') {
      const e = exprOf()
      if (!e) return bail('根 svg 的 style 认不出')
      svgStyle = modelOf(e, sf)
      continue
    }
    if (an === 'className') {
      if (!/overflow-visible/.test(initTxt)) return bail(`根 svg 有未知 className=${initTxt}`)
      svgStyle = svgStyle ?? { k: 'obj', entries: [] }
      ensureProp(svgStyle, 'overflow', `'visible'`)
      continue
    }
    if (an === 'overflow') {
      svgStyle = svgStyle ?? { k: 'obj', entries: [] }
      ensureProp(svgStyle, 'overflow', `'visible'`)
      continue
    }
    return bail(`根 svg 有未知属性 ${an}`)
  }
  if (svgVariants?.ref) {
    constUsage.set(svgVariants.ref, [{ ctrl: rootCtrl, hasTransition: Boolean(svgTransition) }])
  } else if (svgVariants) {
    const res = transformVariants(svgVariants.model, labelsFor(rootCtrl), stats, Boolean(svgTransition))
    if (!res.ok) return bail(`根 svg variants: ${res.reason}`)
    svgVariants.model = res.model
  }

  // 子元素：删 animate/initial，改写 variants / transition。
  const edits = []
  let childFail = null
  for (const child of root.children) {
    const walk = (n) => {
      if (childFail) return
      if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
        const attrs = n.attributes.properties
        const ctrlAttr = attrs.find((a) => ts.isJsxAttribute(a) && a.name.getText(sf) === 'animate')
        const ctrlExpr =
          ctrlAttr && ts.isJsxAttribute(ctrlAttr) && ctrlAttr.initializer && ts.isJsxExpression(ctrlAttr.initializer)
            ? ctrlAttr.initializer.expression
            : null
        const ctrl = ctrlExpr && ts.isIdentifier(ctrlExpr) ? ctrlExpr.text : null
        const hasTransition = attrs.some(
          (a) => ts.isJsxAttribute(a) && a.name.getText(sf) === 'transition'
        )
        for (const a of attrs) {
          if (!ts.isJsxAttribute(a)) continue
          const an = a.name.getText(sf)
          if (an === 'animate' || an === 'initial') {
            edits.push({ start: a.getStart(sf), end: a.getEnd(), text: '' })
            continue
          }
          const expr =
            a.initializer && ts.isJsxExpression(a.initializer) ? a.initializer.expression : null
          if (an === 'transition' && expr) {
            if (ts.isIdentifier(expr)) {
              transitionConsts.add(expr.text)
              continue
            }
            edits.push({
              start: expr.getStart(sf),
              end: expr.getEnd(),
              text: printModel(fixTransition(modelOf(expr, sf), stats))
            })
            continue
          }
          if (an === 'variants' && expr) {
            if (ts.isIdentifier(expr)) {
              const list = constUsage.get(expr.text) ?? []
              list.push({ ctrl, hasTransition })
              constUsage.set(expr.text, list)
              continue
            }
            const res = transformVariants(modelOf(expr, sf), labelsFor(ctrl), stats, hasTransition)
            if (!res.ok) {
              childFail = res.reason
              return
            }
            edits.push({ start: expr.getStart(sf), end: expr.getEnd(), text: printModel(res.model) })
          }
        }
      }
      ts.forEachChild(n, walk)
    }
    walk(child)
  }
  if (childFail) return bail(childFail)

  // 模块级 const：variants 常量按使用点的 controls 归一，其余原样带过来。
  const constTexts = new Map()
  for (const c of consts) {
    const usages = constUsage.get(c.name) ?? []
    let text
    if (usages.length > 0 && ts.isObjectLiteralExpression(c.init)) {
      // 同一份 variants 被多个 controls 引用时，只要各自解析出的标签一致就没有歧义
      // （instagram / dribbble 这类「多个 controls 都跑 animate/normal」是常态）。
      const resolved = usages.map((u) => labelsFor(u.ctrl))
      const fingerprint = new Set(resolved.map((l) => `${l.rest}|${(l.phases ?? []).join(',')}`))
      if (fingerprint.size > 1)
        return bail(`variants 常量 ${c.name} 被多个 controls 用出不同标签，映射有歧义`)
      const res = transformVariants(
        modelOf(c.init, sf),
        resolved[0],
        stats,
        usages.every((u) => u.hasTransition)
      )
      if (!res.ok) return bail(`${c.name}: ${res.reason}`)
      text = printModel(res.model)
    } else if (
      ts.isObjectLiteralExpression(c.init) &&
      (transitionConsts.has(c.name) || propEntry(modelOf(c.init, sf), 'transition'))
    ) {
      // DEFAULT_TRANSITION 之类：整块按 transition 归一（内部还可能裹一层 { transition: … }）。
      const m = modelOf(c.init, sf)
      const inner = propEntry(m, 'transition')
      if (inner) inner.value = fixTransition(inner.value, stats)
      text = printModel(inner ? m : fixTransition(m, stats))
    } else if (ts.isArrowFunction(c.init)) {
      text = annotateArrowReturn(c.init, sf)
      if (!text) return bail(`辅助函数 ${c.name} 的返回类型推不出来（lint 要显式返回类型）`)
    } else {
      text = c.init.getText(sf)
    }
    constTexts.set(c.name, `const ${c.name}${c.typeText ? `: ${c.typeText}` : ''} = ${text}`)
  }

  // 子元素文本（含改写）。
  const region = applyEdits(
    sf.text,
    root.openingElement.getEnd(),
    root.closingElement.getStart(sf),
    edits
  )

  // 只留被引用到的 const（CUSTOM_EASING 这类被 ICON_EASE 顶掉后就该消失）。
  const svgVariantsText = svgVariants ? (svgVariants.ref ?? printModel(svgVariants.model)) : ''
  const svgProps = [
    svgVariantsText,
    svgTransition ? printModel(svgTransition) : '',
    svgStyle ? printModel(svgStyle) : ''
  ].join('\n')
  const kept = []
  let scan = `${region}\n${svgProps}`
  let changed = true
  while (changed) {
    changed = false
    for (const c of consts) {
      if (kept.includes(c.name)) continue
      if (new RegExp(`\\b${c.name}\\b`).test(scan)) {
        kept.push(c.name)
        scan += `\n${constTexts.get(c.name)}`
        changed = true
      }
    }
  }
  const constBlock = consts
    .filter((c) => kept.includes(c.name))
    .map((c) => constTexts.get(c.name))
    .join('\n\n')

  // 出口。
  const body = `${region}${svgProps}${constBlock}`
  const needsMotion = /\bmotion\./.test(body)
  const needsVariants = /:\s*Variants\b/.test(constBlock)
  const needsTransitionType = /:\s*Transition\b/.test(constBlock)
  const needsEase = /\bICON_EASE\b/.test(body)

  const motionImport = needsMotion
    ? `import { motion${needsVariants ? ', type Variants' : ''}${
        needsTransitionType ? ', type Transition' : ''
      } } from 'motion/react'\n`
    : needsVariants || needsTransitionType
      ? `import type { ${[needsVariants ? 'Variants' : null, needsTransitionType ? 'Transition' : null]
          .filter(Boolean)
          .join(', ')} } from 'motion/react'\n`
      : ''

  const shellProps = [
    '{...props}',
    svgVariants ? `svgVariants={${svgVariantsText}}` : null,
    svgTransition ? `svgTransition={${printModel(svgTransition)}}` : null,
    svgStyle ? `svgStyle={${printModel(svgStyle)}}` : null
  ]
    .filter(Boolean)
    .join(' ')

  const notes = []
  if (stats.spring) notes.push(`spring→tween ×${stats.spring}`)
  if (stats.transitionAdded || stats.durationAdded)
    notes.push(`补显式 transition/duration ×${stats.transitionAdded + stats.durationAdded}`)
  if (stats.repeat) notes.push(`去 repeat 循环 ×${stats.repeat}`)
  if (stats.clamped) notes.push(`时长收敛 ×${stats.clamped}`)
  if (stats.renamed) notes.push('variant 标签重命名')
  if (stats.synthesized) notes.push('多阶段序列压成关键帧')

  const code = stripSparseHoles(`// lucide-animated · ${name}。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 ${GENERATED_MARKER}，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell${notes.length ? `；${notes.join('；')}` : ''}。
import * as React from 'react'
${motionImport}
import { IconShell${needsEase ? ', ICON_EASE' : ''}, type AnimatedIconProps } from '../AnimatedIcon'

${constBlock}${constBlock ? '\n\n' : ''}export function ${exportName}(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell ${shellProps}>${region}</IconShell>
  )
}
`)
  return { ok: true, name, code, stats, notes }
}

/** 数值表达式判定 —— 只用来给上提的 delay 计算函数补返回类型（lint 要求显式返回类型）。 */
function isNumericExpr(e, sf) {
  if (!e) return false
  if (ts.isNumericLiteral(e)) return true
  if (ts.isParenthesizedExpression(e)) return isNumericExpr(e.expression, sf)
  if (ts.isPrefixUnaryExpression(e)) return isNumericExpr(e.operand, sf)
  if (ts.isBinaryExpression(e)) return isNumericExpr(e.left, sf) && isNumericExpr(e.right, sf)
  if (ts.isConditionalExpression(e))
    return isNumericExpr(e.whenTrue, sf) && isNumericExpr(e.whenFalse, sf)
  if (ts.isIdentifier(e)) return numericConsts.has(e.text)
  return false
}

/** 上游的 `const CALCULATE_DELAY = (i) => …` 没有返回类型，直接搬进来过不了 lint。 */
function annotateArrowReturn(node, sf) {
  if (!ts.isArrowFunction(node) || node.type) return null
  // number 形参在函数体里当数值用（`i * DURATION + 0.1`），先并进数值标识符集合。
  const savedConsts = numericConsts
  numericConsts = new Map(savedConsts)
  for (const p of node.parameters) {
    if (ts.isIdentifier(p.name) && p.type?.kind === ts.SyntaxKind.NumberKeyword)
      numericConsts.set(p.name.text, 0)
  }
  const restore = (v) => {
    numericConsts = savedConsts
    return v
  }
  const returns = []
  if (ts.isBlock(node.body)) {
    const walk = (n) => {
      if (ts.isReturnStatement(n)) returns.push(n.expression)
      ts.forEachChild(n, walk)
    }
    walk(node.body)
  } else returns.push(node.body)
  if (returns.length === 0 || !returns.every((e) => isNumericExpr(e, sf))) return restore(null)
  return restore(
    `(${node.parameters.map((p) => p.getText(sf)).join(', ')}): number => ${node.body.getText(sf)}`
  )
}

/** 上游 sunset.tsx 的数组里有个多余逗号（稀疏数组）——照搬会被 no-sparse-arrays 判红。 */
function stripSparseHoles(code) {
  const sf = ts.createSourceFile('x.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const cuts = []
  const walk = (n) => {
    if (
      ts.isArrayLiteralExpression(n) &&
      n.elements.some((el) => el.kind === ts.SyntaxKind.OmittedExpression)
    ) {
      cuts.push({
        start: n.getStart(sf),
        end: n.getEnd(),
        text: `[${n.elements
          .filter((el) => el.kind !== ts.SyntaxKind.OmittedExpression)
          .map((el) => el.getText(sf))
          .join(', ')}]`
      })
    }
    ts.forEachChild(n, walk)
  }
  walk(sf)
  if (cuts.length === 0) return code
  const outer = cuts.filter((c) => !cuts.some((o) => o !== c && o.start < c.start && o.end > c.end))
  return applyEdits(code, 0, code.length, outer)
}

function applyEdits(text, from, to, edits) {
  const inside = edits.filter((e) => e.start >= from && e.end <= to).sort((a, b) => a.start - b.start)
  let out = ''
  let pos = from
  for (const e of inside) {
    if (e.start < pos) continue // 嵌套编辑：外层已整体替换
    out += text.slice(pos, e.start) + e.text
    pos = e.end
  }
  return out + text.slice(pos, to)
}

// ────────────────────────── 产物自查（与三道闸同判据） ──────────────────────────

/** 去掉行注释 / 块注释，只留代码行 —— 闸与本自查共用同一套「代码命中」定义。 */
export function stripComments(source) {
  let out = ''
  let i = 0
  let quote = null
  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]
    if (quote) {
      out += ch
      if (ch === '\\') {
        out += next ?? ''
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i += 1
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      out += ch
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

export function redLineHits(source) {
  const code = stripComments(source)
  const hits = []
  for (const pattern of [
    /\bspring\b/,
    /\bstiffness\b/,
    /\bdamping\b/,
    /\buse client\b/,
    /\bforwardRef\b/,
    /\buseAnimation\b/
  ]) {
    const m = code.match(pattern)
    if (m) hits.push(m[0])
  }
  for (const m of code.matchAll(/repeat:\s*(Infinity|Number\.POSITIVE_INFINITY)/g)) {
    hits.push(`repeat: ${m[1]}`)
  }
  // 🔴 duration 必须是数字字面量：留一个 `duration: SOME_CONST * 2` 就等于上界没人验。
  for (const m of code.matchAll(/duration:\s*([^,}\n]+)/g)) {
    const raw = m[1].trim()
    const n = Number(raw)
    if (!Number.isFinite(n)) hits.push(`duration 非字面量: ${raw}`)
    else if (n > MAX_DUR) hits.push(`duration: ${raw}`)
  }
  // 🔴 ease 必须是 ICON_EASE（§8 standard 曲线单源）。上游的 'easeInOut' / 'linear' /
  // 裸 cubic-bezier 数组照抄进来是「半转半留」的唯一无声形态 —— spring、超长时长、
  // 无限循环都被上面三条挡住了，只有曲线不对既不报错也看不出来。
  for (const m of code.matchAll(/ease:\s*(\[[^\]]*\]|[^,}\n]+)/g)) {
    const raw = m[1].trim().replace(/,$/, '')
    if (raw !== 'ICON_EASE') hits.push(`ease 非 ICON_EASE: ${raw}`)
  }
  return hits
}

// ────────────────────────────────── main ──────────────────────────────────

/** 读一个已存在的图标文件导出的组件名（仓内手工版命名与 PascalCase 不一定一致）。 */
function exportedIconName(file) {
  const src = fs.readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(path.basename(file), src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  for (const st of sf.statements) {
    if (
      ts.isFunctionDeclaration(st) &&
      st.name &&
      st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    )
      return st.name.text
  }
  return null
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const { dir, commit } = fetchUpstream(args.source)
  const iconsDir = path.join(dir, 'icons')
  const prettierConfig = (await prettier.resolveConfig(path.join(OUT_DIR, 'x.tsx'))) ?? {}

  let names = fs
    .readdirSync(iconsDir)
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => f.replace(/\.tsx$/, ''))
    .sort()
  if (args.only) names = names.filter((n) => args.only.includes(n))

  // 仓内已有的图标分两类：本脚本生成的（带 GENERATED_MARKER，重跑照常覆盖，保证幂等）
  // 与人工改造的 69 个（🔴 默认一个字都不动 —— 它们是按 checklist 手工套壳、有些还做过
  // 语义简化，机器版覆盖上去等于悄悄回退）。
  const handWritten = new Set(
    fs
      .readdirSync(OUT_DIR)
      .filter((f) => f.endsWith('.tsx'))
      .filter((f) => !fs.readFileSync(path.join(OUT_DIR, f), 'utf8').includes(GENERATED_MARKER))
      .map((f) => f.replace(/\.tsx$/, ''))
  )

  const written = []
  const keptRepo = []
  const skipped = []
  const totals = { spring: 0, repeat: 0, clamped: 0, ease: 0, durationAdded: 0, transitionAdded: 0, renamed: 0, synthesized: 0 }

  for (const name of names) {
    if (handWritten.has(name) && !args.overwrite) {
      keptRepo.push(name)
      continue
    }
    const src = fs.readFileSync(path.join(iconsDir, `${name}.tsx`), 'utf8')
    let result
    try {
      result = convertIcon({ name, src, exportName: `${toPascal(name)}Icon` })
    } catch (err) {
      result = { ok: false, name, reason: `转换抛错: ${err.message}` }
    }
    if (!result.ok) {
      skipped.push({ name, reason: result.reason })
      continue
    }
    let formatted
    try {
      formatted = await prettier.format(result.code, { ...prettierConfig, parser: 'typescript' })
    } catch (err) {
      skipped.push({ name, reason: `产物不是合法 TSX（prettier: ${err.message.split('\n')[0]}）` })
      continue
    }
    const hits = redLineHits(formatted)
    if (hits.length > 0) {
      skipped.push({ name, reason: `产物仍命中红线: ${[...new Set(hits)].join(', ')}` })
      continue
    }
    if (!args.dryRun) fs.writeFileSync(path.join(OUT_DIR, `${name}.tsx`), formatted)
    for (const k of Object.keys(totals)) totals[k] += result.stats[k]
    written.push({ name, notes: result.notes })
  }

  // barrel + LICENSE
  if (!args.dryRun) {
    const files = fs
      .readdirSync(OUT_DIR)
      .filter((f) => f.endsWith('.tsx'))
      .sort()
    const lines = []
    for (const f of files) {
      const exportName = exportedIconName(path.join(OUT_DIR, f))
      if (!exportName) throw new Error(`${f} 没有导出组件，barrel 生成中止`)
      lines.push(`export { ${exportName} } from './${f.replace(/\.tsx$/, '')}'`)
    }
    const barrel = `// 动画图标全量出口 —— 🔴 由 scripts/vendor-animated-icons.mjs 生成，勿手改。
//
// 只出**具名 export**：不要在这里（或任何地方）为这批图标建 key → 组件的 eager 查表。
// \`folderIcons.ts\` 那种查表对 24 个候选是有意为之（key 是落库值），对这里的四百多个
// 照做 = 一个消费点就把全部图标拖进 bundle。按名字 import，Rollup 才摇得掉没用的。
${lines.join('\n')}
`
    fs.writeFileSync(path.join(OUT_DIR, 'index.ts'), await prettier.format(barrel, { ...prettierConfig, parser: 'typescript' }))

    const license = fs.readFileSync(path.join(dir, 'LICENSE'), 'utf8')
    fs.writeFileSync(
      path.join(OUT_DIR, 'LICENSE-pqoqubbw'),
      `本目录下的动画图标源自 pqoqubbw/icons（lucide-animated.com），按 MIT 许可 vendor 进本仓，\n` +
        `并由 scripts/vendor-animated-icons.mjs 做过改造（剥壳套 IconShell、spring→tween、去循环、\n` +
        `收敛时长）。上游快照 commit: ${commit}\n\n` +
        `以下为上游 LICENSE 原文：\n\n${license}`
    )
  }

  const report = {
    upstreamCommit: commit,
    total: names.length,
    written: written.length,
    keptRepo: keptRepo.length,
    skipped,
    totals
  }
  console.log('\n===== vendor 报告 =====')
  console.log(`上游 commit: ${commit}`)
  console.log(`候选 ${names.length} · 新写 ${written.length} · 沿用仓内版 ${keptRepo.length} · 跳过 ${skipped.length}`)
  console.log(
    `转换统计: spring→tween ${totals.spring} · 补 transition ${totals.transitionAdded} · ` +
      `补 duration ${totals.durationAdded} · 去循环 ${totals.repeat} · 时长收敛 ${totals.clamped} · ` +
      `ease 归一 ${totals.ease} · 标签重命名 ${totals.renamed} · 关键帧合成 ${totals.synthesized}`
  )
  if (skipped.length) {
    console.log('\n跳过（需人工，走 pnpm icon:fetch 单图流程）:')
    for (const s of skipped) console.log(`  ${s.name}: ${s.reason}`)
  }
  if (args.json) fs.writeFileSync(args.json, JSON.stringify(report, null, 2))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main()
}
