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
 * 元数据三条腿：官方 Web 的 ajax 接口（直连/代理/外部源）、官方 App API（登录流）、
 * 以及无代理时的第三方 HibiAPI。前两条不需要 token 也能搜排行，登录才需要。
 * 图片两条腿：官方 i.pximg.net，以及镜像 pixiv.re（**只有图，没有元数据**）；
 * 镜像的系统 DNS 被污染时固定到 Cloudflare 节点 IP（SNI/Host 仍是镜像域名）。
 * ============================================================================
 */
import { httpGet, TransportError } from './transport.mjs'
import { RouteProbe, rewriteBase } from './route.mjs'
import {
  hibiGet, illustTypeOf, originalsOf, pathHostOf, RANK_MODE_MAP, searchOrderOf, toMirrorUrl,
} from './hibi.mjs'

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
    /**
     * 🔴 **取图单独给一个更大的超时**（2026-11-09 老大要求「大图要能显示」）。
     *
     * 踩到的：`image()` 原来复用 `this.timeoutMs`（25 秒，那是给元数据用的），
     * 于是一张 3008×4160 的原图下到一半就被掐断，报
     *     「请求超时（25000ms 硬超时）」
     * 而**它不是取不到，是没下完** —— 换 60 秒就下来了。
     *
     * 为什么必须分开而不是把 25 秒调大：
     *   · 元数据（搜索/排行/详情）是几十 KB 的 JSON，25 秒**绰绰有余**，
     *     调大只会让"真的连不上"时白等更久；
     *   · 图片是 5~20MB 的字节流，本来就该给足时间。
     *   一个预算伺候两种请求，必然是一边不够、一边浪费。
     *
     * 默认 120 秒。可在设置页改（imageTimeoutMs）。
     */
    this.imageTimeoutMs = Number(opts.imageTimeoutMs) > 0 ? Number(opts.imageTimeoutMs) : 120_000
    this.probe = new RouteProbe({
      proxyUrl: opts.proxyUrl,
      externalApi: opts.externalApi,
      mirrorHost: opts.mirrorHost || 'pixiv.re',
      timeoutMs: Number(opts.probeTimeoutMs) > 0 ? Number(opts.probeTimeoutMs) : 8_000,
      // 无代理通道（2026-11-09 加，见 lib/hibi.mjs）
      hibiEnabled: opts.hibiEnabled !== false,
      hibiApi: opts.hibiApi,
      mirrorIps: opts.mirrorIps,
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
    if (r.meta === 'hibi') {
      // 走到这里说明调用方漏了 hibi 分支 —— HibiAPI 吃不了官方网页路径
      throw new PixivError(`这个功能在无代理通道（HibiAPI）下没有实现：${url.replace(/\?.*$/, '')}`)
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

  /** 当前是不是走 HibiAPI（无代理通道） */
  async _isHibi() {
    const r = await this.route()
    return r.meta === 'hibi'
  }

  /** 走 HibiAPI 拿一次（带重试；见 lib/hibi.mjs） */
  async _hibi(path, params) {
    try {
      return await hibiGet(this.probe.hibiApi, path, params, {
        timeoutMs: Math.max(this.timeoutMs, 20_000), tries: 3,
      })
    } catch (err) {
      // 连续失败 ⇒ 丢探测缓存，下次重新选路（可能代理开了 / 实例挂了）
      if (!(err && err.fatal)) this.probe.invalidate()
      throw new PixivError((err && err.message) || String(err))
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
    if (await this._isHibi()) {
      // ⚠️ 搜索词会发给 HibiAPI（第三方）。公共实例的搜索实测时好时坏（4.5s 成功 / 15s 超时都见过）
      const j = await this._hibi('search', {
        word: w, order: searchOrderOf(order), mode: searchTarget, page,
      })
      const arr = Array.isArray(j && j.illusts) ? j.illusts : []
      return { total: arr.length, items: arr.map((x) => normalizeHibiItem(x, `search:${w}`)) }
    }
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
    if (await this._isHibi()) {
      const hm = RANK_MODE_MAP[mode]
      if (!hm) throw new PixivError(`无代理通道不支持这个排行：${mode}`)
      const j = await this._hibi('rank', { mode: hm, page })
      const arr = Array.isArray(j && j.illusts) ? j.illusts : []
      return {
        mode,
        items: arr.map((x, i) => ({ ...normalizeHibiItem(x, 'ranking'), rank: (Number(page) - 1) * 30 + i + 1 })),
      }
    }
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
    if (await this._isHibi()) {
      const j = await this._hibi('illust', { id })
      const x = (j && j.illust) || null
      if (!x || !x.id) throw new PixivError(`取详情失败：HibiAPI 没给这件作品（${id}）`)
      const n = normalizeHibiItem(x, 'detail')
      return {
        id,
        title: n.title,
        description: String(x.caption || '').replace(/<[^>]+>/g, '').trim(),
        userId: n.userId,
        userName: n.userName,
        tags: n.tags,
        pageCount: n.pageCount,
        width: n.width,
        height: n.height,
        illustType: n.illustType,
        xRestrict: n.xRestrict,
        aiType: n.aiType,
        createDate: n.createDate,
        viewCount: n.viewCount,
        bookmarkCount: n.bookmarkCount,
        likeCount: 0,
        original: n.original,
        url: n.url,
      }
    }
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
    if (await this._isHibi()) {
      const j = await this._hibi('illust', { id })
      const x = (j && j.illust) || {}
      // ⚠️ App-API 只给第 0 页的宽高，后面几页填 0（下载后会从字节里认）
      return originalsOf(x).map((url, i) => ({
        page: i,
        url,
        width: i === 0 ? Number(x.width) || 0 : 0,
        height: i === 0 ? Number(x.height) || 0 : 0,
      }))
    }
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

    if (await this._isHibi()) {
      // App-API 的 member_illust 一页 30 条、从新到旧；够 limit 默认值用，不翻页
      const j = await this._hibi('member_illust', { id })
      const ids = (Array.isArray(j && j.illusts) ? j.illusts : [])
        .map((x) => String(x.id || '')).filter((x) => /^\d+$/.test(x))
      return { userId: id, total: ids.length, ids: ids.slice(0, limit) }
    }
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
      /**
       * 🔴 别再说"没登录"（2026-11-09 实测踩到）：
       *   `usingLogin()` 要先换 token，而换 token 走官方接口。
       *   本机直连不通时 **token 根本换不到** ⇒ 走到这里。
       *   可用户明明登录着（凭证有效、pixiv_status 显示"已登录：某某"），
       *   报"没登录，拿不到关注流"会把他带去重新登录 —— 那是白折腾，
       *   真因是**这条路现在联不上**。分开说，别混。
       */
      const why = this.session
        ? `登录凭证有，但这会儿换不到 token（${this.lastAuthError || '官方接口不通'}），拿不到${label}`
        : `没登录，拿不到${label}`
      return { items: [], skipped: true, why }
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
        // ⚠️ 取图用**imageTimeoutMs**（默认 120s），不是元数据那个 25s ——
        //    25s 会把 10MB 级的原图钉死在半路
        const res = await httpGet(u, {
          proxyUrl,
          timeoutMs: Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : this.imageTimeoutMs,
          maxBytes,
        })
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
    // 两种拼法，按优先级：
    //   a. 有 i.pximg.net 的真实地址 ⇒ 换成 i.pixiv.re、路径不动（缩略图/原图都行，不用猜扩展名）
    //   b. 只有 id ⇒ pixiv.re/<id>-<n>.jpg（⚠️ png 原图会 404，所以只当最后手段）
    // 镜像的系统 DNS 可能被污染 ⇒ 用探测时找到的固定 IP
    //
    // 🔴 节点轮换 + 速度下限（2026-11-09 实测踩到）：
    //   同一张 4MB 原图，104.18.42.239 是 21KB/s（120 秒超时没下完），
    //   换 104.16.0.1 是 4MB/s、5.9 秒；另一张图两个 IP 正好反过来。
    //   ⇒ 快慢取决于 CF 节点缓存没缓存，**换节点比死等管用**。
    //   所以：每个节点给 8 秒宽限，平均低于 100KB/s 就掐了换下一个；
    //   全换过一轮还不行，最后一次不设下限、用满超时（宁慢勿丢）。
    if (r.image.includes('mirror') && (u || o.illustId)) {
      const host = this.probe.mirrorHost
      const pins = this.probe.mirrorPins.length ? this.probe.mirrorPins : [this.probe.mirrorPin]
      const page = Number(o.page) || 0
      const forms = []
      const viaPath = u ? toMirrorUrl(u, host) : ''
      if (viaPath) forms.push(viaPath)
      if (o.illustId) forms.push(`https://${host}/${o.illustId}-${page + 1}.jpg`)
      const fullTimeout = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : this.imageTimeoutMs
      const attempts = []
      for (const url2 of forms) {
        for (const pin of pins.slice(0, 4)) attempts.push({ url2, pin, minRate: 100 * 1024 })
      }
      // 兜底：第一种形式 + 最快节点，不设速度下限
      if (forms.length) attempts.push({ url2: forms[0], pin: pins[0] || '', minRate: 0 })
      for (const a of attempts) {
        if (a.skip) continue
        try {
          const h2 = new URL(a.url2).hostname
          const res = await httpGet(a.url2, {
            timeoutMs: fullTimeout,
            maxBytes,
            // 跳转到别的主机名时 transport 会重新按表查，不会误用这个 IP
            resolve: a.pin ? { [h2]: a.pin, [host]: a.pin, [pathHostOf(host)]: a.pin } : undefined,
            minRate: a.minRate,
            rateGraceMs: 8_000,
          })
          if (res.status === 404) {
            // 404 换节点也是 404（文件不存在 / 扩展名不对）⇒ 跳过这个形式的其余节点
            errors.push(`镜像[${a.pin || 'DNS'}]: HTTP 404 ${a.url2}`)
            for (const b of attempts) if (b.url2 === a.url2) b.skip = true
            continue
          }
          if (res.status !== 200) throw new TransportError(`HTTP ${res.status}`)
          return {
            bytes: new Uint8Array(res.body),
            contentType: String(res.headers['content-type'] || ''),
            via: 'mirror',
          }
        } catch (err) {
          errors.push(`镜像[${a.pin || 'DNS'}]: ` + (err && err.message ? err.message : err))
        }
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
 *
 * ⚠️ 修过两个坑（登录流专用，2026-11-09 一并修）：
 *   1. `Number(x.type) || 0` —— App API 的 type 是**字符串** 'illust'/'manga'/'ugoira'，
 *      Number('manga') 是 NaN ⇒ 0 ⇒ **漫画和动图全被当成普通插画**
 *      （打分里"纯插画 +6"会给错，发出去也可能是动图的静帧）。改走 illustTypeOf。
 *   2. `original: urls.large` —— 那是 **1200px 的大图，不是原图**，
 *      拿来存会存成缩水版。改走 originalsOf（跟 hibi 那条腿同一个来源）。
 */
export function normalizeAppItem(x, source) {
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
    illustType: illustTypeOf(x.type),
    xRestrict: Number(x.x_restrict) || 0,
    restrict: 0,
    aiType: Number(x.illust_ai_type) === 2 ? 2 : 0,
    bookmarkCount: Number(x.total_bookmarks) || 0,
    likeCount: 0,
    viewCount: Number(x.total_view) || 0,
    createDate: String(x.create_date || ''),
    thumb,
    // 真原图（单页在 meta_single_page、多页在 meta_pages[0]）；都没有才退回 large（1200px，至少打得开）。
    // ⚠️ 别退到 originalFromThumb：它推出的无后缀 img-master 地址实测 404（2026-11-09）
    original: originalsOf(x)[0] || String(urls.large || ''),
    source,
    url: `https://www.pixiv.net/artworks/${x.id}`,
  }
}

/**
 * HibiAPI（= pixiv **App API 原生形状**）的作品 → 内部形状。
 *
 * ⚠️ 跟 normalizeAppItem 长得像，但**不能复用**，两处关键差别：
 *   1. App API 的 `type` 是**字符串** 'illust'/'manga'/'ugoira'，
 *      normalizeAppItem 里是 `Number(x.type) || 0` ⇒ 字符串一进来就是 NaN ⇒ 0，
 *      **所有漫画和动图都会被当成普通插画**。
 *   2. 原图地址得从 `meta_single_page` / `meta_pages` 取，
 *      而 normalizeAppItem 用的是 `image_urls.large`（那是**大图不是原图**，
 *      拿来存会存成 1200px 的缩水版）。这里必须给真原图，见 originalsOf。
 * 另外这里补了 `rank`（排行用）和 `contentFlags`（分级过滤靠它）。
 */
export function normalizeHibiItem(x, source) {
  const u = x.user || {}
  const urls = x.image_urls || {}
  const origs = originalsOf(x)
  // App API 的标签形状是 [{name, translated_name}]，走统一归一化（只取原名）
  const tags = normalizeTags(x.tags)
  return {
    id: String(x.id || ''),
    title: String(x.title || '').trim() || `illust_${x.id}`,
    userId: String(u.id || x.user_id || ''),
    userName: String(u.name || x.user_name || ''),
    tags,
    pageCount: Number(x.page_count) || Math.max(1, origs.length),
    width: Number(x.width) || 0,
    height: Number(x.height) || 0,
    illustType: illustTypeOf(x.type),
    xRestrict: Number(x.x_restrict) || 0,
    restrict: 0,
    aiType: Number(x.illust_ai_type) === 2 ? 2 : 0,
    // App API 没有 illust_content_type，只有 sanity_level（2 全年龄 / 4 轻微 / 6 偏露骨）。
    // ≥6 记成 sexual=1，让 screenContent 拦下来 —— 宁可错杀，分级是红线
    contentFlags: { sexual: Number(x.sanity_level) >= 6 ? 1 : 0 },
    bookmarkCount: Number(x.total_bookmarks) || Number(x.bookmark_count) || 0,
    likeCount: 0,
    viewCount: Number(x.total_view) || Number(x.view_count) || 0,
    rank: Number(x.rank) || 0,
    createDate: String(x.create_date || ''),
    thumb: String(urls.medium || urls.large || urls.square_medium || ''),
    // 真原图（第一页）；页列表由 pages() 单独给
    original: origs[0] || '',
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
