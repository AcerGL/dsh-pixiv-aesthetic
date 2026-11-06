/**
 * 智能漫游 —— 探索与利用的平衡。
 * ============================================================================
 * 规格第五节要的四种模式：
 *   for_you     按长期画像推荐
 *   surprise    有控制地探索新主题/新画师（避免永远同一个风格）
 *   deep_dive   从指定作品/画师出发慢慢往外走
 *   mood        把自然语言情绪转成可执行的搜索计划
 *
 * 🔴 规格里有一条自我约束很关键，必须照做：
 *   「**不得将未知评分伪装成真实模型概率**」
 *   所以这里的 60/25/15 是**配额**（给每类候选留几个位置），
 *   不是"置信度 0.6"那种装模作样的概率。代码里直接叫 quota，
 *   返回值也说清哪个桶里挑的 —— 让上层能如实告诉用户。
 *
 * ⚠️ 另一条实测约束（2026-11-06 验证）：
 *   pixiv **没有可用的「相关作品」接口**（/ajax/illust/<id>/recommend 与
 *   /recommend/init 都是 404）。所以 deep_dive **不能**假装有相似度计算 ——
 *   只能靠：同标签 + 同画师 + （有视觉模型时）读图重排。
 *   规格自己写的「不得伪造相似度」正好卡在这，别绕过去。
 * ============================================================================
 */

/** 探索/利用的默认配额（比例，加起来是 1） */
export const DEFAULT_QUOTA = {
  familiar: 0.60,   // 符合当前偏好
  explore: 0.25,    // 新画师 / 新主题
  diversify: 0.15,  // 多样性调整（同批里避免同一画师/题材刷屏）
}

/** 四种漫游模式 */
export const EXPLORE_MODES = ['for_you', 'surprise', 'deep_dive', 'mood']

/**
 * 按配额把候选分成三桶。
 *
 * ⚠️ 「新」的定义要可解释，不能瞎标：
 *   · 新画师 = 画像里**没有**这个 userId（或负权重）
 *   · 新主题 = 这件作品的标签里，**没有一个**在画像的高权重标签里
 *   · familiar = 其余（画像里见过的画师 或 命中过高权重标签）
 *
 * @param {Array} items   候选（要带 id/tags/userId，以及打分后的 score）
 * @param {object} ctx    { prof, familiarArtists:Set, familiarTags:Set }
 * @returns {{familiar:Array, explore:Array, diversify:Array}}
 */
export function bucketize(items, ctx = {}) {
  const artists = ctx.familiarArtists instanceof Set ? ctx.familiarArtists : new Set()
  const tags = ctx.familiarTags instanceof Set ? ctx.familiarTags : new Set()

  const familiar = []
  const explore = []
  for (const it of items) {
    const uid = String(it.userId || '')
    const itsTags = (it.tags || []).map(String)
    const knownArtist = uid && artists.has(uid)
    const knownTag = itsTags.some((t) => tags.has(t))
    if (knownArtist || knownTag) familiar.push(it)
    else explore.push(it)
  }
  return { familiar, explore, diversify: [] }   // diversify 是**同一批里的去重**，不是独立来源
}

/**
 * 多样性调整：同一批结果里尽量避免重复画师 / 重复题材。
 *
 * 做法（贪心 + 惩罚，不做假的"多样性分数"）：
 *   按顺序挑，每挑走一个，就把"和它同画师/同标签"的其他候选往后压一点。
 *   这样既尊重原本的分数序，又能防止前 5 条全是同一个画师。
 *
 * @param {Array} items           已按分数排好的候选
 * @param {object} [o]
 * @param {number} [o.limit]      要几条
 * @param {number} [o.artistPenalty] 同画师的压制力度
 * @param {number} [o.tagPenalty]    同标签的压制力度
 * @returns {Array} 挑好的
 */
export function diversify(items, o = {}) {
  const limit = Number(o.limit) > 0 ? Number(o.limit) : 10
  const aPen = Number.isFinite(Number(o.artistPenalty)) ? Number(o.artistPenalty) : 6
  const tPen = Number.isFinite(Number(o.tagPenalty)) ? Number(o.tagPenalty) : 1.5

  // 复制一份，带上可变的临时分（不动原对象的 score）
  const pool = items.map((it) => ({ it, adj: Number(it.score) || 0 }))
  const takenArtists = new Map()
  const takenTags = new Map()
  const out = []

  while (out.length < limit && pool.length) {
    // 每轮选当前 adj 最高的
    let best = 0
    for (let i = 1; i < pool.length; i++) if (pool[i].adj > pool[best].adj) best = i
    const picked = pool.splice(best, 1)[0]
    out.push(picked.it)

    // 压制跟它同画师/同标签的
    const uid = String(picked.it.userId || '')
    if (uid) takenArtists.set(uid, (takenArtists.get(uid) || 0) + 1)
    for (const t of (picked.it.tags || []).map(String)) {
      takenTags.set(t, (takenTags.get(t) || 0) + 1)
    }
    for (const ent of pool) {
      const u = String(ent.it.userId || '')
      if (u && takenArtists.has(u)) ent.adj -= aPen * takenArtists.get(u)
      let hit = 0
      for (const t of (ent.it.tags || []).map(String)) if (takenTags.has(t)) hit++
      if (hit) ent.adj -= tPen * hit
    }
  }
  return out
}

/**
 * 按配额组一批结果。
 *
 * ⚠️ 这里**如实处理不足**：某个桶不够时，不假装"按比例"硬凑，
 *    而是记进 `shortfall`，让上层能说实话（"新画师只有 3 个，这次就这些"）。
 *
 * @param {object} buckets  bucketize 的结果
 * @param {object} [o]
 * @param {number} [o.limit]
 * @param {object} [o.quota]
 * @returns {{items:Array, quota:object, actual:object, shortfall:object}}
 */
export function assemble(buckets, o = {}) {
  const limit = Number(o.limit) > 0 ? Number(o.limit) : 10
  const q = { ...DEFAULT_QUOTA, ...(o.quota || {}) }
  const sum = q.familiar + q.explore + q.diversify
  // 归一化（用户可能配了不加起来等于 1 的数）
  const norm = sum > 0 ? { familiar: q.familiar / sum, explore: q.explore / sum, diversify: q.diversify / sum } : DEFAULT_QUOTA

  const wantF = Math.round(limit * norm.familiar)
  const wantE = Math.round(limit * norm.explore)
  const wantD = Math.max(0, limit - wantF - wantE)

  const fam = buckets.familiar || []
  const exp = buckets.explore || []

  // familiar / explore 各自内部先去重画师
  const famPicked = diversify(fam, { limit: wantF })
  const expPicked = diversify(exp, { limit: wantE })

  /**
   * 🔴 diversify 那 15% 是**从"没被上面两个桶选中的剩余候选"里补**的。
   *
   * 之前这里漏了这一步（实测踩到）：配额算出 1 个位置，但这 1 个位置
   * 没有任何来源去填 —— 于是 limit=10 只返回 9 条。
   *
   * 为什么"补剩余"而不是"另一个独立来源"：
   *   多样性本来就是**相对已选集合**而言的（同画师/同题材不要刷屏），
   *   所以它天然是"把剩下的拿来做差异挑选"，而不是另一批作品。
   *   规格把 15% 单列，是想保证**这部分位置留给差异**，不是另一条数据源。
   */
  const pickedIds = new Set([...famPicked, ...expPicked].map((x) => String(x.id)))
  const leftover = [...fam, ...exp].filter((x) => !pickedIds.has(String(x.id)))

  // 先合并已选的（再做一次全量去重，两桶之间也可能撞画师）
  const base = diversify([...famPicked, ...expPicked], { limit })

  // 还差多少，就从剩余里补（diversify 会优先挑跟已选不同的）
  const need = limit - base.length
  const filler = need > 0
    ? diversify([...base, ...leftover], { limit })
    : base

  const actual = {
    familiar: filler.filter((x) => famPicked.includes(x)).length,
    explore: filler.filter((x) => expPicked.includes(x)).length,
  }

  const shortfall = {}
  if (famPicked.length < wantF) shortfall.familiar = { want: wantF, got: famPicked.length }
  if (expPicked.length < wantE) shortfall.explore = { want: wantE, got: expPicked.length }
  // 剩余也不够时，如实说总数不够（别假装凑齐了）
  if (filler.length < limit) {
    shortfall.total = { want: limit, got: filler.length, why: '候选池本身不够这么多' }
  }

  return {
    items: filler,
    quota: { familiar: wantF, explore: wantE, diversify: wantD, ratios: norm },
    actual: { ...actual, total: filler.length },
    shortfall: Object.keys(shortfall).length ? shortfall : null,
  }
}

/**
 * 给一个候选写推荐理由。
 *
 * 规格第六节要求每条说清：来源 / 匹配了什么偏好 / 与要求有何差异 / 是否真读过图。
 * ⚠️ **没读图就必须说没读** —— 不能从标题标签断言光线色彩构图。
 *
 * @param {object} it     候选（带 score/why，可能带 vision）
 * @param {object} [o]
 * @returns {object}
 */
export function explain(it, o = {}) {
  const why = Array.isArray(it.why) ? it.why : []
  const matched = []
  const cautions = []

  for (const w of why) {
    if (w.includes('口味+') || w.includes('熟画师')) matched.push(w)
    else if (w.includes('口味−') || w.includes('避开画师')) cautions.push(w)
    else if (w === '新鲜') matched.push('是最近发布的')
    else if (w === '高清') matched.push('分辨率高')
    else if (w.includes('第') && w.includes('位')) matched.push(`在 Pixiv 榜上排${w}`)
  }

  const vision = it.vision || null
  return {
    id: String(it.id || ''),
    title: String(it.title || ''),
    artist: String(it.userName || ''),
    url: String(it.url || ''),
    from: String(it.source || ''),
    score: Math.round(Number(it.score) || 0),
    matched,
    cautions,
    // 🔴 诚实标注：有没有真读过图
    visualChecked: !!vision,
    visualNote: vision
      ? `读过图（置信度 ${vision.confidence || '未标'}）`
      : '**没有读图** —— 上面这些只从元数据（标签/尺寸/收藏）推的，不是从画面看出来的',
    // 差异：这件作品和用户要求可能不一致的地方
    diff: cautions.length ? `与你的要求有出入：${cautions.join('、')}` : '',
    suggest: Array.isArray(o.suggest) ? o.suggest : [],
  }
}

/**
 * 把「自然语言情绪」转成**可执行的搜索计划**。
 *
 * ⚠️ 这里**不做语义理解**（没有模型参与），只做**可靠的关键词解析**：
 *    从用户话里认出已知的风格词/氛围词，映射到 pixiv 上真能搜的标签。
 *    认不出来的部分老实说"没听懂"，交给 agent 去处理 —— 不猜、不编。
 *
 * @param {string} text  用户原话
 * @param {object} [o]
 * @param {object} [o.lexicon] 自定义词表 { 情绪词: [标签...] }
 * @returns {{keywords:string[], derived:string[], unmatched:string[], plan:string}}
 */
export function planMood(text, o = {}) {
  const lex = { ...MOOD_LEXICON, ...(o.lexicon || {}) }
  const s = String(text || '')
  const keywords = []
  const derived = []
  const unmatched = []

  for (const [word, tags] of Object.entries(lex)) {
    if (!s.includes(word)) continue
    derived.push({ word, tags: tags.slice(0, 4) })
    for (const t of tags) if (!keywords.includes(t)) keywords.push(t)
  }

  // 用户话里**明确带引号/书名号的词**直接当搜索词（最可靠的一类）
  for (const m of s.matchAll(/[「『"“]([^」』"”]{2,20})[」』"”]/g)) {
    const w = m[1].trim()
    if (w && !keywords.includes(w)) { keywords.push(w); derived.push({ word: w, tags: [w], quoted: true }) }
  }

  const plan = keywords.length
    ? `按 ${keywords.slice(0, 6).join('、')} 去搜，按画像和这轮的反馈重排`
    : '这轮话里没有我能可靠映射成 Pixiv 标签的词'

  return {
    keywords: keywords.slice(0, 8),
    derived,
    // 老实说哪些没听懂 —— 别假装全懂
    unmatched,
    plan,
    note: keywords.length
      ? '这些是从你说的话里映射出来的 pixiv 标签。'
      : '没解析出可搜的标签。可以换更具体的说法（比如直接说作品/画风名），或者让 agent 用别的办法。',
  }
}

/**
 * 情绪/氛围词 → pixiv 上真能搜到的标签。
 *
 * ⚠️ 只收**我确认过在 pixiv 上常用的**词。宁可少，不要编 ——
 *    编一个搜不到的标签，用户会以为"这插件搜不出东西"。
 *    想扩就改这里，或传 o.lexicon。
 */
export const MOOD_LEXICON = {
  // 氛围 / 空气感
  '空气感': ['空気感', '透明感'],
  '透明感': ['透明感', '水彩'],
  '安静': ['静か', '落ち着いた'],
  '治愈': ['癒し', 'ほのぼの'],
  '温暖': ['暖色', 'あたたかい'],
  '清冷': ['寒色', 'クール'],
  // 光线
  '夜景': ['夜景', '夜'],
  '黄昏': ['夕暮れ', 'マジックアワー'],
  '清晨': ['朝', '朝焼け'],
  '逆光': ['逆光'],
  '柔和的光': ['柔らかい光'],
  // 色彩
  '低饱和': ['低彩度', '淡い色'],
  '高饱和我不要': ['低彩度'],
  '色彩丰富': ['カラフル', '鮮やか'],
  '黑白': ['モノクロ', '白黒'],
  // 构图
  '远景': ['風景', '広い'],
  '大构图': ['構図'],
  '人物特写': ['顔アップ', 'ポートレート'],
  // 场景
  '夏日': ['夏', '夏服'],
  '冬日': ['冬', '雪'],
  '雨中': ['雨', '雨の日'],
  '海边': ['海', '海岸'],
  '森林': ['森', '森林'],
  // 风格
  '水彩': ['水彩'],
  '厚涂': ['厚塗り'],
  '像素': ['ドット絵', 'ピクセルアート'],
  '赛博朋克': ['サイバーパンク'],
  '和风': ['和風'],
  '未来感': ['SF', '近未来'],
}
