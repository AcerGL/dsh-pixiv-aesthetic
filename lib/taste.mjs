/**
 * 口味漏斗 —— 打分、过滤、排序。
 * ============================================================================
 * 这一层是纯函数，不碰网络、不碰磁盘。所以它能被 selfcheck 全覆盖。
 *
 * 三层漏斗的**第一、二层**在这里：
 *   一层 硬过滤：R-18、页数、分辨率、时间窗、排除标签、收藏下限
 *   二层 打分：权重标签、画师亲疏、新鲜度、完成度、热度
 *   三层 我 read_image 真看图 —— 那一步在 toolset 里，不在这儿。
 * ============================================================================
 */

/** R-18 的标签特征。排行 json 没有 xRestrict，只能靠标签 + 内容标记。 */
const R18_TAG_RE =
  /(^|[^a-z])(r-?18|r18|r18g|18禁|成人向|エロ|えろ|ero|nsfw|adult|露骨|裸体|全裸|下着|パンツ|おっぱい|ちんこ|まんこ|フェラ|セックス|中出し|輪姦|レイプ|触手責め|痴漢|寝取|ntr)([^a-z]|$)/i

/** 明确要躲开的内容标签（不是 R-18，但多半不是你要的） */
const GROSS_TAG_RE = /(グロ|guro|グロテスク|猟奇|惨殺|四肢切断|リョナ|ryona|スカトロ|排泄|嘔吐)/i

/**
 * 元数据层 R-18 / 不适内容判定。
 * ⚠️ 这是**尽力而为**：没有读图复查，必漏。
 */
export function screenContent(item) {
  const reasons = []
  const tags = Array.isArray(item.tags) ? item.tags : []
  const cf = item.contentFlags || {}

  if (Number(item.xRestrict) === 1) reasons.push('xRestrict=1')
  if (Number(item.restrict) > 0) reasons.push(`restrict=${item.restrict}`)
  if (cf.sexual > 0) reasons.push(`sexual=${cf.sexual}`)
  if (cf.grotesque) reasons.push('grotesque')
  if (cf.violent) reasons.push('violent')
  for (const t of tags) {
    if (R18_TAG_RE.test(t)) { reasons.push(`标签:${t}`); break }
  }
  for (const t of tags) {
    if (GROSS_TAG_RE.test(t)) { reasons.push(`标签:${t}`); break }
  }
  return { blocked: reasons.length > 0, reasons }
}

/** 「原创」这类不沾 R-18 的池塘，用来做默认兜底 */
export const SAFE_RANK_MODES = ['daily', 'weekly', 'original', 'rookie']

/**
 * 把「手填的权重」和「画像学出来的权重」合成一份。
 * ============================================================================
 * 为什么要分开记再合（而不是直接覆盖）：
 *   · 手填的 tagWeights 是用户**显式**说的，画像学的是**隐式**推断的
 *   · 两者冲突时**以手填为准**（显式 > 隐式，这是常识）
 *   · 但都保留：显式给基底，隐式在上面加，这样"我说了算"和"它学到的"并行
 *
 * ⚠️ 画像关着（tasteEnabled=false）时，本函数必须**原样返回手填值** ——
 *    这是"默认关 = 行为完全不变"这条承诺的落点。
 */
export function mergeWeights(manual = {}, learned = {}, o = {}) {
  const scale = Number(o.scale) > 0 ? Number(o.scale) : 1
  const out = {}
  // 先铺手填的
  for (const [k, v] of Object.entries(manual || {})) {
    const n = Number(v)
    if (Number.isFinite(n) && n !== 0) out[k] = n
  }
  // 再叠学到的（按 scale 缩放）
  for (const [k, v] of Object.entries(learned || {})) {
    const n = Number(v) * scale
    if (!Number.isFinite(n) || n === 0) continue
    out[k] = (Number(out[k]) || 0) + n
  }
  return out
}

/**
 * 打分。分数本身没意义，只有相对排序有意义。
 *
 * ⚠️ 关于 prefs.tasteTagWeights / prefs.tasteArtistBoost：
 *    这是**画像学出来的**权重，跟手填的 tagWeights / artistBoost **分开传**。
 *    为什么不在外面合好再传：因为报告里要能说清"这条是它学的还是你设的"。
 */
export function score(item, prefs = {}) {
  const weights = prefs.tagWeights && typeof prefs.tagWeights === 'object' ? prefs.tagWeights : {}
  const minLong = Number(prefs.minLongEdge) || 0
  const tags = Array.isArray(item.tags) ? item.tags : []
  let s = 0
  const why = []

  // 1) 权重标签：命中就加
  for (const t of tags) {
    const w = Number(weights[t])
    if (Number.isFinite(w) && w !== 0) { s += w; why.push(`${t}${w > 0 ? '+' : ''}${w}`) }
  }

  // 1b) 画像学出来的标签权重（单独一条，好区分来源）
  const tw = prefs.tasteTagWeights && typeof prefs.tasteTagWeights === 'object' ? prefs.tasteTagWeights : {}
  if (Object.keys(tw).length) {
    const scale = Number(prefs.tasteScale) > 0 ? Number(prefs.tasteScale) : 1
    // ⚠️ 画像命中**不该无条件全加** —— 一件作品挂十几个热门标签时，
    //    简单求和会让"标签多的"无脑胜出。所以取**命中项的平均**再乘个系数。
    const hits = []
    for (const t of tags) {
      const w = Number(tw[t])
      if (Number.isFinite(w) && w > 0) hits.push({ t, w })
    }
    if (hits.length) {
      const cap = 40 // 画像单条上限，防止某个标签学过头
      const avg = hits.reduce((a, h) => a + h.w, 0) / hits.length
      const bump = Math.min(cap, avg * scale * 0.8)
      s += bump
      const top = hits.sort((a, b) => b.w - a.w).slice(0, 3).map((h) => h.t)
      why.push(`口味+${bump.toFixed(1)}(${top.join('/')})`)
    }
  }

  // 2) 画师亲疏：点过赞的画师（prefs.artistBoost 里有的）
  const boost = prefs.artistBoost && typeof prefs.artistBoost === 'object' ? prefs.artistBoost : {}
  const ab = Number(boost[item.userId] ?? boost[item.userName])
  if (Number.isFinite(ab) && ab !== 0) { s += ab; why.push(`画师+${ab}`) }

  // 2b) 画像学出来的画师权重（画师信号比标签强，所以这里不取平均，直接加）
  const tb = prefs.tasteArtistBoost && typeof prefs.tasteArtistBoost === 'object' ? prefs.tasteArtistBoost : {}
  if (Object.keys(tb).length) {
    const w = Number(tb[item.userId]) || 0
    if (w > 0) {
      const cap = 45
      const bump = Math.min(cap, w * (Number(prefs.tasteScale) > 0 ? Number(prefs.tasteScale) : 1))
      s += bump
      why.push(`熟画师+${bump.toFixed(1)}`)
    }
  }

  /* ── 负向反馈：扣分 ──
   * ⚠️ 这里是"不喜欢"真正生效的地方。
   *
   * 为什么负分要单独一条、而不是并进上面的 tasteTagWeights：
   *   ① 来源不同 —— 上面是"存下来学到的喜欢"，这里是"明确说了不喜欢"，
   *      报告里要能分清（规格第六节要求推荐可解释）。
   *   ② 收敛方式不同 —— 负分必须压住上限，不然一个 -20 的标签能把
   *      十次喜欢攒的正分全抵消（见 feedback.mjs 的 toPenalties）。
   */
  const tp = prefs.tasteTagPenalty && typeof prefs.tasteTagPenalty === 'object' ? prefs.tasteTagPenalty : {}
  if (Object.keys(tp).length) {
    // 跟正向一样**取命中项的平均**，理由相同：不该因为标签多就扣得狠
    const hits = []
    for (const t of tags) {
      const w = Number(tp[t])
      if (Number.isFinite(w) && w < 0) hits.push({ t, w })
    }
    if (hits.length) {
      const avg = hits.reduce((a, h) => a + h.w, 0) / hits.length
      s += avg
      const top = hits.sort((a, b) => a.w - b.w).slice(0, 3).map((h) => h.t)
      why.push(`口味−${Math.abs(avg).toFixed(1)}(${top.join('/')})`)
    }
  }

  const ap = prefs.tasteArtistPenalty && typeof prefs.tasteArtistPenalty === 'object' ? prefs.tasteArtistPenalty : {}
  if (Object.keys(ap).length) {
    const w = Number(ap[item.userId]) || 0
    if (w < 0) {
      s += w
      why.push(`避开画师${w.toFixed(1)}`)
    }
  }

  // 3) 新鲜度：7 天内线性衰减
  const t = Date.parse(item.createDate || '')
  if (Number.isFinite(t)) {
    const days = (Date.now() - t) / 86_400_000
    const fresh = Math.max(0, 20 - days * (20 / 7))
    s += fresh
    if (fresh > 8) why.push('新鲜')
  }

  // 4) 完成度：分辨率
  const long = Math.max(Number(item.width) || 0, Number(item.height) || 0)
  if (long >= 2000) { s += 18; why.push('高清') }
  else if (long >= 1200) s += 10
  if (minLong > 0 && long > 0 && long < minLong) { s -= 40; why.push('分辨率偏低') }

  // 5) 多页（漫画/组图通常是认真画的）
  const pc = Number(item.pageCount) || 1
  if (pc > 1) { s += Math.min(12, 3 + pc); why.push(`${pc}页`) }

  // 6) 热度
  const bk = Number(item.bookmarkCount) || 0
  if (bk > 0) { s += Math.min(25, Math.log10(bk + 1) * 10); if (bk >= 500) why.push(`收藏${bk}`) }
  const vw = Number(item.viewCount) || 0
  if (vw > 0) { s += Math.min(12, Math.log10(vw + 1) * 4) }

  // 7) 纯插画 > 漫画 > 动图（动图发出去是静帧，体验差）
  const it = Number(item.illustType)
  if (it === 0) s += 6
  else if (it === 1) s -= 2
  else if (it === 2) { s -= 18; why.push('动图') }

  // 8) 排行位的天然加成
  if (item.rank > 0 && item.rank <= 30) { s += 12; why.push(`第${item.rank}位`) }

  return { score: s, why }
}

/**
 * 一层 + 二层：过滤 + 打分 + 排序。
 * @param {Array} items
 * @param {object} prefs  见 lib/config 的默认值
 * @returns {{kept:Array, dropped:Array}}
 */
export function filterAndRank(items, prefs = {}) {
  const exclude = (prefs.excludeTags || []).map((t) => String(t).toLowerCase()).filter(Boolean)
  const requireAll = (prefs.requireTags || []).map((t) => String(t).toLowerCase()).filter(Boolean)
  const minBookmarks = Number(prefs.minBookmarks) || 0
  const maxPages = Number(prefs.maxPages) || 0
  const allowR18 = prefs.allowR18 === true
  const dropAi = prefs.dropAiGenerated === true
  const days = Number(prefs.maxAgeDays) || 0
  const seen = prefs.seenIds instanceof Set ? prefs.seenIds : new Set()
  /**
   * 「不想再看」的作品 id（用户明确说过不要的那几张）。
   * ⚠️ 跟 seenIds 分开：seenIds 是"存过了"，这个是"不想看" ——
   *    报告里要说清原因，别让用户以为是自己存过。
   */
  const disliked = prefs.dislikedIds instanceof Set ? prefs.dislikedIds : new Set()

  const kept = []
  const dropped = []
  const now = Date.now()

  for (const it of items) {
    const tagsLower = (it.tags || []).map((t) => String(t).toLowerCase())
    let reason = ''

    if (!it.id) reason = '没有 id'
    else if (seen.has(it.id)) reason = '存过了'
    else if (disliked.has(String(it.id))) reason = '你说过不想看这张'
    else if (!allowR18 && screenContent(it).blocked) {
      reason = '分级：' + screenContent(it).reasons.join('/')
    }
    else if (dropAi && Number(it.aiType) === 2) reason = 'AI 生成'
    else if (maxPages > 0 && Number(it.pageCount) > maxPages) reason = `${it.pageCount} 页超过上限 ${maxPages}`
    else if (minBookmarks > 0 && Number(it.bookmarkCount) > 0 && Number(it.bookmarkCount) < minBookmarks) {
      reason = `收藏 ${it.bookmarkCount} < ${minBookmarks}`
    }
    else if (days > 0 && it.createDate) {
      const t = Date.parse(it.createDate)
      if (Number.isFinite(t) && (now - t) / 86_400_000 > days) reason = `超过 ${days} 天`
    }
    else {
      const hit = exclude.find((e) => tagsLower.some((t) => t.includes(e)))
      if (hit) reason = `排除标签:${hit}`
      else if (requireAll.length && !requireAll.every((r) => tagsLower.some((t) => t.includes(r)))) {
        reason = '缺必须标签'
      }
    }

    if (reason) dropped.push({ ...it, dropReason: reason })
    else {
      const { score: sc, why } = score(it, prefs)
      kept.push({ ...it, score: sc, why })
    }
  }

  kept.sort((a, b) => b.score - a.score)
  return { kept, dropped }
}

/** 报告里给人看的一行 */
export function describe(item) {
  const bits = []
  bits.push(`#${item.id}`)
  bits.push(item.userName || '?')
  if (item.why && item.why.length) bits.push(item.why.join(','))
  if (item.tags && item.tags.length) bits.push(item.tags.slice(0, 6).join('/'))
  return bits.join(' | ')
}
