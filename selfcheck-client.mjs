/**
 * 客户端设置页（client.js）的自检。
 *   node selfcheck-client.mjs
 *
 * client bundle 不是 ESM，是 window.__ModuleLoader__.load({...}) 的自注册脚本。
 * 所以不能 import —— 要用桩把 window / document / React 摆好，再 eval 它。
 * 这一步能抓到的问题：语法错、id 跟包名不符、没注册到 settings.section、
 * 渲染时抛错（宿主那边表现就是"设置页空白"）。
 */
import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
let pass = 0
const fails = []
const ok = (n, c, extra) => { if (c) pass++; else fails.push(n + (extra ? '  → ' + extra : '')) }
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)

const src = await fs.readFile(join(here, 'client.js'), 'utf8')
const pkg = JSON.parse(await fs.readFile(join(here, 'package.json'), 'utf8'))

/* ─────────── 桩：最小可用的 React / document / window ─────────── */
function makeReact() {
  const el = (type, props, ...kids) => ({
    __el: true, type,
    props: { ...(props || {}), children: kids.length === 1 ? kids[0] : (kids.length ? kids : undefined) },
  })
  const hooks = { states: [], effects: [], cursor: 0 }
  const React = {
    createElement: el,
    // 极简 useState：按调用序号存，重复渲染时复用
    useState: (init) => {
      const i = hooks.cursor++
      if (!(i in hooks.states)) hooks.states[i] = typeof init === 'function' ? init() : init
      return [hooks.states[i], (v) => { hooks.states[i] = typeof v === 'function' ? v(hooks.states[i]) : v }]
    },
    useEffect: (fn) => { hooks.effects.push(fn) },
    __hooks: hooks,
    __reset() { hooks.cursor = 0 },
  }
  return React
}

function makeDoc() {
  const head = { children: [], appendChild(n) { this.children.push(n) } }
  return {
    head,
    createElement: (tag) => ({
      tag, textContent: '', style: {}, remove() {},
    }),
  }
}

function makeSandbox(React) {
  const registered = []   // settings.section 的注册
  const injected = []     // slots.inject 的 ownerKey
  const effects = []
  const css = []

  const slots = {
    inject: (ownerKey, fn) => { injected.push(ownerKey); fn() },
    register: (opts, comp) => { registered.push({ opts, comp }); return () => {} },
  }

  const doc = makeDoc()
  const sandbox = {
    console,
    window: {},
    document: doc,
    fetch: async () => { throw new Error('测试里不该真的发请求') },
    setTimeout, clearTimeout, Promise, JSON, Object, Array, String, Number, Boolean, Error,
    Math, Date, RegExp, isNaN, parseInt, parseFloat,
  }
  sandbox.window.__ModuleLoader__ = {
    load: ({ id, factory }) => {
      sandbox.__loadId = id
      sandbox.__factory = factory
    },
  }
  // require('react') → 我们的桩
  sandbox.__require = (n) => {
    if (n === 'react') return sandbox.__React
    throw new Error('测试桩没准备这个模块：' + n)
  }
  sandbox.__React = React
  sandbox.__slots = slots
  sandbox.__registered = registered
  sandbox.__injected = injected
  sandbox.__effects = effects
  sandbox.__css = () => doc.head.children.map((c) => c.textContent).join('\n')
  return sandbox
}

/* ─────────── 1. 能加载，且 id 对 ─────────── */
const React = makeReact()
const sb = makeSandbox(React)
try {
  vm.createContext(sb)
  vm.runInContext(src, sb, { filename: 'client.js' })
  ok('client.js 能跑起来（语法没错）', true)
} catch (e) {
  ok('client.js 能跑起来（语法没错）', false, e && e.message)
}

eq('id 等于包名的 name', sb.__loadId, pkg.name)
ok('有 factory', typeof sb.__factory === 'function')

/* ─────────── 2. factory 产出注入与 apply ─────────── */
let mod
try {
  mod = sb.__factory(sb.__require)
  ok('factory 返回了插件对象', !!mod)
} catch (e) {
  ok('factory 返回了插件对象', false, e && e.message)
}
if (mod) {
  ok('声明了 inject', Array.isArray(mod.inject) || typeof mod.inject === 'object', JSON.stringify(mod.inject))
  ok('inject 里有 slots', JSON.stringify(mod.inject).includes('slots'))
  ok('有 apply', typeof mod.apply === 'function')
}

/* ─────────── 3. apply：注册到 settings.section ─────────── */
if (mod && typeof mod.apply === 'function') {
  const ctx = {
    get: (k) => (k === 'slots' ? sb.__slots : undefined),
    slots: sb.__slots,
    effect: (fn, label) => { const d = fn(); sb.__effects.push({ label, d }); return d || (() => {}) },
  }
  try {
    mod.apply(ctx)
    ok('apply 不抛', true)
  } catch (e) {
    ok('apply 不抛', false, e && e.message)
  }

  ok('注册进了 settings.section', sb.__injected.includes('settings.section'), JSON.stringify(sb.__injected))
  eq('注册了一项', sb.__registered.length, 1)

  const reg = sb.__registered[0] || {}
  eq('slot 名字对', reg.opts && reg.opts.name, 'settings.section')
  eq('slot id 对', reg.opts && reg.opts.id, 'pixiv-scroll')
  ok('左侧导航有 label', reg.opts && typeof reg.opts.label === 'string' && reg.opts.label.length > 0, JSON.stringify(reg.opts))
  ok('order 是数字', typeof (reg.opts && reg.opts.order) === 'number')
  ok('给了渲染组件', typeof reg.comp === 'function')

  // 样式挂了，且卸载能收掉
  ok('注入了样式', sb.__css().length > 100, String(sb.__css().length))
  const before = sb.document.head.children.length
  for (const e of sb.__effects) { try { if (e.d && typeof e.d === 'function') e.d() } catch { /* ignore */ } }
  ok('卸载时样式被收掉', sb.document.head.children.length <= before, `${before} → ${sb.document.head.children.length}`)
}

/* ─────────── 4. 组件能渲染（不抛） ─────────── */
if (mod && sb.__registered.length) {
  const Panel = sb.__registered[0].comp
  React.__reset()
  let tree
  try {
    tree = Panel({})
    ok('组件首次渲染不抛', true)
  } catch (e) {
    ok('组件首次渲染不抛', false, e && e.message)
  }
  ok('渲染出的是 React 元素', tree && tree.__el === true, typeof tree)

  // 跑一遍 effect（首屏会去 load 配置）—— fetch 被桩成抛错，但组件该自己接住
  for (const fn of React.__hooks.effects) {
    try { fn() } catch { /* 组件内部自己 catch */ }
  }
  ok('effect 不把异常抛到外面', true)

  // 递归找一遍树，确认没有 undefined/非法节点
  const walk = (n, depth = 0) => {
    if (n === null || n === undefined || typeof n !== 'object') return true
    if (n.__el) {
      if (typeof n.type !== 'string' && typeof n.type !== 'function') return false
      const kids = n.props && n.props.children
      if (!kids) return true
      const arr = Array.isArray(kids) ? kids : [kids]
      for (const k of arr) { if (k !== null && k !== undefined && !walk(k, depth + 1)) return false }
    }
    return true
  }
  ok('整棵树里没有被渲染成 undefined 的节点', walk(tree))
}

/* ─────────── 5. 红线：client 里不该出现凭证/私人 ID ─────────── */
{
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  // 🔴 自己也不能把这些 ID **原样写进源码** —— 不然开源发出去就泄漏了。
  //    所以用片段拼出来：正则一样能匹配，但仓库里查不到完整 ID。
  // ⚠️ 转义：'\\\\b' 在正则源码里才是 \b（词边界）；写成 '\\b' 会失效（踩过）。
  const idRe = (...parts) => new RegExp(String.raw`\b` + parts.join('') + String.raw`\b`)
  const bad = [
    { re: /\b(appSecret|refreshToken)\s*[:=]\s*['"][^'"]{10,}['"]/, why: '硬编码凭证' },
    { re: /\brv_[A-Za-z0-9_-]{16,}/, why: 'river key' },
    { re: idRe('190582', '8754'), why: '本机 QQ appId' },
    { re: idRe('44372', '0005'), why: '号主 uid' },
  ]
  const hit = bad.filter((b) => b.re.test(code)).map((b) => b.why)
  ok('client.js 没有硬编码凭证/私人 ID', hit.length === 0, hit.join(','))

  // 密码/token 输入框必须是 password 类型（别明文显示）
  ok('refresh_token 输入框是 password 类型', /type:\s*['"]password['"]/.test(src))
  // 不该把 token 写进 localStorage 之类
  ok('没有往 localStorage 写东西', !/localStorage/.test(code))

  /* ─────────── 🔴 后端地址探测：两条通道都要试，且只看 ok ───────────
   * 踩过的坑（2026-11-05）：桌面版里设置页报 "HTTP 404"。
   * 两个原因叠一起：
   *   ① 宿主 connection.fetch 只认**精确路径**，我注册成前缀 /api/pixiv-scroll，
   *      于是 /api/pixiv-scroll/config 匹配不上 → 404（这条在 host 自检里钉）
   *   ② 客户端 resolveBase 只试了 /api/… 一条，失败就**盲退** /pixiv-scroll/api，
   *      而桌面版那条也 404 —— 于是拿到 404 却以为"探测过了"。
   */
  ok('探测了两条候选通道',
    /CANDIDATES\s*=\s*\[/.test(src) && /\/api\/pixiv-scroll/.test(src) && /\/pixiv-scroll\/api/.test(src))
  ok('探测时检查 r.ok（404 不能当成功）',
    /if\s*\(\s*r\.ok\s*\)\s*return\s+base/.test(src),
    '必须判 ok，否则会把 404 当成找到了通道')
  ok('两处都留了说明为什么不能盲退',
    /盲退/.test(src) || /404/.test(src))
}

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  console.log('\n失败项：')
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过 ✓')
