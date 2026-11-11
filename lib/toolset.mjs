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
// ⚠️ 预览用的缩图走这条现成的 Pillow 路（shrink.py），别另引依赖
import { runShrink } from './shrink.mjs'
// 过度区：这一轮的候选先落这儿，点「存」才搬进主图库
import * as staging from './staging.mjs'
import { Delivery, LocalFolderChannel, QQChannel, filesFromSaved, broadcast } from './deliver.mjs'
import { Session } from './auth.mjs'
import { originalFromThumb } from './pxclient.mjs'
import {
  readProfile, writeProfile, clearProfile, learn, undoLearn, toWeights, pickKeywords, pickArtists,
  describe as describeTaste, isWarm, COLD_START_MIN, profilePath, clearWeights,
} from './profile.mjs'
import {
  readAccount, writeAccount, accountShare, mergeTasteProfiles, slotFromWorks,
  setOwner, advanceMigration, resetAccountOnly, describeAccount, accountPath,
  SAMPLE_PAGES, REFRESH_MS,
} from './accounttaste.mjs'
import {
  penalize, toPenalties, undoPenalty, describePenalty,
  dislikedIds as dislikedIdsOf, NEGATIVE_KINDS,
} from './feedback.mjs'
import {
  bucketize, assemble, diversify, explain, planMood,
  DEFAULT_QUOTA, EXPLORE_MODES,
} from './explore.mjs'
import { analyzeImages, describeVisual } from './vision.mjs'
import { bookmarkIdSet, clearCache as clearBookmarkCache, fetchBookmarkIds } from './bookmarks.mjs'

/** 统一把异常变成人话 */
function humanError(err) {
  if (err instanceof PixivError) return err.message
  const m = err && err.message ? err.message : String(err)
  return m
}

/**
 * 从原图 URL 推出 pixiv 的缩略图 URL。
 * ============================================================================
 * 🔴 这里踩过一个很隐蔽的坑（2026-11-06）：原来的写法是**连着两次 replace**：
 *
 *     original.replace('/img-original/', '/c/540x540_70/img-master/')
 *             .replace('/img-master/',  '/c/540x540_70/img-master/')
 *
 *   第一次已经把 `/img-original/` 换成 `/c/540x540_70/img-master/` 了，
 *   第二次又在**刚生成的结果**里找 `/img-master/` —— 于是拼成
 *     `/c/540x540_70/c/540x540_70/img-master/...`   ← 双重前缀，404
 *
 *   为什么一直没人发现：调用点有 fallback（缩略图失败就下原图再缩），
 *   所以功能"看起来是好的"，只是**每次都白撞一次 404、多下一次大图**。
 *
 * 正确做法：**只换一次**，且要认两种情况：
 *   · 原图是 `/img-original/` → 换成 `/c/540x540_70/img-master/`
 *   · 已经是 `/img-master/`    → 前面加 `/c/540x540_70/`
 * 用 if/else 一次改完，不做链式 replace。
 */
/**
 * 过度区 meta.json → 存图要的作品形状（联不上网时用）。
 * 🔴 分级字段原样带过去，存的时候照样过 screenContent —— 本地兜底不等于绕开红线。
 */
export function itemFromStaged(m, id) {
  const x = m || {}
  const sid = String(x.id || id || '')
  return {
    id: sid,
    title: String(x.title || '') || `illust_${sid}`,
    userId: String(x.userId || ''),
    userName: String(x.artist || x.userName || ''),
    tags: Array.isArray(x.tags) ? x.tags : [],
    pageCount: Math.max(1, Number(x.pageCount) || 1),
    width: Number(x.width) || 0,
    height: Number(x.height) || 0,
    illustType: Number(x.illustType) || 0,
    xRestrict: Number(x.xRestrict) || 0,
    restrict: Number(x.restrict) || 0,
    contentFlags: x.contentFlags || {},
    aiType: Number(x.aiType) || 0,
    createDate: String(x.createDate || ''),
    bookmarkCount: Number(x.bookmarkCount) || 0,
    url: String(x.url || `https://www.pixiv.net/artworks/${sid}`),
  }
}

export function thumbFromOriginal(original) {
  const u = String(original || '').trim()
  if (!u) return ''
  // 已经是缩略图形态就别再动（幂等，防重复调用出错）
  if (/\/c\/\d+x\d+/.test(u)) return u
  if (u.includes('/img-original/')) return u.replace('/img-original/', '/c/540x540_70/img-master/')
  if (u.includes('/img-master/')) return u.replace('/img-master/', '/c/540x540_70/img-master/')
  return u
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
 * 深清洗：把返回值里**过不了 JSON 往返**的东西就地换掉。
 * ============================================================================
 * 🔴 为什么必须做（2026-11-07 实测踩到，而且是**活 bug**）：
 *
 *   宿主在工具执行后会校验返回值「是不是 lossless JSON」，
 *   判据等价于 `JSON.parse(JSON.stringify(v))` 能否还原。
 *   而 `JSON.stringify` 会**静默丢掉值为 `undefined` 的键**：
 *       { a: 1, b: undefined }  ──往返──▶  { a: 1 }    ← 不等于原值
 *   宿主判不合格，**整个工具调用失败**，模型只看到一句：
 *       tool "pixiv_search" returned invalid output: value is not lossless JSON
 *
 *   而本文件里有大量 `x.length ? x : undefined` 这种"有就带上、没有就省略"
 *   的写法（本意是让返回干净），正好全部命中 ——
 *   也就是说 **`pixiv_search` 在「画像没开 / 没有报错」这种最常见的
 *   情况下是必然失败的**。
 *
 *   ⚠️ 这类 bug 自检抓不到：自检直接调函数、不过宿主那道校验。
 *      所以必须补一条"往返自检"（见 selfcheck-tools.mjs）。
 *
 * 修法：不在每个 return 上删 `undefined`（治标 —— 下次再加一个字段又中招），
 *       而在**工具输出的唯一出口**统一清洗（治本）。
 *
 * 处理规则：
 *   undefined / 函数 / Symbol → 丢键（保持"省略"的语义）
 *   NaN / ±Infinity           → null（JSON 没这些；转字符串更骗人）
 *   bigint                    → 字符串
 *   Set / Map                 → 数组 / 对象
 *   Date                      → ISO 字符串
 *   循环引用                  → '[循环引用]'（绝不抛）
 *   深度超限                  → '[太深了]'
 * ============================================================================
 */
export function deepSanitize(v, depth = 0) {
  if (depth > 12) return '[太深了]'
  const t = typeof v
  if (v === null) return null
  if (t === 'undefined' || t === 'function' || t === 'symbol') return DROP
  if (t === 'bigint') return String(v)
  if (t === 'number') return Number.isFinite(v) ? v : null
  if (t === 'string' || t === 'boolean') return v
  if (v instanceof Date) {
    return Number.isFinite(v.getTime()) ? v.toISOString() : null
  }
  // 二进制（取图那条路会给 Uint8Array）—— 不能原样进去，会变成 {"0":..} 空壳
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) {
    return `[bytes ${v.byteLength}]`
  }
  if (v instanceof Set) {
    return [...v].map((x) => {
      const s = deepSanitize(x, depth + 1)
      return s === DROP ? null : s
    })
  }
  if (v instanceof Map) {
    const o = {}
    for (const [k, x] of v) {
      const s = deepSanitize(x, depth + 1)
      if (s !== DROP) o[String(k)] = s
    }
    return o
  }
  if (t === 'object') {
    if (seen.has(v)) return '[循环引用]'
    seen.add(v)
    try {
      if (Array.isArray(v)) {
        return v.map((x) => {
          const s = deepSanitize(x, depth + 1)
          return s === DROP ? null : s   // 数组里的空位补 null（删元素会挪下标）
        })
      }
      const o = {}
      for (const k of Object.keys(v)) {
        const s = deepSanitize(v[k], depth + 1)
        if (s !== DROP) o[k] = s        // 丢键，就是"省略"的语义
      }
      return o
    } finally {
      seen.delete(v)
    }
  }
  return String(v)
}

/** 清洗时用的哨兵：表示"这个键整个不要" */
const DROP = Symbol('drop')

/** 循环引用检测用的在途集合（每次顶层调用前清空） */
const seen = new Set()

/** 对外入口：清洗一个返回值，保证它一定能安全 JSON 往返 */
export function lossless(value) {
  seen.clear()
  const out = deepSanitize(value, 0)
  seen.clear()
  return out === DROP ? null : out
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
    /**
     * 结果回调 —— 宿主用它把每轮候选推给「浮窗·这一轮」。
     * ⚠️ 调用时**必须吞异常**：浮窗是展示层，它坏了不该影响工具返回。
     */
    this.onResult = typeof o.onResult === 'function' ? o.onResult : null
    this._client = null
    this._clientKey = ''
    this._session = null
  }

  /** 把一批候选推给浮窗（失败静默 —— 展示层不该影响主流程） */
  publish(items, label) {
    if (!this.onResult) return
    try { this.onResult({ items, label }) } catch { /* ignore */ }
  }

  /**
   * 「这一轮」的 id —— 过度区按它分目录。
   *
   * 🔴 进程内记住**当前这一轮**；每次调用 `startRound()` 才算新一轮。
   *    为什么要这样而不是每次现算时间戳：
   *    `pixiv_pick` 一批一批地调（10 张一批），如果每次都生成新 id，
   *    同一轮的候选会被拆进好几个目录，"清上一轮"就清不干净了。
   */
  roundId() {
    if (!this._roundId) this._roundId = staging.newRoundId()
    return this._roundId
  }

  /**
   * 开新的一轮 —— 顺手把**上一轮**的过度区清掉。
   *
   * 🔴 这是"清理"的唯一触发点（老大定的：按轮清，不掐表）。
   *    为什么不掐表（比如"10 分钟后删"）：
   *      ① 边看边挑会被删到手，缩略图当场变破图，而且**没法重下**；
   *      ② 定时删除和"按日期分目录"的结构打架，还会出现
   *         "我明明刚存过怎么又删了"这类竞态。
   *    按轮清就没有这些 —— 你开始看新的一轮时，上一轮的东西才走。
   *
   * ⚠️ 只清过度区，**绝不动主图库**（staging.cleanRounds 里只遍历 staging 根）。
   */
  async startRound() {
    const cfg = this.getConfig()
    const prev = this._roundId
    const next = staging.newRoundId()
    this._roundId = next
    let cleaned = null
    if (cfg.stagingEnabled !== false && prev) {
      try {
        cleaned = await staging.cleanRounds({
          home: this.home,
          // 保留当前这一轮；上一轮（prev）不保留 ⇒ 被清
          keep: [next],
        })
      } catch { /* 清不掉不该挡住这一轮 */ }
    }
    return { roundId: next, prev, cleaned }
  }

  /** 配置变了就重建 client（代理地址/外部源/超时可能都变了） */
  client() {
    const cfg = this.getConfig()
    const key = `${cfg.proxyUrl}|${cfg.externalApi}|${cfg.mirrorHost}|${cfg.hibiEnabled}|${cfg.hibiApi}|${(cfg.mirrorIps || []).join(',')}|${cfg.timeoutMs}|${cfg.imageTimeoutMs}|${cfg.probeTimeoutMs}|${cfg.useLogin}|${cfg.tasteEnabled}|${cfg.tasteKeywords}|${cfg.tasteMinWeight}|${cfg.tasteScale}`
    if (!this._client || this._clientKey !== key) {
      this._client = new PixivClient({
        proxyUrl: cfg.proxyUrl,
        externalApi: cfg.externalApi,
        mirrorHost: cfg.mirrorHost,
        hibiEnabled: cfg.hibiEnabled,
        hibiApi: cfg.hibiApi,
        mirrorIps: cfg.mirrorIps,
        timeoutMs: cfg.timeoutMs,
        // ⚠️ 取图那个更大的超时也要传 —— 不传的话大图还是会 25s 掐断
        imageTimeoutMs: cfg.imageTimeoutMs,
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

  /** 账号喜好那份（读盘 + 算占比 + 一句话说明）—— toolTaste / status / 搜索共用 */
  async accountTaste() {
    const prof = await readProfile(this.home)
    const acc = await readAccount(this.home)
    const info = accountShare(acc, prof)
    return { acc, info, prof, text: describeAccount(acc, info), file: accountPath(this.home) }
  }

  /**
   * 把画像翻译成「打分参数」和「该搜什么」。
   * 画像不成熟（冷启动没学够）时只给搜索词、不参与打分 ——
   * 学了两件就去干扰排序，还不如不学。
   *
   * 🔴 账号喜好（2026-11-10 加）在这一步**合进同一份画像**再往下走：
   *    打分、反搜关键词、画师池全从这一份出，不会出现"打分管用、反搜不管用"的半生效。
   *    占比由 `accountShare()` 一处决定（本机没热身 / 刚重置 ⇒ 占大，否则只当零头）。
   *    ⚠️ 这里**不能**乘 `tasteScale` —— 它是下游 `taste.mjs` 打分时乘的，这里乘会双重缩放。
   *
   * @returns {Promise<{prof:object|null, acc:object, accInfo:object, warm:boolean, tasteTagWeights:object, tasteArtistBoost:object, keywords:string[], note:string}>}
   */
  async tasteContext() {
    const cfg = this.getConfig()
    const empty = {
      prof: null, acc: null, accInfo: null, warm: false,
      tasteTagWeights: {}, tasteArtistBoost: {},
      tasteTagPenalty: {}, tasteArtistPenalty: {}, dislikedIds: new Set(),
      keywords: [], artists: [], note: '',
    }
    if (!cfg.tasteEnabled) return { ...empty, note: '口味画像关着' }

    const prof = await readProfile(this.home)
    const acc = await readAccount(this.home)
    const accInfo = accountShare(acc, prof)
    const merged = mergeTasteProfiles(prof, acc, { shareInfo: accInfo })

    const learned = Number(prof.learned) || 0
    const disliked = Number(prof.disliked) || 0

    // ⚠️ 负向反馈**不看冷启动门槛**，这一点跟正向不同。
    //    理由：「不要这个画师」是**明确指示**，不是从行为里猜出来的偏好 ——
    //    用户说了就该立刻生效，不该等攒够 5 件。正向要等是因为那是推断。
    const { tagPenalty, artistPenalty } = toPenalties(prof)
    const dislikedIds = dislikedIdsOf(prof)
    const negTagCount = Object.keys(tagPenalty).length
    const negArtistCount = Object.keys(artistPenalty).length

    // 账号喜好能顶上时，就不能因为"本机没学过"而整体罢工
    const accountActive = accInfo.hasAccount && accInfo.share > 0
    if (!learned && !disliked && !accountActive) {
      return {
        ...empty, prof, acc, accInfo,
        note: `口味画像开着，但还没学到东西（存够 ${COLD_START_MIN} 件后生效）`,
      }
    }

    // ⚠️ warm 用**合并后**的：账号喜好占大时（本机还没热身），它得能真的参与打分
    const warm = isWarm(merged)
    const { tagWeights, artistBoost } = toWeights(merged)
    const keywords = pickKeywords(merged, {
      max: cfg.tasteKeywords,
      minWeight: cfg.tasteMinWeight,
      exclude: cfg.keywords, // 配置里已经有的词不用重复搜
    })
    // ⚠️ 画师返回的是 **userId**（不是名字）—— 按画师捞作品得走
    //    /ajax/user/<id>/profile/all，跟搜索无关。见 pickArtists 的注释。
    const artists = pickArtists(merged, { max: 2, minWeight: cfg.tasteMinWeight, minTimes: 2 })

    const bits = []
    if (keywords.length) bits.push(`反搜：${keywords.join('/')}`)
    if (artists.length) bits.push(`翻熟画师 ${artists.length} 个`)
    if (negTagCount || negArtistCount) {
      const neg = []
      if (negTagCount) neg.push(`${negTagCount} 个标签降权`)
      if (negArtistCount) neg.push(`${negArtistCount} 个画师避开`)
      bits.push(neg.join('、'))
    }
    if (accountActive) bits.push(accInfo.promoted ? `账号喜好占大（×${accInfo.share}）` : `账号喜好当零头（×${accInfo.share}）`)

    return {
      prof,
      acc,
      accInfo,
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
        ? `口味画像生效（本机学过 ${learned} 件${bits.length ? '，' + bits.join('；') : ''}）`
        : `口味画像学中（本机 ${learned}/${COLD_START_MIN}），正向暂不参与排序${bits.length ? '；' + bits.join('；') : ''}`,
    }
  }

  /**
   * 抓一次「账号喜好」—— 「登录过就记下来」那条规则的实现。
   *
   * 🔴 关键前提（2026-11-10 实测）：**登录 ≠ 能读**。
   *    本机凭证好好的，但 `oauth.secure.pixiv.net` 被墙 ⇒ 换不到 token ⇒ 读不了。
   *    所以这里只在**真拿到 token** 时抓，拿不到就如实说"登录着但换不到 token"，
   *    **绝不**报成"没登录"（那会把人引去重新登录）。
   *
   * 口径（老大定的，别改）：
   *   · 只记**第一个**账号；同一账号隔 7 天才刷新一次。
   *   · 换账号 ⇒ 不立刻接管，`advanceMigration()` 每轮往前走一步，慢慢移过去。
   *   · 全程官方 API（要 token），永不经第三方；只读。
   */
  async snapshotAccountTaste(o = {}) {
    const cfg = this.getConfig()
    const log = o.log || this.log
    if (!cfg.tasteEnabled) return { ok: false, why: '口味画像关着（开了才会记账号喜好）' }
    if (cfg.useLogin === false) return { ok: false, why: '登录功能关着' }
    const s = this.session()
    const who = await s.who().catch(() => ({ loggedIn: false }))
    if (!who || !who.loggedIn || !who.userId) return { ok: false, why: '没登录' }

    let token = null
    try { token = await s.token() } catch { token = null }
    if (!token) {
      const why = this.client().lastAuthError
      return {
        ok: false,
        why: `登录着但这会儿换不到 token（登录 ≠ 能读）${why ? '：' + String(why).split('\n')[0].slice(0, 60) : ''}`,
      }
    }

    const acc = await readAccount(this.home)
    const ownerId = String((acc.owner && acc.owner.userId) || '')
    const sameAccount = !!ownerId && ownerId === String(who.userId)
    if (sameAccount && !o.force) {
      const age = Date.now() - Date.parse(acc.owner.at || '')
      if (Number.isFinite(age) && age < REFRESH_MS) {
        return { ok: true, kind: 'fresh', acc, note: `这个账号刚记过（${String(acc.owner.at).slice(0, 10)}），先不重复抓` }
      }
    }

    let works = []
    let source = ''
    try {
      // ⚠️ 走 `this._bookmarksFetch`（默认就是 fetchBookmarkIds）—— 留这个口子是为了
      //    自检能离线喂假收藏；生产里没人会设它。
      const fetchWorks = this._bookmarksFetch || fetchBookmarkIds
      const got = await fetchWorks({
        userId: who.userId,
        token,
        proxyUrl: cfg.proxyUrl,
        timeoutMs: cfg.timeoutMs,
        maxPages: Number(o.maxPages) > 0 ? Number(o.maxPages) : SAMPLE_PAGES,
        withWorks: true,   // 顺手把标签/画师带回来，不额外发请求
        log,
      })
      works = Array.isArray(got.works) ? got.works : []
      source = '收藏'
    } catch (err) {
      log(`读账号收藏失败（不影响刷图）：${humanError(err).split('\n')[0]}`)
    }
    // 收藏太少（或读不到）⇒ 用同一个账号的个性化推荐补一手
    if (works.length < COLD_START_MIN) {
      try {
        const r = await this.client().recommended({ limit: 60 })
        const items = (r && Array.isArray(r.items)) ? r.items : []
        if (items.length) {
          works = works.concat(items)
          source = source ? `${source}+个性化推荐` : '个性化推荐'
        }
      } catch { /* 补不上就算了，不是错 */ }
    }
    if (works.length < COLD_START_MIN) {
      return { ok: false, why: `只采到 ${works.length} 件（少于 ${COLD_START_MIN} 件），先不记` }
    }

    const slot = slotFromWorks(works, {
      userId: who.userId, userName: who.userName, source,
    })
    let next
    let kind
    if (!ownerId) { next = setOwner(acc, slot); kind = 'first' }
    else if (sameAccount) { next = { ...acc, owner: slot }; kind = 'refresh' }
    else {
      const adv = advanceMigration(acc, slot)
      next = adv.acc
      kind = adv.action === 'handover' ? 'handover' : 'drift'
    }
    await writeAccount(this.home, next)
    const prof = await readProfile(this.home)
    const shareInfo = accountShare(next, prof)
    const kindText = {
      first: '记下了第一个账号',
      refresh: '同一个账号，刷新了采样',
      drift: `换账号了 —— 开始慢慢往「${who.userName || who.userId}」移（本步 ${Math.round((next.migration || 0) * 100)}%）`,
      handover: `交接完成，账号喜好现在以「${who.userName || who.userId}」为准`,
    }[kind] || kind
    log(`账号喜好：${kindText}（采样 ${slot.sampled} 件，来源 ${source}）`)
    return {
      ok: true, kind, acc: next, sampled: slot.sampled, source,
      userId: who.userId, userName: who.userName, shareInfo,
      note: `${kindText}。${describeAccount(next, shareInfo)}`,
    }
  }

  /**
   * 两种重置（老大 2026-11-10 要的）。
   *   `{ account: true }` = **只重置账号那份**：本机画像一点不动，账号喜好清掉、
   *                        并记下"重置那一刻本机学到哪了" ⇒ 下次登录的账号会**占大**。
   *   `{}`（默认）        = **完全重置**：本机画像 + 账号喜好都清。
   * 🔴 两种都**保留**"不想看 / 删过了"清单 —— 那是不属于画像的明确指示，
   *    清了就等于把用户删过的图全放回来（这是他前一天刚否掉的行为）。
   */
  async resetTaste(o = {}) {
    const accountOnly = o.account === true
    const prof = await readProfile(this.home)
    const acc = await readAccount(this.home)
    const learned = Number(prof.learned) || 0
    const negatives = (Array.isArray(prof.dislikes) ? prof.dislikes.length : 0) + (Number(prof.disliked) || 0)

    if (accountOnly) {
      await writeAccount(this.home, resetAccountOnly(acc, learned))
      this.log('账号喜好已重置（本机画像保留）')
      return {
        ok: true, kind: 'account', localLearned: learned,
        accountFile: accountPath(this.home),
        note: '账号喜好已清掉，本机学的画像一点没动。下次登录的账号会被重新读取，而且**这次会占大**'
          + `（直到本机自己再攒够 ${COLD_START_MIN} 件）。`,
      }
    }

    await writeProfile(this.home, clearWeights(prof))
    await writeAccount(this.home, resetAccountOnly(acc, 0))
    this.log('口味画像已完全重置（保留不想看/删过了）')
    return {
      ok: true, kind: 'all', keptNegatives: negatives,
      accountFile: accountPath(this.home),
      note: `本机画像和账号喜好都清了，回到冷启动。`
        + (negatives
          ? `⚠️ "不想看 / 删过了"那 ${negatives} 条**留着没清** —— 那不算画像，清掉的话你删过的图会全部再冒出来。`
          : '（本来也没有"不想看"的记录。）')
        + '下次登录的账号会被重新读取。',
    }
  }

  /**
   * 取一件作品的缩略图字节 —— 给浮窗 `<img>` 用。
   *
   * 为什么要插件代取（浏览器直连 i.pximg.net 不行）：
   *   ① pximg 有防盗链，得带 `Referer: https://www.pixiv.net/`
   *   ② 本机直连 pixiv 不通，要走插件已有的网络层（代理/自动发现）
   * 两条浏览器都做不到，插件能做到。
   *
   * @param {string} id
   * @param {number} [page]
   * @returns {Promise<{bytes: Buffer, contentType: string}>}
   */
  async thumbnailBytes(id, page = 0) {
    const clean = String(id || '').trim()
    if (!/^\d+$/.test(clean)) throw new Error(`id 不合法：${id}`)
    const c = this.client()
    const pg = await c.pages(clean)
    const p = Math.min(Math.max(0, Number(page) || 0), Math.max(0, pg.length - 1))
    const full = pg[p] && pg[p].url
    if (!full) throw new Error('这件作品没有可取的第 ' + p + ' 页')
    // 缩略图优先（省流量）；取不到就退原图
    const thumb = thumbFromOriginal(full)
    for (const [url, tag] of [[thumb, '缩略图'], [full, '原图']]) {
      if (!url) continue
      try {
        const r = await c.image(url, { illustId: clean, page: p, pageCount: pg.length, maxBytes: 12 * 1024 * 1024 })
        let ct = r.contentType && /^image\//.test(r.contentType) ? r.contentType : ''
        if (!ct) ct = sniffExt(Buffer.from(r.bytes)) === '.png' ? 'image/png' : 'image/jpeg'
        return { bytes: Buffer.from(r.bytes), contentType: ct }
      } catch (err) {
        this.log(`缩略图取字节失败（${tag}）：${humanError(err)}`)
      }
    }
    throw new Error('缩略图和原图都没取到')
  }

  /**
   * 列出图库里已存的作品（按目录聚合）。
   *
   * 为什么直接扫盘而不是读 ledger：ledger 记的是"什么时候存的"，
   * 而浮窗要显示的是"**现在文件还在不在**" —— 用户可能手删了。
   */
  async libraryList(o = {}) {
    const limit = Math.min(500, Math.max(1, Number(o.limit) || 120))
    const root = this.libraryRoot()
    const out = []
    const walk = async (dir, depth) => {
      if (out.length >= limit || depth > 3) return
      let entries
      try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
      const imgs = entries.filter((e) => e.isFile() && /\.(png|jpe?g|webp|gif)$/i.test(e.name))
      /**
       * ⚠️ 这里**必须 depth > 0** 才算"作品目录"（2026-11-06 踩到）。
       *
       * 踩的现象：图库里明明有 4 件作品，浮窗只显示 1 件。
       * 根因：保存根目录**自己也躺着图片文件**（测试时放进去的 preview_*.png，
       *      正常用里可能有用户手放的图）⇒ `imgs.length > 0` 在 depth=0 就成立
       *      ⇒ 把**根目录本身**当成一件作品返回 ⇒ `return` ⇒ 子目录一件都没扫到。
       * 修法：根目录（depth=0）永远只是容器，不当作品；只有它的子目录才可能是。
       */
      if (imgs.length && depth > 0) {
        // 这一层就是一个作品目录：取第一张当封面
        const first = imgs.sort((a, b) => a.name.localeCompare(b.name))[0]
        const rel = join(dir, first.name).slice(root.length).replace(/^[\\/]+/, '')
        // 目录名形如「标题_id」，末尾的 id 就是作品 id
        const base = dir.split(/[\\/]/).pop() || ''
        const m = /_(\d{5,})$/.exec(base)
        out.push({
          rel,
          dir: dir.slice(root.length).replace(/^[\\/]+/, ''),
          name: base,
          id: m ? m[1] : '',
          pages: imgs.length,
        })
        return
      }
      // 根目录直接躺着的散图也收进来（否则用户手放的图在浮窗里看不见）
      if (imgs.length && depth === 0) {
        for (const e of imgs) {
          if (out.length >= limit) break
          out.push({
            rel: join(dir, e.name).slice(root.length).replace(/^[\\/]+/, ''),
            dir: '',
            name: e.name,
            id: (/_(\d{5,})\./.exec(e.name) || [])[1] || '',
            pages: 1,
            loose: true,   // 标记"散在根目录的"，浮窗可以据此少显示点信息
          })
        }
      }
      for (const e of entries) {
        if (out.length >= limit) break
        if (e.isDirectory() && !e.name.startsWith('.')) await walk(join(dir, e.name), depth + 1)
      }
    }
    await walk(root, 0)
    out.sort((a, b) => b.name.localeCompare(a.name))   // 新的在前（目录名含 id 大致单调）
    return { root, count: out.length, items: out }
  }

  /**
   * 读图库里某个文件的字节（浮窗显示用）。
   * ⚠️ **必须挡住路径穿越** —— 参数来自 HTTP query，不能让它读任意文件。
   */
  async libraryFileBytes(rel) {
    const root = this.libraryRoot()
    const clean = String(rel || '').replace(/\\/g, '/')
    if (!clean) throw new Error('没给路径')
    if (clean.includes('..') || clean.startsWith('/')) throw new Error('路径不合法')
    if (!/\.(png|jpe?g|webp|gif)$/i.test(clean)) throw new Error('只允许取图片')
    const full = join(root, ...clean.split('/'))
    // 二次确认：解析后的绝对路径必须在 root 里面（防 ../ 绕过）
    const resolved = (await import('node:path')).resolve(full)
    const rootResolved = (await import('node:path')).resolve(root)
    if (!resolved.startsWith(rootResolved + (await import('node:path')).sep)) {
      throw new Error('路径越界')
    }
    const bytes = await fs.readFile(resolved)
    const ext = clean.slice(clean.lastIndexOf('.')).toLowerCase()
    const ct = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg'
    return { bytes, contentType: ct }
  }

  /**
   * 从「已收藏」里删掉一件作品（2026-11-08 老大要求"加个删除键"）。
   *
   * 删到哪一层由配置 `deleteMode` 决定（设置页可改）：
   *   'files'  删文件，**台账留行 + 打标记** ⇒ 以后不再推回来（**默认**）
   *   'remove' 删文件 + 清台账，口味留着 ⇒ 以后可能又推回来
   *   'forget' 删文件 + 清台账 + 撤画像权重 = 当作从没存过 ⇒ 以后可能又推回来
   *   ⚠️ 'files' 必须走 `rejectById()`：只"留着行"会被 prune 当死行清掉。
   *
   * 🔴 安全红线（这条比功能重要，别改成"顺手"的写法）：
   *    · **只许删主图库里的东西** —— 解析后的绝对路径必须真的在
   *      libraryRoot 之下，否则直接拒绝；
   *    · 拒绝删图库根目录本身（那是容器，不是作品）；
   *    · 删除前把目标**再 stat 一次**确认它是个目录 ——
   *      不接受"文件路径"（免得有人传个 rel 就删掉单个文件绕过校验）；
   *    · 只删「作品目录」这一层（<画师>/<作品_id>），不递归往上删画师目录。
   *
   * ⚠️ 为什么这么唠叨：项目里清测试数据时手抖过一次（把整个 library 当目标）。
   *    那种事不能再有，所以这里宁可多校验几道。
   *
   * @param {string} rel  图库里的相对路径（来自 libraryList 的 item.dir 或 rel）
   * @param {object} [o]
   * @param {string} [o.mode] 覆盖配置里的 deleteMode
   * @returns {Promise<object>}
   */
  async deleteWork(rel, o = {}) {
    const pathMod = await import('node:path')
    const root = pathMod.resolve(this.libraryRoot())
    const raw = String(rel || '').replace(/\\/g, '/')
    /**
     * 🔴 这里**不能**把开头的 `/` 悄悄削掉（我第一版就是这么写的，测试当场抓到）。
     *
     * 踩到的：`deleteWork('/abs/path')` 本来该拒绝，结果被
     * `replace(/^\/+/, '')` 削成 `abs/path`，变成一个**合法的相对路径**
     * —— 于是"绝对路径"这个明显越界的输入反而通过了。
     * 修法：绝对路径（以 / 开头）直接判不合法，别想着"帮用户修一下"。
     *       另外挡盘符（`C:/…`）和 UNC（`//server/share`）。
     */
    if (!raw.trim()) throw new Error('没给路径')
    if (/^[a-zA-Z]:/.test(raw)) throw new Error('路径不合法（不接受绝对路径）')
    if (raw.startsWith('/')) throw new Error('路径不合法（不接受绝对路径）')

    /**
     * 🔴 `..` 必须**按路径分段**判，不能全文 `includes('..')`。
     *
     * 踩到的（2026-11-08，老大点删除报「路径不合法」）：作品标题叫
     *   `管理人...？_151743550`
     * 里面**三个点**是标题的一部分（省略号），而全文搜 `..` 会命中它
     * ⇒ 合法的作品被当成"路径穿越"拒了。
     *
     * ⚠️ 这是个典型的"安全校验误伤正常输入"：
     *    校验要盯**结构**（".." 是不是单独一段），不是**字面**（出现过没）。
     *    标题里的点、空格、括弧、emoji 都是合法的。
     */
    const segs = raw.split('/').filter((x) => x !== '')
    if (segs.some((x) => x === '..' || x === '.')) throw new Error('路径不合法')
    const clean = segs.join('/')
    if (!clean) throw new Error('没给路径')

    const mode = ['forget', 'remove', 'files'].includes(o.mode)
      ? o.mode
      : (['forget', 'remove', 'files'].includes(this.getConfig().deleteMode)
        ? this.getConfig().deleteMode
        : 'forget')

    const full = pathMod.resolve(root, ...clean.split('/'))
    // ① 必须在图库之内（且不是图库根自己）
    if (full === root) throw new Error('不能删图库根目录')
    if (!full.startsWith(root + pathMod.sep)) throw new Error('路径越界')

    // ② 目标必须是个**作品目录**，不接受单个文件
    let st
    try {
      st = await fs.stat(full)
    } catch {
      return { ok: false, why: '这个作品已经不在图库里了', dir: full }
    }
    if (!st.isDirectory()) {
      // 传进来的是文件（比如 .../001.png）→ 退到它所在的作品目录
      const dir = pathMod.dirname(full)
      if (dir === root || !dir.startsWith(root + pathMod.sep)) throw new Error('路径越界')
      if (!(await fs.stat(dir)).isDirectory()) throw new Error('目标不是一个作品目录')
      return await this.deleteWork(pathMod.relative(root, dir), { mode })
    }

    // ③ 目录名末尾的 id 就是作品 id（沿用 libraryList 的约定）
    const base = full.split(pathMod.sep).pop() || ''
    const m = /_(\d{5,})$/.exec(base)
    const id = m ? m[1] : ''

    const existed = { files: 0, bytes: 0 }
    try {
      for (const f of await fs.readdir(full, { withFileTypes: true })) {
        if (f.isFile()) {
          existed.files++
          try { existed.bytes += (await fs.stat(pathMod.join(full, f.name))).size } catch { /* ignore */ }
        }
      }
    } catch { /* 数不出来不影响删 */ }

    await fs.rm(full, { recursive: true, force: true })

    // ④ 画师目录空了就收掉（只收**紧邻的上一层**，绝不往上递归删）
    let prunedArtist = false
    const artistDir = pathMod.dirname(full)
    if (artistDir !== root && artistDir.startsWith(root + pathMod.sep)) {
      try {
        if ((await fs.readdir(artistDir)).length === 0) {
          await fs.rmdir(artistDir)
          prunedArtist = true
        }
      } catch { /* 收不掉就留着，不是错 */ }
    }

    const out = {
      ok: true, id, dir: full, mode,
      removedFiles: existed.files, removedBytes: existed.bytes,
      prunedArtist, note: `已从图库删掉（${mode === 'files' ? '保留记录' : '并清掉记录'}）`,
    }

    if (!id) {
      out.note = '已删除。⚠️ 目录名里没有作品 id，无法清记录/画像，只删了文件。'
      return out
    }

    // ⑤ 台账
    if (mode === 'files') {
      /**
       * 🔴 打标记、**行留着**（老大 2026-11-10 定的默认口径："删了就别再被找到"）。
       *    不能只"什么都不做"：prune 会把"台账有记录但文件不在"当死行清掉，
       *    那这张图下一轮就又会被推回来。
       */
      try {
        const r = await this.ledger().rejectById(id)
        out.ledgerRejected = r.marked
      } catch (e) {
        out.note += `（标记台账失败：${e && e.message}）`
      }
    } else {
      const led = this.ledger()
      try {
        const r = await led.removeById(id)
        out.ledgerRemoved = r.removed
        // 台账里可能有"目录已不在"的别的行，顺手对一次账
        try { await led.prune() } catch { /* 不影响主流程 */ }
      } catch (e) {
        out.note += `（清台账失败：${e && e.message}）`
      }
    }

    // ⑥ 撤画像权重（只有 'forget' 档）
    if (mode === 'forget') {
      try {
        const prof = await readProfile(this.home)
        const { profile: next, undone } = undoLearn(prof, id)
        if (undone) {
          await writeProfile(this.home, next)
          out.tasteUndone = true
        }
      } catch (e) {
        out.note += `（撤画像失败：${e && e.message}）`
      }
    }

    this.log(`从图库删除 #${id}（mode=${mode}）`)
    return out
  }

  /**
   * 在文件管理器里打开图库里的某个作品目录。
   * ⚠️ 路径穿越检查跟 libraryFileBytes 一样严格 —— 参数来自 HTTP。
   *
   * 🔴 这个函数改过两轮，两轮的坑都记着：
   *
   * 第一轮（假成功）：只 `spawn('explorer', ...)` 就 `return { ok:true }` ——
   *   spawn 失败也照样说"已打开"。
   *
   * 第二轮（真打开了但看不见）：改成等 spawn 结果 + 返回提示，**后端确实起来了**，
   *   窗口也真开了（实测进程里有 `无题_151576867 - 文件资源管理器`），
   *   但 **Explorer 不抢焦点** —— 它开在 DSH 窗口后面，
   *   老大看到的还是"点了没反应"。
   *
   * 第三轮（现在）两处改动：
   *   ① **改用 ShellExecuteW**（而不是 `explorer.exe /select,` 命令行）。
   *      ShellExecute 是 Windows 官方开文件夹的接口，走系统的默认关联行为，
   *      比拼 explorer 命令行可靠（命令行在路径含空格/中文/括弧时容易出幺蛾子）。
   *   ② **打开的是目录本身**，并且**主动把它带到前台**
   *      （老大明确要求"点了直接打开到存图的文件夹里"）。
   *      前端优先用 `openDir`，它不挑文件、直接开那一层。
   */
  async revealInExplorer(rel) {
    const root = this.libraryRoot()
    const clean = String(rel || '').replace(/\\/g, '/')
    if (!clean) throw new Error('没给路径')
    if (clean.includes('..') || clean.startsWith('/')) throw new Error('路径不合法')

    const pathMod = await import('node:path')
    // `.` = 图库根目录本身（面板上那个「打开图库」按钮用的）
    if (clean === '.') {
      if (process.platform === 'win32') return await this.openDir(pathMod.resolve(root))
      const { spawn: sp } = await import('node:child_process')
      if (process.platform === 'darwin') sp('open', [root], { detached: true, stdio: 'ignore' }).unref()
      else sp('xdg-open', [root], { detached: true, stdio: 'ignore' }).unref()
      return { ok: true, dir: root }
    }

    const full = pathMod.resolve(join(root, ...clean.split('/')))
    if (!full.startsWith(pathMod.resolve(root) + pathMod.sep)) throw new Error('路径越界')
    // 传目录而不是文件 —— 资源管理器里跳到该作品那层更自然
    const target = pathMod.dirname(full)

    if (process.platform === 'win32') {
      return await this.openDir(target)
    }
    const { spawn } = await import('node:child_process')
    if (process.platform === 'darwin') {
      spawn('open', [target], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref()
    }
    return { ok: true, dir: target }
  }

  /**
   * 在系统文件管理器里打开一个**目录**，并尽量把它带到前台。
   *
   * 🔴 为什么用 ShellExecuteW 而不是 `explorer.exe` 命令行（2026-11-07 实测）：
   *    两者都**能**把窗口开出来（进程表里能看到
   *    `无题_151576867 - 文件资源管理器`），但 **Explorer 都不会跳到最前面** ——
   *    它开在 DSH 窗口后面，用户看着就是"点了没反应"。
   *    所以光"能开"不够，还得**把它拽到前面**。
   *
   * 做法（全部走 PowerShell 的 COM，不引依赖）：
   *    ShellExecuteW 开目录 → 再让 shell 把自己前置。
   *    ⚠️ 这里**必须容忍失败**：前置失败最坏也就是窗口在后面，
   *      比整个操作报错好得多。所以外层 try 住，失败只降级成提示。
   *
   * @param {string} dir 绝对路径
   */
  async openDir(dir) {
    const { execFile } = await import('node:child_process')
    const ps = [
      '$ErrorActionPreference = "Stop"',
      `$d = '${String(dir).replace(/'/g, "''")}'`,
      'if (-not (Test-Path -LiteralPath $d)) { throw "目录不存在" }',
      // ① 官方接口开目录（比 explorer.exe 命令行可靠）
      'Add-Type -Namespace PxOpen -Name Sh -MemberDefinition \'',
      '  [DllImport("shell32.dll", CharSet=CharSet.Unicode)]',
      '  public static extern IntPtr ShellExecuteW(IntPtr h, string op, string file, string p, string dir, int show);\'',
      '$r = [PxOpen.Sh]::ShellExecuteW([IntPtr]::Zero, "open", $d, $null, $null, 1)',
      'if ([int64]$r -le 32) { throw "ShellExecute 返回 $r" }',
      // ② 把它带到前台。
      //    ⚠️ 实测：**Windows 的前台锁**会让"别的进程刚开的窗口"难以抢焦点，
      //       Shell.Application.Focus() 也常常没效果。所以这里做三层尝试，
      //       全失败也不报错（窗口在后面总比报错强）：
      //         a. Shell.Application 找到那个窗口，ShowWindow + SetForegroundWindow
      //         b. 退一步用 AppActivate（WScript.Shell 的路子）
      //      真抢不到也没关系 —— 前端会把**路径**显示出来，用户能自己找。
      'Start-Sleep -Milliseconds 900',
      'try {',
      '  $sh = New-Object -ComObject Shell.Application',
      '  $win = $sh.Windows() | Where-Object { try { $_.Document.Folder.Self.Path -eq $d } catch { $false } } | Select-Object -First 1',
      '  if ($win) {',
      '    try { $win.Visible = $true } catch { }',
      '    try { $win.Focus() } catch { }',
      '  }',
      '  $ws = New-Object -ComObject WScript.Shell',
      '  if ($win) { try { $null = $ws.AppActivate($win.LocationName) } catch { } }',
      '} catch { }',   // 前置失败不算失败
      'Write-Output "OK"',
    ].join('\n')

    return await new Promise((resolve) => {
      let done = false
      const finish = (v) => { if (!done) { done = true; resolve(v) } }
      let child
      try {
        child = execFile('powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
          { windowsHide: true, timeout: 15000 },
          (err, stdout) => {
            if (err && !/OK/.test(String(stdout || ''))) {
              finish({ ok: false, why: `打开失败：${(err.message || '').split('\n')[0].slice(0, 120)}` })
              return
            }
            finish({
              ok: true,
              dir,
              note: '已经打开这个目录。若没跳到最前面，切到任务栏的「文件资源管理器」看一下。',
            })
          })
      } catch (e) {
        finish({ ok: false, why: `拉不起 powershell：${e && e.message}` })
        return
      }
      child.on('error', (e) => finish({ ok: false, why: `起不来：${e && e.message}` }))
      setTimeout(() => finish({ ok: true, dir, note: '已经让系统打开这个目录（等超时了，结果没确认）。' }), 16000)
    })
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
        // 让 bookmarks 能分清"换 token 失败"和"没登录"
        lastAuthError: this.client().lastAuthError || '',
        log: this.log,
      })
      // loggedIn 说的是**这次到底用没用上**：凭证有但换不到 token（本机直连不通）时是 false，
      // 别让上层显示成"已登录 ✓ 收藏剔除生效"
      return { ids: r.ids, why: r.why, loggedIn: !!(r.from && (r.from.fresh || r.from.cache)), from: r.from }
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

  /**
   * 🔴 跑一个工具，**this 绑好**。
   *
   * 踩过的坑（2026-11-07 老大实测：浮窗点「存」报
   * `this.getConfig is not a function`）：
   *
   *   宿主半端的 HTTP 路由里写的是
   *       ts.toolSave().execute({ id })
   *   —— `toolSave()` 返回一个对象字面量，`.execute` 被**摘下来单独调**，
   *   于是 `this` 不再是 Toolset。而 execute 内部要用 `this.getConfig()`、
   *   `this.client()`、`this.ledger()`… 必然全炸。
   *
   *   `definitions()` 那边是**绑过的**（给宿主注册工具用），
   *   但路由是另一条路，当时没走 definitions()，就漏了。
   *   实测三个路由全中：toolStatus（设置页状态）、toolFeedback（浮窗的
   *   喜欢/不喜欢）、toolSave（浮窗的存）。
   *
   * ⚠️ 所以**路由里别再写 `toolXxx().execute(...)`**，一律走这里：
   *       await ts.run('toolSave', { id })
   *
   * @param {string} name  工具名，如 'toolSave'
   * @param {object} args
   */
  async run(name, args) {
    const mk = this[name]
    if (typeof mk !== 'function') throw new Error(`没有这个工具：${name}`)
    const spec = mk.call(this)
    if (!spec || typeof spec.execute !== 'function') throw new Error(`${name} 没有 execute`)
    // 绑死再调 —— 这是本方法存在的**全部意义**
    return await spec.execute.call(this, args || {})
  }

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
    return specs.map((s) => {
      if (!s || typeof s.execute !== 'function') return s
      const bound = s.execute.bind(this)
      return {
        ...s,
        /**
         * 🔴 唯一出口，**必须**在这里过一遍 lossless()。
         *
         * 宿主会校验返回值能不能无损 JSON 往返；`undefined` 键会被
         * JSON.stringify 静默丢掉 ⇒ 判不合格 ⇒ 整个工具调用失败。
         * 详见上面 deepSanitize() 的注释（这是实测踩到的活 bug）。
         *
         * 包在这里而不是在 render 里：render 只管**给人/m 模型看的文本**，
         * 校验的是**返回值本身** —— 两码事，在 render 里洗没用。
         */
        execute: async (...a) => lossless(await bound(...a)),
      }
    })
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
            const at = await this.accountTaste()
            taste = {
              enabled: true,
              learned,
              warm: isWarm(prof),
              coldStartMin: COLD_START_MIN,
              text: describeTaste(prof),
              account: {
                recorded: !!(at.acc && at.acc.owner),
                text: at.text,
                userName: (at.acc && at.acc.owner && at.acc.owner.userName) || '',
                sampled: (at.acc && at.acc.owner && at.acc.owner.sampled) || 0,
                share: at.info ? at.info.share : 0,
                promoted: !!(at.info && at.info.promoted),
              },
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
        '⚠️ 调权重是**直接改** taste.json，改完立刻影响下次搜索排序。' +
        '另外还能重置「账号喜好」（从你登录的 pixiv 账号读来的那份，跟本机学的那份分开存）。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['show', 'enable', 'disable', 'set', 'remove', 'reset', 'resetAccount', 'account'],
            description:
              'show=看现状（默认）/ enable=开启画像 / disable=关闭（不学也不影响排序）' +
              ' / set=改权重 / remove=删掉某标签或画师' +
              ' / reset=**完全重置**（清本机画像+账号喜好，但保留"不想看/删过了"）' +
              ' / resetAccount=**只重置账号喜好**（本机画像一点不动）' +
              ' / account=只看/更新账号喜好（带 force 就立刻重抓一次）',
          },
          kind: { type: 'string', enum: ['tag', 'artist'], description: 'set/remove 时改哪类，默认 tag' },
          key: { type: 'string', description: 'set/remove 的标签名或画师 id' },
          weight: { type: 'number', description: 'set 时的权重（0 就是不再推它）' },
          force: { type: 'boolean', description: 'account：无视 7 天间隔，立刻重抓一次当前登录账号' },
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

        // 完全重置：清画像（本机 + 账号），**保留"不想看/删过了"**
        if (action === 'reset') {
          const r = await this.resetTaste({})
          return { ok: true, action, ...r }
        }

        // 只重置账号那份（本机画像不动）
        if (action === 'resetAccount') {
          const r = await this.resetTaste({ account: true })
          return { ok: true, action, ...r }
        }

        // 账号喜好：看一眼 /（带 force）立刻重抓
        if (action === 'account') {
          const at = await this.accountTaste()
          let snap = null
          if (args.force) {
            snap = await this.snapshotAccountTaste({ force: true })
          }
          const now = await this.accountTaste()
          return {
            ok: true,
            action,
            recorded: !!(now.acc && now.acc.owner),
            text: now.text,
            userId: (now.acc && now.acc.owner && now.acc.owner.userId) || '',
            userName: (now.acc && now.acc.owner && now.acc.owner.userName) || '',
            sampled: (now.acc && now.acc.owner && now.acc.owner.sampled) || 0,
            source: (now.acc && now.acc.owner && now.acc.owner.source) || '',
            at: (now.acc && now.acc.owner && now.acc.owner.at) || '',
            share: now.info ? now.info.share : 0,
            promoted: !!(now.info && now.info.promoted),
            migrating: now.acc && now.acc.latest
              ? { to: now.acc.latest.userName || now.acc.latest.userId, progress: now.acc.migration }
              : undefined,
            snapshot: snap || undefined,
            file: now.file,
            note: snap && snap.ok ? snap.note : (snap && !snap.ok ? `没抓成：${snap.why}` : (at.info && at.info.why)),
          }
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
        const at = await this.accountTaste()
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
          // 账号喜好（从登录的 pixiv 账号读来的那份，跟本机学的分开存）
          account: {
            recorded: !!(at.acc && at.acc.owner),
            text: at.text,
            userName: (at.acc && at.acc.owner && at.acc.owner.userName) || '',
            userId: (at.acc && at.acc.owner && at.acc.owner.userId) || '',
            sampled: (at.acc && at.acc.owner && at.acc.owner.sampled) || 0,
            source: (at.acc && at.acc.owner && at.acc.owner.source) || '',
            at: (at.acc && at.acc.owner && at.acc.owner.at) || '',
            share: at.info ? at.info.share : 0,
            promoted: !!(at.info && at.info.promoted),
            why: at.info ? at.info.why : '',
            migrating: at.acc && at.acc.latest
              ? { to: at.acc.latest.userName || at.acc.latest.userId, progress: at.acc.migration }
              : undefined,
            file: at.file,
          },
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

        // 推给浮窗的「这一轮」（展示层坏了不影响这里的返回）
        this.publish(items, `${mode}${words.length ? '：' + words.slice(0, 2).join('/') : ''}`)

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
          items,          // 画像这一轮的状态
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
        //
        // 账号喜好：开一轮时顺手看能不能抓一次（登录着、且真拿得到 token 才抓）。
        // ⚠️ 失败**绝不能挡搜索** —— 抓不到就照旧用本机画像，顺便如实记一句。
        let accountSnap = null
        if (cfg.tasteEnabled && cfg.useLogin !== false) {
          try { accountSnap = await this.snapshotAccountTaste({}) } catch (err) {
            accountSnap = { ok: false, why: humanError(err) }
          }
          if (accountSnap && accountSnap.ok && accountSnap.kind !== 'fresh' && accountSnap.note) {
            this.log(`账号喜好：${accountSnap.note}`)
          }
        }
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
        // 用户明确删掉的（台账里打过标记）—— 剔除原因要跟"存过了"分开说
        const rejected = await led.rejectedIds()
        // 已收藏的（登录才有）—— 推荐时跳过，不拿旧画复习
        const bm = await this.bookmarkedIds()
        const { kept, dropped } = filterAndRank(uniq, {
          ...cfg,
          seenIds: seen,
          rejectedIds: rejected,
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

        /**
         * 🔴 画师去重 —— 别让一个画师刷屏（2026-11-06 实测踩到）。
         *
         * 不做的后果：画像生效后，"翻熟画师"那条腿会一次带回该画师的十来件，
         * 而它们都带「熟画师+」+「画像专门找的」加成 ⇒ 分数集体偏高 ⇒
         * 实测 12 条里 10 条是同一个画师（83%），**变成回音室**。
         *
         * 对比：pixiv_explore 有配额 + diversify 压制，同样画像能出 12 个不同画师。
         *      search 也得有，不然两个工具行为天差地别。
         *
         * ⚠️ 只对有画像/多来源时做 —— 用户**明确指定一个词**搜的时候，
         *    结果本来就该是那个词的，不该硬拆散。
         */
        const picked = diversify(kept, {
          limit,
          // 用户指定了词 ⇒ 温和一点，别硬拆；走画像的 ⇒ 该拆就拆
          artistPenalty: args.word ? 8 : 14,
        })

        const outItems = picked.map((it) => ({
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
        }))
        // 推给浮窗的「这一轮」（浮窗是展示层，它坏了不影响这里的返回）
        this.publish(outItems, args.word ? `搜索：${args.word}` : '这一轮推荐')

        return {
          ok: true,
          found: uniq.length,
          afterFilter: kept.length,
          returned: picked.length,
          items: outItems,
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
            // 账号喜好：这一轮读到了什么/新抓了什么，如实说
            account: tasteCtx.accInfo && tasteCtx.accInfo.hasAccount
              ? {
                  from: (tasteCtx.acc.owner && (tasteCtx.acc.owner.userName || tasteCtx.acc.owner.userId)) || '',
                  sampled: (tasteCtx.acc.owner && tasteCtx.acc.owner.sampled) || 0,
                  share: tasteCtx.accInfo.share,
                  promoted: tasteCtx.accInfo.promoted,
                  why: tasteCtx.accInfo.why,
                }
              : undefined,
            accountSnapshot: accountSnap
              ? { ok: !!accountSnap.ok, kind: accountSnap.kind, why: accountSnap.why, note: accountSnap.note }
              : undefined,
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
        '⚠️ 这需要有视觉能力的模型；纯文本模型会读不了图。' +
        '⚠️ 一次能挑几件有上限（配置 perRound），超出的会被如实列在 notPicked 里，不会偷偷丢掉。',
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
        const raw = Array.isArray(args.ids) ? args.ids.map(String).filter(Boolean) : []
        if (!raw.length) throw new Error('pixiv_pick: 需要给至少一个作品 id')

        /**
         * 🔴 挑的上限（2026-11-09 老大要求把 perRound 接上；此前它是**空设置** ——
         *    设置页能改、日志会打印，但没有任何代码读它）。
         *
         * ⚠️ 单位是「**一次调用**」，不是「一轮」—— 这是有意的，别改成"一轮累计"：
         *    章程（prompts/duty.md）说的"一轮"= 一次值班，由 index.js 的 runRound 拉起；
         *    可 runRound 现在**还是个桩**（只写日志，不真起子会话），而且
         *    `startRound()` 只在 `_roundId` 为空时触发 ⇒ 在一个长驻会话里
         *    **轮次永不轮转**。真按"一轮累计"算，挑满 5 件之后这一整个会话
         *    都再也挑不动了 —— 那是把工具锁死，不是设上限。
         *    锚在一次调用上则简单、可预期、锁不死；要挑更多就再调一次（这是自觉动作，
         *    正是设闸门的目的）。
         *
         * ⚠️ 另外这里**不再静默截断**：原来写死 `slice(0, 20)`，多给的 id 无声消失，
         *    调用方以为都挑到了。现在超出的原样列进 notPicked。
         */
        const HARD_MAX = 20                      // 防御性硬上限：挡住超长数组
        const cap = Math.max(1, Number(cfg.perRound) || 1)
        const limit = Math.min(cap, HARD_MAX)
        const ids = raw.slice(0, limit)
        const notPicked = raw.slice(limit)
        const capNote = notPicked.length
          ? `一次最多挑 ${limit} 件，这 ${notPicked.length} 件没挑：${notPicked.join(', ')}`
            + (cap > HARD_MAX ? `（配置 perRound=${cap}，但单次硬上限 ${HARD_MAX} 件）` : '（想接着挑就再调一次）')
          : null

        /**
         * 🔴 `pixiv_pick` = **一轮的开始**，顺手开新轮次并清掉上一轮的过度区。
         *
         * 为什么把"清上一轮"挂在这儿（而不是 search）：
         *   `pick` 是"真的开始看这一轮的图"那一下 —— 用户不会回头看上一轮的
         *   候选了，所以这时清最安全。挂在 search 上清得太早
         *   （搜完可能还没看，上一轮的图就没了）。
         *
         * ⚠️ 只在**这一批的第一批**开新轮 —— pick 会被一批批地调，
         *    每批都开新轮的话，同一轮的候选会被拆散、也清不干净。
         */
        if (!this._roundId) await this.startRound()

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

            /**
             * 取一张用于**预览**的图。
             *
             * 🔴 这里的口径（2026-11-07 老大明确要求）：
             *    「**保存原图**才是目的，缩略图只是这一轮的预览」
             *    所以：
             *      · 预览这步**不该因为原图大就取不到** ——
             *        实测栽过两次：`Cold Harbor. K48`(4500×6000) 和
             *        `管理人...？`(2894×4093, **10.2MB**)，都是高分作品，
             *        而这里原来卡死在 8MB ⇒ 直接 error，连看都看不到。
             *      · 但预览也不需要原图那么大 —— 下载回来超过阈值就**本地缩**，
             *        省的是读图/落盘的成本，画面内容不打折。
             *      · **保存那条路（toolSave / pixiv_works）仍然取原图**，
             *        上限 30MB，不受这里影响。
             *
             * ⚠️ 缩图走的是现成的 Pillow（shrink.mjs），不另引依赖；
             *    缩失败就退回原图（大不了大一点，**绝不能因此看不到图**）。
             */
            const WANT_MAX = 24 * 1024 * 1024   // 下载上限：多数原图够用
            const PREVIEW_EDGE = 1600           // 预览长边：够看构图和细节
            const thumbUrl = thumbFromOriginal(d.original)

            let bytes = null
            let viaNote = ''
            for (const [url, tag] of [[thumbUrl, '缩略图'], [d.original, '原图']]) {
              if (!url) continue
              try {
                const r = await c.image(url, {
                  illustId: id, page: 0, pageCount: d.pageCount, maxBytes: WANT_MAX,
                })
                bytes = r.bytes
                viaNote = tag
                break
              } catch (e) {
                // 这条不行就试下一条；两条都不行才认错
                viaNote = `${tag}取不到（${String(e && e.message).split('\n')[0].slice(0, 60)}）`
              }
            }
            if (!bytes) {
              // 缩略图 URL 那条路彻底失败时，退一步拿页列表第一页
              const pg = await c.pages(id)
              if (!pg.length) throw new Error('没拿到任何页')
              const r = await c.image(pg[0].url, {
                illustId: id, page: 0, pageCount: d.pageCount, maxBytes: WANT_MAX,
              })
              bytes = r.bytes
              viaNote = '页列表原图'
            }

            /**
             * ── 过度区：把**原图**存下来，供「点存」时直接搬走 ──────────
             *
             * 🔴 为什么（2026-11-09 老大提的）：
             *   原来预览只留一张**缩过的**图，点「存」要**回 pixiv 重下原图**。
             *   那一刻网络一抽风（或代理掉了），就会出现
             *   「图我明明看得见，点存却说下不来」。
             *   把原图先落过度区，点存变成**移动** ⇒ 看过就存得下。
             *
             * ⚠️ 这里存的是**原字节**（缩之前的），别写成缩过的那份 ——
             *    否则"存原图"就成了空话。缩图只是另存一份用于预览。
             *
             * ⚠️ 失败**不影响预览**：过度区写不进去就退回老行为（点存时再下）。
             */
            let staged = null
            if (cfg.stagingEnabled !== false) {
              try {
                const rr = await staging.putWork({
                  home: this.home,
                  roundId: this.roundId(),
                  id,
                  pages: [{ page: 0, bytes, contentType: '' }],
                  // ⚠️ 存时可能**只靠这份**元数据（联不上网时），分级要用的字段一个都不能少
                  meta: {
                    id, title: d.title, artist: d.userName, userId: d.userId,
                    tags: d.tags, pageCount: d.pageCount, url: d.url,
                    xRestrict: d.xRestrict, restrict: d.restrict || 0,
                    contentFlags: d.contentFlags || undefined,
                    aiType: d.aiType || 0, illustType: d.illustType || 0,
                    width: d.width || 0, height: d.height || 0,
                    createDate: d.createDate || '', bookmarkCount: d.bookmarkCount || 0,
                    via: viaNote,
                    at: new Date().toISOString(),
                  },
                })
                staged = rr
              } catch { /* 存不下就算了，点存时会重下 */ }
            }

            /**
             * 太大就**本地缩一份用于预览**。
             * ⚠️ 缩的是**预览副本**；原图已经（或将要）在过度区里躺着。
             */
            let previewShrunk = false
            const SHRINK_OVER = 3 * 1024 * 1024
            if (bytes.byteLength > SHRINK_OVER && this.python) {
              const tmpDir = join(this.home, 'cache', 'thumbs', localDay(), '_tmp')
              try {
                await fs.mkdir(tmpDir, { recursive: true })
                const srcF = join(tmpDir, base + sniffExt(bytes))
                await fs.writeFile(srcF, Buffer.from(bytes))
                const r = await runShrink({
                  python: this.python, src: srcF,
                  longEdge: PREVIEW_EDGE, quality: 88,
                  outDir: join(tmpDir, 'out'),
                })
                if (r.ok && r.out && r.bytes && r.bytes < bytes.byteLength) {
                  bytes = new Uint8Array(await fs.readFile(r.out))
                  previewShrunk = true
                }
              } catch { /* 缩失败就用原字节，绝不因此看不到图 */ }
            }

            // 🔴 按**字节**定扩展名，别写死 .jpg（否则 read_image 会读不了）
            const ext = sniffExt(bytes)
            const target = join(dir, base + ext)
            await fs.writeFile(target, Buffer.from(bytes))
            out.push({
              id, path: target, title: d.title, artist: d.userName,
              bytes: bytes.byteLength, ext, tags: d.tags.slice(0, 10),
              // 过度区里有没有原图 —— 有的话「存」就是搬一下，不重下
              staged: staged ? staged.rel : null,
              // 如实说明这张预览是怎么来的 —— 别让人以为看到的是原图
              preview: previewShrunk ? `预览已缩到长边 ${PREVIEW_EDGE}` : viaNote,
            })
          } catch (err) {
            out.push({ id, error: humanError(err) })
          }
        }

        /**
         * ── 阶段 C：视觉特征 ──────────────────────────────────────────
         * 缩略图已经落在本地了，顺手量一遍画面特征（色彩/光线/构图）。
         *
         * 🔴 三条纪律，别动：
         *   1. **失败就如实没有** —— 整批挂了就 visual=null，
         *      上层 explain() 会据此说"没读图"。绝不拿标签去猜画面。
         *   2. **只量化，不审美** —— 报"高饱和/画面很满"（量出来的），
         *      不报"好看/有氛围感"（没测，等于编）。
         *   3. **不阻断主流程** —— 分析挂了照样把缩略图路径给出去，
         *      读图那一步是 agent 的事，不能被这里连累。
         */
        let visionNote = null
        try {
          const okPaths = out.filter((o) => !o.error && o.path).map((o) => o.path)
          if (okPaths.length) {
            const va = await analyzeImages({ python: this.python, paths: okPaths })
            if (va.ok) {
              for (const o of out) {
                const v = o.path ? va.byPath.get(String(o.path)) : null
                if (!v) continue
                o.visual = {
                  brightness: v.brightness, contrast: v.contrast, saturation: v.saturation,
                  warmth: v.warmth, colorfulness: v.colorfulness, edgeDensity: v.edgeDensity,
                  lightness: v.lightness, tonality: v.tonality,
                  saturationBand: v.saturationBand, temperature: v.temperature,
                  palette: v.palette, orientation: v.orientation,
                  composition: v.composition, dominant: v.dominant,
                  width: v.width, height: v.height,
                }
                o.visualText = describeVisual(v)
              }
              visionNote = '画面特征已量好（本地 Pillow 测的数值，不是模型描述）。'
            } else {
              visionNote = `这轮没做成画面特征（${va.why}）—— 下面的 visual 会缺，按"没读图"算。`
            }
          }
        } catch (err) {
          // 绝不因为这一步把 pick 整个搞挂
          visionNote = `画面特征这一步出错（${humanError(err)}），按"没读图"算。`
        }

        return {
          ok: out.some((o) => !o.error),
          note: '用 read_image 看这些缩略图，挑出真正好的，再用 pixiv_works 取原图。',
          visionNote,
          // 超上限时如实交代 —— 悄悄少给几张是最难查的那种问题
          capped: notPicked.length ? true : undefined,
          askedCount: raw.length,
          pickedCount: ids.length,
          notPicked: notPicked.length ? notPicked : undefined,
          capNote,
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
              illustId: id, page: p, pageCount: d.pageCount, maxBytes: 64 * 1024 * 1024,
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
        '这是唯一会占每日额度的操作（**额度只管 agent 自动存的**；' +
        '使用者自己在「发现」里点存不受限、也不占额度）。用户说「存下来」「收了」就用它。',
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
        //
        // 🔴 判重之前**先对一次账**（2026-11-07 踩到）：
        //    台账里可能躺着"文件早就不在了"的行（换过保存目录、手动删过、
        //    早期测试写进临时目录后被系统清掉）。那些行会让这张图**永远**
        //    存不进来，而用户只看到一句"存过了"，毫无线索。
        //    所以先 prune 掉死行 —— 一次 stat 的事，代价很小。
        try {
          const p = await led.prune()
          if (p && p.removed > 0) this.log(`台账清掉 ${p.removed} 条失效记录（文件已不在）`)
        } catch { /* 对账失败不该挡住保存 */ }

        if (await led.has(id)) {
          return { ok: false, skipped: true, reason: '存过了', id }
        }
        // 闸门 2：额度 —— 🔴 **只管 agent 自动存的**（2026-11-11 老大要求）。
        //   使用者自己在浮窗点「存」：既不拦他，也不占额度。额度是给"替我自动刷"
        //   上的闸，不是替他做主不让我存图。
        //   ⚠️ `byUser` **故意不写进工具参数 schema** —— 那是给浮窗那条路的，
        //      不许 agent 自己传它来绕过额度。
        const byUser = args.byUser === true
        let quota = null
        if (!byUser) {
          quota = await led.hasRoomFor(1, cfg.perDay)
          if (!quota.ok) return { ok: false, skipped: true, reason: quota.why, id, quota }
        }

        /**
         * 🔴 过度区先看（2026-11-09 实测踩到）：
         *   原来这里**先联网取详情**，过度区要到后面才查。结果：预览时原图明明已在本地，
         *   探测缓存一过期、HibiAPI 那一刻又慢，点存就整个失败 ——
         *   「看得见就存得下」的承诺落空（5 张全挂，报的还是"拿不到元数据"）。
         *   改成：过度区有这件、且要存的页都在本地 ⇒ 用 pick 时记下的 meta，**完全不碰网络**。
         *   要别的页才联网；联网失败但页 0 在本地 ⇒ 先把页 0 存下，如实说缺了哪些页。
         */
        let stagedTake = null
        if (cfg.stagingEnabled !== false) {
          try { stagedTake = await staging.takeWork(this.home, id) } catch { stagedTake = null }
        }
        const sm = stagedTake && stagedTake.meta && stagedTake.files.length ? stagedTake.meta : null
        const askedPages = Array.isArray(args.pages) && args.pages.length ? args.pages.map(Number) : null
        const hintCount = sm ? Math.max(1, Number(sm.pageCount) || 1) : 0
        const needNet = !sm || (askedPages
          ? askedPages.some((n) => n !== 0)
          : Math.min(hintCount, cfg.maxPagesPerWork) > 1)

        let d = null
        let netError = ''
        if (needNet) {
          try { d = await c.detail(id) } catch (err) {
            if (!sm) throw err
            netError = humanError(err)
          }
        }
        if (!d) d = itemFromStaged(sm, id)

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

        // 页列表：联网拿得到就用；拿不到但过度区有页 0 ⇒ 只存页 0
        let pg = []
        if (needNet && !netError) {
          try { pg = await c.pages(id) } catch (err) {
            if (!sm) throw err
            netError = humanError(err)
          }
        }
        const localOnly = !pg.length && !!sm
        if (!pg.length && !localOnly) return { ok: false, skipped: true, reason: '没有任何页可取', id }
        const pageTotal = localOnly ? hintCount : pg.length

        let want = askedPages
          ? askedPages.filter((n) => n >= 0 && n < pageTotal)
          : Array.from({ length: Math.min(pageTotal, cfg.maxPagesPerWork) }, (_, i) => i)
        // 只有本地那份时，能存的只有页 0；其余页如实记成缺
        const missingPages = localOnly ? want.filter((n) => n !== 0) : []
        if (localOnly) want = want.includes(0) || !askedPages ? [0] : []
        if (!want.length) {
          return { ok: false, skipped: true, reason: '要的页只能联网取，而现在联不上：' + (netError || '无可用通道'), id }
        }

        const images = []
        /**
         * 🔴 优先从**过度区**拿原图（2026-11-09 老大要求）。
         *
         * 为什么要这样：预览时（pixiv_pick）原图已经落进过度区了，
         * 点存就该是**搬一下**，而不是回 pixiv 再下一遍。
         * 好处很实在：
         *   · 点存**必成功** —— 文件已经在本地，网络抽风也不影响；
         *   · 不用再等一次下载（10MB 级的图能省好几秒）。
         *
         * ⚠️ 只在**页 0** 上生效：预览时只下了第一页（候选看的就是第一页）。
         *    多页作品（漫画）其余页还是得下 —— 这是有意的，
         *    不然一轮要为 100 页的漫画预先拉 100 张。
         */
        let fromStaging = 0

        for (const p of want) {
          // 页 0 且过度区里有 —— 直接用本地那份，不碰网络
          if (stagedTake && p === 0 && stagedTake.files.length) {
            try {
              const f = stagedTake.files[0]
              const b = await fs.readFile(f.path)
              if (b.length > 0) {
                images.push({ page: 0, bytes: new Uint8Array(b), contentType: f.name.endsWith('.png') ? 'image/png' : (f.name.endsWith('.webp') ? 'image/webp' : 'image/jpeg'), via: 'staging', url: (pg[0] && pg[0].url) || '' })
                fromStaging++
                continue
              }
            } catch { /* 读不到就走下面的网络路径 */ }
          }
          if (!pg[p]) {
            images.push({ page: p, error: '过度区里没有这页，也联不上网：' + (netError || '无可用通道') })
            continue
          }
          try {
            const r = await c.image(pg[p].url, { illustId: id, page: p, pageCount: d.pageCount, maxBytes: 64 * 1024 * 1024 })
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
          // 使用者自己存的 ⇒ 不占额度（见闸门 2 那段说明）
          byUser,
        })

        // 学进口味画像（关着就是 no-op）。
        // ⚠️ 放在**存成功之后**，且它自己吞异常 —— 学口味坏了绝不能让"已存下"变成失败。
        const tasteLearn = await this.learnFromSaved(d)

        /**
         * 搬进图库了，过度区那份就该收掉（不收的话一直占地方，
         * 而且下次 findWork 还会找到这个"已经存过"的）。
         * ⚠️ 失败不影响返回 —— 图已经存好了，清不掉最多是多占点空间。
         */
        if (stagedTake) {
          try { await staging.dropWork(this.home, id) } catch { /* ignore */ }
        }

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
          // 如实说明这一页是从过度区搬的、还是重新下的
          fromStaging: fromStaging > 0 ? fromStaging : undefined,
          // 元数据用的是预览时记下的那份（没联网）——如实说
          metaFrom: needNet && !netError ? 'network' : 'staging',
          missingPages: missingPages.length ? missingPages : undefined,
          netNote: netError
            ? `联网失败（${netError.split('\n')[0].slice(0, 80)}），用了过度区里的那份${missingPages.length ? `；缺第 ${missingPages.map((n) => n + 1).join('/')} 页，网好了再存一次会补上` : ''}`
            : undefined,
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
