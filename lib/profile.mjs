/**
 * 口味画像 —— 从「你存过什么」里自动学出偏好，再拿它去反向找图。
 * ============================================================================
 * 设计口径（2026-11-05 跟老大对过的）：
 *
 *   ① **默认关**。`tasteEnabled=false` 时这个模块一概不参与 ——
 *      不学、不影响排序、不产生文件。行为跟没有这个功能时一模一样。
 *
 *   ② **开了就全自动**。不要求用户打分/标注 ——
 *      「存下来」这个动作本身就是投票。存一件算一票。
 *
 *   ③ **要改就在会话里让 agent 改** —— 所以权重必须是**明文 JSON**，
 *      键可读、值可改。不做设置页 UI（老大明确说不要）。
 *      这也是为什么这里刻意不做"二进制/加密/藏内存"那些花样。
 *
 * 为什么不用 pixiv 自己的推荐：那要登录，而登录这条路已实测走不通。
 * 好在偏好这件事**本来就不需要 pixiv 参与** —— 它是本地信号。
 *
 * ⚠️ 一个红线：画像文件里**只放标签和画师的统计**，不放任何凭证，
 *    也不放作品本身的标题/URL。前者有专门的家（credential.json），
 *    后者会无限膨胀且没必要（台账 ledger.jsonl 已经是真相源）。
 * ============================================================================
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/** 权重上限：防止某个标签被刷到压死一切 */
const TAG_CAP = 100
const ARTIST_CAP = 100

/**
 * 半衰期（天）。口味会变，三个月前存的初音不该跟昨天存的一样重。
 * 60 天：一个月后衰减 ~30%，两个月 ~50%，半年几乎归零。
 */
export const HALF_LIFE_DAYS = 60

export function profilePath(home) {
  return join(home, 'taste.json')
}

/** 空画像 */
function emptyProfile() {
  return {
    version: 1,
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    /** 学过多少件（用来判断冷启动够没够） */
    learned: 0,
    /** { "初音ミク": {w: 12.5, n: 8, last: "2026-11-05T..."} } */
    tags: {},
    /** { "<userId>": {w: 6, n: 3, last: "...", name: "画师名"} } */
    artists: {},
    /** 每次学习的流水（只留最近 N 条，便于回查"为什么它变胖了"） */
    recent: [],
  }
}

/**
 * 读画像。**不存在就返回空画像，不抛** ——
 * 配置文件读不到不该让整个插件挂掉。
 */
export async function readProfile(home) {
  try {
    const raw = await fs.readFile(profilePath(home), 'utf8')
    const j = JSON.parse(raw)
    if (!j || typeof j !== 'object') return emptyProfile()
    // 形状兜底：手改坏了也别崩
    return {
      ...emptyProfile(),
      ...j,
      tags: (j.tags && typeof j.tags === 'object' && !Array.isArray(j.tags)) ? j.tags : {},
      artists: (j.artists && typeof j.artists === 'object' && !Array.isArray(j.artists)) ? j.artists : {},
      recent: Array.isArray(j.recent) ? j.recent : [],
    }
  } catch {
    return emptyProfile()
  }
}

/** 原子写（先 tmp 再 rename），避免写一半崩了把画像弄坏 */
export async function writeProfile(home, prof) {
  await fs.mkdir(home, { recursive: true })
  const p = profilePath(home)
  const tmp = p + '.tmp'
  const out = { ...prof, updatedAt: new Date().toISOString() }
  await fs.writeFile(tmp, JSON.stringify(out, null, 2), 'utf8')
  await fs.rename(tmp, p)
  return out
}

export async function clearProfile(home) {
  try { await fs.unlink(profilePath(home)) } catch { /* 没有就算了 */ }
}

/**
 * 时间衰减系数：`last` 距现在多久，衰减到多少。
 * 返回 0..1，越新越接近 1。
 */
export function decayFactor(lastIso, now = Date.now()) {
  const t = Date.parse(lastIso || '')
  if (!Number.isFinite(t)) return 1 // 没有时间戳就当新的
  const days = Math.max(0, (now - t) / 86_400_000)
  return Math.pow(0.5, days / HALF_LIFE_DAYS)
}

/** 数值钳制 */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/**
 * 学一件作品。
 *
 * 「权重」的算法刻意做得**简单可读** —— 因为老大要能自己看懂再让我改：
 *   · 每件 +1 基础分
 *   · 分类加成：插画 > 漫画 > 动图（动图多半是手滑存的）
 *   · 高清加成：长边 ≥2000 再加 0.5
 *   · 写回时对旧权重做**时间衰减后再累加**，所以老兴趣会自动淡出
 *
 * @param {object} prof    现有画像（不会被改，返回新的）
 * @param {object} item    作品（要 tags / userId / userName / width / height / illustType）
 * @param {object} [o]
 * @returns {object} 新画像
 */
export function learn(prof, item, o = {}) {
  const now = o.now || Date.now()
  const nowIso = new Date(now).toISOString()
  const p = {
    ...prof,
    tags: { ...prof.tags },
    artists: { ...prof.artists },
    recent: [...(prof.recent || [])],
  }

  // 这件作品值多少分
  let base = 1
  const it = Number(item.illustType)
  if (it === 0) base += 0.3          // 插画：最想要
  else if (it === 2) base -= 0.5     // 动图：多半不是你想收的
  const long = Math.max(Number(item.width) || 0, Number(item.height) || 0)
  if (long >= 2000) base += 0.5      // 高清
  base = clamp(base, 0.2, 2)         // 负数也保底加点，别学出"负口味"

  const tags = Array.isArray(item.tags) ? item.tags.map(String).filter(Boolean) : []

  // 先对**所有**旧条目做衰减（不只是这次命中的）—— 这样不活跃的兴趣会自然沉下去
  for (const k of Object.keys(p.tags)) {
    const e = p.tags[k]
    if (!e || typeof e !== 'object') { delete p.tags[k]; continue }
    p.tags[k] = { ...e, w: clamp(Number(e.w) || 0, 0, TAG_CAP) * decayFactor(e.last, now) }
  }
  for (const k of Object.keys(p.artists)) {
    const e = p.artists[k]
    if (!e || typeof e !== 'object') { delete p.artists[k]; continue }
    p.artists[k] = { ...e, w: clamp(Number(e.w) || 0, 0, ARTIST_CAP) * decayFactor(e.last, now) }
  }

  // 标签累加
  for (const t of tags) {
    const key = t.slice(0, 60) // 防超长标签把文件撑肿
    const e = p.tags[key] || { w: 0, n: 0, last: nowIso }
    p.tags[key] = {
      w: clamp((Number(e.w) || 0) + base, 0, TAG_CAP),
      n: (Number(e.n) || 0) + 1,
      last: nowIso,
    }
  }

  // 画师累加（画师信号比单个标签更强 —— 你连着存同一个画师，那是硬偏好）
  const uid = String(item.userId || '')
  if (uid) {
    const e = p.artists[uid] || { w: 0, n: 0, last: nowIso, name: '' }
    p.artists[uid] = {
      w: clamp((Number(e.w) || 0) + base * 1.5, 0, ARTIST_CAP), // 画师权重给 1.5 倍
      n: (Number(e.n) || 0) + 1,
      last: nowIso,
      name: item.userName ? String(item.userName).slice(0, 60) : (e.name || ''),
    }
  }

  // 流水（留最近 50 条）
  p.recent.push({
    ts: nowIso,
    id: String(item.id || ''),
    title: String(item.title || '').slice(0, 80),
    artist: String(item.userName || '').slice(0, 60),
    gain: Number(base.toFixed(2)),
    tags: tags.slice(0, 12),
  })
  if (p.recent.length > 50) p.recent = p.recent.slice(-50)

  p.learned = (Number(prof.learned) || 0) + 1
  return p
}

/**
 * 把画像压成「打分用的权重表」。
 * 这就是交给 taste.mjs 的 score() 的东西 —— 它只认 {标签: 数值}。
 */
export function toWeights(prof, o = {}) {
  const scale = Number(o.scale) > 0 ? Number(o.scale) : 1
  const tagWeights = {}
  const artistBoost = {}

  for (const [k, e] of Object.entries(prof.tags || {})) {
    const w = Number(e && e.w) || 0
    if (w <= 0) continue
    tagWeights[k] = Number((w * scale).toFixed(3))
  }
  for (const [k, e] of Object.entries(prof.artists || {})) {
    const w = Number(e && e.w) || 0
    if (w <= 0) continue
    artistBoost[k] = Number((w * scale).toFixed(3))
  }

  const topTags = Object.entries(tagWeights).sort((a, b) => b[1] - a[1]).slice(0, 20)
  const topArtists = Object.entries(artistBoost).sort((a, b) => b[1] - a[1]).slice(0, 10)

  return { tagWeights, artistBoost, topTags, topArtists }
}

/**
 * 这些标签太宽泛，拿去搜等于没搜（数量级千万，全是噪声）。
 * 留着是为了**不让它们占掉 pickKeywords 的名额**。
 */
const VERY_BROAD = new Set([
  'オリジナル', 'original', 'イラスト', 'illustration', '插画', '原创',
  '練習', 'practice', '落書き', 'sketch', '女の子', '男の子', '漫画', 'manga',
  'アニメ', 'anime', 'fanart', 'ファンアート',
])

/**
 * 挑出「该去搜什么」的标签 —— 这是把偏好变成**新池子**的那一步。
 *
 * ⚠️ 只返回**标签**，不返回画师。原因（2026-11-05 实测踩到的坑）：
 *    我原本想用 pixiv 的 `user:画师名` 搜索语法去捞某个画师的作品，
 *    实测 **total 恒为 0** —— 那个语法在现在的网页接口上不工作。
 *    而直接搜画师名更糟：搜「幸永」返回 3 条，画师 id 却是别人的（6278780）。
 *    ⇒ 按画师捞作品**不能走搜索**，得走 `/ajax/user/<id>/profile/all`
 *      （见 pickArtists 与 toolset 里的实现）。
 *
 * ⚠️ 关键设计：只挑**权重够高**的标签。不然会把噪声词也拿去搜，
 *    池子被稀释，还不如原来的日榜。
 *
 * @param {object} prof
 * @param {object} [o]
 * @param {number} [o.max]      最多几个词
 * @param {number} [o.minWeight] 权重门槛
 * @param {string[]} [o.exclude] 别用的词（比如已经在配置 keywords 里的）
 * @returns {string[]}
 */
export function pickKeywords(prof, o = {}) {
  const max = Number(o.max) > 0 ? Number(o.max) : 5
  const minW = Number(o.minWeight) > 0 ? Number(o.minWeight) : 2
  const exclude = new Set((o.exclude || []).map((s) => String(s).toLowerCase()))

  return Object.entries(prof.tags || {})
    .filter(([k, e]) => e && Number(e.w) >= minW && !exclude.has(k.toLowerCase()))
    // 太通用的标签搜出来等于没搜（オリジナル 有 1200 万条）
    .filter(([k]) => !VERY_BROAD.has(k.toLowerCase()))
    .sort((a, b) => Number(b[1].w) - Number(a[1].w))
    .slice(0, max)
    .map(([k]) => k)
}

/**
 * 挑出「该去翻哪些画师」—— 返回 **userId**（不是名字）。
 *
 * 为什么给 id 而不是名字：按画师捞作品要走 `/ajax/user/<id>/profile/all`，
 * 那个接口吃的是数字 id。见 pickKeywords 上面那段实测记录。
 *
 * @param {object} prof
 * @param {object} [o]
 * @param {number} [o.max]       最多几个画师
 * @param {number} [o.minWeight] 权重门槛
 * @param {number} [o.minTimes]  至少存过几次才算真爱
 * @returns {string[]} userId 列表
 */
export function pickArtists(prof, o = {}) {
  const max = Number(o.max) > 0 ? Number(o.max) : 2
  const minW = Number(o.minWeight) > 0 ? Number(o.minWeight) : 2
  const minN = Number(o.minTimes) > 0 ? Number(o.minTimes) : 2

  return Object.entries(prof.artists || {})
    .filter(([k, e]) => k && /^\d+$/.test(k) && e && Number(e.n) >= minN && Number(e.w) >= minW * 1.2)
    .sort((a, b) => Number(b[1].w) - Number(a[1].w))
    .slice(0, max)
    .map(([k]) => k)
}

/** 给状态显示用的一句话 */
export function describe(prof) {
  const learned = Number(prof.learned) || 0
  if (!learned) return '还没学到任何东西（存第一件之后才开始）'
  const { topTags, topArtists } = toWeights(prof)
  const tagStr = topTags.slice(0, 6).map(([k, w]) => `${k}(${w.toFixed(1)})`).join(' · ')
  const artStr = topArtists.slice(0, 3).map(([k, w]) => {
    const name = (prof.artists[k] && prof.artists[k].name) || k
    return `${name}(${w.toFixed(1)})`
  }).join(' · ')
  const parts = [`学过 ${learned} 件`]
  if (tagStr) parts.push(`标签：${tagStr}`)
  if (artStr) parts.push(`画师：${artStr}`)
  return parts.join('\n')
}

/** 冷启动门槛：学够这么多件之前，画像不参与排序 */
export const COLD_START_MIN = 5

/** 画像够不够成熟（决定要不要真的用它） */
export function isWarm(prof, min = COLD_START_MIN) {
  return (Number(prof.learned) || 0) >= min
}
