/**
 * 账号喜好 —— 从他**登录的 pixiv 账号**读出来的口味，单独存一份。
 * ============================================================================
 * 老大 2026-11-10 定的口径（照着做，别改）：
 *
 *   ① 登录一次就记一次：登录着说明那会儿有网能读 pixiv（注意：**登录 ≠ 能读**，
 *      本机实测过凭证在但 token 换不到的情况 ⇒ 只在真拿到 token 时才抓）。
 *      只记**第一次、第一个**账号；换账号不覆盖（除非重置）。
 *   ② 用途：没代理时也优先按他的喜好找图，而不是只在每日榜里无脑搜。
 *   ③ 权重**以本机跑出来的为主**。账号喜好只在两种情况下占大：
 *        · 本机还没热身（learned < COLD_START_MIN），或
 *        · 刚重置过、本机还没重新攒够。
 *      其余情况只算**微小影响**。
 *   ④ 没重置就换账号 ⇒ 不立刻接管，而是**从那一轮开始慢慢把权重移到最后登录的账号**上。
 *      重置 = 立刻交接（所以"换账号别把上一个带进来"靠重置）。
 *   ⑤ 两种重置：只重置账号那份（本机画像不动）／完全重置（本机 + 账号都清，
 *      但**保留**"不想看/删过了"清单 —— 那是明确指示，不属于画像）。
 *
 * 🔴 三条纪律：
 *   · 只走**官方 API**（要 token）—— 永不经第三方（HibiAPI 用的是它自己的 token，
 *     读不到他的账号）。全程只读，不点赞/关注/收藏。
 *   · 账号画像**只加正向**（`learn()` 本身就把权值钳在 [0, CAP]，不会学出负口味）。
 *     本机的负向（不喜欢/删过了）优先级永远更高。
 *   · 账号再大也不能绕过红线：分级过滤、判重、`rejectedIds` 一律照走。
 * ============================================================================
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { learn, COLD_START_MIN, isWarm } from './profile.mjs'

export const ACCOUNT_FILE = 'account-taste.json'

/** 账号喜好占大的系数（本机没热身 / 刚重置时用这个） */
export const SHARE_PROMOTE = 1
/** 账号喜好只当零头时的系数（本机画像成熟、也没重置过） */
export const SHARE_SMALL = 0.2
/** 没重置就换账号时，每轮往前挪多少（0.1 ⇒ 约十轮移完） */
export const DRIFT_STEP = 0.1
/** 抓一次采样几页（每页 30 件） */
export const SAMPLE_PAGES = 3
/** 同一个账号隔多久才值得再抓一次（收藏会变，但没必要每轮都打接口） */
export const REFRESH_MS = 7 * 24 * 60 * 60_000

export function accountPath(home) {
  return join(home, ACCOUNT_FILE)
}

/** 空骨架 —— 读不到文件时也返回它，调用方不用到处判空 */
export function emptyAccount() {
  return {
    version: 1,
    owner: null,      // 最初记录的账号（{ userId, userName, at, sampled, source, tags, artists }）
    latest: null,     // 后登录的**另一个**账号（迁移目标），没换过就是 null
    migration: 0,     // 0..1：owner → latest 的迁移进度
    resetBaseline: 0, // 上次重置时本机 learned 是多少（判断"重置后本机又攒了几件"）
    resetAt: '',
  }
}

/** 读账号画像。⚠️ 坏文件当没有，绝不抛（画像坏了不该让整轮挂掉） */
export async function readAccount(home) {
  try {
    const raw = await fs.readFile(accountPath(home), 'utf8')
    const j = JSON.parse(raw)
    if (!j || typeof j !== 'object') return emptyAccount()
    return { ...emptyAccount(), ...j }
  } catch {
    return emptyAccount()
  }
}

export async function writeAccount(home, acc) {
  await fs.mkdir(home, { recursive: true })
  await fs.writeFile(accountPath(home), JSON.stringify(acc, null, 2), 'utf8')
}

/**
 * 用采样到的一批作品建一个"槽位"（owner / latest 共用这个形状）。
 * 复用 `learn()`：权重算法、衰减、钳制、画师 1.5 倍都跟本机画像**完全同源**，
 * 免得两套口径算出来的权重没法比。
 */
export function slotFromWorks(works, o = {}) {
  let prof = { version: 1, learned: 0, disliked: 0, dislikes: [], recent: [], tags: {}, artists: {} }
  const list = Array.isArray(works) ? works : []
  for (const w of list) {
    try { prof = learn(prof, w, o) } catch { /* 单件坏了跳过，别整批挂 */ }
  }
  return {
    userId: String(o.userId || ''),
    userName: String(o.userName || ''),
    at: new Date(o.now || Date.now()).toISOString(),
    sampled: prof.learned,
    source: String(o.source || ''),
    tags: prof.tags,
    artists: prof.artists,
  }
}

/**
 * 账号画像占多大 —— 老大那条规则的**唯一实现**，别在别处另写一套。
 *
 *   promote = 本机没热身 或 距上次重置以来本机新学的还不够
 *   ⚠️ "本机没热身"用的是现有 `isWarm()`（learned < COLD_START_MIN）——
 *      跟正向打分用的是同一把尺子，不另立标准。
 */
export function accountShare(acc, localProf, o = {}) {
  const cold = Number(o.coldStart) > 0 ? Number(o.coldStart) : COLD_START_MIN
  const learned = Number(localProf && localProf.learned) || 0
  const warm = isWarm(localProf || {}, cold)
  const baseline = Number(acc && acc.resetBaseline) || 0
  const sinceReset = Math.max(0, learned - baseline)
  const freshAfterReset = !!acc && !!acc.resetAt && sinceReset < cold
  const promoted = !warm || freshAfterReset
  const hasAccount = !!(acc && acc.owner && Number(acc.owner.sampled) > 0)
  return {
    share: hasAccount ? (promoted ? SHARE_PROMOTE : SHARE_SMALL) : 0,
    promoted,
    hasAccount,
    localLearned: learned,
    localWarm: warm,
    sinceReset,
    why: !hasAccount ? '还没有账号喜好'
      : promoted
        ? (warm ? `刚重置过（本机只新学 ${sinceReset} 件）⇒ 账号喜好占大`
          : `本机还没热身（学过 ${learned} 件）⇒ 账号喜好占大`)
        : `本机画像为主（学过 ${learned} 件）⇒ 账号喜好只当零头`,
  }
}

/**
 * 把账号画像按 `share` 合进本机画像，产出**一个合并画像**。
 *
 * 🔴 为什么合成一个对象再交给下游：`toWeights` / `pickKeywords` / `pickArtists`
 *    / `isWarm` 全都吃这个形状。合成一处、下游一行不动 —— 改动面最小，
 *    也不会出现"打分用了合并权重、反搜却用了本机权重"这种半生效的鬼状态。
 *
 * 迁移（owner → latest）在这里按 `migration` 线性插值。
 */
export function mergeTasteProfiles(localProf, acc, o = {}) {
  const local = localProf || { tags: {}, artists: {}, learned: 0 }
  const scale = Number(o.scale) > 0 ? Number(o.scale) : 1
  const info = o.shareInfo || accountShare(acc, local, o)
  const share = Number(info.share) || 0

  const tags = {}
  const artists = {}
  const add = (bag, key, w) => {
    if (!key || !(w > 0)) return
    bag[key] = (bag[key] || 0) + w
  }

  // 本机那份：权重照旧（乘用户设的 scale）
  for (const [k, e] of Object.entries(local.tags || {})) add(tags, k, (Number(e && e.w) || 0) * scale)
  for (const [k, e] of Object.entries(local.artists || {})) add(artists, k, (Number(e && e.w) || 0) * scale)

  // 账号那份：owner 与 latest 按 migration 插值，再乘 share
  let accLearned = 0
  if (share > 0 && acc && acc.owner) {
    const m = Math.min(1, Math.max(0, Number(acc.migration) || 0))
    const mix = (a, b, key, bag) => {
      const wa = Number((a && a[key] && a[key].w) || 0)
      const wb = b && b[key] ? Number(b[key].w || 0) : wa
      const w = wa * (1 - m) + wb * m
      add(bag, key, w * share * scale)
    }
    for (const k of new Set([
      ...Object.keys(acc.owner.tags || {}),
      ...Object.keys((acc.latest && acc.latest.tags) || {}),
    ])) mix(acc.owner.tags, acc.latest && acc.latest.tags, k, tags)
    for (const k of new Set([
      ...Object.keys(acc.owner.artists || {}),
      ...Object.keys((acc.latest && acc.latest.artists) || {}),
    ])) mix(acc.owner.artists, acc.latest && acc.latest.artists, k, artists)

    const sm = Number(acc.owner.sampled) || 0
    const sl = Number((acc.latest && acc.latest.sampled) || 0) || sm
    accLearned = (sm * (1 - m) + sl * m) * share
  }

  const nowIso = new Date().toISOString()
  const wrap = (bag, extra = {}) => Object.fromEntries(
    Object.entries(bag).map(([k, w]) => [k, { w: Number(w.toFixed(3)), n: 1, last: nowIso, ...extra }]),
  )
  return {
    _merged: true,
    version: 1,
    // ⚠️ learned 是"有效证据量"：本机学的 + 账号按占比折算过来的。
    //    它决定 isWarm（要不要拿这份权重去排序），所以要算进来。
    learned: (Number(local.learned) || 0) + Math.round(accLearned),
    disliked: Number(local.disliked) || 0,
    dislikes: local.dislikes || [],
    recent: local.recent || [],
    tags: wrap(tags),
    artists: wrap(artists, {}),
    _accountShare: share,
    _accountPromoted: !!info.promoted,
  }
}

/**
 * 换账号时的"慢慢迁移"：把新账号采到的槽位接到 `latest`，进度往前走一步。
 * 走满（>= 1）就正式交接：owner ← latest，进度归零。
 *
 * @returns {{acc:object, action:'handover'|'drift'|'none', migration:number}}
 */
export function advanceMigration(acc, slot, o = {}) {
  const step = Number(o.step) > 0 ? Number(o.step) : DRIFT_STEP
  const a = { ...emptyAccount(), ...acc }
  const ownerId = String((a.owner && a.owner.userId) || '')
  const slotId = String((slot && slot.userId) || '')
  // 没有 owner（第一次记录由调用方走 snapshotOwner）或者就是同一个账号 ⇒ 不动
  if (!a.owner || !slotId || slotId === ownerId) return { acc: a, action: 'none', migration: a.migration || 0 }

  const m = Math.min(1, Math.max(0, Number(a.migration) || 0) + step)
  if (m >= 1) {
    return {
      acc: { ...a, owner: slot, latest: null, migration: 0 },
      action: 'handover',
      migration: 0,
    }
  }
  return { acc: { ...a, latest: slot, migration: Number(m.toFixed(3)) }, action: 'drift', migration: m }
}

/** 第一次记录（还没有 owner 时） */
export function setOwner(acc, slot) {
  const a = { ...emptyAccount(), ...acc }
  return { ...a, owner: slot, latest: null, migration: 0 }
}

/**
 * 「只重置账号那份」：清掉账号数据，但**留下基线** —— 基线是"重置那一刻本机学到哪了"，
 * 靠它才能判断"重置之后本机又攒了几件"，从而让新账号立刻占大（老大那条 ③）。
 * ⚠️ 所以这里**不能把文件删掉**（删了基线也没了，新账号就只能当零头）。
 */
export function resetAccountOnly(acc, localLearned, o = {}) {
  const a = { ...emptyAccount(), ...acc }
  return {
    ...a,
    owner: null,
    latest: null,
    migration: 0,
    resetBaseline: Number(localLearned) || 0,
    resetAt: new Date(o.now || Date.now()).toISOString(),
  }
}

/** 给使用者看的一行 */
export function describeAccount(acc, info) {
  if (!acc || !acc.owner) return info && info.localLearned ? '账号喜好：还没记录过' : '账号喜好：还没记录过'
  const own = acc.owner
  const bits = [`账号喜好：${own.userName || own.userId || '?'}`]
  bits.push(`抓于 ${String(own.at || '').slice(0, 10)}`)
  bits.push(`${own.sampled || 0} 件${own.source ? `（${own.source}）` : ''}`)
  bits.push(info && info.promoted ? '占大' : '只当零头')
  if (acc.latest && acc.migration > 0) {
    bits.push(`正慢慢移向 ${acc.latest.userName || acc.latest.userId || '?'}（已移 ${Math.round(acc.migration * 100)}%）`)
  }
  return bits.join(' · ')
}
