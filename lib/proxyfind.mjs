/**
 * 代理自动发现 —— 让插件「零配置也能搜到图」。
 * ============================================================================
 * 为什么需要它（2026-11-06 在本机实测出来的）：
 *
 *   这台机器**直连 pixiv 不通**（8.5 秒硬超时），而 127.0.0.1:7897 上的
 *   Clash 代理通（HTTP 200 / 50 条 / 1.1 秒）。
 *
 *   但插件原来不会自己找代理：用户不填 `proxyUrl`，三条腿（外部源/直连/代理）
 *   就全不通，只剩镜像那条 —— 而**镜像没有元数据接口，搜索和排行都用不了**。
 *   对使用者来说就是"这插件搜不出东西"，但他其实**本地明明挂着代理**。
 *
 *   ⇒ 所以自动探一遍常见端口，找到能用的就用。用户不用知道 7897 是什么。
 *
 * ⚠️ 两条设计红线：
 *   1. **只在用户没配 proxyUrl 时才探**。填了就是明确说了走那个，不许自作主张
 *      （跟 route.mjs 里 externalApi 优先级最高的道理一样）。
 *   2. **探测结果是缓存 + 可失效的**。代理软件会被关掉/换端口，所以结果带 TTL，
 *      而且真请求失败时会丢缓存重探。
 *
 * ⚠️ 不要把这个当成"翻墙功能"。它**只是发现本机已经在跑的代理**，
 *    不建隧道、不带自己的服务器、不绕过任何限制。
 * ============================================================================
 */
import net from 'node:net'
import { httpGet } from './transport.mjs'

/**
 * 常见本地代理端口，**按流行度排**（命中就停）。
 *
 * 只用 127.0.0.1 —— 局域网里的代理不该被自动发现（那是安全边界：
 * 你不希望插件悄悄把流量发给别人的机器）。
 */
export const COMMON_PORTS = [
  7897,  // Clash Verge / Mihomo（本站实测最常命中）
  7890,  // Clash for Windows
  7899,  // Clash 混合端口
  10809, // v2rayN（HTTP）
  10808, // v2rayN（SOCKS，也常兼 HTTP）
  1080,  // 通用 SOCKS/HTTP
  12000, // 某些机场客户端
  8888,  // 通用
  20171, // 某些国产客户端
  8080,  // 通用
]

/** 探测结果缓存多久（毫秒） */
export const DISCOVER_TTL_MS = 10 * 60_000

/** 单个端口的 TCP 探测超时 —— 要短，不然十个端口串起来要好几秒 */
const TCP_TIMEOUT_MS = 400

/** 用公开排行接口当靶子：轻量、无需登录、返回可校验的 json */
const PROBE_URL = 'https://www.pixiv.net/ranking.php?mode=daily&content=illust&format=json'

/** 端口开着吗（只探 TCP，不等握手） */
export function portOpen(port, host = '127.0.0.1', timeoutMs = TCP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false
    let sock
    const fin = (v) => {
      if (done) return
      done = true
      try { sock && sock.destroy() } catch { /* ignore */ }
      resolve(v)
    }
    try {
      sock = net.connect({ host, port })
    } catch {
      fin(false)
      return
    }
    sock.setTimeout(timeoutMs, () => fin(false))
    sock.on('connect', () => fin(true))
    sock.on('error', () => fin(false))
  })
}

/**
 * 探一个端口**能不能真拿到 pixiv 数据**。
 * ⚠️ 只探到「端口开着」是不够的 —— 别的软件也可能占着那个端口，
 *    或者代理开着但规则没放行 pixiv。所以必须真发一次请求验证。
 */
async function proxyWorks(url, timeoutMs) {
  try {
    const r = await httpGet(PROBE_URL, { proxyUrl: url, timeoutMs })
    if (r.status !== 200) return null
    const j = JSON.parse(r.body.toString('utf8'))
    const n = (j && j.contents && j.contents.length) || 0
    return n > 0 ? n : null
  } catch {
    return null
  }
}

/**
 * 自动发现一个可用的本地代理。
 *
 * @param {object} [o]
 * @param {number} [o.timeoutMs]  每个候选的请求超时
 * @param {number[]} [o.ports]    自定义端口列表（默认 COMMON_PORTS）
 * @param {(m:string)=>void} [o.log]
 * @returns {Promise<{url:string, port:number, ms:number, count:number}|null>}
 */
export async function discoverProxy(o = {}) {
  const ports = Array.isArray(o.ports) && o.ports.length ? o.ports : COMMON_PORTS
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : 8_000
  const log = o.log || (() => {})

  // 先并行摸一遍哪些端口开着（便宜，快）
  const opened = (await Promise.all(ports.map(async (p) => ((await portOpen(p)) ? p : null)))).filter(Boolean)
  if (!opened.length) {
    log('代理自动发现：没发现任何候选端口在听')
    return null
  }
  log(`代理自动发现：端口开着的有 ${opened.join(', ')}，逐个验证能不能通 pixiv`)

  // 再串行验证（避免同时压一堆连接），按端口列表顺序
  for (const port of opened) {
    const url = `http://127.0.0.1:${port}`
    const t0 = Date.now()
    const count = await proxyWorks(url, timeoutMs)
    const ms = Date.now() - t0
    if (count) {
      log(`代理自动发现：✓ ${url} 可用（${count} 条 / ${ms}ms）`)
      return { url, port, ms, count }
    }
    log(`代理自动发现：✗ ${url} 端口开着但拿不到 pixiv 数据`)
  }
  log('代理自动发现：候选端口都不通 pixiv')
  return null
}

/**
 * 带缓存的发现器。给 RouteProbe 用。
 *
 * 为什么要有状态：自动发现要发真请求，不能每次 search 都探一遍。
 * 但也不能永远信 —— 代理软件会关、端口会变，所以带 TTL + 手动失效。
 */
export class ProxyFinder {
  /**
   * @param {object} [o]
   * @param {string} [o.explicit]  用户显式配的代理；给了就直接用它，不自动探
   * @param {number} [o.ttlMs]
   * @param {number} [o.timeoutMs]
   * @param {(m:string)=>void} [o.log]
   */
  constructor(o = {}) {
    this.explicit = String(o.explicit || '').trim()
    this.ttlMs = Number(o.ttlMs) > 0 ? Number(o.ttlMs) : DISCOVER_TTL_MS
    this.timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : 8_000
    this.log = o.log || (() => {})
    this.ports = Array.isArray(o.ports) && o.ports.length ? o.ports : COMMON_PORTS
    this._found = null   // { url, port, ms, count, at }
    this._inflight = null
  }

  /** 用户显式配了没有 */
  get isExplicit() {
    return this.explicit !== ''
  }

  /**
   * 拿一个可用的代理 URL。
   * @returns {Promise<string>} 空字符串 = 没有可用代理（调用方据此降级）
   */
  async get() {
    if (this.isExplicit) return this.explicit   // 🔴 用户说了算，不探
    if (this._found && Date.now() - this._found.at < this.ttlMs) return this._found.url
    if (this._inflight) return this._inflight
    // 关键：先把错误接住再存，否则会有 unhandled rejection 崩进程（route.mjs 踩过）
    this._inflight = discoverProxy({ ports: this.ports, timeoutMs: this.timeoutMs, log: this.log })
      .then((r) => {
        this._found = r ? { ...r, at: Date.now() } : null
        return r ? r.url : ''
      })
      .catch(() => { this._found = null; return '' })
      .finally(() => { this._inflight = null })
    return this._inflight
  }

  /** 丢掉缓存（请求失败时调；设置页「重测」也调） */
  invalidate() {
    this._found = null
    this._inflight = null
  }

  /** 上次发现的结果，给状态显示 */
  snapshot() {
    return this._found ? { ...this._found } : null
  }
}
