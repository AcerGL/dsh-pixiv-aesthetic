/**
 * 宿主半端的装配自检 —— 用假 ctx 把 apply() 走一遍。
 *   node selfcheck-host.mjs
 *
 * 不联网、不启动 DSH。目的：确认 apply 的导出形状对、不抛、
 * 工具真的注册进去了、定时器兜得住异常。
 */
import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

let pass = 0
const fails = []
const ok = (n, c, extra) => { if (c) pass++; else fails.push(n + (extra ? '  → ' + extra : '')) }
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)

const home = join(tmpdir(), 'px-host-' + Date.now())
await fs.mkdir(home, { recursive: true })
process.env.DSH_HOME = home

const mod = await import('./index.js')

/* ─────────── 导出形状 ─────────── */
ok('导出了 name', typeof mod.name === 'string' && mod.name.length > 0, mod.name)
eq('name 是 pixiv-scroll', mod.name, 'pixiv-scroll')
// ⚠️ 故意**不**导出对象级 inject —— 见下面那组"注入时序"的断言
ok('没有导出对象级 inject', mod.inject === undefined, 'inject=' + JSON.stringify(mod.inject))
ok('导出了 apply 函数', typeof mod.apply === 'function')
ok('默认导出也在', mod.default && typeof mod.default.apply === 'function')
ok('默认导出也没带 inject', mod.default.inject === undefined, JSON.stringify(mod.default.inject))

/* ─────────── 🔴 宿主入口不许有顶层 await ───────────
 * 踩过的大坑（2026-11-04）：为了拿 schemastery 建校验 schema，写了
 *     export let Config
 *     try { const { z } = await import('@deepseek-ai/schemastery'); Config = z.object({...}) }
 * schemastery 是 optional peer，**对 link 安装的插件解析不到**（MODULE_NOT_FOUND）。
 * 顶层 await 会把整个模块求值挂起 ⇒ 宿主认为模块没加载完 ⇒ **apply 压根不被调用**
 * ⇒ 工具一个都不注册。try/catch 还吃掉了异常，日志里什么都看不到 ——
 * 表现就是"插件装了但完全没反应"。
 *
 * 判据：入口里出现顶层 await（不在 async 函数内的 await）就是错。
 */
{
  const src = await fs.readFile(join(here, 'index.js'), 'utf8')
  // 判断"代码里有没有"时要剥掉注释 —— 注释里解释这些坑是允许的
  const codeOnly = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  let inBlock = false
  const topLevelAwaits = []
  src.split('\n').forEach((raw, i) => {
    let line = raw
    if (inBlock) {
      const end = line.indexOf('*/')
      if (end < 0) return
      line = line.slice(end + 2)
      inBlock = false
    }
    const open = line.indexOf('/*')
    if (open >= 0) {
      const close = line.indexOf('*/', open + 2)
      if (close < 0) { inBlock = true; line = line.slice(0, open) }
      else line = line.slice(0, open) + line.slice(close + 2)
    }
    line = line.replace(/(^|[^:])\/\/.*$/, '$1')
    if (/^\s{0,2}await\s/.test(line) || /^await\s/.test(line)) {
      topLevelAwaits.push(`L${i + 1}: ${raw.trim().slice(0, 60)}`)
    }
  })
  ok('宿主入口没有顶层 await', topLevelAwaits.length === 0, topLevelAwaits.join(' | '))

  /* ─────────── 🔴 Config 必须满足 cordis 的契约 ───────────
   * 这是**唯一一个「自检全绿但真机不工作」**的坑，前后撞了两次（2026-11-04）。
   *
   * 宿主 cordis 源码里的真实契约：
   *     function resolveConfig(runtime, config) {
   *       if (!runtime.Config) return config
   *       const result = runtime.Config['~standard'].validate(config)   // ← 必须有
   *       ...
   *     }
   *
   * 所以：**要么不导出 Config，要么导出带 `~standard.validate` 的对象**。
   * 普通对象字面量两头不沾，宿主抛
   *     TypeError: Cannot read properties of undefined (reading 'validate')
   * → entry 不 activate → apply 完全不执行 → 表现是"装了没反应"，
   *   而且警告只写 stderr，GUI 里一个字都看不到。
   */
  const C = mod.Config
  if (C === undefined) {
    ok('没导出 Config（合法：宿主会跳过校验）', true)
  } else {
    ok('Config 是对象', typeof C === 'object' && C !== null, typeof C)
    ok('Config 不是 Promise', typeof C.then !== 'function')
    ok('Config 带 ~standard（cordis 靠它校验）', !!C['~standard'], JSON.stringify(Object.keys(C)))
    ok('~standard.validate 是函数',
      typeof (C['~standard'] && C['~standard'].validate) === 'function',
      typeof (C['~standard'] || {}).validate)

    // 真喂几种输入，确认**永远不抛、永远回 { value }**
    const v = C['~standard'].validate
    const cases = [
      ['正常配置', { perDay: 3, proxyUrl: 'http://x', keywords: ['a'] }],
      ['空对象', {}],
      ['null', null],
      ['undefined', undefined],
      ['数组（类型错）', [1, 2, 3]],
      ['字符串（类型错）', 'nonsense'],
      ['字符串数字', { perDay: '5' }],
      ['字段类型错', { keywords: 'not-array', perDay: {} }],
      ['带未知键', { whatever: 1 }],
    ]
    let allOk = true
    const detail = []
    for (const [label, input] of cases) {
      try {
        const r = v(input)
        if (!r || typeof r !== 'object' || !('value' in r)) { allOk = false; detail.push(label + ': 没回 {value}') }
        else if (typeof r.then === 'function') { allOk = false; detail.push(label + ': 回了 Promise') }
      } catch (e) {
        allOk = false
        detail.push(label + ': 抛了 ' + e.message)
      }
    }
    ok('validate 对任何输入都不抛、都回 { value }', allOk, detail.join(' | '))
    ok('未知键不会被偷偷删掉', 'whatever' in (v({ whatever: 1 }).value || {}))
    ok('类型错的字段被丢掉而不是让校验失败',
      !('keywords' in (v({ keywords: 'not-array' }).value || {})))
  }

  ok('没有动态 import schemastery 来建 Config',
    !/await import\(['"]@deepseek-ai\/schemastery/.test(codeOnly),
    'schemastery 是 optional peer，link 安装时解析不到')
}

/**
 * 用假 ctx 走一遍 apply。
 * ⚠️ 必须**收集并按宿主的方式调用 disposer** —— 真实宿主在插件卸载/重启时会调
 *    每个 effect 的返回值。不调的话 setInterval 会一直挂着，测试进程退出不了
 *    （这是测试自己的问题，不是插件的；但也说明 effect 的返回值有意义）。
 */
function makeCtx(opts = {}) {
  const registered = []
  const effects = []
  const services = { tools: { register: (d) => { registered.push(d); return () => {} } }, ...(opts.services || {}) }
  const flatten = (k) => {
    const raw = k in services ? services[k] : undefined
    return raw
  }
  const disposers = []
  return {
    registered,
    effects,
    dispose() {
      for (const d of disposers.reverse()) {
        try { if (typeof d === 'function') d() } catch { /* 卸载时抛错也不该崩 */ }
      }
    },
    ctx: {
      get: (k) => flatten(k),
      // 宿主：effect(fn) 会调 fn 并把返回值当 disposer 收好，卸载时调用
      effect: (fn) => { effects.push(fn); const d = fn(); if (typeof d === 'function') disposers.push(d); return d || (() => {}) },
      on: () => () => {},
      // 局部等待：默认"永远等不到"（模拟服务不来），个别用例会覆盖它
      inject: () => {},
    },
    services,
  }
}

const ctxs = [] // 记住所有造过的，收尾统一清理

{
  const h = makeCtx()
  ctxs.push(h)
  const { ctx, registered, effects } = h
  // 用短超时 + 必定拒绝的代理，让 status 的网络探测快速失败，
  // 测试不依赖真实网络、也不会卡住。
  let threw = null
  try { mod.apply(ctx, { probeTimeoutMs: 1500, timeoutMs: 1500 }) } catch (e) { threw = e }
  ok('apply 不抛', threw === null, threw && threw.message)
  eq('注册了 8 个工具', registered.length, 8)
  ok('都带 name/execute', registered.every((d) => d.name && typeof d.execute === 'function'))
  ok('注册了 effect（可回收）', effects.length > 0, String(effects.length))

  const names = registered.map((d) => d.name).sort()
  eq('工具名齐全', names, ['pixiv_feedback', 'pixiv_pick', 'pixiv_save', 'pixiv_search', 'pixiv_send', 'pixiv_status', 'pixiv_taste', 'pixiv_works'].sort())

  // 摘下来调 —— 回归那个 this 绑定坑
  // ⚠️ pixiv_status 会真的探一次网络。这里配的是黑洞直连（pixiv 在测试环境
  //    通常连不上），加上 1.5s 超时，探测会快速返回"不通" —— 顺带验了
  //    "探测失败时 status 照样给结果、不抛"。
  const status = registered.find((d) => d.name === 'pixiv_status')
  const r = await status.execute({})
  ok('摘下来调不报 this 错', r && typeof r === 'object', JSON.stringify(r).slice(0, 120))
  ok('status 报到家目录', String(JSON.stringify(r)).includes('pixiv-scroll') || r.saveRoot !== undefined)
  ok('status 在探测失败时也给结果（不抛）', typeof r.network === 'object', JSON.stringify(r.network).slice(0, 120))
}

/* ─────────── 没有 tools 服务时不该崩 ─────────── */
{
  const h = makeCtx({ services: { tools: undefined } })
  ctxs.push(h)
  let threw = null
  try { mod.apply(h.ctx, {}) } catch (e) { threw = e }
  ok('没有 tools 服务时优雅退出，不抛', threw === null, threw && threw.message)
}

/* ─────────── ⚠️ 对象级 inject 的坑（真踩过，别改回去） ───────────
 * 桌面端（Electron）的注入表是**宿主启动时一次性收集**的；
 * 声明对象级 `inject` 会把整个 apply 推迟到服务就绪之后，
 * 订阅一晚于那次收集就再也补不进去 ⇒ 插件**完全不注册工具**。
 *
 * 实测症状：duty.log 里只有「配置已加载」（apply 里的异步回调写的），
 * 而排在后面的「已挂载：注册了 N 个工具」一个字都没有。
 */
{
  ok('没有导出对象级 inject（会推迟 apply）',
    mod.inject === undefined, '导出了 inject=' + JSON.stringify(mod.inject))

  // tools 晚到（模拟桌面端时序）：apply 必须能自己等到它
  const h = makeCtx({ services: { tools: undefined } })
  ctxs.push(h)
  const injected = []
  h.ctx.inject = (names, cb) => {
    injected.push(names)
    setTimeout(() => {
      h.services.tools = { register: (d) => { h.registered.push(d); return () => {} } }
      cb(h.ctx)
    }, 10)
  }
  mod.apply(h.ctx, {})
  ok('拿不到 tools 时会去局部等待', injected.length > 0, JSON.stringify(injected))
  ok('等的是 tools', injected.some((n) => JSON.stringify(n).includes('tools')), JSON.stringify(injected))
  await new Promise((r) => setTimeout(r, 150))
  eq('服务晚到后工具仍注册上了', h.registered.length, 8)
}

/* ─────────── 立刻能拿到 tools 时走最快路径（不必等 tools） ─────────── */
{
  const h = makeCtx()
  ctxs.push(h)
  const asked = []
  h.ctx.inject = (names) => { asked.push(names) }
  mod.apply(h.ctx, {})
  eq('工具服务已在时直接注册', h.registered.length, 8)
  // tools 已在就不该为它去等；connection 是另一回事（没给就等，见下一条）
  ok('tools 已在时不为 tools 去等',
    !asked.some((n) => JSON.stringify(n).includes('tools')), JSON.stringify(asked))
}

/* ─────────── connection 没就绪时要等它（否则设置页接口静默缺失） ───────────
 * 踩过的坑：`connection` 和 `tools` 一样可能晚于 apply 就绪。
 * 原来拿不到就**默默跳过**，结果设置页永远读不到配置，日志里一点痕迹都没有。
 */
{
  const h = makeCtx()
  ctxs.push(h)
  const asked = []
  h.ctx.inject = (names, cb) => {
    asked.push(names)
    // connection 稍后到达
    setTimeout(() => {
      h.services.connection = { fetch: { register: () => () => {} } }
      cb(h.ctx)
    }, 10)
  }
  mod.apply(h.ctx, {})
  ok('拿不到 connection 时会去等', asked.some((n) => JSON.stringify(n).includes('connection')), JSON.stringify(asked))
  await new Promise((r) => setTimeout(r, 80))
  const log = await fs.readFile(join(home, 'pixiv-scroll', 'duty.log'), 'utf8').catch(() => '')
  ok('等到了会记一行日志', /connection 精确路由已注册/.test(log), log.split('\n').filter((l) => l.includes('设置页接口')).join(' | '))
}

/* ─────────── 拿不到 connection 时也要留痕，不许静默 ─────────── */
{
  const h = makeCtx()
  ctxs.push(h)
  h.ctx.inject = () => { /* 永远等不到 */ }
  mod.apply(h.ctx, {})
  await new Promise((r) => setTimeout(r, 50))
  const log = await fs.readFile(join(home, 'pixiv-scroll', 'duty.log'), 'utf8').catch(() => '')
  ok('没有 connection 时日志里有交代',
    /设置页接口：/.test(log), log.split('\n').filter((l) => l.includes('设置页接口')).join(' | '))
}

/* ─────────── 🔴 设置页接口：connection 只认精确路径 ───────────
 * 踩过的坑（2026-11-05）：设置页弹 "读不到插件配置：HTTP 404"。
 * 原因：我把 connection.fetch 注册写成 `path: '/api/pixiv-scroll'`（一个前缀），
 * 而这条通道**只做精确匹配** —— 官方 README 原话：
 *     "When a Web carrier is present it also owns the sole `/api` route …
 *      unclaimed requests return 404."
 * 所以 /api/pixiv-scroll/config 之类全都 404。必须**每个端点单独注册**。
 */
{
  const h = makeCtx()
  ctxs.push(h)
  const routes = []
  h.services.connection = {
    fetch: {
      register: (opts) => { routes.push(opts); return () => {} },
    },
  }
  // webServer 也给上，验另一条通道
  const webRoutes = []
  h.services.webServer = { register: (opts) => { webRoutes.push(opts); return () => {} } }

  mod.apply(h.ctx, { intervalMin: 0 })
  await new Promise((r) => setTimeout(r, 60))

  const paths = routes.map((r) => r.path)
  ok('注册了 connection 路由', paths.length > 0, JSON.stringify(paths))

  // 每条都必须是具体端点，不能是前缀
  const prefixes = paths.filter((p) => !/\/[a-z]/.test(p) || !p.startsWith('/api/'))
  ok('路由都在 /api/ 下', paths.every((p) => p.startsWith('/api/')), JSON.stringify(paths))
  ok('没有把前缀当路由注册',
    !paths.includes('/api/pixiv-scroll') && !paths.includes('/api/pixiv-scroll/'),
    '前缀匹配不到子路径 —— 必须逐条注册具体端点：' + JSON.stringify(paths))

  // 设置页会用到的端点一个都不能少
  for (const need of [
    '/api/pixiv-scroll/ping',
    '/api/pixiv-scroll/config',
    '/api/pixiv-scroll/check',
    '/api/pixiv-scroll/login/who',
    '/api/pixiv-scroll/login/token',
    '/api/pixiv-scroll/login/logout',
  ]) {
    ok(`注册了 ${need}`, paths.includes(need), JSON.stringify(paths))
  }

  // 每条都要声明 requestBody 和 methods（宿主读 body 前要先知道怎么读）
  ok('每条都声明了 requestBody',
    routes.every((r) => r.requestBody === 'buffered'), JSON.stringify(routes.map((r) => r.requestBody)))
  ok('每条都声明了 methods',
    routes.every((r) => Array.isArray(r.methods) && r.methods.length > 0))
  ok('每条都有 fetch 处理函数', routes.every((r) => typeof r.fetch === 'function'))

  // config 端点必须同时收 GET 和 POST（读配置 + 存配置）
  const cfgRoute = routes.find((r) => r.path === '/api/pixiv-scroll/config')
  ok('config 同时支持 GET 和 POST',
    cfgRoute && cfgRoute.methods.includes('GET') && cfgRoute.methods.includes('POST'),
    JSON.stringify(cfgRoute && cfgRoute.methods))

  // webServer 那条前缀路由也该在（普通 web 版用）
  ok('webServer 注册了前缀路由',
    webRoutes.some((r) => r.kind === 'prefix' && r.path === '/pixiv-scroll'),
    JSON.stringify(webRoutes.map((r) => r.path)))
}

/* ─────────── 定时器：跟着 intervalMin 走，且卸载能停掉 ─────────── */
{
  // ⚠️ 别用 process.getActiveResourcesInfo() 数 Timeout —— 我们对定时器调了
  //    .unref()，它不一定出现在那个列表里（实测一直返回 0，会误判）。
  //    判据改成**看日志**，那才是使用者真正能看到的东西。
  const h = makeCtx()
  ctxs.push(h)
  mod.apply(h.ctx, { intervalMin: 5 })
  await new Promise((r) => setTimeout(r, 400))

  const logFile = join(home, 'pixiv-scroll', 'duty.log')
  const log1 = await fs.readFile(logFile, 'utf8').catch(() => '')
  ok('intervalMin>0 时日志说定时器起来了', log1.includes('定时器已起'), log1.split('\n').filter((l) => l.includes('定时器')).join(' | '))
  ok('日志里有「已挂载」', log1.includes('已挂载'), log1.slice(0, 160))

  h.dispose()
  // 卸载后再 etc 一下，日志里不该再多出新的「定时轮」记录
  const before = log1.length
  await new Promise((r) => setTimeout(r, 300))
  const log2 = await fs.readFile(logFile, 'utf8').catch(() => '')
  ok('卸载后没有新活动', log2.length === before, `${before} → ${log2.length}`)
}

/* ─────────── intervalMin=0 时不该起定时器 ─────────── */
{
  // ⚠️ 必须用**独立的家目录** —— 上一段往 config.json 里写过 intervalMin:5，
  //    共用目录的话这段会读到那个值，测出来的是上一段的残留（踩过）。
  const home2 = join(home, 'zero')
  await fs.mkdir(home2, { recursive: true })
  const h = makeCtx({
    services: { dshHomePath: (sub) => join(home2, sub) },
  })
  ctxs.push(h)
  mod.apply(h.ctx, { intervalMin: 0 })
  await new Promise((r) => setTimeout(r, 400))
  const log1 = await fs.readFile(join(home2, 'pixiv-scroll', 'duty.log'), 'utf8').catch(() => '')
  ok('intervalMin=0 时日志里没有「定时器已起」', !log1.includes('定时器已起'),
    log1.split('\n').filter((l) => l.includes('定时器')).join(' | '))
  h.dispose()
}

/* ─────────── dshHomePath 是函数 / 字符串 两种都要兜 ─────────── */
for (const [label, svc] of [
  ['函数式', { dshHomePath: (sub) => join(home, sub || '') }],
  ['字符串式', { dshHomePath: home }],
  ['完全没有', {}],
]) {
  const h = makeCtx({ services: svc })
  ctxs.push(h)
  let threw = null
  try { mod.apply(h.ctx, {}) } catch (e) { threw = e }
  ok(`dshHomePath ${label} 时 apply 不抛`, threw === null, threw && threw.message)
  eq(`dshHomePath ${label} 时仍注册 8 个工具`, h.registered.length, 8)
  h.dispose()
}

/* ─────────── 配置：profile 的值要能被 config.json 覆盖 ─────────── */
{
  const h = makeCtx()
  ctxs.push(h)
  mod.apply(h.ctx, { perDay: 20, keywords: ['来自profile'] })

  // 等异步 loadConfig 落地
  await new Promise((r) => setTimeout(r, 300))

  const status = h.registered.find((d) => d.name === 'pixiv_status')
  const r1 = await status.execute({})
  eq('先用 profile 的值', r1.quota.limit, 20)
  eq('实测关键字也来自 profile', r1.keywords, ['来自profile'])
  h.dispose()

  // 现在写 config.json 覆盖
  const { saveConfig } = await import('./lib/config.mjs')
  await saveConfig(join(home, 'pixiv-scroll'), { perDay: 4, keywords: ['来自文件'] }, { perDay: 20, keywords: ['来自profile'] })

  // 再 apply 一次（模拟重启后读文件）
  const h2 = makeCtx()
  ctxs.push(h2)
  mod.apply(h2.ctx, { perDay: 20, keywords: ['来自profile'] })
  await new Promise((r) => setTimeout(r, 300))
  const s2 = h2.registered.find((d) => d.name === 'pixiv_status')
  const r2 = await s2.execute({})
  eq('config.json 覆盖了 profile 的 perDay', r2.quota.limit, 4)
  eq('config.json 覆盖了 profile 的 keywords', r2.keywords, ['来自文件'])
  h2.dispose()
}

/* ─────────── 家目录里确实落了东西 ─────────── */
{
  const p = join(home, 'pixiv-scroll')
  const files = await fs.readdir(p).catch(() => [])
  ok('家目录建起来了', files.length >= 0, files.join(','))
  ok('写了 duty.log', files.includes('duty.log'), files.join(','))
  const log = await fs.readFile(join(p, 'duty.log'), 'utf8').catch(() => '')
  ok('日志里有「已挂载」', log.includes('已挂载'), log.slice(0, 200))
}

/* ─────────── 收尾：把所有 ctx 都卸载，别让进程挂住 ─────────── */
for (const h of ctxs) { try { h.dispose() } catch { /* ignore */ } }

await fs.rm(home, { recursive: true, force: true }).catch(() => {})
console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  console.log('\n失败项：')
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过 ✓')

// 自检自身也要能退出：留个硬兜底，免得又挂住终端
// （正常的路径上这时已经没有活跃 handle 了）
const linger = setTimeout(() => {
  const live = process.getActiveResourcesInfo().filter((r) => r !== 'FSReqPromise' && r !== 'PipeWrap' && r !== 'TTYWrap')
  if (live.length) {
    console.log(`\n⚠️ 还有活跃 handle 没清：${live.join(',')}`)
    process.exit(2)
  }
  process.exit(0)
}, 1500)
if (linger.unref) linger.unref()
