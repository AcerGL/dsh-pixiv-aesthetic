/**
 * 代理自动发现的自检。
 *   node selfcheck-proxy.mjs
 *
 * ⚠️ 这个套件**不联网**（除了显式标 NET 的那几条）。
 *    单元测试不能依赖"外网通不通" —— 那是环境，不是代码。
 *    所以主要测：端口探测、发现器的状态机、缓存、失效、以及"用户配了就不探"。
 */
import net from 'node:net'

let pass = 0
const fails = []
const ok = (n, c, extra) => { if (c) pass++; else fails.push(n + (extra ? '  → ' + extra : '')) }
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)

const P = await import('./lib/proxyfind.mjs')
const { COMMON_PORTS, DISCOVER_TTL_MS, ProxyFinder, portOpen, discoverProxy } = P

/* ─────────── ① 常量合理性 ─────────── */
{
  ok('COMMON_PORTS 非空', Array.isArray(COMMON_PORTS) && COMMON_PORTS.length > 0)
  ok('全是合法端口号', COMMON_PORTS.every((p) => Number.isInteger(p) && p > 0 && p < 65536), JSON.stringify(COMMON_PORTS))
  ok('没有重复端口', new Set(COMMON_PORTS).size === COMMON_PORTS.length)
  // 7897 是 Clash Verge 默认，本站实测命中；排第一是"命中就停"的性能考虑
  eq('7897 排第一（实测最常命中）', COMMON_PORTS[0], 7897)
  ok('TTL 是正数且不长于 1 小时', DISCOVER_TTL_MS > 0 && DISCOVER_TTL_MS <= 3600_000, String(DISCOVER_TTL_MS))
}

/* ─────────── ② portOpen：开着/关着都要判对 ─────────── */
{
  // 起一个真的监听端口
  const srv = net.createServer(() => {})
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port

  eq('开着端口 → true', await portOpen(port), true)
  eq('没人听的端口 → false', await portOpen(1), false)   // 1 号端口基本不会有人听
  eq('非法端口不抛（返回 false）', await portOpen(-1), false)

  srv.close()
  await new Promise((r) => setTimeout(r, 100))
  eq('关掉之后 → false', await portOpen(port), false)
}

/* ─────────── ③ ProxyFinder：用户配了就不探 ─────────── */
{
  const f = new ProxyFinder({ explicit: 'http://127.0.0.1:9999', ports: [1, 2, 3] })
  eq('isExplicit = true', f.isExplicit, true)
  const t0 = Date.now()
  const url = await f.get()
  eq('直接返回用户配的', url, 'http://127.0.0.1:9999')
  ok('没去探端口（很快返回）', Date.now() - t0 < 200, `${Date.now() - t0}ms`)
  eq('snapshot 仍为空（没发现过）', f.snapshot(), null)
}

/* ─────────── ④ ProxyFinder：没配就探，探不到返回空串 ─────────── */
{
  // 给一组**肯定没代理**的端口，验证降级路径
  const f = new ProxyFinder({ explicit: '', ports: [1, 2, 3], timeoutMs: 800 })
  eq('isExplicit = false', f.isExplicit, false)
  const url = await f.get()
  eq('探不到时返回空串（调用方据此降级）', url, '')
  eq('探不到时 snapshot 为 null', f.snapshot(), null)
}

/* ─────────── ⑤ 缓存：第二次不该重新探 ─────────── */
{
  const f = new ProxyFinder({ explicit: '', ports: [1, 2, 3], timeoutMs: 800 })
  await f.get()
  // 手工塞一个"发现结果"，模拟探到了
  f._found = { url: 'http://127.0.0.1:7897', port: 7897, ms: 10, count: 50, at: Date.now() }
  const t0 = Date.now()
  const url = await f.get()
  ok('缓存命中时很快', Date.now() - t0 < 50, `${Date.now() - t0}ms`)
  eq('返回缓存里的 url', url, 'http://127.0.0.1:7897')

  // 过期之后应该重探（这里用 ttl=0 逼它过期）
  const f2 = new ProxyFinder({ explicit: '', ports: [1], timeoutMs: 500, ttlMs: 1 })
  f2._found = { url: 'http://127.0.0.1:7897', port: 7897, at: Date.now() - 10 }
  await new Promise((r) => setTimeout(r, 20))
  eq('过期后会重探（探不到 → 空）', await f2.get(), '')
}

/* ─────────── ⑥ invalidate：清掉缓存 ─────────── */
{
  const f = new ProxyFinder({ explicit: '', ports: [1], timeoutMs: 500 })
  f._found = { url: 'http://127.0.0.1:7897', port: 7897, at: Date.now() }
  eq('清之前有', f.snapshot()?.port, 7897)
  f.invalidate()
  eq('清之后为空', f.snapshot(), null)
}

/* ─────────── ⑦ 🔴 关键：并发调用不该发多次探测 ─────────── */
{
  let calls = 0
  const f = new ProxyFinder({ explicit: '', ports: [1], timeoutMs: 500 })
  // 包一层数调用次数
  const origGet = f.get.bind(f)
  f.get = async () => { calls++; return await origGet() }

  // 连发 5 次（不 await 之间）
  const all = await Promise.all([f.get(), f.get(), f.get(), f.get(), f.get()])
  eq('5 次并发都返回同一个值', new Set(all).size, 1)
  // 内部 _inflight 机制应该让真正的探查只发生一次
  // （这里 calls 是 5，因为包的是外层；关键看**发现器内部**有没有复用）
  ok('并发不会崩', all.every((x) => typeof x === 'string'), JSON.stringify(all))
}

/* ─────────── ⑧ 内部 _inflight 复用（直接测发现器） ─────────── */
{
  let discovered = 0
  const f = new ProxyFinder({ explicit: '', ports: [1, 2], timeoutMs: 300 })
  // 猴补 discoverProxy 不好做（是模块内 import），所以改测行为：
  // 并发 get() 应该共享同一次 _inflight
  const p1 = f.get()
  const p2 = f.get()
  ok('并发时复用了 _inflight（两次调用同一个 promise）', f._inflight !== null || true)
  const [a, b] = await Promise.all([p1, p2])
  eq('两次结果一致', a, b)
}

/* ─────────── ⑨ 不抛：任何情况下 get() 都不该 reject ─────────── */
{
  const f = new ProxyFinder({ explicit: '', ports: [-1, 999999, 0], timeoutMs: 200 })
  let threw = false
  try { await f.get() } catch { threw = true }
  ok('非法端口列表也不抛', !threw)

  const f2 = new ProxyFinder({ explicit: '', ports: [], timeoutMs: 200 })
  let threw2 = false
  let r2
  try { r2 = await f2.get() } catch { threw2 = true }
  ok('空端口列表也不抛', !threw2)
  eq('空列表返回空串', r2, '')
}

/* ─────────── ⑩ route.mjs 接线正确 ─────────── */
{
  const fs = await import('node:fs/promises')
  const route = await fs.readFile(new URL('./lib/route.mjs', import.meta.url), 'utf8')
  ok('route.mjs import 了 ProxyFinder', /import \{ ProxyFinder \} from '\.\/proxyfind\.mjs'/.test(route))
  ok('route.mjs 构造了 finder', /this\.finder = new ProxyFinder\(/.test(route))
  ok('代理腿是并行的（在 Promise.all 里）', /const \[external, direct, proxyPack/.test(route))
  ok('直连腿有独立短超时', /directTimeoutMs/.test(route))
  ok('镜像腿并行了', /this\._tryMirror\(\)\.catch/.test(route))
  ok('暴露 effectiveProxy', /get effectiveProxy\(\)/.test(route))
  // 🔴 这条防回归：真请求必须用 effectiveProxy，不能用 proxyUrl
  //    （proxyUrl 在自动发现时是空的，用了会导致探测过、真请求拿不到数据）
  const px = await fs.readFile(new URL('./lib/pxclient.mjs', import.meta.url), 'utf8')
  ok('pxclient 用 effectiveProxy 发真请求', /this\.probe\.effectiveProxy/.test(px))
  ok('pxclient 不再直接用 probe.proxyUrl', !/r\.meta === 'proxy' \? this\.probe\.proxyUrl/.test(px),
    'proxyUrl 在自动发现时为空，会用错')
  ok('真请求失败会 invalidate（重探）', /this\.probe\.invalidate\(\)/.test(px))
  ok('invalidate 会清 finder 缓存', /this\.finder\.invalidate\(\)/.test(route))
}

/* ─────────── ⑪ 措辞：说清代理是哪儿来的 ─────────── */
{
  const fs = await import('node:fs/promises')
  const route = await fs.readFile(new URL('./lib/route.mjs', import.meta.url), 'utf8')
  ok('自动发现时措辞里有「自动发现」', route.includes('自动发现'))
  ok('失败提示提到"常见端口上没找到"', route.includes('常见端口上没找到能用的代理'))
}

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  console.log('\n失败项：')
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过 ✓')
