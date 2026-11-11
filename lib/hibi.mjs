/**
 * 无代理那条路 —— HibiAPI 拿元数据 + 镜像固定 IP 拿图。
 * ============================================================================
 * 为什么有这一层（2026-11-09 本机实测，有线直连，无本地代理）：
 *
 *   · pixiv 官方的真 IP（210.140.x 段，10 个）**TCP 443 全超时**，80 也不通；
 *     同时段 github / yahoo.co.jp / dmm.co.jp 秒通 ⇒ 是**针对 pixiv 的 IP 黑洞**。
 *     ⇒ pixivpy3 的 ByPassSniApi（DoH 查真 IP + SNI 伪装）救不了：
 *       查到真 IP 也连不上。所以**没有集成它**。
 *   · HibiAPI 公共实例（hibiapi.getloli.com）走系统 DNS 直连能用：
 *       日榜 30 条、详情 1s、返回的是 pixiv **App-API 原生格式**。
 *     但不稳：同一个请求三次分别 17s / 超时 / 2s ⇒ **必须重试**。
 *   · pixiv.re 的系统 DNS 结果是污染地址（连不上），
 *     但**直接连 Cloudflare 的 104.x 节点**、SNI 填域名就是 200：
 *       i.pixiv.re + i.pximg.net 的原路径  →  原图 / master / 缩略图 都通
 *       pixiv.re/<id>-1.jpg                 →  对 png 原图 404（扩展名得猜对）
 *     ⇒ 有 HibiAPI 给的真实地址时，**走 i.pixiv.re 换主机名**，不猜扩展名。
 *
 * ⚠️ 隐私：走这条路时，**搜索词会发给第三方服务器**（老大 2026-11-09 点过头）。
 *    登录相关（refresh token）**永远不走这里**。
 * ⚠️ 这是"今天中午测通"的路，不保证长期有效 ⇒ 可关（hibiEnabled），
 *    并且只在 外部源 / 直连 / 代理 都不通时才被选中。
 * ============================================================================
 */
import { httpGet } from './transport.mjs'

export const DEFAULT_HIBI = 'https://hibiapi.getloli.com'

/**
 * Cloudflare 节点池（pixiv.re 挂在 CF 上）。2026-11-09 实测：
 *   104.18.42.239 / 104.17.0.1 / 104.16.0.1 对 i.pixiv.re 原图路径都是 200；
 *   172.67.135.150（系统 DNS 给的那个）不通。
 * 其余几个是同网段候选，探测时一起试，谁通用谁。用户可以在设置里补。
 */
export const MIRROR_IP_POOL = [
  '104.18.42.239', '104.17.0.1', '104.16.0.1', '104.21.0.1',
  '104.18.32.47', '104.19.192.29', '172.67.0.1', '188.114.96.1',
]

/**
 * 探测用的靶子：一张**已验证存在**的 360px 缩略图（16KB，探起来快）。
 * ⚠️ 作品被删了这条就会失效 —— 那时探测会报"镜像不通"，换一张就行。
 */
export const MIRROR_PROBE_PATH =
  '/c/360x360_70/img-master/img/2024/01/01/11/17/08/114770345_p0_square1200.jpg'

/** 网页排行模式 → HibiAPI（App-API）的 mode */
export const RANK_MODE_MAP = {
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
  rookie: 'week_rookie',
  original: 'week_original',
  male: 'day_male',
  female: 'day_female',
}

/** 网页搜索排序 → App-API 排序 */
export function searchOrderOf(order) {
  if (order === 'popular_d') return 'popular_desc'
  if (order === 'date_a') return 'date_asc'
  return 'date_desc'
}

/** 镜像的"换主机名"形态：pixiv.re → i.pixiv.re（已经是 i. 开头就不动） */
export function pathHostOf(mirrorHost) {
  const h = String(mirrorHost || 'pixiv.re').trim()
  return /^i\./.test(h) ? h : `i.${h}`
}

/** i.pximg.net 直链 → 镜像同路径；不是 pximg 的原样返回空串 */
export function toMirrorUrl(pximgUrl, mirrorHost) {
  const u = String(pximgUrl || '')
  const m = /^https:\/\/i\.pximg\.net(\/.+)$/.exec(u)
  return m ? `https://${pathHostOf(mirrorHost)}${m[1]}` : ''
}

/** 规范化 HibiAPI 基址：带协议、末尾无斜杠；空 = 默认实例 */
export function normalizeHibiBase(s) {
  const t = String(s || '').trim().replace(/\/+$/, '')
  if (!t) return DEFAULT_HIBI
  return /^https?:\/\//i.test(t) ? t : `https://${t}`
}

/**
 * 请求 HibiAPI 的 pixiv 接口，带重试。
 * @param {string} base
 * @param {string} path   'rank' / 'search' / 'illust' / 'member_illust'
 * @param {object} params
 * @param {object} o      { timeoutMs, tries }
 */
export async function hibiGet(base, path, params = {}, o = {}) {
  const tries = Math.max(1, Number(o.tries) || 3)
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : 20_000
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)]),
  ).toString()
  const url = `${normalizeHibiBase(base)}/api/pixiv/${path}${qs ? '?' + qs : ''}`
  let last = ''
  for (let i = 0; i < tries; i++) {
    try {
      const res = await httpGet(url, { timeoutMs, headers: { Accept: 'application/json' } })
      if (res.status !== 200) { last = `HTTP ${res.status}`; continue }
      const j = JSON.parse(res.body.toString('utf8'))
      // HibiAPI 把 pixiv 的报错原样透传：{ error: { message, user_message } }
      if (j && j.error && typeof j.error === 'object') {
        const msg = j.error.user_message || j.error.message || JSON.stringify(j.error).slice(0, 80)
        // pixiv 自己说的错（比如作品被删）重试也没用，直接抛
        const e = new Error(`HibiAPI 透传 pixiv 报错：${msg}`)
        e.fatal = true
        throw e
      }
      return j
    } catch (err) {
      if (err && err.fatal) throw err
      last = (err && err.message ? err.message : String(err)).split('\n')[0].slice(0, 100)
    }
  }
  throw new Error(`HibiAPI 连续 ${tries} 次没拿到：${last}（${url.replace(/\?.*$/, '')}）`)
}

/**
 * 找一个能出图的镜像 IP。
 * 先试**不固定**（系统 DNS 万一是干净的就不用折腾），再把池子**并行**全试一遍，
 * 取最快通的那个。
 * @returns {Promise<{ok:boolean, pin:string, ms:number, why:string, tried:number}>}
 *   pin = '' 且 ok = true 表示系统 DNS 就能用
 */
export async function findMirrorIp(mirrorHost, o = {}) {
  const host = pathHostOf(mirrorHost)
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : 6_000
  const extra = Array.isArray(o.extraIps) ? o.extraIps.map(String).filter(Boolean) : []
  const pool = [...new Set([...extra, ...MIRROR_IP_POOL])]
  const url = `https://${host}${MIRROR_PROBE_PATH}`
  const fetchOne = async (ip) => {
    const t0 = Date.now()
    const res = await httpGet(url, {
      timeoutMs,
      resolve: ip ? { [host]: ip } : undefined,
      maxBytes: 2 * 1024 * 1024,
    })
    const okImg = res.status === 200 && res.body.length > 1000 &&
      /^image\//.test(String(res.headers['content-type'] || 'image/'))
    if (!okImg) throw new Error(`HTTP ${res.status} ${res.body.length}B`)
    return { ip, ms: Date.now() - t0 }
  }
  const candidates = ['', ...pool]
  /**
   * ⚠️ 要**所有**通的 IP，不只最快那个（2026-11-09 实测）：
   *   同一张原图，104.16.0.1 5.9s 下完 24MB，104.18.42.239 只有 21KB/s；
   *   另一张图两个 IP 的表现**正好反过来**。快慢是"这个节点缓存了没有"，
   *   不是 IP 本身的好坏 ⇒ 取图时得能换节点重试，所以探测结果要留一串。
   */
  const settled = await Promise.allSettled(candidates.map((ip) => fetchOne(ip)))
  const good = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value)
    .sort((a, b) => a.ms - b.ms)
  if (!good.length) {
    return { ok: false, pin: '', pins: [], ms: 0, why: `系统 DNS 和 ${pool.length} 个固定 IP 都没出图`, tried: candidates.length }
  }
  return { ok: true, pin: good[0].ip, pins: good.map((g) => g.ip), ms: good[0].ms, why: '', tried: candidates.length }
}

/** App-API 的 type 字符串 → 网页接口的 illustType 数字 */
export function illustTypeOf(t) {
  if (t === 'manga') return 1
  if (t === 'ugoira') return 2
  const n = Number(t)
  return Number.isFinite(n) ? n : 0
}

/** 一件作品所有页的原图地址（App-API 形状） */
export function originalsOf(x) {
  const mp = Array.isArray(x && x.meta_pages) ? x.meta_pages : []
  if (mp.length) {
    return mp.map((p) => String((p.image_urls && (p.image_urls.original || p.image_urls.large)) || '')).filter(Boolean)
  }
  const one = x && x.meta_single_page && x.meta_single_page.original_image_url
  return one ? [String(one)] : []
}
