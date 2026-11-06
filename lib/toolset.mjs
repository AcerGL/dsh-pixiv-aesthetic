/**
 * 工具集 —— 暴露给 agent 的能力。
 * ============================================================================
 * 设计口径：
 *   - 工具是「随时喊」那条路的入口。定时轮走同一套（prompts/duty.md 里规定它怎么用）。
 *   - **工具结果只回纯文本 JSON**。DSH 官方 attachment 是单向的（只做用户→模型，
 *     assistant 侧图片输出只是 forward-compatibility），所以图**进不了聊天框**，
 *     必须走投递通道（落盘 / QQ）。别想着往工具结果里塞图。
 *   - 落盘/额度/分级这些闸门都在工具里，不靠 agent 自觉。
 * ============================================================================
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { PixivClient, PixivError } from './pxclient.mjs'
import { filterAndRank, screenContent, describe as describeItem } from './taste.mjs'
import { Ledger, localDay } from './seen.mjs'
import { saveWork, sanitize } from './save.mjs'
import { Delivery, LocalFolderChannel, QQChannel, filesFromSaved, broadcast } from './deliver.mjs'
import { Session } from './auth.mjs'
import { originalFromThumb } from './pxclient.mjs'
import {
  readProfile, writeProfile, clearProfile, learn, toWeights, pickKeywords, pickArtists,
  describe as describeTaste, isWarm, COLD_START_MIN, profilePath,
} from './profile.mjs'
import {
  penalize, toPenalties, undoPenalty, describePenalty,
  dislikedIds as dislikedIdsOf, NEGATIVE_KINDS,
} from './feedback.mjs'
import {
  bucketize, assemble, diversify, explain, planMood,
  DEFAULT_QUOTA, EXPLORE_MODES,
} from './explore.mjs'
import { bookmarkIdSet, clearCache as clearBookmarkCache } from './bookmarks.mjs'

/** 统一把异常变成人话 */
function humanError(err) {
  if (err instanceof PixivError) return err.message
  const m = err && err.message ? err.message : String(err)
  return m
}

/**
 * 从**字节内容**认出真实图片格式，返回扩展名（带点）。
 * ============================================================================
 * ⚠️ 为什么必须看字节、不能信 content-type 也不能写死 .jpg（2026-11-05 实测踩到）：
 *   pixiv 的缩略图 c/540x540_70/ 会把**大量 PNG 原图**返回成 PNG 字节，
 *   但文件名我们原先写死 `.jpg` ⇒ 存出来是 "xxx.jpg" 里面装 PNG。
 *   后果：`read_image` 按扩展名判定格式，直接报
 *     "the .jpg extension declares image/jpeg, but the bytes use a different image format"
 *   —— 读图那一步整个断掉。所以**以字节为准**。
 */
function sniffExt(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return '.png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return '.jpg'
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return '.webp'
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return '.gif'
  return '.jpg' // 实在认不出就退 jpg（至少多数浏览器能容错）
}

/**
 * 🔴 工具的 `output` 声明 —— **每个工具都必须有，漏了插件就装不上**。
 *
 * 踩过的坑（2026-11-04，排查了整整两轮）：只给 name/description/parameters/execute
 * 是不够的，宿主 `ctx.tools.register()` 会抛：
 *     TypeError: tool "pixiv_status" must declare output { schema, render, presentationMeta? }
 * 而这个异常被宿主吞掉（只写 stderr），表现就是「插件装了但完全没反应」——
 * entry 在配置树里、但没有 activate，apply 完全不执行。
 *
 * 设计取舍：schema 放宽成「任意对象」，render 用 JSON 文本。
 * 理由：我们的返回结构会随功能演进（status/search/pick/save/send 各不相同），
 * 写死 JSON Schema 只会变成维护负担；而**模型要的是文本**，
 * render 成一段 JSON 反而信息最全（模型的工具结果本来就是文本）。
 */
function toolOutput(summary) {
  return {
    schema: {
      type: 'object',
      // 不锁 properties：各工具返回结构不同，且会演进。
      // 额外字段一律放行，避免"改了个返回字段插件就报错"。
      additionalProperties: true,
    },
    render: (_args, value) => {
      let text
      try {
        if (typeof value === 'string') text = value
        else {
          const j = JSON.stringify(value, null, 2)
          // ⚠️ JSON.stringify(undefined) 返回的是 **undefined**（不是字符串），
          //    直接 .length 会 TypeError。函数、Symbol 同理。
          text = (j === undefined) ? String(value) : j
        }
      } catch {
        // 循环引用之类：退化成 String()，绝不抛
        try { text = String(value) } catch { text = '(无法序列化的结果)' }
      }
      if (typeof text !== 'string') text = String(text)
      // 太长就截断 —— 别让一个工具结果把上下文吃光
      const cap = 12_000
      if (text.length > cap) text = text.slice(0, cap) + `\n…（已截断，共 ${text.length} 字符）`
      return [{ type: 'text', text: summary ? `${summary}\n${text}` : text }]
    },
  }
}

export class Toolset {
  /**
   * @param {object} o
   * @param {string} o.home       插件家目录
   * @param {() => object} o.getConfig  取当前配置（每次现取，设置页改了立刻生效）
   * @param {() => object} o.getDelivery 取投递通道（延迟注入，宿主半端才有 QQ）
   * @param {string} [o.python]   压缩用的 python
   */
  constructor(o) {
    this.home = o.home
    this.getConfig = o.getConfig
    this.getDelivery = o.getDelivery || (() => null)
    this.python = o.python || ''
    this.log = o.log || (() => {})
    this._client = null
    this._clientKey = ''
    this._session = null
  }

  /** 配置变了就重建 client（代理地址/外部源/超时可能都变了） */
  client() {
    const cfg = this.getConfig()
    const key = `${cfg.proxyUrl}|${cfg.externalApi}|${cfg.mirrorHost}|${cfg.timeoutMs}|${cfg.probeTimeoutMs}|${cfg.useLogin}|${cfg.tasteEnabled}|${cfg.tasteKeywords}|${cfg.tasteMinWeight}|${cfg.tasteScale}`
    if (!this._client || this._clientKey !== key) {
      this._client = new PixivClient({
        proxyUrl: cfg.proxyUrl,
        externalApi: cfg.externalApi,
        mirrorHost: cfg.mirrorHost,
        timeoutMs: cfg.timeoutMs,
        probeTimeoutMs: cfg.probeTimeoutMs,
        session: this.session(),
      })
      this._clientKey = key
    }
    return this._client
  }

  /** 登录会话（可选）。没开登录也建它，但 token() 会直接返回 null。 */
  session() {
    if (!this._session) {
      this._session = new Session(this.home, this.getConfig, this.log)
    }
    return this._session
  }

  ledger() {
    return new Ledger(this.home)
  }

  /**
   * 读口味画像。**关着就返回 null** —— 这是"默认关"承诺的落点：
   * 调用方拿到 null 就完全按老路走，连文件都不碰。
   */
  async taste() {
    const cfg = this.getConfig()
    if (!cfg.tasteEnabled) return null
    return await readProfile(this.home)
  }

  /**
   * 把画像翻译成「打分参数」和「该搜什么」。
   * 画像不成熟（冷启动没学够）时只给搜索词、不参与打分 ——
   * 学了两件就去干扰排序，还不如不学。
   *
   * @returns {Promise<{prof:object|null, warm:boolean, tasteTagWeights:object, tasteArtistBoost:object, keywords:string[], note:string}>}
   */
  async tasteContext() {
    const cfg = this.getConfig()
    const empty = {
      prof: null, warm: false,
      tasteTagWeights: {}, tasteArtistBoost: {},
      tasteTagPenalty: {}, tasteArtistPenalty: {}, dislikedIds: new Set(),
      keywords: [], artists: [], note: '',
    }
    if (!cfg.tasteEnabled) return { ...empty, note: '口味画像关着' }

    const prof = await readProfile(this.home)
    const learned = Number(prof.learned) || 0
    const disliked = Number(prof.disliked) || 0

    // ⚠️ 负向反馈**不看冷启动门槛**，这一点跟正向不同。
    //    理由：「不要这个画师」是**明确指示**，不是从行为里猜出来的偏好 ——
    //    用户说了就该立刻生效，不该等攒够 5 件。正向要等是因为那是推断。
    const { tagPenalty, artistPenalty } = toPenalties(prof)
    const dislikedIds = dislikedIdsOf(prof)
    const negTagCount = Object.keys(tagPenalty).length
    const negArtistCount = Object.keys(artistPenalty).length

    if (!learned && !disliked) {
      return { ...empty, prof, note: `口味画像开着，但还没学到东西（存够 ${COLD_START_MIN} 件后生效）` }
    }

    const warm = isWarm(prof)
    const { tagWeights, artistBoost } = toWeights(prof)
    const keywords = pickKeywords(prof, {
      max: cfg.tasteKeywords,
      minWeight: cfg.tasteMinWeight,
      exclude: cfg.keywords, // 配置里已经有的词不用重复搜
    })
    // ⚠️ 画师返回的是 **userId**（不是名字）—— 按画师捞作品得走
    //    /ajax/user/<id>/profile/all，跟搜索无关。见 pickArtists 的注释。
    const artists = pickArtists(prof, { max: 2, minWeight: cfg.tasteMinWeight, minTimes: 2 })

    const bits = []
    if (keywords.length) bits.push(`反搜：${keywords.join('/')}`)
    if (artists.length) bits.push(`翻熟画师 ${artists.length} 个`)
    if (negTagCount || negArtistCount) {
      const neg = []
      if (negTagCount) neg.push(`${negTagCount} 个标签降权`)
      if (negArtistCount) neg.push(`${negArtistCount} 个画师避开`)
      bits.push(neg.join('、'))
    }

    return {
      prof,
      warm,
      // 冷启动期间**不给正向打分权重**，避免用一个不靠谱的画像去排序
      tasteTagWeights: warm ? tagWeights : {},
      tasteArtistBoost: warm ? artistBoost : {},
      // 🔴 但**负向永远生效**（明确指示优先于推断）
      tasteTagPenalty: tagPenalty,
      tasteArtistPenalty: artistPenalty,
      dislikedIds,
      keywords,
      artists,
      note: warm
        ? `口味画像生效（学过 ${learned} 件${bits.length ? '，' + bits.join('；') : ''}）`
        : `口味画像学中（${learned}/${COLD_START_MIN}），正向暂不参与排序${bits.length ? '；' + bits.join('；') : ''}`,
    }
  }

  /**
   * 已经收藏过的作品 id —— 推荐时跳过它们。
   *
   * 为什么要有（老大 2026-11-06 明确要求）：登录之后，推荐里再出现
   * "他已经收藏过的画"就是纯噪音 —— 那不是在发现，是在复习。
   *
   * ⚠️ 这个**独立于口味画像**：画像关着也应该剔（收藏是既成事实，不是推断）。
   *    但**依赖登录** —— 没登录就没有收藏列表，安静退化成不剔。
   * ⚠️ 任何失败都返回空集合，绝不抛（见 bookmarks.mjs 的铁律）——
   *    收藏只是额外剔除，拿不到不能影响搜索。
   */
  async bookmarkedIds() {
    const cfg = this.getConfig()
    try {
      const s = this.session()
      const who = await s.who().catch(() => ({ loggedIn: false }))
      if (!who.loggedIn || !who.userId) {
        return { ids: new Set(), why: '没登录 —— 不做收藏剔除', loggedIn: false }
      }
      const r = await bookmarkIdSet({
        home: this.home,
        userId: who.userId,
        proxyUrl: cfg.proxyUrl,
        timeoutMs: cfg.timeoutMs,
        getToken: () => s.token(),
        log: this.log,
      })
      return { ids: r.ids, why: r.why, loggedIn: true, from: r.from }
    } catch (err) {
      return { ids: new Set(), why: '读收藏出错（不影响搜索）：' + humanError(err), loggedIn: false }
    }
  }

  /**
   * 存成功之后，把这一件学进画像。
   * ⚠️ **失败绝不能影响保存结果** —— 学口味是加分项，它坏了不该让"已存下"变成报错。
   */
  async learnFromSaved(item) {
    try {
      const cfg = this.getConfig()
      if (!cfg.tasteEnabled) return null
      const prof = await readProfile(this.home)
      const next = learn(prof, item)
      await writeProfile(this.home, next)
      return { learned: next.learned, warm: isWarm(next) }
    } catch (err) {
      this.log(`口味学习失败（不影响保存）：${err && err.message ? err.message : err}`)
      return null
    }
  }

  libraryRoot() {
    const cfg = this.getConfig()
    return cfg.saveRoot || join(this.home, 'library')
  }

  /** 投递通道：落盘永远在；QQ 只有宿主给了才在 */
  delivery() {
    const cfg = this.getConfig()
    const fromHost = this.getDelivery()
    const channels = []
    if (fromHost && fromHost.qq) {
      channels.push(new QQChannel({
        ...fromHost.qq,
        passiveWindowMs: cfg.qqPassiveWindowMs,
        maxBytes: cfg.qqMaxBytes,
      }))
    }
    // 落盘永远加，且永远排最后当兜底
    channels.push(new LocalFolderChannel({ home: this.libraryRoot() }))
    return new Delivery(channels)
  }

  /* ═══════════════ 工具定义 ═══════════════ */

  definitions() {
    // ⚠️ 坑：宿主调用时是 `tool.execute(args, exec)` —— 方法被摘下来调，
    //    `this` 不再是 Toolset。所以每个 execute 都要**绑死**，
    //    否则报 "this.getConfig is not a function"。
    const specs = [
      this.toolStatus(),
      this.toolTaste(),
      this.toolFeedback(),
      this.toolExplore(),
      this.toolSearch(),
      this.toolPick(),
      this.toolWorks(),
      this.toolSave(),
      this.toolSend(),
    ]
    return specs.map((s) => (s && typeof s.execute === 'function' ? { ...s, execute: s.execute.bind(this) } : s))
  }

  /** pixiv_status —— 现在什么状况 */
  toolStatus() {
    return {
      name: 'pixiv_status',
      description:
        '看 Pixiv 插件的运行状况：网络走哪条路、今天存了几件、额度还剩多少、投递通道哪些可用。' +
        '在搜索/保存之前先用它，或者用户问「pixiv 通不通」「今天存了几张」时用它。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: toolOutput('Pixiv 插件状态'),
      async execute() {
        const cfg = this.getConfig()
        const led = this.ledger()
        // 用 remaining() 算，别在这儿手算 —— 之前手算的地方和 ledger 的口径漂移过
        const room = await led.remaining(cfg.perDay)
        let net = { ok: false, text: '还没探测' }
        try {
          const c = this.client()
          const p = await c.ping()
          net = { ok: p.ok, mirror: p.mirror, ms: p.ms, text: p.text, detail: p.detail }
        } catch (err) {
          net = { ok: false, text: humanError(err) }
        }
        const chans = await this.delivery().status()

        // 口味画像（可选功能）：说清楚开没开、学到什么程度
        let taste = { enabled: false, learned: 0, warm: false, text: '口味画像关着（默认）' }
        try {
          if (cfg.tasteEnabled) {
            const prof = await readProfile(this.home)
            const learned = Number(prof.learned) || 0
            taste = {
              enabled: true,
              learned,
              warm: isWarm(prof),
              coldStartMin: COLD_START_MIN,
              text: describeTaste(prof),
            }
          }
        } catch (err) {
          taste = { enabled: true, learned: 0, warm: false, text: '口味画像读取失败：' + humanError(err) }
        }

        // 登录态（可选功能）：说清楚现在是哪种身份，别让人猜
        let login = { enabled: false, loggedIn: false, text: '未使用登录（游客模式）' }
        try {
          const s = this.session()
          const who = await s.who()
          if (!cfg.useLogin) {
            login = { enabled: false, loggedIn: false, text: '未使用登录（游客模式）' }
          } else if (who.loggedIn) {
            login = {
              enabled: true,
              loggedIn: true,
              userId: who.userId,
              userName: who.userName,
              scope: who.scope,
              text: `已登录：${who.userName || who.userId || '(未知)'}${who.scope ? `（权限 ${who.scope}）` : ''}`,
            }
          } else {
            login = { enabled: true, loggedIn: false, text: '开了登录但没配 refresh_token —— 去设置页贴一个' }
          }
        } catch (err) {
          login = { enabled: !!(cfg.useLogin), loggedIn: false, text: '登录态检查失败：' + humanError(err) }
        }

        return {
          ok: true,
          network: net,
          taste,
          login,
          quota: { used: room.used, limit: room.limit, left: room.left, unlimited: room.unlimited },
          channels: chans,
          saveRoot: this.libraryRoot(),
          keywords: cfg.keywords,
          rankModes: cfg.rankModes,
          allowR18: cfg.allowR18,
        }
      },
    }
  }

  /**
   * pixiv_taste —— 看 / 调口味画像。
   *
   * 设计：**不给用户做设置页 UI**（老大明确说的）。
   * 所以这个工具是「agent 的抓手」：用户说「初音权重压一压」，
   * agent 直接调这里改，或者直接改 taste.json（明文，人手也能改）。
   */
  toolTaste() {
    return {
      name: 'pixiv_taste',
      description:
        '看 Pixiv 口味画像（它从你「存下来」的东西里自动学出的偏好），或者调它。' +
        '用户问「我的口味学成什么样了」「把 X 的权重压一压」「别再推 Y 了」「清空重学」时用它。' +
        '画像默认关着；关着时插件只按关键词+排行找图。' +
        '⚠️ 调权重是**直接改** taste.json，改完立刻影响下次搜索排序。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['show', 'enable', 'disable', 'set', 'remove', 'reset'],
            description:
              'show=看现状（默认）/ enable=开启画像 / disable=关闭（不学也不影响排序）' +
              ' / set=改权重 / remove=删掉某标签或画师 / reset=清空重学',
          },
          kind: { type: 'string', enum: ['tag', 'artist'], description: 'set/remove 时改哪类，默认 tag' },
          key: { type: 'string', description: 'set/remove 的标签名或画师 id' },
          weight: { type: 'number', description: 'set 时的权重（0 就是不再推它）' },
        },
        additionalProperties: false,
      },
      output: toolOutput('口味画像'),
      async execute(args) {
        const cfg = this.getConfig()
        const action = String(args.action || 'show')

        if (action === 'enable' || action === 'disable') {
          // 开关本身走 saveConfig（跟其它配置一个家）
          const { saveConfig } = await import('./config.mjs')
          const next = await saveConfig(this.home, { tasteEnabled: action === 'enable' }, {})
          this._client = null // 配置变了，client 缓存作废
          return {
            ok: true,
            action,
            enabled: next.tasteEnabled,
            note: action === 'enable'
              ? '口味画像已开启：以后每存一件就学一件；存够 ' + COLD_START_MIN + ' 件后开始影响排序。'
              : '口味画像已关闭：不再学习，也不再影响排序（已有的 taste.json 保留着）。',
          }
        }

        if (action === 'reset') {
          await clearProfile(this.home)
          return { ok: true, action, note: '口味画像已清空，下次存图从头学起。' }
        }

        if (action === 'set' || action === 'remove') {
          const kind = args.kind === 'artist' ? 'artists' : 'tags'
          const key = String(args.key || '').trim()
          if (!key) throw new Error(`pixiv_taste: ${action} 需要给 key`)
          const prof = await readProfile(this.home)

          if (action === 'remove') {
            if (prof[kind] && prof[kind][key]) {
              delete prof[kind][key]
              await writeProfile(this.home, prof)
              return { ok: true, action, kind, key, note: `已从画像里删掉 ${kind === 'tags' ? '标签' : '画师'}「${key}」，以后不再靠它推。` }
            }
            return { ok: true, action, kind, key, note: `画像里本来就没有「${key}」。` }
          }

          // set
          const w = Number(args.weight)
          if (!Number.isFinite(w)) throw new Error('pixiv_taste: set 需要给 weight')
          const cur = (prof[kind] && prof[kind][key]) || { n: 0, last: new Date().toISOString() }
          prof[kind] = { ...(prof[kind] || {}) }
          if (w <= 0) {
            // 权重 0 = 明确不想再看 → 直接删，比留个 0 干净
            delete prof[kind][key]
            await writeProfile(this.home, prof)
            return { ok: true, action, kind, key, weight: 0, note: `「${key}」权重设为 0，已删掉（等于不再推它）。` }
          }
          prof[kind][key] = { ...cur, w: Math.min(100, w), last: new Date().toISOString() }
          await writeProfile(this.home, prof)
          return { ok: true, action, kind, key, weight: prof[kind][key].w, note: `「${key}」权重已设为 ${prof[kind][key].w}。` }
        }

        // show（默认）
        const prof = await readProfile(this.home)
        const { topTags, topArtists } = toWeights(prof)
        const ctx = await this.tasteContext()
        const learned = Number(prof.learned) || 0
        return {
          ok: true,
          enabled: cfg.tasteEnabled,
          learned,
          warm: isWarm(prof),
          coldStartMin: COLD_START_MIN,
          text: describeTaste(prof),
          note: cfg.tasteEnabled
            ? ctx.note
            : '画像关着（默认）。要开就说一声，开了之后你只管存图，它自己学。',
          topTags: topTags.map(([k, w]) => ({ tag: k, weight: Number(w.toFixed(2)), times: (prof.tags[k] || {}).n || 0 })),
          topArtists: topArtists.map(([k, w]) => ({
            userId: k, name: (prof.artists[k] || {}).name || '', weight: Number(w.toFixed(2)), times: (prof.artists[k] || {}).n || 0,
          })),
          searchKeywords: await (async () => {
            const c = this.getConfig()
            return pickKeywords(prof, { max: c.tasteKeywords, minWeight: c.tasteMinWeight, exclude: c.keywords })
          })(),
          file: profilePath(this.home),
          recent: (prof.recent || []).slice(-5).map((r) => ({ ts: r.ts, title: r.title, artist: r.artist, gain: r.gain })),
          howToChange: '要改就直接说：比如「把 初音ミク 权重设成 20」「别再推 XX 这个标签」「清空重学」。我改 taste.json。',
        }
      },
    }
  }

  /**
   * pixiv_feedback —— 对话式审美反馈。
   *
   * 用户说「这张不错，但色彩太艳了，下一轮要更有空气感」「第二个不要」
   * 「别再推这个画师」—— agent 把它解析成这里的参数。
   *
   * ⚠️ 三类反馈扣的东西**不一样**（这是本工具最重要的设计，别简化成一个 like/dislike）：
   *    unlike      不喜欢这一张 → **一个标签都不扣**，只记下不再推这张
   *    artist_down 不要这个画师 → 只扣画师
   *    style_down  不要这种风格 → 只扣**用户点名的**标签
   *
   *   为什么 unlike 不扣标签：一张作品挂十几个标签，用户讨厌的往往只是一个维度。
   *   一刀切会把「初音ミク」也扣掉 —— 而他明明喜欢初音，只是不喜欢那张的饱和度。
   */
  toolFeedback() {
    return {
      name: 'pixiv_feedback',
      description:
        '记录用户的审美反馈，让它影响后续推荐。三类：「不喜欢这一张」/「不要这个画师」/「不要这种风格」。' +
        '⚠️ 三类扣的东西不同 —— 不喜欢某一张**不会**牵连它身上的标签（那可能只是构图问题，标签没问题）；' +
        '只有用户**点名**了风格/标签才扣标签。' +
        '用户说「这张不要」「别再推这个画师」「色彩太艳了少来点」「我改主意了撤回」时用它。' +
        '注意：负向反馈**不受口味画像开关与冷启动影响**，说了立刻生效（那是明确指示，不是推断）。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['unlike', 'artist_down', 'style_down', 'undo', 'list'],
            description:
              'unlike=不喜欢这一张（不扣标签） / artist_down=不要这个画师（扣画师） / ' +
              'style_down=不要这种风格（扣点名的标签） / undo=撤回一条 / list=看已有的负向反馈',
          },
          id: { type: 'string', description: '作品 id（unlike 用；list 时也可用来筛）' },
          userId: { type: 'string', description: '画师 id（artist_down 用）' },
          userName: { type: 'string', description: '画师名（只是记着好显示，扣分用 userId）' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: '要点名扣掉的标签（**只有 style_down 用**）。必须来自用户明确说出的偏好，别自己推断',
          },
          weight: { type: 'number', description: '这条反馈多重（默认 1，上限 5）。用户说"特别讨厌"时可以调大' },
          title: { type: 'string', description: '作品标题（只是记着好显示）' },
          kind: { type: 'string', enum: ['tag', 'artist', 'id'], description: 'undo：撤回哪一类' },
          key: { type: 'string', description: 'undo：撤回哪个（标签名 / 画师 id / 作品 id）' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: toolOutput('审美反馈已记录'),
      async execute(args) {
        const cfg = this.getConfig()
        const action = String(args.action || '')

        /* ── 看已有的负向反馈 ── */
        if (action === 'list') {
          const prof = await readProfile(this.home)
          const both = toPenalties(prof, { max: 50, floor: -999 })
          const negTags = Object.entries(both.tagPenalty).sort((a, b) => a[1] - b[1])
          const negArtists = Object.entries(both.artistPenalty).sort((a, b) => a[1] - b[1])
          return {
            ok: true,
            enabled: cfg.tasteEnabled,
            dislikedCount: Number(prof.disliked) || 0,
            // ⚠️ 看的时候用**原始权重**（floor 关掉），不然显示的是收敛后的值，对不上账
            tags: negTags.map(([k, w]) => ({ tag: k, weight: w, raw: Number(prof.tags[k]?.w) || 0 })),
            artists: negArtists.map(([k, w]) => ({
              userId: k, name: prof.artists[k]?.name || '', weight: w, raw: Number(prof.artists[k]?.w) || 0,
            })),
            suppressed: (prof.dislikes || []).slice(-20).map((d) => ({ id: d.id, title: d.title, ts: d.ts })),
            note: negTags.length || negArtists.length || (prof.dislikes || []).length
              ? '上面就是现在生效的负向反馈。说「撤回 XX」就能取消一条。'
              : '还没有任何负向反馈。',
          }
        }

        /* ── 撤回 ── */
        if (action === 'undo') {
          const kind = String(args.kind || 'tag')
          const key = String(args.key || args.id || args.userId || '').trim()
          if (!key) throw new Error('pixiv_feedback undo: 需要给 key（标签名 / 画师 id / 作品 id）')
          const prof = await readProfile(this.home)
          const { profile: next, undone } = undoPenalty(prof, { kind, key })
          if (undone) {
            await writeProfile(this.home, next)
            this.log(`撤回负向反馈：${kind} ${key}`)
          }
          return {
            ok: true,
            action: 'undo',
            undone,
            note: undone ? `已撤回对「${key}」的负向反馈。` : `没找到对「${key}」的负向反馈（可能本来就没记，或已经被时间衰减抹平）。`,
          }
        }

        /* ── 记一条负向反馈 ── */
        if (!NEGATIVE_KINDS.includes(action)) {
          throw new Error(`pixiv_feedback: 不认识的 action「${action}」（可用：${NEGATIVE_KINDS.join(' / ')} / undo / list）`)
        }

        // unlike / artist_down 必须有 id（不然不知道针对谁）
        if (action === 'unlike' && !String(args.id || '').trim()) {
          throw new Error('pixiv_feedback: unlike 需要给作品 id')
        }
        if (action === 'artist_down' && !String(args.userId || '').trim()) {
          throw new Error('pixiv_feedback: artist_down 需要给画师 userId')
        }
        if (action === 'style_down' && !(Array.isArray(args.tags) && args.tags.length)) {
          throw new Error('pixiv_feedback: style_down 需要给 tags（用户点名要少来的标签）')
        }

        const prof = await readProfile(this.home)
        const { profile: next, applied } = penalize(prof, {
          kind: action,
          id: args.id,
          userId: args.userId,
          userName: args.userName,
          title: args.title,
          tags: args.tags,
          weight: args.weight,
        })
        await writeProfile(this.home, next)
        this.log(`负向反馈：${action} —— ${applied.reason}`)

        return {
          ok: true,
          action,
          applied: {
            reason: applied.reason,
            tags: applied.tags,
            artist: applied.artist,
            suppressed: applied.suppressedId || undefined,
          },
          text: describePenalty(applied),
          dislikedTotal: Number(next.disliked) || 0,
          note: action === 'unlike'
            // 把这条设计明确写给用户看 —— 免得他以为"不喜欢"会牵连标签
            ? '只记下这一张不再推，**没有**动它身上的标签（一张图挂的标签通常不止一个，牵连会误伤）。要是那一类风格整体不想要，就点名说「少来 XX 标签」。'
            : '下次搜图时就会按这个避开。',
        }
      },
    }
  }

  /**
   * pixiv_explore —— 智能漫游。
   *
   * 四种模式（规格第五节）：
   *   for_you    按长期画像推荐
   *   surprise   有控制地探索新主题/新画师
   *   deep_dive  从指定作品/画师出发往外走
   *   mood       把自然语言情绪转成可执行搜索计划
   *
   * 🔴 两条自我约束（都写在代码里，不只是提示词）：
   *   ① **不把未知评分伪装成概率** —— 60/25/15 是**配额**，不是置信度。
   *      某项不足时如实报 shortfall，不假装按比例凑齐。
   *   ② **不伪造相似度** —— pixiv 没有可用的「相关作品」接口（实测 404），
   *      所以 deep_dive 只靠同标签 + 同画师，不编"相似度 0.87"那种数。
   */
  toolExplore() {
    return {
      name: 'pixiv_explore',
      description:
        '智能漫游：不只是按关键词搜，而是按「你想要的语境」找图。' +
        '四种模式：for_you=按口味画像推荐 / surprise=有控制地探索新画师新主题 / ' +
        'deep_dive=从某个作品或画师出发往外走 / mood=把自然语言情绪（如「有空气感的夏日夜景」）转成搜索计划。' +
        '每条结果都带**可解释的理由**，并**如实标注有没有真读过图**（没读就说没读，不从标签编造画面判断）。' +
        '用户说「给我推荐点」「来个惊喜的」「找跟这张像的」「找有空气感的图」时用它。',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: EXPLORE_MODES,
            description: 'for_you（默认）/ surprise / deep_dive / mood',
          },
          text: { type: 'string', description: 'mood 模式下用户的自然语言（原话）' },
          seedId: { type: 'string', description: 'deep_dive：从哪个作品 id 出发' },
          seedUserId: { type: 'string', description: 'deep_dive：从哪个画师出发' },
          limit: { type: 'integer', description: '要几条（默认 8，上限 30）' },
          quota: {
            type: 'object',
            description: '自定义探索/利用比例（默认 0.6/0.25/0.15）。是**配额**不是概率',
            properties: {
              familiar: { type: 'number' },
              explore: { type: 'number' },
              diversify: { type: 'number' },
            },
            additionalProperties: false,
          },
          dryRun: { type: 'boolean', description: 'true = 只返回搜索计划，不去真搜（mood 模式常用）' },
        },
        required: ['mode'],
        additionalProperties: false,
      },
      output: toolOutput('漫游结果'),
      async execute(args) {
        const cfg = this.getConfig()
        const c = this.client()
        const mode = EXPLORE_MODES.includes(String(args.mode)) ? String(args.mode) : 'for_you'
        const limit = Math.min(30, Math.max(1, Number(args.limit) || 8))

        /* ── mood：只出计划（可选），或按计划去搜 ── */
        const mood = mode === 'mood' ? planMood(args.text || '') : null
        if (mode === 'mood' && args.dryRun) {
          return {
            ok: true, mode, plan: mood.plan, keywords: mood.keywords,
            derived: mood.derived, note: mood.note,
            hint: '确认计划没问题就再调一次（不传 dryRun）去真搜。',
          }
        }

        /* ── 决定这轮去搜什么 ── */
        const taste = await this.tasteContext()
        const words = []
        if (mode === 'mood') {
          words.push(...mood.keywords)
        } else if (mode === 'deep_dive') {
          // 从种子出发：拿它的标签 + 画师
          const seed = String(args.seedId || '').trim()
          if (seed) {
            try {
              const d = await c.detail(seed)
              words.push(...(d.tags || []).slice(0, 3))
            } catch (err) { this.log(`deep_dive 取种子失败：${humanError(err)}`) }
          }
          if (args.seedUserId) {
            // 该画师的其他作品（走 byArtist，不是搜索）
            const other = await this._artistWorks(String(args.seedUserId), 12).catch(() => [])
            if (other.length) {
              // 直接用这些当候选池，不再去搜
              words.push(...(other[0].tags || []).slice(0, 2))
            }
          }
          if (!words.length) words.push(...(cfg.keywords || []))
        } else {
          // for_you / surprise：用画像反搜
          words.push(...taste.keywords)
        }
        if (!words.length) {
          // 兜底：配置关键词，再不行就刷排行
          words.push(...(cfg.keywords || []))
        }

        /* ── 搜 ── */
        const pool = []
        const errors = []
        const seenIds = await this.ledger().seenIds()

        if (words.length) {
          const order = mode === 'surprise' ? 'date_d' : 'popular_d'
          for (const w of words.slice(0, 4)) {
            try {
              const r = await c.search({ word: w, order })
              for (const it of r.items) it.source = `${mode}:${w}`
              pool.push(...r.items)
            } catch (err) { errors.push(`搜「${w}」: ${humanError(err)}`) }
          }
        } else {
          for (const m of (cfg.rankModes.length ? cfg.rankModes : ['daily'])) {
            try {
              const r = await c.ranking({ mode: m })
              for (const it of r.items) it.source = `${mode}:排行`
              pool.push(...r.items)
            } catch (err) { errors.push(`排行 ${m}: ${humanError(err)}`) }
          }
        }

        // surprise 模式补一批**陌生画师**的作品：从某个熟标签里挑没见过的画师
        if (mode === 'surprise' && taste.keywords.length) {
          try {
            const r = await c.search({ word: taste.keywords[0], order: 'date_d' })
            const known = new Set(Object.keys(taste.prof?.artists || {}))
            for (const it of r.items) {
              if (!known.has(String(it.userId))) { it.source = 'surprise:新画师'; pool.push(it) }
            }
          } catch { /* 加分项，失败就算 */ }
        }

        // deep_dive 的特殊来源：同画师的其他作品（走 byArtist）
        if (mode === 'deep_dive' && args.seedUserId) {
          const other = await this._artistWorks(String(args.seedUserId), 12).catch(() => [])
          pool.push(...other)
        }

        // 去重
        const byId = new Map()
        for (const it of pool) if (!byId.has(it.id)) byId.set(it.id, it)
        const uniq = [...byId.values()]

        /* ── 打分 + 过滤（复用现有漏斗，不另造一套）── */
        // 已收藏的（登录才有）—— 漫游时同样跳过：那不是"发现"，是"复习"
        const bm = await this.bookmarkedIds()
        const { kept, dropped } = filterAndRank(uniq, {
          ...cfg,
          seenIds,
          bookmarkedIds: bm.ids,
          tasteTagWeights: taste.tasteTagWeights,
          tasteArtistBoost: taste.tasteArtistBoost,
          tasteTagPenalty: taste.tasteTagPenalty,
          tasteArtistPenalty: taste.tasteArtistPenalty,
          dislikedIds: taste.dislikedIds,
          tasteScale: cfg.tasteScale,
        })

        /* ── 分桶 + 按配额组 ── */
        const familiarArtists = new Set(Object.keys(taste.prof?.artists || {}))
        const familiarTags = new Set([
          ...Object.keys(taste.prof?.tags || {}),
          ...(taste.keywords || []),
        ])
        // surprise 模式：故意把"熟"的定义收紧一点，好让新东西进 explore 桶
        const buckets = bucketize(kept, {
          familiarArtists: mode === 'surprise' ? new Set() : familiarArtists,
          familiarTags: mode === 'surprise' ? new Set(taste.keywords) : familiarTags,
        })
        const picked = assemble(buckets, { limit, quota: args.quota || undefined })

        /* ── 写理由 ── */
        const items = picked.items.map((it) => explain(it, {
          suggest: (it.why || []).some((w) => w.includes('口味−'))
            ? ['这条踩到了你说过不喜欢的点，要是还想要就撤回那条反馈']
            : [],
        }))

        return {
          ok: true,
          mode,
          // 计划：让用户知道这轮到底去搜了什么
          plan: mood ? mood.plan : (words.length ? `按 ${words.slice(0, 4).join('、')} 搜，再去重排序` : '刷排行'),
          searchedWords: words.slice(0, 4),
          found: uniq.length,
          afterFilter: kept.length,
          returned: items.length,
          // 🔴 如实说明配额与不足（不是概率，是名额）
          quota: picked.quota,
          actual: picked.actual,
          shortfall: picked.shortfall || undefined,
          items,
          // 画像这一轮的状态
          taste: { enabled: cfg.tasteEnabled, warm: taste.warm, note: taste.note },
          // 收藏剔除的状态 —— 让用户知道它到底生效没
          bookmarks: {
            loggedIn: bm.loggedIn,
            count: bm.ids.size,
            note: bm.why,
          },
          mood: mood ? { keywords: mood.keywords, note: mood.note } : undefined,
          droppedCount: dropped.length,
          errors: errors.length ? errors : undefined,
          note: picked.shortfall
            ? '候选池不够，没凑满 —— 上面 shortfall 写了缺哪个桶多少条。'
            : '每条的理由里写清了匹配什么、有没有真读过图。',
        }
      },
    }
  }

  /**
   * 取某个画师的作品（走 /ajax/user/<id>/profile/all，不是搜索）。
   * ⚠️ 实测过 `user:画师名` 搜索语法恒返回 0，所以必须走这个接口。
   */
  async _artistWorks(userId, limit = 12) {
    const c = this.client()
    const got = await c.byArtist(userId, { limit })
    const out = []
    for (const id of got.ids) {
      try {
        const d = await c.detail(id)
        d.source = 'deep_dive:同画师'
        out.push(d)
      } catch { /* 单件失败跳过 */ }
    }
    return out
  }

  /** pixiv_search —— 找候选 */
  toolSearch() {
    return {
      name: 'pixiv_search',
      description:
        '在 Pixiv 上找插画候选。不传参数就用配置里的关键词与排行榜（推荐）。' +
        '返回的是**候选列表**（含 id/标题/画师/标签/尺寸/收藏），还没有读图。' +
        '想要真正挑出好的，接着用 pixiv_pick；想直接取某一件的图，用 pixiv_works。',
      parameters: {
        type: 'object',
        properties: {
          word: { type: 'string', description: '搜索关键词（中文/日文/英文标签都行）。不传就用配置里的关键词；配置也为空就只刷排行榜。' },
          order: { type: 'string', enum: ['date_d', 'popular_d'], description: 'date_d=最新（默认），popular_d=热门' },
          limit: { type: 'integer', description: '最多返回几条候选（默认取配置的 maxLook，上限 100）' },
        },
        additionalProperties: false,
      },
      output: toolOutput('候选列表'),
      async execute(args) {
        const cfg = this.getConfig()
        const c = this.client()
        const limit = Math.min(100, Math.max(1, Number(args.limit) || cfg.maxLook))
        const words = args.word ? [String(args.word)] : cfg.keywords
        const order = args.order === 'popular_d' ? 'popular_d' : 'date_d'

        const pool = []
        const errors = []

        // 口味画像：拿到「学出来的权重」和「该反搜什么词」
        // ⚠️ 画像关着时 tasteCtx 全空，下面的行为跟没有这个功能时**完全一致**
        const tasteCtx = await this.tasteContext()

        // 熟画师那条腿要逐个取详情，先拿一份"存过的 id"来省请求。
        // （后面 filterAndRank 还会再取一次 seen，这里只为省网络往返）
        const seenIdsForTaste = new Set()
        if (cfg.tasteEnabled && tasteCtx.artists.length) {
          try {
            const led0 = this.ledger()
            for (const idStr of await led0.seenIds()) seenIdsForTaste.add(String(idStr))
          } catch { /* 拿不到就算了，大不了多取几次详情 */ }
        }

        // 没关键词 → 刷排行（这是「通用池塘」，零配置也能用）
        if (!words.length) {
          for (const mode of (cfg.rankModes.length ? cfg.rankModes : ['daily'])) {
            try {
              const r = await c.ranking({ mode })
              pool.push(...r.items)
            } catch (err) {
              errors.push(`排行 ${mode}: ${humanError(err)}`)
            }
          }
        } else {
          for (const w of words) {
            try {
              const r = await c.search({ word: w, order })
              pool.push(...r.items)
            } catch (err) {
              errors.push(`搜索「${w}」: ${humanError(err)}`)
            }
          }
        }

        /* ── 口味腿：拿学出来的高权重标签**反向搜** ──
         * 这是「不只看排行」的核心：日榜只有 50 条，而按你的口味去搜，
         * 池子立刻从几十条变成几十万条（实测：初音ミク 62 万、風景 34 万）。
         * ⚠️ 只在用户**没指定 word** 时做 —— 他明确说了搜什么，就别自作主张塞东西。
         * ⚠️ 用 popular_d：口味腿要的是"这个标签下的精品"，不是"最新"。 */
        const tasteSearched = []
        if (!args.word && cfg.tasteEnabled && tasteCtx.keywords.length) {
          for (const w of tasteCtx.keywords) {
            try {
              const r = await c.search({ word: w, order: 'popular_d' })
              // 打个来源戳，方便报告里说清这条是哪来的
              for (const it of r.items) it.source = `口味:${w}`
              pool.push(...r.items)
              tasteSearched.push({ word: w, got: r.items.length, total: r.total })
            } catch (err) {
              errors.push(`口味搜索「${w}」: ${humanError(err)}`)
            }
          }
        }

        /* ── 口味腿 · 画师：翻你反复存的画师的全部作品 ──
         * ⚠️ 这里**不能**用搜索。实测 `user:画师名` 恒返回 0，
         *    直接搜名字还会串到别的画师（搜「幸永」拿回别人的 id）。
         *    所以走 /ajax/user/<id>/profile/all，拿 id 列表再逐个取详情。
         * ⚠️ 逐个取详情是有代价的（N 次请求），所以数量卡得很紧。 */
        const artistSearched = []
        if (!args.word && cfg.tasteEnabled && tasteCtx.artists.length) {
          for (const uid of tasteCtx.artists) {
            try {
              const got = await c.byArtist(uid, { limit: 12 })
              let took = 0
              for (const idStr of got.ids) {
                if (seenIdsForTaste.has(idStr)) continue // 存过的不用再取详情
                try {
                  const d = await c.detail(idStr)
                  d.source = `熟画师:${d.userName || uid}`
                  pool.push(d)
                  took++
                } catch { /* 单件取不到就跳过，别让整条腿废掉 */ }
              }
              artistSearched.push({ userId: uid, total: got.total, took })
              // 取回来的顺手记进 seen，避免同一次里重复
              for (const idStr of got.ids) seenIdsForTaste.add(idStr)
            } catch (err) {
              errors.push(`熟画师「${uid}」: ${humanError(err)}`)
            }
          }
        }

        // 登录后额外刷的池子：关注流 / 个性化推荐。
        // ⚠️ 这两个失败**不能影响整体** —— 它们是加分项，不是必需项。
        //    没登录时 c.following() 会自己返回 skipped，这里只如实记一句。
        const loginSkipped = []
        if (cfg.useLogin && cfg.loginSources.length) {
          for (const src of cfg.loginSources) {
            try {
              if (src === 'follow') {
                const r = await c.following({ limit: cfg.followLimit })
                if (r.skipped) loginSkipped.push(r.why)
                else pool.push(...r.items)
              } else if (src === 'recommend') {
                const r = await c.recommended({ limit: cfg.recommendLimit })
                if (r.skipped) loginSkipped.push(r.why)
                else pool.push(...r.items)
              }
            } catch (err) {
              loginSkipped.push(`${src}: ${humanError(err)}`)
            }
          }
        }

        // 去重（同一个 id 可能既在排行又在搜索里）
        const byId = new Map()
        for (const it of pool) if (!byId.has(it.id)) byId.set(it.id, it)
        const uniq = [...byId.values()]

        const led = this.ledger()
        const seen = await led.seenIds()
        // 已收藏的（登录才有）—— 推荐时跳过，不拿旧画复习
        const bm = await this.bookmarkedIds()
        const { kept, dropped } = filterAndRank(uniq, {
          ...cfg,
          seenIds: seen,
          bookmarkedIds: bm.ids,
          // 画像学出来的权重（关着 / 冷启动时是空对象 —— 那就等于没这一项）
          tasteTagWeights: tasteCtx.tasteTagWeights,
          tasteArtistBoost: tasteCtx.tasteArtistBoost,
          // 负向：扣分 + 「不想再看」的 id 直接剔除
          tasteTagPenalty: tasteCtx.tasteTagPenalty,
          tasteArtistPenalty: tasteCtx.tasteArtistPenalty,
          dislikedIds: tasteCtx.dislikedIds,
          tasteScale: cfg.tasteScale,
        })

        return {
          ok: true,
          found: uniq.length,
          afterFilter: kept.length,
          returned: Math.min(limit, kept.length),
          items: kept.slice(0, limit).map((it) => ({
            id: it.id,
            title: it.title,
            artist: it.userName,
            artistId: it.userId,
            tags: (it.tags || []).slice(0, 12),
            size: `${it.width}x${it.height}`,
            pages: it.pageCount,
            bookmarks: it.bookmarkCount,
            score: Math.round(it.score),
            why: it.why || [],
            from: it.source || '',
            url: it.url,
          })),
          droppedSample: dropped.slice(0, 8).map((d) => ({ id: d.id, reason: d.dropReason })),
          droppedCount: dropped.length,
          // 口味画像这一轮干了什么 —— 让 agent/用户看得见，不是黑盒
          taste: {
            enabled: cfg.tasteEnabled,
            warm: tasteCtx.warm,
            learned: tasteCtx.prof ? Number(tasteCtx.prof.learned) || 0 : 0,
            searched: tasteSearched.length ? tasteSearched : undefined,
            artists: artistSearched.length ? artistSearched : undefined,
            note: tasteCtx.note || undefined,
          },
          // 收藏剔除的状态 —— 让用户知道它到底生效没
          bookmarks: {
            loggedIn: bm.loggedIn,
            count: bm.ids.size,
            note: bm.why,
          },
          loginUsed: cfg.useLogin && !loginSkipped.length && await c.usingLogin(),
          loginSkipped: loginSkipped.length ? loginSkipped : undefined,
          errors: errors.length ? errors : undefined,
        }
      },
    }
  }

  /** pixiv_pick —— 元数据粗筛后，让 agent 挑（真读图的那步由 agent 自己做） */
  toolPick() {
    return {
      name: 'pixiv_pick',
      description:
        '把 pixiv_search 的候选**缩略图**下下来，好让你用 read_image 真的看一眼再挑。' +
        '返回本地缩略图路径；看过之后用 pixiv_works 取原图。' +
        '⚠️ 这需要有视觉能力的模型；纯文本模型会读不了图。',
      parameters: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: '要看的作品 id 列表（来自 pixiv_search）' },
        },
        required: ['ids'],
        additionalProperties: false,
      },
      output: toolOutput('缩略图已落盘，用 read_image 看'),
      async execute(args) {
        const cfg = this.getConfig()
        const c = this.client()
        const ids = Array.isArray(args.ids) ? args.ids.map(String).slice(0, 20) : []
        if (!ids.length) throw new Error('pixiv_pick: 需要给至少一个作品 id')

        const dir = join(this.home, 'cache', 'thumbs', localDay())
        await fs.mkdir(dir, { recursive: true })

        const out = []
        for (const id of ids) {
          try {
            const d = await c.detail(id)
            const base = sanitize(id, { max: 20 })

            // 有缓存就不重复下 —— ⚠️ 四种扩展名都要找，因为真实格式是下完才知道的
            for (const ext of ['.jpg', '.png', '.webp', '.gif']) {
              const p = join(dir, base + ext)
              try {
                const st = await fs.stat(p)
                if (st.size > 1000) {
                  out.push({ id, path: p, title: d.title, artist: d.userName, cached: true })
                  break
                }
              } catch { /* 这个扩展名没有，试下一个 */ }
            }
            if (out.length && out[out.length - 1].id === id && out[out.length - 1].cached) continue

            // 缩略图：从 original 反推一个小尺寸；拿不到就直接下一张原图（然后缩）
            const thumbUrl = d.original
              ? d.original.replace('/img-original/', '/c/540x540_70/img-master/').replace('/img-master/', '/c/540x540_70/img-master/')
              : ''
            let bytes
            try {
              const r = await c.image(thumbUrl || d.original || '', {
                illustId: id, page: 0, pageCount: d.pageCount, maxBytes: 8 * 1024 * 1024,
              })
              bytes = r.bytes
            } catch {
              // 缩略图那条失败就退一步：拿页列表再试
              const pg = await c.pages(id)
              if (!pg.length) throw new Error('没拿到任何页')
              const r = await c.image(pg[0].url, { illustId: id, page: 0, pageCount: d.pageCount, maxBytes: 8 * 1024 * 1024 })
              bytes = r.bytes
            }
            // 🔴 按**字节**定扩展名，别写死 .jpg（否则 read_image 会读不了）
            const ext = sniffExt(bytes)
            const target = join(dir, base + ext)
            await fs.writeFile(target, Buffer.from(bytes))
            out.push({
              id, path: target, title: d.title, artist: d.userName,
              bytes: bytes.byteLength, ext, tags: d.tags.slice(0, 10),
            })
          } catch (err) {
            out.push({ id, error: humanError(err) })
          }
        }
        return {
          ok: out.some((o) => !o.error),
          note: '用 read_image 看这些缩略图，挑出真正好的，再用 pixiv_works 取原图。',
          thumbs: out,
        }
      },
    }
  }

  /** pixiv_works —— 取原图（下载到本地缓存，不落库） */
  toolWorks() {
    return {
      name: 'pixiv_works',
      description:
        '把某个作品的**原图**下下来（存到插件的临时缓存里），返回本地路径。' +
        '这一步只是下载，**不写进图库、不占额度**。要正式收进图库用 pixiv_save；要发出去用 pixiv_send。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '作品 id' },
          pages: { type: 'array', items: { type: 'integer' }, description: '要哪几页（从 0 起）。不传就取第一页。' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      output: toolOutput('原图已下载'),
      async execute(args) {
        const cfg = this.getConfig()
        const c = this.client()
        const id = String(args.id || '').trim()
        if (!id) throw new Error('pixiv_works: 需要作品 id')

        const d = await c.detail(id)
        const pg = await c.pages(id)
        if (!pg.length) throw new Error(`作品 ${id} 没有任何页`)

        const want = Array.isArray(args.pages) && args.pages.length
          ? args.pages.map(Number).filter((n) => n >= 0 && n < pg.length)
          : [0]
        const cap = Math.min(want.length, cfg.maxPagesPerWork)

        const dir = join(this.home, 'cache', 'works', localDay(), sanitize(id, { max: 20 }))
        await fs.mkdir(dir, { recursive: true })

        const files = []
        for (const p of want.slice(0, cap)) {
          try {
            const r = await c.image(pg[p].url, {
              illustId: id, page: p, pageCount: d.pageCount, maxBytes: 30 * 1024 * 1024,
            })
            const ext = /png/.test(r.contentType) ? '.png' : /webp/.test(r.contentType) ? '.webp' : '.jpg'
            const target = join(dir, String(p + 1).padStart(3, '0') + ext)
            await fs.writeFile(target, Buffer.from(r.bytes))
            files.push({ page: p, path: target, bytes: r.bytes.byteLength, via: r.via, contentType: r.contentType })
          } catch (err) {
            files.push({ page: p, error: humanError(err) })
          }
        }

        return {
          ok: files.some((f) => !f.error),
          work: { id: d.id, title: d.title, artist: d.userName, tags: d.tags.slice(0, 12), pages: d.pageCount, url: d.url, xRestrict: d.xRestrict },
          files,
          note: '这些是临时文件。要收进图库用 pixiv_save，要发出去用 pixiv_send。',
        }
      },
    }
  }

  /** pixiv_save —— 正式收进图库（过所有闸门） */
  toolSave() {
    return {
      name: 'pixiv_save',
      description:
        '把作品**正式收进图库**：过分级/额度/判重闸门，落盘到保存目录，写 metadata，记台账。' +
        '这是唯一会占每日额度的操作。用户说「存下来」「收了」就用它。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '作品 id' },
          keyword: { type: 'string', description: '这次是搜什么词找到的（写进 metadata，便于回查）' },
          pages: { type: 'array', items: { type: 'integer' }, description: '要存哪几页（从 0 起）。不传就按 maxPagesPerWork 存前几页。' },
          note: { type: 'string', description: '为什么选它（写进 metadata，如「构图好/完成度高」）' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      output: toolOutput('已收进图库'),
      async execute(args) {
        const cfg = this.getConfig()
        const c = this.client()
        const led = this.ledger()
        const id = String(args.id || '').trim()
        if (!id) throw new Error('pixiv_save: 需要作品 id')

        // 闸门 1：判重
        if (await led.has(id)) {
          return { ok: false, skipped: true, reason: '存过了', id }
        }
        // 闸门 2：额度
        const q = await led.hasRoomFor(1, cfg.perDay)
        if (!q.ok) return { ok: false, skipped: true, reason: q.why, id, quota: q }

        const d = await c.detail(id)

        // 闸门 3：分级
        if (!cfg.allowR18) {
          const s = screenContent(d)
          if (s.blocked) {
            return { ok: false, skipped: true, reason: '分级拦下：' + s.reasons.join('/'), id, title: d.title }
          }
        }
        // 闸门 4：页数
        if (cfg.maxPages > 0 && d.pageCount > cfg.maxPages) {
          return { ok: false, skipped: true, reason: `${d.pageCount} 页，超过上限 ${cfg.maxPages}`, id, title: d.title }
        }

        const pg = await c.pages(id)
        if (!pg.length) return { ok: false, skipped: true, reason: '没有任何页可取', id }

        const want = Array.isArray(args.pages) && args.pages.length
          ? args.pages.map(Number).filter((n) => n >= 0 && n < pg.length)
          : Array.from({ length: Math.min(pg.length, cfg.maxPagesPerWork) }, (_, i) => i)

        const images = []
        for (const p of want) {
          try {
            const r = await c.image(pg[p].url, { illustId: id, page: p, pageCount: d.pageCount, maxBytes: 30 * 1024 * 1024 })
            images.push({ page: p, bytes: r.bytes, contentType: r.contentType, via: r.via, url: pg[p].url })
          } catch (err) {
            // 一页失败不该让整件失败；但如果一页都没成，下面会报
            images.push({ page: p, error: humanError(err) })
          }
        }
        const good = images.filter((i) => i.bytes)
        if (!good.length) {
          return { ok: false, skipped: true, reason: '一页都没下下来：' + (images[0] && images[0].error), id }
        }

        const saved = await saveWork({
          root: this.libraryRoot(),
          item: { ...d, source: args.keyword ? `search:${args.keyword}` : d.url },
          images: good,
          opts: { dirTemplate: cfg.dirTemplate, kind: '插画', keyword: args.keyword || '' },
        })

        await led.add({
          id,
          title: d.title,
          artist: d.userName,
          dir: saved.dir,
          pages: saved.fileCount,
          bytes: saved.bytes,
          via: good[0].via,
          keyword: args.keyword || '',
          source: d.url,
        })

        // 学进口味画像（关着就是 no-op）。
        // ⚠️ 放在**存成功之后**，且它自己吞异常 —— 学口味坏了绝不能让"已存下"变成失败。
        const tasteLearn = await this.learnFromSaved(d)

        return {
          ok: true,
          id,
          title: d.title,
          artist: d.userName,
          dir: saved.dir,
          files: saved.saved,
          savedCount: saved.saved.length,
          skippedPages: saved.skipped.length,
          merged: saved.merged,
          bytes: saved.bytes,
          note: args.note || '',
          quotaAfter: await this.ledger().remaining(cfg.perDay),
          taste: tasteLearn
            ? {
                learned: tasteLearn.learned,
                warm: tasteLearn.warm,
                note: tasteLearn.warm
                  ? `已学进口味画像（累计 ${tasteLearn.learned} 件）—— 下次搜索会按口味反搜`
                  : `已学进口味画像（${tasteLearn.learned}/${COLD_START_MIN}，够数后才影响排序）`,
              }
            : undefined,
          url: d.url,
        }
      },
    }
  }

  /** pixiv_send —— 投递出去 */
  toolSend() {
    return {
      name: 'pixiv_send',
      description:
        '把已经下好的图**发出去**（走投递通道：落盘 / QQ）。' +
        '⚠️ DSH 的聊天框**不支持助手发图**（官方 attachment 只做用户→模型），所以图只能这样送到用户手里。' +
        'QQ 通道只在「最近收到过消息」的被动窗口内能用，窗口过期就只能落盘，工具会如实告诉你。',
      parameters: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' }, description: '要发的本地图片路径（来自 pixiv_works 或 pixiv_save）' },
          text: { type: 'string', description: '附一句话（如「今日排行第 3，画师 XX」）' },
          channels: { type: 'array', items: { type: 'string' }, description: "走哪些通道，如 ['qq','local']。不传就按配置里的。" },
          all: { type: 'boolean', description: 'true = 每个通道都试一遍（QQ 挂了落盘还在）；false = 按顺序试，成功一个就停' },
        },
        required: ['paths'],
        additionalProperties: false,
      },
      output: toolOutput('投递结果'),
      async execute(args) {
        const cfg = this.getConfig()
        const paths = Array.isArray(args.paths) ? args.paths.map(String).filter(Boolean) : []
        if (!paths.length) throw new Error('pixiv_send: 需要给至少一个图片路径')

        const files = []
        for (const p of paths) {
          try {
            const st = await fs.stat(p)
            if (!st.isFile()) throw new Error('不是文件')
            const name = p.split(/[/\\]/).pop()
            const buf = await fs.readFile(p)
            files.push({ path: p, name, bytes: st.size, buffer: buf, contentType: '' })
          } catch (err) {
            files.push({ path: p, name: p.split(/[/\\]/).pop(), ok: false, why: `读不到：${humanError(err)}` })
          }
        }
        const real = files.filter((f) => !f.ok === false && f.buffer)
        if (!real.length) throw new Error('pixiv_send: 给的路径一个都读不到')

        const D = this.delivery()
        const order = Array.isArray(args.channels) && args.channels.length ? args.channels : cfg.channels.map(String)
        const withLocal = order.includes('local') ? order : [...order, 'local']

        const res = args.all
          ? await broadcast(D, real, { order: withLocal, text: args.text || '' })
          : await D.deliver(real, { order: withLocal, text: args.text || '' })

        return {
          ok: res.ok,
          sent: res.sent || (res.channel ? [res.channel] : []),
          channel: res.channel || null,
          failed: res.failed || (res.tried || []).filter((t) => !t.ok).map((t) => ({ name: t.name, why: t.why })),
          skipped: res.skipped || [],
          why: res.why || '',
          note: res.ok ? '' : '图还在本地，上面 failed/skipped 写了每个通道为什么没成',
        }
      },
    }
  }
}
