/**
 * 出口探测 —— 决定这次用哪条路打 pixiv。
 * ============================================================================
 * 为什么要有这一层（2026-11-04 在本机实测的教训）：
 *   同一台机器十分钟内三种结果：
 *     ① DNS 返回 198.18.0.72（Clash TUN 的 fake-IP）→ 裸 fetch 通，1.2s
 *     ② DNS 返回 157.240.12.5（Facebook 的 IP，DNS 污染）→ 裸 fetch 全超时
 *     ③ DNS 返回 192.133.77.133 → 裸 fetch 全超时，走 7897 代理 3/3 通
 *   ⇒ **不能按 IP 段猜**（fake-IP 时有时无），也**不能写死代理**
 *      （别人的机器可能是 TUN、可能什么都没挂、可能挂着别的端口）。
 *   唯一的判据是：**这条路现在能不能真拿到数据**。
 *
 * ⚠️ 2026-11-06 补充实测（重要）：
 *   本机**直连 pixiv 是硬超时**（8.5s），只有 127.0.0.1:7897 的代理通。
 *   而 DNS 返回的 pixiv 域名 IP 全是**污染地址**（Facebook/Twitter 段，
 *   TCP 直接超时）。所以 pixivpy3 的 `ByPassSniApi`（DoH 查真 IP + SNI 伪装）
 *   在本机**无效** —— 四个 DoH 服务器全不可达。
 *   ⇒ 本机唯一正解是**走代理**。但用户常常不填 proxyUrl（也不知道填什么），
 *     所以这里加了**代理自动发现**（lib/proxyfind.mjs）：探本机常见端口，
 *     找到真能通 pixiv 的就用。这样零配置也能搜到图。
 *
 * 所以：并行探三条腿，谁通用谁；结果缓存一段时间，别每次请求都探。
 * ============================================================================
 */
import { ProxyFinder } from './proxyfind.mjs'

/** 探测用的靶子：一个轻量的官方接口 */
const PROBE_URL = 'https://www.pixiv.net/ranking.php?mode=daily&content=illust&format=json'

/** 探测结果缓存（毫秒） */
const PROBE_TTL_MS = 5 * 60_000

/**
 * 把一个 pixiv 官方地址换到**外部源**的基址上。
 *
 * 外部源的形态约定：**兼容 pixiv 官方接口**（用户填 `http://127.0.0.1:8080`
 * 或 `https://他的反代.com`），插件保持官方路径不变，只换 origin。
 *
 * 例：
 *   https://www.pixiv.net/ranking.php?mode=daily
 *     → http://127.0.0.1:8080/ranking.php?mode=daily
 *
 * 容错：用户填的地址末尾带不带 `/` 都行，带了裸域名也行。
 * 如果用户填的**自带路径**（比如 `http://x/api/pixiv`），就保留那段前缀 ——
 * 有些反代就挂在这个子路径下。
 */
export function rewriteBase(officialUrl, base) {
  const b = String(base || '').trim().replace(/\/+$/, '')
  if (!b) return officialUrl
  let u
  try {
    u = new URL(officialUrl)
  } catch {
    return officialUrl
  }
  // 带协议的直接用；不带协议的就当 http://
  const withProto = /^https?:\/\//i.test(b) ? b : `http://${b}`
  return withProto + u.pathname + u.search
}

/**
 * 三条腿，按优先级：
 *   direct   —— 裸直连（TUN 模式 / 本来就通的机器）
 *   proxy    —— 走用户配的代理（系统代理模式 / 本机常见）
 *   mirror   —— pixiv.re 图片反代（**只有图，没有元数据**）
 */
export const ROUTES = ['direct', 'proxy', 'mirror']

export class RouteProbe {
  constructor(opts = {}) {
    this.proxyUrl = String(opts.proxyUrl || '').trim()
    /**
     * **外部源**：一个用户自己的、能上 pixiv 的 HTTP 端点（兼容 pixiv 官方接口形态）。
     *
     * 典型用法：用户机器上跑着一个能连 pixiv 的客户端/自建反代/自己的服务器，
     * 插件把元数据请求发给它，而不是发给 www.pixiv.net。
     *
     * 优先级最高（见 _run）：用户填了就是明确说了走它，插件不自作主张绕开。
     */
    this.externalApi = String(opts.externalApi || '').trim()
    this.timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 8_000
    /**
     * 直连腿单独的探测超时，**故意比整体短**。
     *
     * 为什么（2026-11-06 实测）：本机直连 pixiv 是"连上了但没响应"，
     * 会一直等到硬超时。而代理腿只要 ~1-2 秒。三条腿并行时整体耗时
     * 取决于**最慢那条**，所以直连腿的 8 秒会把整体拖到 8 秒以上。
     * 实测整体探测 19 秒（当时还是串行）→ 并行后仍需压这里。
     *
     * 取 4 秒：直连真能通的机器通常 <1.5 秒就回来了，
     * 等不到 4 秒的基本就是不通 —— 没必要为它让用户多等。
     */
    this.directTimeoutMs = Number(opts.directTimeoutMs) > 0
      ? Number(opts.directTimeoutMs)
      : Math.min(4_000, this.timeoutMs)
    this.mirrorHost = String(opts.mirrorHost || 'pixiv.re').trim()

    /**
     * 代理自动发现器。用户配了 proxyUrl 就直接用它（不探），
     * 没配才去探本机常见端口 —— 见 _run 里那段说明。
     */
    this.finder = new ProxyFinder({
      explicit: this.proxyUrl,
      timeoutMs: this.timeoutMs,
      log: opts.log || (() => {}),
      ports: opts.proxyPorts,
    })

    /** 探测得出的**实际**可用代理（空 = 不代理）。给 pxclient 复用。 */
    this._effectiveProxy = ''
    this._proxyHow = ''

    this._cache = null // { at, meta: 'external'|'direct'|'proxy'|null, image: [...] }
    this._inflight = null
  }

  /** 缓存是否还新鲜 */
  _fresh() {
    return this._cache && Date.now() - this._cache.at < PROBE_TTL_MS
  }

  /** 丢掉缓存（用户在设置页点了「重测」） */
  invalidate() {
    this._cache = null
    this._inflight = null
    this._effectiveProxy = ''
    this._proxyHow = ''
    try { this.finder.invalidate() } catch { /* ignore */ }
  }

  /** 上次探测的快照，给状态显示用；没有就是 null */
  snapshot() {
    return this._cache ? { ...this._cache } : null
  }

  /**
   * 探一遍。并行跑，谁先通用谁。
   * @returns {Promise<{at:number, meta:'direct'|'proxy'|null, image:string[], detail:object}>}
   */
  /**
   * 探一遍。并行跑，谁先通用谁。
   *
   * ⚠️ 这里有个会**崩进程**的坑，别改回去：
   *    原来写的是 `this._inflight = this._run().finally(...)`，然后 await 它。
   *    但 `_run()` 一旦 reject，`_inflight` 里就存着一个**已 reject 的 promise**；
   *    在没有 await 它的那一小段时间里，Node 会报 unhandled rejection，
   *    默认行为是**直接干掉进程**（刷B站那边"DSH 突然崩了"就是这个味）。
   *    解法：构造时就挂上 catch，保证这个 promise 永远不处于"未处理的 reject"状态。
   * @returns {Promise<{at:number, meta:'direct'|'proxy'|null, image:string[], detail:object}>}
   */
  async probe() {
    if (this._fresh()) return this._cache
    if (this._inflight) return this._inflight
    // 关键：先接住错误，再存起来
    this._inflight = this._run()
      .catch((err) => ({
        at: Date.now(),
        meta: null,
        image: [],
        detail: { error: (err && err.message) ? err.message : String(err) },
      }))
      .finally(() => { this._inflight = null })
    this._cache = await this._inflight
    return this._cache
  }

  async _run() {
    const detail = {}

    // 元数据三条腿并行：**外部源** / 直连 / 代理
    // ⚠️ Promise.all 里任何一条 reject 都会让整个 _run reject —— 所以这里
    //    用 allSettled 语义自己包一层，确保**探测永远只返回结果、不抛**。
    const safe = async (fn) => {
      try { return await fn() } catch (err) {
        return { ok: false, why: (err && err.message ? err.message : String(err)).slice(0, 120) }
      }
    }

    /**
     * 代理那条腿：用户配了就用他的；**没配就自动发现一个本机在跑的**，
     * 发现到了**立刻**用它打一次真请求 —— 这三步连在一起做。
     *
     * 为什么必须连在一起（2026-11-06 实测的性能教训）：
     *   一开始写成"先 resolveProxy() 再 _tryMeta(proxyUrl)"，两段是**串行**的。
     *   加上直连那条腿要等满 8 秒硬超时，整体探测要 **19 秒** 才出结果 ——
     *   用户点一下搜索要等 19 秒，不能接受。
     *   所以：发现和验证合成一条腿，跟直连**并行跑**。整体耗时 = max(直连超时, 代理腿)。
     *
     * ⚠️ 用户**配了**就不探 —— 那是明确指示，不许自作主张（同 externalApi 的规矩）。
     */
    const proxyLeg = async () => {
      let url = ''
      let how = 'none'
      if (this.proxyUrl) {
        url = this.proxyUrl
        how = 'explicit'
      } else {
        try {
          const found = await this.finder.get()
          if (found) { url = found; how = 'auto' }
        } catch { /* 发现失败就当没有 */ }
      }
      if (!url) {
        return { res: { ok: false, why: how === 'none' ? '没配代理，自动发现也没找到' : '未配代理' }, url, how }
      }
      const res = await safe(() => this._tryMeta(url))
      res.via = how === 'auto' ? '自动发现' : '用户配置'
      res.url = url
      return { res, url, how }
    }

    const [external, direct, proxyPack, mirrorOk] = await Promise.all([
      this.externalApi ? safe(() => this._tryMeta(undefined, this.externalApi)) : Promise.resolve({ ok: false, why: '未配外部源' }),
      safe(() => this._tryMeta(undefined, undefined, this.directTimeoutMs)),
      proxyLeg(),
      this._tryMirror().catch(() => false),
    ])
    const proxy = proxyPack.res
    const proxyRes = { url: proxyPack.url, how: proxyPack.how }

    detail.external = external
    detail.direct = direct
    detail.proxy = proxy

    // 🔴 记住这一轮到底用了哪个代理 —— 后面的请求（图片/详情）要复用，
    //    不能每发一次请求都重新发现一遍。
    this._effectiveProxy = proxy.ok ? proxyRes.url : ''
    this._proxyHow = proxy.ok ? proxyRes.how : ''

    // 优先级：**外部源 > 直连 > 代理**
    // 为什么外部源排第一：用户既然填了地址，就是明确说了"走这个" ——
    // 他有能上 pixiv 的客户端/自建反代，插件不该自作主张绕开它去直连。
    let meta = null
    if (external.ok) meta = 'external'
    else if (direct.ok) meta = 'direct'
    else if (proxy.ok) meta = 'proxy'

    // 图片腿：官方两条 + 镜像，全都探一下（图片和元数据的可达性未必一致）
    // ⚠️ 镜像这条**跟元数据并行跑**：实测它不通时会一直等到超时，
    //    放在后面串行会把整体探测拖长好几秒。
    const image = []
    if (meta) image.push('official')
    if (mirrorOk) image.push('mirror')
    detail.mirror = image.includes('mirror')
    detail.proxyHow = this._proxyHow || undefined

    return { at: Date.now(), meta, image, detail }
  }

  /**
   * 当前**实际可用**的代理 URL（供 pxclient 发真请求时复用）。
   * 没探测过 / 不需要代理 / 没有可用代理 → 返回空字符串。
   */
  get effectiveProxy() {
    return this._effectiveProxy || ''
  }


  /**
   * 探元数据：能不能拿到官方 json。
   * @param {string|undefined} proxy  走哪个代理（不给=直连）
   * @param {string} [baseOverride]   外部源基址；给了就用它替换 pixiv 的域名
   * @param {number} [timeoutMs]      这次探测的超时（不给用默认）
   */
  async _tryMeta(proxy, baseOverride, timeoutMs) {
    const t0 = Date.now()
    try {
      const { httpGet } = await import('./transport.mjs')
      const url = baseOverride ? rewriteBase(PROBE_URL, baseOverride) : PROBE_URL
      const res = await httpGet(url, {
        proxyUrl: proxy,
        timeoutMs: Number(timeoutMs) > 0 ? Number(timeoutMs) : this.timeoutMs,
      })
      if (res.status !== 200) return { ok: false, why: `HTTP ${res.status}`, ms: Date.now() - t0 }
      const j = JSON.parse(res.body.toString('utf8'))
      const n = (j && j.contents && j.contents.length) || 0
      return { ok: n > 0, why: n > 0 ? '' : '返回空', count: n, ms: Date.now() - t0 }
    } catch (err) {
      return { ok: false, why: (err && err.message ? err.message : String(err)).slice(0, 120), ms: Date.now() - t0 }
    }
  }

  /**
   * 探镜像：pixiv.re 能不能出图。
   *
   * ⚠️ 超时故意给得短（默认 3 秒），而且它在 _run 里**不跟元数据腿并行**
   *    —— 元数据才是"能不能搜到图"的关键，镜像只是取图兜底。
   *    实测：镜像不通时会一直等到超时，把整体探测从 4 秒拖到 14 秒。
   *    镜像只是加分项，不该让用户多等这么久。
   */
  async _tryMirror() {
    const url = `https://${this.mirrorHost}/151616953.jpg`
    try {
      const { httpGet } = await import('./transport.mjs')
      const res = await httpGet(url, { timeoutMs: Math.min(3_000, this.timeoutMs) })
      return res.status === 200 && res.body.length > 1000
    } catch {
      return false
    }
  }

  /**
   * 给使用者看的一句话结论 —— 设置页和报错都用它。
   */
  describe() {
    const c = this._cache
    if (!c) return '还没测过'
    const parts = []
    const how = (c.detail && c.detail.proxyHow) || ''
    if (c.meta === 'external') parts.push('外部源 ✓')
    else if (c.meta === 'direct') parts.push('官方直连 ✓')
    else if (c.meta === 'proxy') {
      // 说清代理是哪儿来的 —— 用户没配却通了，得让他知道插件自己找了
      parts.push(how === 'auto' ? '官方经代理 ✓（自动发现）' : '官方经代理 ✓')
    } else parts.push(this.externalApi ? '外部源 ✗' : '官方 ✗')
    parts.push(c.image.includes('mirror') ? '镜像 ✓' : '镜像 ✗')

    if (!c.meta && !c.image.length) {
      const why = []
      why.push('完全打不通 pixiv。')
      if (this.externalApi) {
        const ex = (c.detail && c.detail.external) || {}
        why.push(`外部源（${this.externalApi}）也不通${ex.why ? '：' + ex.why : ''}。`)
      }
      if (this.proxyUrl) {
        why.push(`你配的代理（${this.proxyUrl}）不通。`)
      } else {
        const pr = (c.detail && c.detail.proxy) || {}
        why.push(`本机常见端口上没找到能用的代理${pr.why ? '（' + pr.why + '）' : ''}。`)
        why.push('开一个代理（Clash 之类）再试，或在设置页手填代理地址；')
      }
      why.push('也可以填一个能上 pixiv 的「外部源」。')
      return parts.join(' · ') + '\n  → ' + why.join('')
    }
    if (!c.meta && c.image.includes('mirror')) {
      return parts.join(' · ') + '\n  → 只能按作品 ID 取图，不能搜索/排行（镜像没有元数据接口）。'
    }
    return parts.join(' · ')
  }
}
