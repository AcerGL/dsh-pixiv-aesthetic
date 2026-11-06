/**
 * 负向反馈 —— 让插件「听得懂不喜欢」。
 * ============================================================================
 * 规格里最难的一句（老大原话）：
 *   **不能把用户不喜欢一张作品，简单理解为不喜欢它所有标签。**
 *
 * 为什么这句是对的：一张作品挂十几个标签，用户讨厌的**往往只有一个维度** ——
 * 可能是构图太满、可能是色彩太艳、也可能只是"这张画得不行"。标签本身没问题。
 * 如果一不喜欢就把那十几个标签全扣一遍，画像会被噪声淹没：
 *   用户不喜欢一张「初音ミク 夜景 高饱和 大构图」的图，
 *   一刀切会把「初音ミク」也扣了 —— 但他明明喜欢初音，只是不喜欢那张的饱和度。
 *
 * 所以这里**分三类处理**（这也是本模块存在的全部理由）：
 *
 *   ① unlike（不喜欢这张）      → **不扣标签**。只把这张记进「不想再看」，避免重复推。
 *   ② artist_down（不要这个画师）→ 扣画师。这是**强信号**，用户说得具体。
 *   ③ style_down（不要这种风格）→ 扣**用户点名的那些标签**，没点名的不动。
 *
 * ⚠️ 还有一个更深的设计：**负权重不是"反向加分"，是"扣分"**。
 *    但负分容易把一件本来不错的东西压死（一个 -5 的标签能抵掉十个 +1）。
 *    所以这里对负权重额外做**收敛**：见 scorePenalty 的说明。
 * ============================================================================
 */

/** 标签负权重下限（别让一个词被反复踩到无限负） */
export const TAG_NEG_FLOOR = -20
/** 画师负权重下限 */
export const ARTIST_NEG_FLOOR = -30

/** 数值钳制 */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/**
 * 把当前权重「推成负的」。
 * ============================================================================
 * 🔴 这是本模块最容易做错的一处（2026-11-06 实测踩到）：
 *
 *   一开始写成 `w - step`（减 1）。但那有个致命问题 ——
 *   如果那个画师/标签已经攒了 **+8** 的正权重，减 1 只剩 +7，
 *   **还是正的** ⇒ `toPenalties` 只收负数 ⇒ 惩罚表是空的 ⇒
 *   **用户说"不要这个画师"完全没效果**。
 *
 *   而"不喜欢"是**明确指示**，它必须能盖过之前攒的喜欢。
 *   所以规则是：
 *     · 当前 >= 0  → 直接推到 `-step`（越过零，一次到位）
 *     · 当前 <  0  → 正常再减 step（反复说会越扣越狠）
 *
 *   为什么是"越过零"而不是"减够 step 再额外扣"：
 *     用户说一次"不要"就该生效，不该要求他说八次才压过八分正权重。
 *     越过的量就是 step 本身，所以第一次说 = -1（画师 -1），语义干净。
 */
function pushNegative(cur, step) {
  const c = Number(cur) || 0
  if (c >= 0) return -step
  return c - step
}

/** 负向反馈的类型 */
export const NEGATIVE_KINDS = [
  'unlike',        // 不喜欢这一张（不扣标签）
  'artist_down',   // 不要这个画师（扣画师）
  'style_down',    // 不要这种风格（扣点名的标签）
]

/**
 * 判断一条反馈该扣什么。**这是本模块的核心决策**，所以单独拎出来，
 * 让它能被自检直接测（不用去猜行为）。
 *
 * @param {object} fb
 * @param {string} fb.kind        反馈类型（见 NEGATIVE_KINDS）
 * @param {string[]} [fb.tags]    用户点名要扣的标签（只有 style_down 用得上）
 * @param {string} [fb.userId]    画师 id（artist_down 用）
 * @returns {{tags:string[], artist:string, reason:string}}
 */
export function planPenalty(fb = {}) {
  const kind = String(fb.kind || '')

  if (kind === 'unlike') {
    // 🔴 关键：**一个标签都不扣**。这就是规格那句要求的落点。
    return { tags: [], artist: '', reason: '不喜欢这一张：只记下不重复推，不牵连它身上的标签' }
  }

  if (kind === 'artist_down') {
    const uid = String(fb.userId || '').trim()
    if (!uid) return { tags: [], artist: '', reason: '说了不要这个画师，但没给画师 id' }
    return { tags: [], artist: uid, reason: '不喜欢这个画师：只扣画师，不牵连标签' }
  }

  if (kind === 'style_down') {
    const tags = (Array.isArray(fb.tags) ? fb.tags : [])
      .map((t) => String(t || '').trim())
      .filter(Boolean)
      .map((t) => t.slice(0, 60))
    // 去重（同一个词重复扣会让权重异常 —— 规格第四节点名要防的）
    const uniq = [...new Set(tags)]
    if (!uniq.length) {
      return { tags: [], artist: '', reason: '说了不要这种风格，但没点名具体标签' }
    }
    return { tags: uniq, artist: '', reason: `不要这种风格：只扣点名的 ${uniq.length} 个标签` }
  }

  return { tags: [], artist: '', reason: `不认识的反馈类型：${kind || '(空)'}` }
}

/**
 * 把一条负向反馈写进画像。
 *
 * 跟 learn() 一样**不改原对象**，返回新的。
 * 时间衰减照样适用：讨厌的东西也会随时间淡忘（不然一次误点记一辈子）。
 *
 * @param {object} prof
 * @param {object} fb     反馈（kind / tags / userId / userName / id / title / weight）
 * @param {object} [o]
 * @returns {{profile:object, applied:object}} applied 说明这次到底扣了什么
 */
export function penalize(prof, fb = {}, o = {}) {
  const now = o.now || Date.now()
  const nowIso = new Date(now).toISOString()
  // 单次扣多少。默认 1，可以调大（用户说"特别讨厌"）。
  // ⚠️ 上限 5：防止一条反馈把某个标签一次踩死。
  const step = clamp(Number(fb.weight) > 0 ? Number(fb.weight) : 1, 0.2, 5)

  const p = {
    ...prof,
    tags: { ...prof.tags },
    artists: { ...prof.artists },
    recent: [...(prof.recent || [])],
    dislikes: Array.isArray(prof.dislikes) ? [...prof.dislikes] : [],
  }

  const plan = planPenalty(fb)

  // 先对所有旧条目做衰减（跟 learn 一致，这样"讨厌"也会淡忘）
  for (const k of Object.keys(p.tags)) {
    const e = p.tags[k]
    if (!e || typeof e !== 'object') { delete p.tags[k]; continue }
    p.tags[k] = { ...e, w: (Number(e.w) || 0) * decayFactorSafe(e.last, now) }
  }
  for (const k of Object.keys(p.artists)) {
    const e = p.artists[k]
    if (!e || typeof e !== 'object') { delete p.artists[k]; continue }
    p.artists[k] = { ...e, w: (Number(e.w) || 0) * decayFactorSafe(e.last, now) }
  }

  // 扣标签
  const touchedTags = []
  for (const t of plan.tags) {
    const e = p.tags[t] || { w: 0, n: 0, last: nowIso }
    const cur = Number(e.w) || 0
    const w = clamp(pushNegative(cur, step), TAG_NEG_FLOOR, 100)
    p.tags[t] = { ...e, w, n: (Number(e.n) || 0) + 1, last: nowIso }
    touchedTags.push({ tag: t, w: Number(w.toFixed(2)) })
  }

  // 扣画师
  let touchedArtist = null
  if (plan.artist) {
    const e = p.artists[plan.artist] || { w: 0, n: 0, last: nowIso, name: '' }
    const cur = Number(e.w) || 0
    const w = clamp(pushNegative(cur, step), ARTIST_NEG_FLOOR, 100)
    p.artists[plan.artist] = {
      ...e,
      w,
      n: (Number(e.n) || 0) + 1,
      last: nowIso,
      name: fb.userName ? String(fb.userName).slice(0, 60) : (e.name || ''),
    }
    touchedArtist = { userId: plan.artist, w: Number(w.toFixed(2)), name: p.artists[plan.artist].name, from: Number(cur.toFixed(2)) }
  }

  // 「不想再看」的那一张（unlike 用）—— 让判重能避开它
  if (String(fb.kind) === 'unlike' && fb.id) {
    p.dislikes.push({
      id: String(fb.id),
      title: String(fb.title || '').slice(0, 80),
      ts: nowIso,
    })
    if (p.dislikes.length > 300) p.dislikes = p.dislikes.slice(-300)
  }

  // 流水（跟 learn 的 recent 分开记：正向和负向混在一起不好查）
  p.recent.push({
    ts: nowIso,
    id: String(fb.id || ''),
    title: String(fb.title || '').slice(0, 80),
    artist: String(fb.userName || '').slice(0, 60),
    gain: -step,
    kind: String(fb.kind || ''),
    tags: plan.tags.slice(0, 12),
    why: plan.reason,
  })
  if (p.recent.length > 50) p.recent = p.recent.slice(-50)

  // 负向反馈**不计入 learned**（那个字段是"学了多少件喜欢的"）
  p.disliked = (Number(prof.disliked) || 0) + 1

  return {
    profile: p,
    applied: {
      kind: String(fb.kind || ''),
      reason: plan.reason,
      tags: touchedTags,
      artist: touchedArtist,
      suppressedId: String(fb.kind) === 'unlike' && fb.id ? String(fb.id) : '',
      step,
    },
  }
}

/**
 * 把负权重压成「扣分表」交给 score()。
 *
 * 🔴 关键设计：**负分要收敛，不然会压死一切**。
 *   一个 -10 的标签如果直接减 10 分，能抵消十次"喜欢"攒下的正分 ——
 *   而用户可能只是随手说过一次"这个标签不太行"。
 *   所以这里做两件事：
 *     ① 只取**负得最多**的几个（默认 8 个）参与扣分，长尾不参与；
 *     ② 每条按下限收敛到 `floor`（默认 -12），别让单条主导排序。
 *
 * @param {object} prof
 * @param {object} [o]
 * @param {number} [o.max]    最多几个负标签参与
 * @param {number} [o.floor]  单条扣分下限（越负扣得越狠）
 * @returns {{tagPenalty:object, artistPenalty:object}}
 */
export function toPenalties(prof, o = {}) {
  const max = Number(o.max) > 0 ? Number(o.max) : 8
  const floor = Number.isFinite(Number(o.floor)) ? Number(o.floor) : -12

  const tagPenalty = {}
  const artistPenalty = {}

  const negTags = Object.entries(prof.tags || {})
    .map(([k, e]) => [k, Number(e && e.w) || 0])
    .filter(([, w]) => w < 0)
    .sort((a, b) => a[1] - b[1])   // 最负的在前
    .slice(0, max)
  for (const [k, w] of negTags) {
    tagPenalty[k] = Number(Math.max(floor, w * 0.6).toFixed(3))
  }

  const negArtists = Object.entries(prof.artists || {})
    .map(([k, e]) => [k, Number(e && e.w) || 0])
    .filter(([, w]) => w < 0)
    .sort((a, b) => a[1] - b[1])
    .slice(0, max)
  for (const [k, w] of negArtists) {
    // 画师负分给得更狠一点（用户说"不要这个画师"是明确指示）
    artistPenalty[k] = Number(Math.max(floor * 1.5, w * 0.8).toFixed(3))
  }

  return { tagPenalty, artistPenalty }
}

/** 「不想再看」的 id 集合（判重时排除掉） */
export function dislikedIds(prof) {
  const out = new Set()
  for (const d of prof.dislikes || []) {
    // ⚠️ 必须挡住 null/undefined：直接 String(null) 会得到字符串 "null"，
    //    于是集合里多一个永远匹配不到的垃圾项（实测踩过）。
    //    也挡住非对象——用户手改坏了画像时不该造出脏 id。
    if (!d || typeof d !== 'object') continue
    const id = d.id
    if (id === null || id === undefined) continue
    const s = String(id).trim()
    if (s && s !== 'null' && s !== 'undefined') out.add(s)
  }
  return out
}

/** 撤销：把某个标签/画师的负权重抹平（用户说"我改主意了"） */
export function undoPenalty(prof, { kind = 'tag', key = '' } = {}) {
  const p = {
    ...prof,
    tags: { ...prof.tags },
    artists: { ...prof.artists },
    dislikes: [...(prof.dislikes || [])],
  }
  const k = String(key || '').trim()
  let undone = false

  if (kind === 'tag' && p.tags[k]) {
    if (Number(p.tags[k].w) < 0) {
      delete p.tags[k]      // 负权重直接删（抹平没有意义，不如让它从零开始）
      undone = true
    }
  } else if (kind === 'artist' && p.artists[k]) {
    if (Number(p.artists[k].w) < 0) {
      delete p.artists[k]
      undone = true
    }
  } else if (kind === 'id') {
    const before = p.dislikes.length
    p.dislikes = p.dislikes.filter((d) => String(d && d.id) !== k)
    undone = p.dislikes.length !== before
  }

  return { profile: p, undone }
}

/** 跟 profile.mjs 的 decayFactor 同语义，这里单独放一份避免循环依赖 */
function decayFactorSafe(lastIso, now) {
  const t = Date.parse(lastIso || '')
  if (!Number.isFinite(t)) return 1
  const days = Math.max(0, (now - t) / 86_400_000)
  return Math.pow(0.5, days / 60)   // 半衰期 60 天，跟 profile.mjs 保持一致
}

/**
 * 给用户看的一句话：这次反馈到底起了什么作用。
 * 规格第六节要求「每条推荐要能说清匹配与差异」——这是同一件事的另一半。
 */
export function describePenalty(applied = {}) {
  const bits = [applied.reason || '']
  if (applied.tags && applied.tags.length) {
    bits.push(`已降权：${applied.tags.map((t) => `${t.tag}(${t.w})`).join('、')}`)
  }
  if (applied.artist) {
    bits.push(`画师已降权：${applied.artist.name || applied.artist.userId}(${applied.artist.w})`)
  }
  if (applied.suppressedId) {
    bits.push(`已记下不再推这张（#${applied.suppressedId}）`)
  }
  return bits.filter(Boolean).join('；')
}
