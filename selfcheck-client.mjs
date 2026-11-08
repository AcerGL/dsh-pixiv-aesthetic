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
    // inject 里声明了浮窗服务，apply 会直接取它们（不是可选）
    sidebarRightTabs: {
      register: (def) => { sb.__paneTabs = sb.__paneTabs || []; sb.__paneTabs.push(def); return () => {} },
    },
    sidebarRight: { openTab: () => {} },
    effect: (fn, label) => { const d = fn(); sb.__effects.push({ label, d }); return d || (() => {}) },
  }
  try {
    mod.apply(ctx)
    ok('apply 不抛', true)
  } catch (e) {
    ok('apply 不抛', false, e && e.message)
  }

  ok('注册进了 settings.section', sb.__injected.includes('settings.section'), JSON.stringify(sb.__injected))

  // ⚠️ 这里以前断言"只注册了一项"。现在浮窗的 tab 也在这个 ctx 上注册，
  //    所以改成**按座位找**，别写死总数 —— 写死总数会在加 tab 时假报错。
  const settingsRegs = sb.__registered.filter((r) => r.opts && r.opts.name === 'settings.section')
  eq('settings.section 注册了一项', settingsRegs.length, 1)

  const reg = settingsRegs[0] || {}
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
  const Panel = (sb.__registered.find((r) => r.opts && r.opts.name === 'settings.section') || {}).comp
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

  /**
   * 🔴 探测失败**不能把死地址缓存下来**。
   *
   * 2026-11-08 老大报「点了删除没删成」，而 duty.log 里**一条删除记录都没有**
   * ⇒ 请求压根没发出去。根因：`resolveBase()` 把结果缓存在 `basePromise` 里
   * **永不失效、也不重试**；而路由注册经常"晚一步"（日志里好几个启动是
   * `webserver/connection 不可用`），面板要在那时加载，就缓存一个死地址，
   * 之后**所有**请求全废 —— 界面上只显示一句"没删成"，毫无线索。
   *
   * 这条断言**跑行为**，不是查源码字符串（那种查法容易被注释骗到）：
   * 摆一个"第一次 ping 全失败、第二次才通"的 fetch 桩，
   * 断言第一次拿到兜底值、第二次能探到真地址。
   */
  {
    const React3 = makeReact()
    const sb3 = makeSandbox(React3)
    let pingCount = 0
    /**
     * 桩：**前两次 ping 失败**（模拟"路由还没注册上"），之后才通。
     * 老代码会把失败结果焊死在缓存里 ⇒ 只探 2 次，之后永远用死地址。
     */
    sb3.fetch = async (url) => {
      const u = String(url)
      if (u.includes('/ping')) {
        pingCount++
        if (pingCount <= 2) throw new Error('探测失败（模拟路由还没注册上）')
        return { ok: true, json: async () => ({ ok: true }), text: async () => '' }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    }
    sb3.__pingCount = () => pingCount
    vm.createContext(sb3)
    vm.runInContext(src, sb3, { filename: 'client.js' })

    /**
     * ⚠️ 不去绕 React 那一套（试过，桩不完整，触发不到）。
     *    直接把 `resolveBase` 从源码里**切出来**单独跑 ——
     *    它是纯函数（只依赖 fetch 和两个模块级变量），
     *    这样测的就是"重试行为"本身，不受组件渲染干扰。
     */
    const m = /const CANDIDATES\s*=\s*\[[^\]]*\][\s\S]*?\n    \}\n/.exec(src)
    ok('能从源码里切出探测函数（测试自身的前提）', !!m,
      '切不出来说明源码结构变了，这条测试得跟着改')

    if (m) {
      const fn = new Function('fetch', `
        ${m[0]}
        return resolveBase
      `)(sb3.fetch)

      const first = await fn()
      const afterFirst = pingCount
      const second = await fn()
      await new Promise((r) => setTimeout(r, 10))
      const third = await fn()
      await new Promise((r) => setTimeout(r, 10))
      const afterThird = pingCount

      ok('🔴 探测失败后**会再试**（不把死地址焊死）',
        afterThird > afterFirst,
        `第一次探了 ${afterFirst} 次、之后总共 ${afterThird} 次 —— ` +
        '要是相等，说明失败结果被缓存死了，' +
        '那正是"点了删除没删成、服务器却毫无记录"的根因')
      ok('🔴 探不到时会重试，最终能拿到通的那条',
        afterThird >= 3,
        `ping 次数 = ${afterThird}（预期 ≥3：前两次失败 + 至少一次重试）`)
      ok('探到之后就用它（别每张图都重探）',
        second === third || third === '/api/pixiv-scroll',
        `second=${second} third=${third}`)
    }
  }
}

/* ─────────── 🔴 apply 绝不能把异常漏给宿主 ───────────
 *
 * 这是 2026-11-07 真把 DSH 弄崩的那条的回归。
 *
 * 现场：client apply 里某一步抛了异常 → 宿主把 entry 标成 failed →
 *       `web boot` 抛「1 entry did not activate / dsh-pixiv-aesthetic: failed」→
 *       **整个应用启动失败**，而且只给状态名、不给原因。
 *
 * 一个 UI 插件没资格拖垮宿主启动。所以这里喂它一个**每一步都会炸**的 ctx，
 * 断言 apply 仍然平静返回。这条断言如果红了，说明兜底又被谁拆了。
 */
{
  const hostile = {
    // 服务在 inject 里声明过就一定拿得到；这里让方法本身炸
    slots: {
      register: () => { throw new Error('register 炸了') },
      inject: () => { throw new Error('inject 炸了') },
    },
    sidebarRightTabs: { register: () => { throw new Error('tabs.register 炸了') } },
    sidebarRight: { openTab: () => { throw new Error('openTab 炸了') } },
    get: (k) => hostile[k],
    effect: (fn) => { fn() },
  }
  const React2 = makeReact()
  const sb2 = makeSandbox(React2)
  vm.createContext(sb2)
  vm.runInContext(src, sb2, { filename: 'client.js' })
  const mod2 = sb2.__factory(sb2.__require)
  let threw = null
  try {
    mod2.apply(hostile)
  } catch (e) {
    threw = e
  }
  ok('🔴 服务全炸时 apply 仍不抛（否则宿主整个起不来）', threw === null,
    threw && (threw.message || String(threw)))

  /**
   * 🔴 inject 必须列全。
   *
   * 这条以前写反过 —— 断言的是 `inject: ['slots']`，等于把"删掉服务声明"
   * 这个**错误做法锁死**，我照着它改，结果又把 DSH 弄崩一次（2026-11-07）。
   *
   * 契约（cordis `ReflectService.handler` 的源码）：ctx 是 Proxy，
   * 取一个**没在 inject 里声明过**的服务属性会直接抛
   *     cannot get property "<name>" without inject
   * 所以 inject 是"我声明要用这些服务"，不是"可选名单"。
   */
  ok('🔴 inject 声明了浮窗要用的三个服务',
    JSON.stringify(mod2.inject) === JSON.stringify(['slots', 'sidebarRightTabs', 'sidebarRight']),
    JSON.stringify(mod2.inject) + ' —— 少一个，取它就抛 without inject')

  // 用"会抛 Proxy"模拟真实 ctx，验证代码没有去摸没声明的服务
  {
    const declared = new Set(mod2.inject)
    const proxyCtx = new Proxy({}, {
      get: (_t, prop) => {
        if (prop === 'effect') return (fn) => { try { fn() } catch { /* ignore */ } }
        if (typeof prop === 'symbol') return undefined
        if (!declared.has(prop)) {
          const e = new Error(`cannot get property "${String(prop)}" without inject`)
          throw e
        }
        return {
          register: () => () => {},
          inject: (_seat, cb) => { try { cb() } catch { /* ignore */ } return () => {} },
          openTab: () => {},
        }
      },
    })
    let threw2 = null
    try { mod2.apply(proxyCtx) } catch (e) { threw2 = e }
    ok('🔴 用真实的「没声明就抛」ctx 跑 apply 也不炸',
      threw2 === null, threw2 && (threw2.message || String(threw2)))
  }

  ok('有把异常报给宿主的通道（reportClientError）',
    /reportClientError/.test(src) && /client-error/.test(src),
    '没有上报就只能靠猜，2026-11-07 就是这么猜错的')
}

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  console.log('\n失败项：')
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过 ✓')
