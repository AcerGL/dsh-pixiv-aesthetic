/**
 * 我的收藏 —— 拿一份 id 集合，用来**避免推荐用户已经收藏过的图**。
 * ============================================================================
 * 为什么需要它（老大 2026-11-06 明确要求）：
 *   登录之后，推荐里再出现"他已经收藏过的画"就是纯噪音 —— 那不是在发现，
 *   是在复习。所以把收藏的 id 拉下来，在过滤阶段剔除。
 *
 * ⚠️ 端点是用**假 token 探活**找出来的（2026-11-06 实测），别乱改：
 *   只有 `/v1/user/bookmarks/illust` 是活的（返回 400 OAuth 错），
 *   `/v2/...` 和 `/v2/illust/bookmark/list` 全是 **404 端点不存在**。
 *   判据：400 = 端点活着（token 假而已），404 = 端点不存在。
 *
 * ⚠️ 实测确认：即便 token 的 scope 是**空字符串**，这个接口照样返回 200
 *    和真实收藏数据（30 条）。所以不需要额外申请权限。
 *
 * 设计取舍：
 *   · 收藏会变（用户随时在收藏），所以带**缓存 + TTL**，不是每次搜都拉。
 *   · 拉失败**不能影响搜索** —— 收藏只是个"额外剔除"，拿不到就退化成不剔。
 *   · 只存 id 集合，不存作品内容（那是用户的隐私，没必要落盘）。
 * ============================================================================
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { httpGet } from './transport.mjs'
import { APP_API_BASE } from './auth.mjs'

/** 缓存多久（收藏变化不频繁，10 分钟够用；也避免每轮都打接口） */
export const BOOKMARK_TTL_MS = 10 * 60_000

/** 单次最多拉几页（一页 30 条，默认够覆盖常见收藏量而不至于太重） */
export const DEFAULT_MAX_PAGES = 10

export function cachePath(home) {
  return join(home, 'bookmarks.json')
}

/**
 * 读缓存（不判过期 —— 过期判断交给调用方，因为要区分"过期"与"没有"）。
 */
export async function readCache(home) {
  try {
    const j = JSON.parse(await fs.readFile(cachePath(home), 'utf8'))
    if (!j || typeof j !== 'object') return null
    return {
      ids: Array.isArray(j.ids) ? j.ids.map(String) : [],
      userId: String(j.userId || ''),
      total: Number(j.total) || 0,
      fetchedAt: Number(j.fetchedAt) || 0,
      complete: j.complete === true,   // 是否拉全了（没拉全时不能说"这就是全部收藏"）
    }
  } catch {
    return null
  }
}

async function writeCache(home, data) {
  await fs.mkdir(home, { recursive: true })
  const p = cachePath(home)
  const tmp = p + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await fs.rename(tmp, p)
  return data
}

export async function clearCache(home) {
  try { await fs.unlink(cachePath(home)) } catch { /* 没有就算了 */ }
}

/**
 * 拉某个用户的公开收藏 id。
 *
 * @param {object} o
 * @param {string} o.userId
 * @param {string} o.token        access_token
 * @param {string} [o.proxyUrl]
 * @param {number} [o.timeoutMs]
 * @param {number} [o.maxPages]   最多拉几页（每页 30）
 * @param {(m:string)=>void} [o.log]
 * @returns {Promise<{ids:string[], total:number, complete:boolean, pages:number}>}
 */
export async function fetchBookmarkIds(o = {}) {
  const uid = String(o.userId || '').trim()
  if (!/^\d+$/.test(uid)) throw new Error(`读收藏需要数字 userId，收到：${userIdOf(o)}`)
  const token = String(o.token || '')
  if (!token) throw new Error('读收藏需要 access_token')
  const maxPages = Math.min(50, Math.max(1, Number(o.maxPages) || DEFAULT_MAX_PAGES))
  const log = o.log || (() => {})

  const ids = []
  let offset = 0
  let maxBookmarkId = ''
  let pages = 0
  let complete = false

  while (pages < maxPages) {
    /**
     * ⚠️ 翻页靠的是 **max_bookmark_id**，不是 offset（2026-11-06 实测踩到）。
     *
     * 症状：只改 offset 时，三次请求（offset=0/30/60）返回**完全相同的 30 条**，
     *      `next_url` 里的 max_bookmark_id 也一模一样 —— 于是 10 页拉到同一批，
     *      日志写"拉到 300 条"但去重后还是 30 条。
     * 根因：这个接口是按收藏**时间倒序 + 游标**翻页的，offset 不参与定位。
     *      真正的游标是 `next_url` 里的 max_bookmark_id。
     * ⇒ 所以：第一次用 offset=0，之后一律跟着 next_url 的 max_bookmark_id 走。
     */
    const qs = new URLSearchParams({ user_id: uid, restrict: 'public', offset: String(offset) })
    if (maxBookmarkId) qs.set('max_bookmark_id', maxBookmarkId)
    const url = `${APP_API_BASE}/v1/user/bookmarks/illust?${qs.toString()}`
    const res = await httpGet(url, {
      proxyUrl: o.proxyUrl,
      timeoutMs: Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : 20_000,
      headers: {
        Authorization: `Bearer ${token}`,
        'App-OS': 'android', 'App-OS-Version': '9.0', 'App-Version': '7.6.2',
        'User-Agent': 'PixivAndroidApp/5.0.234 (Android 9.0; Pixel 3)',
        Accept: 'application/json',
      },
    })
    if (res.status !== 200) {
      const body = res.body.toString('utf8').slice(0, 120)
      throw new Error(`读收藏失败 HTTP ${res.status}：${body}`)
    }
    let j
    try { j = JSON.parse(res.body.toString('utf8')) } catch { throw new Error('收藏返回的不是 JSON') }
    if (j && j.error) throw new Error(`收藏接口报错：${j.error.user_message || j.error.message || ''}`)

    const arr = Array.isArray(j.illusts) ? j.illusts : []
    const before = ids.length
    for (const it of arr) if (it && it.id) ids.push(String(it.id))
    pages++

    // 到底了：这一页不满 30 条
    if (arr.length < 30) { complete = true; break }
    // 这一页没带来任何新 id ⇒ 游标没动，再翻也是白翻，直接停（防死循环）
    if (ids.length === before) { complete = false; break }

    // 跟着 next_url 的游标走（max_bookmark_id 是关键，offset 只是陪衬）
    let nextMax = ''
    let nextOffset = null
    if (j.next_url) {
      try {
        const nu = new URL(j.next_url, APP_API_BASE)
        nextMax = nu.searchParams.get('max_bookmark_id') || ''
        const offStr = nu.searchParams.get('offset')
        if (offStr != null && /^\d+$/.test(offStr)) nextOffset = Number(offStr)
      } catch { /* next_url 解析不了就退化成 +30 */ }
    }
    if (nextMax && nextMax === maxBookmarkId) { complete = false; break }  // 游标没前进 ⇒ 停
    maxBookmarkId = nextMax
    // ⚠️ 用 Number() 明确转数字：之前写成 offset + 30，
    //    而 offset 当时是字符串 "30" ⇒ 拼成 "3030"（实测踩到的第二个坑）
    offset = nextOffset != null ? nextOffset : Number(offset) + 30
  }

  const uniqIds = [...new Set(ids)]
  log(`收藏拉到 ${uniqIds.length} 条${complete ? '（已到底）' : `（到 ${maxPages} 页上限或游标没动，可能不全）`}`)
  return { ids: uniqIds, total: uniqIds.length, complete, pages }
}

function userIdOf(o) { return String(o.userId || '(空)') }

/**
 * 带缓存的取用 —— 这是给搜索用的主入口。
 *
 * 🔴 铁律：**任何失败都返回空集合，绝不抛**。
 *    收藏只是"额外剔除"，拿不到就退化成不剔 —— 不能因此让搜索整个挂掉。
 *
 * @param {object} o
 * @param {string} o.home
 * @param {string} o.userId
 * @param {() => Promise<string|null>} o.getToken  取 access_token（登出/失败时返回 null）
 * @param {string} [o.proxyUrl]
 * @param {number} [o.ttlMs]
 * @param {boolean} [o.force]  忽略缓存强拉
 * @returns {Promise<{ids:Set<string>, from:{cache?:boolean, fresh?:boolean}, why:string}>}
 */
export async function bookmarkIdSet(o = {}) {
  const home = o.home
  const uid = String(o.userId || '').trim()
  const ttl = Number(o.ttlMs) > 0 ? Number(o.ttlMs) : BOOKMARK_TTL_MS
  const empty = (why) => ({ ids: new Set(), from: {}, why })

  if (!home || !uid) return empty('没登录或没有 userId —— 不做收藏剔除')

  // 缓存还新鲜就直接用
  if (!o.force) {
    const c = await readCache(home)
    if (c && c.userId === uid && Date.now() - c.fetchedAt < ttl) {
      return { ids: new Set(c.ids), from: { cache: true, age: Date.now() - c.fetchedAt }, why: `用缓存的收藏（${c.ids.length} 条）` }
    }
  }

  let token = null
  try {
    token = await o.getToken()
  } catch {
    token = null
  }
  if (!token) {
    // 拿不到 token 时，能退回旧缓存就退（总比完全不剔好）
    const c = await readCache(home)
    if (c && c.userId === uid && c.ids.length) {
      return { ids: new Set(c.ids), from: { cache: true, stale: true }, why: `登录态不可用，退回旧缓存（${c.ids.length} 条）` }
    }
    return empty('拿不到登录态 —— 不做收藏剔除')
  }

  try {
    const got = await fetchBookmarkIds({
      userId: uid, token, proxyUrl: o.proxyUrl, timeoutMs: o.timeoutMs,
      maxPages: o.maxPages, log: o.log,
    })
    await writeCache(home, {
      ids: got.ids, userId: uid, total: got.total, complete: got.complete,
      fetchedAt: Date.now(),
    })
    return {
      ids: new Set(got.ids),
      from: { fresh: true, complete: got.complete, pages: got.pages },
      why: `拉到 ${got.ids.length} 条收藏${got.complete ? '' : '（未拉全）'}，推荐时会跳过这些`,
    }
  } catch (err) {
    // 拉失败：能退缓存就退，不能就空集合（绝不抛）
    const c = await readCache(home)
    const why = `读收藏失败：${err && err.message ? err.message : err}`
    if (c && c.userId === uid && c.ids.length) {
      return { ids: new Set(c.ids), from: { cache: true, stale: true }, why: why + '（退回旧缓存）' }
    }
    return empty(why + '（这次不做收藏剔除）')
  }
}
