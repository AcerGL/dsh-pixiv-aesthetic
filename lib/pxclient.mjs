/**
 * pixiv 网络层 —— 只做「读」。
 * ============================================================================
 * 三条硬规矩（都是踩出来的）：
 *   1. 能不能连上 pixiv **取决于运行环境**，不能写死。本机 2026-11-04 实测：
 *      同一地址十分钟内 TUN 时通时不通、裸直连整体超时、走代理 3/3 通
 *      ⇒ 交给 route.mjs 去探，别在代码里假设。
 *   2. i.pximg.net 的图**必须带 Referer: https://www.pixiv.net/**，否则 403。
 *   3. 排行/搜索的 json 里本来就混着露骨封面的作品（实测 daily 前 50 有 5 条
 *      sexual>0）。所以过滤是标配，不是可选项。
 *
 * 元数据只走 Web 的 ajax 接口，不需要登录、不需要 token。
 * 图片两条腿：官方 i.pximg.net，以及镜像 pixiv.re（**只有图，没有元数据**）。
 * ============================================================================
 */
import { httpGet, TransportError } from './transport.mjs'
import { RouteProbe, rewriteBase } from './route.mjs'

export { TransportError }
export { UA, REFERER } from './transport.mjs'

/** 排行模式 → 中文名，给报告用的 */
export const RANK_MODES = {
  daily: '今日',
  weekly: '本周',
  monthly: '本月',
  rookie: '新人',
  original: '原创',
  male: '男性向',
  female: '女性向',
}

export class PixivError extends Error {
  constructor(message, detail) {
    super(message)
    this.name = 'PixivError'
    this.detail = detail
  }
}

export class PixivClient {
  constructor(opts = {}) {
    this.timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 25_000
    this.probe = new RouteProbe({
      proxyUrl: opts.proxyUrl,
      externalApi: opts.externalApi,
      mirrorHost: opts.mirrorHost || 'pixiv.re',
      timeoutMs: Number(opts.probeTimeoutMs) > 0 ? Number(opts.probeTimeoutMs) : 8_000,
    })
    /** 可选登录会话（lib/auth.mjs 的 Session）。没有就是游客模式。 */
    this.session = opts.session || null
    /**
     * ⚠️ 把「实际可用的代理」喂给登录会话。
     *
     * 为什么：Session.apiGet 要给 App API 发请求，而本机直连 pixiv 不通。
     * 用户没填 proxyUrl 时靠 **自动发现** 才拿到代理 —— 那个结果在 probe 里，
     * Session 自己看不到。不给它的话就是「个性化推荐取不到：连不上」。
     * 踩过一次（2026-11-06），所以在这里接上。
     */
    if (this.session && typeof this.session.setEffectiveProxy === 'function') {
      this.session.setEffectiveProxy(() => this.probe.effectiveProxy)
    }
  }

  /** 当前走哪条路（按需探测并缓存） */
  async route() {
    return await this.probe.probe()
  }

  /** 给使用者看的一句话 */
  async status() {
    await this.route()
    return this.probe.describe()
  }

  /** 有没有登录可用（没配就返回 null，调用方降级到游客） */
  async _tok() {
    if (!this.session) return null
    try {
      return await this.session.token()
    } catch (err) {
      // 登录出问题不该让整个插件挂掉 —— 记下来，降级成游客
      this.lastAuthError = err && err.message ? err.message : String(err)
      return null
    }
  }

  /** 本次会话是不是以登录身份在跑 */
  async usingLogin() {
    return !!(await this._tok())
  }

  /**
   * 元数据出口。**镜像没有元数据接口**，所以拿不到路就直接报错 ——
   * 静默返回 0 条比报错难查得多。
   *
   * 走哪条路（按探测结果，优先级见 lib/route.mjs 的 _run）：
   *   external → 用户配的**外部源**（能上 pixiv 的客户端/反代/自己的服务器）
   *   direct   → 官方直连
   *   proxy    → 官方经代理
   */
  async _meta(url) {
    const r = await this.route()
    if (!r.meta) {
      throw new PixivError(
        '现在拿不到 pixiv 的元数据（搜索/排行/详情都需要它）。\n' + this.probe.describe(),
      )
    }
    // 外部源：保持官方路径，只换 origin（见 route.mjs 的 rewriteBase）
    const target = r.meta === 'external' ? rewriteBase(url, this.probe.externalApi) : url
    // ⚠️ 用 probe.effectiveProxy，**不是** probe.proxyUrl ——
    //    后者在「自动发现代理」时是空的，直接用会导致探测过得去、真请求拿不到数据。
    const proxyUrl = r.meta === 'proxy' ? this.probe.effectiveProxy : undefined
    const res = await httpGet(target, { proxyUrl, timeoutMs: this.timeoutMs })
    if (res.status !== 200) {
      // 真请求失败 ⇒ 丢掉探测缓存，下次重新选路（代理可能被关了/换了端口）
      this.probe.invalidate()
      throw new PixivError(`pixiv 返回 HTTP ${res.status}：${target}`)
    }
    try {
      return JSON.parse(res.body.toString('utf8'))
    } catch {
      throw new PixivError(`pixiv 返回的不是 JSON（HTTP ${res.status}）：${url}`)
    }
  }

  /** 探活 + 说清楚现在什么状况。设置页「测一下」用 */
  async ping() {
    const t0 = Date.now()
    this.probe.invalidate()
    const r = await this.route()
    return {
      ok: !!r.meta,
      mirror: r.image.includes('mirror'),
      ms: Date.now() - t0,
      text: this.probe.describe(),
      detail: r.detail,
    }
  }

  /* ─────────────────── 搜索 / 排行 ─────────────────── */

  /** 标签/关键词搜索 */
  async search({ word, order = 'date_d', page = 1, searchTarget = 'partial_match_for_tags' }) {
    const w = String(word || '').trim()
    if (!w) throw new PixivError('搜索关键词不能为空')
    const qs = new URLSearchParams({
      word: w,
      order,
      mode: 'all',
      p: String(page),
      s_mode: searchTarget,
      type: 'all',
      lang: 'zh',
    })
    const url =
      'https://www.pixiv.net/ajax/search/artworks/' + encodeURIComponent(w) + '?' + qs.toString()
    const json = await this._meta(url)
    if (json && json.error) throw new PixivError(`pixiv 搜索报错：${json.message || '未知'}`)
    const im = (json && json.body && json.body.illustManga) || {}
    const data = Array.isArray(im.data) ? im.data : []
    return { total: Number(im.total) || 0, items: data.map((d) => normalizeSearchItem(d, w)) }
  }

  /** 排行榜 */
  async ranking({ mode = 'daily', page = 1 } = {}) {
    const url =
      'https://www.pixiv.net/ranking.php?' +
      new URLSearchParams({
        mode: String(mode),
        content: 'illust',
        format: 'json',
        p: String(page),
      }).toString()
    const json = await this._meta(url)
    const contents = Array.isArray(json && json.contents) ? json.contents : []
    return { mode, items: contents.map((c) => normalizeRankItem(c)) }
  }

  /** 作品详情 */
  async detail(illustId) {
    const id = String(illustId || '').trim()
    if (!/^\d+$/.test(id)) throw new PixivError(`illust id 不合法：${illustId}`)
    const json = await this._meta(`https://www.pixiv.net/ajax/illust/${id}`)
    if (json && json.error) throw new PixivError(`取详情失败：${json.message || ''}`)
    const b = (json && json.body) || {}
    // ⚠️ 坑：/ajax/illust/<id> 的 body.tags 是**对象**
    //    { authorId, isLocked, tags:[{tag,...}] }，
    //    而搜索接口的 tags 是**字符串数组**。两种形状都要吃。
    const rawTags = b.tags
    const tagList = Array.isArray(rawTags)
      ? rawTags
      : rawTags && Array.isArray(rawTags.tags)
        ? rawTags.tags
        : []
    const tags = tagList
      .map((t) =>
        typeof t === 'string'
          ? t
          : t && (t.tag || (t.translation && (t.translation.zh || t.translation.en))),
      )
      .filter(Boolean)
      .map(String)

    return {
      id,
      title: String(b.illustTitle || b.title || '').trim() || `illust_${id}`,
      description: String(b.description || '').trim(),
      userId: String(b.userId || ''),
      userName: String(b.userName || ''),
      tags,
      pageCount: Number(b.pageCount) || 1,
      width: Number(b.width) || 0,
      height: Number(b.height) || 0,
      illustType: Number(b.illustType) || 0, // 0=插画 1=漫画 2=动图
      xRestrict: Number(b.xRestrict) || 0, // 1 = R-18
      aiType: Number(b.aiType) || 0, // 2 = AI 生成
      createDate: String(b.createDate || ''),
      viewCount: Number(b.viewCount) || 0,
      bookmarkCount: Number(b.bookmarkCount) || 0,
      likeCount: Number(b.likeCount) || 0,
      url: `https://www.pixiv.net/artworks/${id}`,
    }
  }

  /** 作品的每一页地址 */
  async pages(illustId) {
    const id = String(illustId || '').trim()
    const json = await this._meta(`https://www.pixiv.net/ajax/illust/${id}/pages`)
    if (json && json.error) throw new PixivError(`取页列表失败：${json.message || ''}`)
    const body = Array.isArray(json && json.body) ? json.body : []
    return body.map((p, i) => ({
      page: i,
      url: String((p.urls && (p.urls.original || p.urls.regular)) || ''),
      width: Number(p.width) || 0,
      height: Number(p.height) || 0,
    }))
  }

  /* ─────────────────── 登录才有：关注流 / 推荐 ─────────────────── */
  /*
   * ⚠️ 这两个走 app-api.pixiv.net + Bearer token。
   *    实测网页 cookie **喂不动**（全是 404），必须 App API。
   *    没登录就返回空数组 + 一句说明，让上层如实降级，别假装有结果。
   */

  /**
   * 一个画师的**全部作品**。
   * ============================================================================
   * ⚠️ 为什么不用搜索（2026-11-05 实测踩到的坑）：
   *   · `user:画师名` 这个搜索语法**恒返回 0** —— 不工作
   *   · 直接搜画师名更糟：搜「幸永」拿回 3 条，画师 id 是**别人**的（6278780）
   *   ⇒ 按画师捞作品必须走这个接口，它吃数字 userId，返回稳定的 id 列表。
   *
   * 返回的是一堆**只有 id** 的条目（这个接口不给标题/标签），
   * 所以拿到 id 后还得逐个取详情 —— 因此这里限制数量，别一次拉几百个。
   * ============================================================================
   * @param {string|number} userId
   * @param {object} [o]
   * @param {number} [o.limit] 最多返回几个（默认 24）
   */
  async byArtist(userId, o = {}) {
    const id = String(userId || '').trim()
    if (!/^\d+$/.test(id)) throw new PixivError(`画师 id 不合法：${userId}`)
    const limit = Math.min(200, Math.max(1, Number(o.limit) || 24))

    const json = await this._meta(`https://www.pixiv.net/ajax/user/${id}/profile/all`)
    if (json && json.error) throw new PixivError(`取画师作品失败：${json.message || ''}`)
    const b = (json && json.body) || {}
    // 接口给的是 { illusts: {id: null, ...}, manga: {id: null, ...} }
    // ⚠️ 值是 null，只有键有用；顺序大致是从新到旧，但**别依赖它**
    const ids = [
      ...Object.keys(b.illusts || {}),
      ...Object.keys(b.manga || {}),
    ].filter((x) => /^\d+$/.test(x))

    return { userId: id, total: ids.length, ids: ids.slice(0, limit) }
  }

  /**
   * 你关注的人的新作。
   * @param {object} [o]
   * @param {number} [o.limit]
   */
  async following({ limit = 30 } = {}) {
    return await this._appFeed(
      '/v2/illust/follow',
      { restrict: 'public' },
      limit,
      'follow',
      '关注流',
    )
  }

  /**
   * 个性化推荐（登录才准）。
   */
  async recommended({ limit = 30 } = {}) {
    return await this._appFeed(
      '/v1/illust/recommended',
      { content_type: 'illust', include_ranking_label: 'true' },
      limit,
      'recommend',
      '个性化推荐',
    )
  }

  /**
   * App API 取一个池子。
   * ⚠️ 红线：**登录相关的任何失败都不能往外抛** —— 没登录、token 过期、
   *    网络不通，全部降级成"空结果 + 说明"。理由：登录是可选的，
   *    它出问题不该让"刷图"整件事挂掉。
   */
  async _appFeed(path, params, limit, source, label) {
    if (!(await this.usingLogin())) {
      return { items: [], skipped: true, why: `没登录，拿不到${label}` }
    }
    try {
      const j = await this.session.apiGet(path, params)
      const arr = Array.isArray(j && j.illusts) ? j.illusts.slice(0, limit) : []
      return { items: arr.map((x) => normalizeAppItem(x, source)), total: arr.length }
    } catch (err) {
      const why = (err && err.message ? err.message : String(err)).split('\n')[0]
      this.lastAuthError = why
      return { items: [], skipped: true, why: `${label}取不到：${why}` }
    }
  }

  /* ─────────────────── 取字节 ─────────────────── */

  /**
   * 下载一张图。先试官方，不行退镜像。
   * @param {string} url   官方 i.pximg.net 直链（可空，只有镜像时用 illustId）
   * @param {object} [o]
   * @param {number} [o.page]      第几页（0 起）
   * @param {string} [o.illustId]  镜像拼 URL 用
   * @param {number} [o.pageCount] 作品总页数（决定镜像用单页式还是多页式）
   */
  async image(url, o = {}) {
    const maxBytes = Number(o.maxBytes) || 24 * 1024 * 1024
    const u = String(url || '').trim()
    if (!u && !o.illustId) throw new PixivError('图片地址为空')
    if (u && !/^https:\/\/i\.pximg\.net\//.test(u)) {
      throw new PixivError(`只允许从 i.pximg.net 取图，收到：${u}`)
    }

    const r = await this.route()
    const errors = []

    // 腿 1：官方（直连或代理，按探测结果）
    if (r.image.includes('official') && u) {
      try {
        // ⚠️ 同 _meta：用 effectiveProxy，自动发现时 proxyUrl 是空的
        const proxyUrl = r.meta === 'proxy' ? this.probe.effectiveProxy : undefined
        const res = await httpGet(u, { proxyUrl, timeoutMs: this.timeoutMs, maxBytes })
        if (res.status !== 200) throw new TransportError(`HTTP ${res.status}`)
        return {
          bytes: new Uint8Array(res.body),
          contentType: String(res.headers['content-type'] || ''),
          via: 'official',
        }
      } catch (err) {
        errors.push('官方: ' + (err && err.message ? err.message : err))
      }
    }

    // 腿 2：镜像（只有图）
    if (r.image.includes('mirror') && o.illustId) {
      try {
        const host = this.probe.mirrorHost
        const page = Number(o.page) || 0
        // ⚠️ 镜像的 URL 形式：多页 /<id>-<n>.jpg（n 从 1 起）。
        //    单页请求 /<id>.jpg 会 301 到 /<id>-1.jpg —— transport 会跟跳转，
        //    但直接拼 -1 更省一次往返，所以这里统一用多页形式。
        const url2 = `https://${host}/${o.illustId}-${page + 1}.jpg`
        const res = await httpGet(url2, { timeoutMs: this.timeoutMs, maxBytes })
        if (res.status !== 200) throw new TransportError(`HTTP ${res.status}`)
        return {
          bytes: new Uint8Array(res.body),
          contentType: String(res.headers['content-type'] || ''),
          via: 'mirror',
        }
      } catch (err) {
        errors.push('镜像: ' + (err && err.message ? err.message : err))
      }
    }

    throw new PixivError('这张图取不到。\n  ' + (errors.join('\n  ') || '没有可用的图片通道'))
  }
}

/* ─────────────────── 归一化 ─────────────────── */

/** 从搜索结果的缩略图 url 反推原图 url —— 省一次详情请求 */
export function originalFromThumb(thumbUrl) {
  const u = String(thumbUrl || '')
  const m = /\/c\/[^/]+\/(img-master|img-original)\/img\/(.+?)_p(\d+)_[^/]+\.(jpg|png|webp|gif)$/.exec(u)
  if (m) return `https://i.pximg.net/${m[1]}/img/${m[2]}_p${m[3]}.${m[4]}`
  return ''
}

/**
 * 把**任意一种** pixiv 标签形状归一成字符串数组。
 * ============================================================================
 * 🔴 为什么必须单独做这个（2026-11-06 实测踩到，后果很严重）：
 *
 *   pixiv 三个接口的 tags 形状**各不相同**：
 *     搜索  /ajax/search/artworks/  → ['初音ミク', '青']            （字符串数组）
 *     详情  /ajax/illust/<id>       → { tags: [{ tag: '...' }] }    （对象包一层）
 *     App   /v1/illust/recommended  → [{ name, translated_name }]   （对象数组）
 *
 *   我原来在 normalizeAppItem 里写了 `x.tags.map(String)` ——
 *   对第三种形状的结果是 **每个标签都变成字符串 "[object Object]"**。
 *   后果不只是"标签难看"：
 *     ① **分级过滤失效** —— screenContent 靠标签认 R-18，垃圾标签一个都认不出
 *     ② **口味打分失效** —— 匹配不到任何标签，画像白学
 *     ③ 静默 —— 不报错，只是"效果不对"，最难查的那种
 *
 *   所以统一走这里，任何形状都能吃。
 */
export function normalizeTags(raw) {
  if (!raw) return []
  // 形状 A：字符串数组
  if (Array.isArray(raw)) {
    const out = []
    for (const t of raw) {
      if (t == null) continue
      if (typeof t === 'string') { const s = t.trim(); if (s) out.push(s); continue }
      if (typeof t === 'object') {
        // 形状 C：{ name, translated_name }  或  { tag }
        const s = String(t.name || t.tag || '').trim()
        if (s) out.push(s)
        // ⚠️ translated_name 是**另一个语言的同一个标签**，不是新标签。
        //    加进来会让"一个标签"被算两次（打分翻倍）—— 所以**只取原名**。
        continue
      }
      const s = String(t).trim()
      if (s) out.push(s)
    }
    return [...new Set(out)]
  }
  // 形状 B：{ tags: [...] } 包一层
  if (typeof raw === 'object' && Array.isArray(raw.tags)) return normalizeTags(raw.tags)
  return []
}

/**
 * App API（关注流 / 推荐）返回的作品形状。
 * ⚠️ 和网页接口不一样：
 *   - 作者信息在 `user` 对象里（网页是扁平的 userName/userId）
 *   - 预览图在 `image_urls` 里（网页是单个 url 字符串）
 *   - **tags 是 [{name, translated_name}]**（见 normalizeTags 的说明）
 *   - `illust_types` 之类字段也没有
 *   所以必须单独归一，别硬套 normalizeSearchItem。
 */
function normalizeAppItem(x, source) {
  const tags = normalizeTags(x.tags)
  const u = x.user || {}
  const urls = x.image_urls || {}
  const thumb = String(urls.medium || urls.large || urls.square_medium || '')
  return {
    id: String(x.id || ''),
    title: String(x.title || '').trim() || `illust_${x.id}`,
    userId: String(u.id || x.user_id || ''),
    userName: String(u.name || x.user_name || ''),
    tags,
    pageCount: Number(x.page_count) || 1,
    width: Number(x.width) || 0,
    height: Number(x.height) || 0,
    illustType: Number(x.type) || 0,
    xRestrict: Number(x.x_restrict) || 0,
    restrict: 0,
    aiType: Number(x.illust_ai_type) === 2 ? 2 : 0,
    bookmarkCount: Number(x.total_bookmarks) || 0,
    likeCount: 0,
    viewCount: Number(x.total_view) || 0,
    createDate: String(x.create_date || ''),
    thumb,
    original: String(urls.large || ''),
    source,
    url: `https://www.pixiv.net/artworks/${x.id}`,
  }
}

function normalizeSearchItem(d, word) {
  // ⚠️ 走统一的 normalizeTags：网页搜索接口给的是字符串数组，但
  //    pixiv 时不时改形状，用同一个归一化函数能自动兼容（见它的说明）
  const tags = normalizeTags(d.tags)
  return {
    id: String(d.id || ''),
    title: String(d.title || '').trim() || `illust_${d.id}`,
    userId: String(d.userId || ''),
    userName: String(d.userName || ''),
    tags,
    pageCount: Number(d.pageCount) || 1,
    width: Number(d.width) || 0,
    height: Number(d.height) || 0,
    illustType: Number(d.illustType) || 0,
    xRestrict: Number(d.xRestrict) || 0,
    restrict: Number(d.restrict) || 0,
    aiType: Number(d.aiType) || 0,
    bookmarkCount: Number(d.bookmarkCount) || 0,
    likeCount: Number(d.likeCount) || 0,
    viewCount: Number(d.viewCount) || 0,
    createDate: String(d.createDate || ''),
    thumb: String(d.url || ''),
    original: originalFromThumb(d.url),
    source: `search:${word}`,
    url: `https://www.pixiv.net/artworks/${d.id}`,
  }
}

function normalizeRankItem(c) {
  const ct = c.illust_content_type || {}
  // ⚠️ 同上：统一走 normalizeTags（排行 json 的 tags 也是字符串数组，但别赌）
  const tags = normalizeTags(c.tags)
  return {
    id: String(c.illust_id || ''),
    title: String(c.title || '').trim() || `illust_${c.illust_id}`,
    userId: String(c.user_id || ''),
    userName: String(c.user_name || ''),
    tags,
    pageCount: Number(c.illust_page_count) || 1,
    width: Number(c.width) || 0,
    height: Number(c.height) || 0,
    illustType: Number(c.illust_type) || 0,
    // ⚠️ 排行 json **没有 xRestrict**，只有内容标记 —— 两个都要看
    xRestrict: 0,
    contentFlags: {
      sexual: Number(ct.sexual) || 0,
      grotesque: ct.grotesque === true,
      violent: ct.violent === true,
      homosexual: ct.homosexual === true,
      drug: ct.drug === true,
      antisocial: ct.antisocial === true,
    },
    aiType: 0,
    bookmarkCount: 0,
    likeCount: 0,
    viewCount: Number(c.view_count) || 0,
    rank: Number(c.rank) || 0,
    createDate: c.illust_upload_timestamp
      ? new Date(Number(c.illust_upload_timestamp) * 1000).toISOString()
      : '',
    thumb: String(c.url || ''),
    original: originalFromThumb(c.url),
    source: 'ranking',
    url: `https://www.pixiv.net/artworks/${c.illust_id}`,
  }
}
