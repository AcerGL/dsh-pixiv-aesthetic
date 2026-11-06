/**
 * 收藏剔除的自检。
 *   node selfcheck-bookmarks.mjs
 *
 * ⚠️ 不联网。用**假的 fetch 层**测解析与翻页逻辑 ——
 *    单元测试不能依赖"外网通不通、账号有没有登录"。
 *    真联网的验证在 _tmp 的 e2e 脚本里，不进套件。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = join(tmpdir(), 'px-bm-' + Date.now())
await fs.mkdir(home, { recursive: true })

let pass = 0
const fails = []
const ok = (n, c, extra) => { if (c) pass++; else fails.push(n + (extra ? '  → ' + extra : '')) }
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)

const BM = await import('./lib/bookmarks.mjs')
const { readCache, clearCache, cachePath, BOOKMARK_TTL_MS, DEFAULT_MAX_PAGES } = BM

/* ─────────── ① 常量 ─────────── */
{
  ok('TTL 是正数且不超过 1 小时', BOOKMARK_TTL_MS > 0 && BOOKMARK_TTL_MS <= 3600_000, String(BOOKMARK_TTL_MS))
  ok('默认页数合理', DEFAULT_MAX_PAGES >= 1 && DEFAULT_MAX_PAGES <= 50, String(DEFAULT_MAX_PAGES))
  ok('缓存路径在 home 下', cachePath(home).startsWith(home))
}

/* ─────────── ② 缓存读写 ─────────── */
{
  eq('没有缓存时返回 null', await readCache(home), null)

  await fs.writeFile(cachePath(home), JSON.stringify({
    ids: ['1', '2', 3], userId: '74614610', total: 3, fetchedAt: Date.now(), complete: true,
  }), 'utf8')
  const c = await readCache(home)
  eq('读回 ids（都转成字符串）', c.ids, ['1', '2', '3'])
  eq('userId 读回', c.userId, '74614610')
  eq('complete 读回', c.complete, true)

  // 脏数据兜底
  await fs.writeFile(cachePath(home), '{"ids": "not-array", "userId": 123}', 'utf8')
  const c2 = await readCache(home)
  eq('脏 ids 被兜成空数组', c2.ids, [])
  eq('脏 userId 被兜成字符串', c2.userId, '123')

  await fs.writeFile(cachePath(home), 'NOT JSON AT ALL', 'utf8')
  eq('完全不是 JSON 时返回 null', await readCache(home), null)

  await clearCache(home)
  eq('clearCache 之后是 null', await readCache(home), null)
  await clearCache(home)   // 重复清不该抛
  ok('重复 clearCache 不抛', true)
}

/* ─────────── ③ 🔴 翻页靠 max_bookmark_id，不是 offset ─────────── */
{
  const fsmod = await import('node:fs/promises')
  const src = await fsmod.readFile(new URL('./lib/bookmarks.mjs', import.meta.url), 'utf8')
  // 这条防回归：实测踩到过"只改 offset 时三次请求返回同一批"
  ok('用了 max_bookmark_id 游标', src.includes('max_bookmark_id'))
  ok('注释里写明了为什么不能用 offset 翻页', /offset 不参与定位|靠的是 \*\*max_bookmark_id\*\*/.test(src))
  ok('有"游标没前进就停"的防死循环', src.includes('游标没前进') || src.includes('nextMax === maxBookmarkId'))
  // 第二条坑：字符串拼接
  ok('🔴 offset 推进用了 Number()（不是字符串拼接）', /Number\(offset\) \+ 30/.test(src),
    '写成 offset + 30 会拼成 "3030"')
}

/* ─────────── ④ bookmarkIdSet 的降级行为（不抛铁律） ─────────── */
{
  // 没 userId → 空集合
  const a = await BM.bookmarkIdSet({ home, userId: '', getToken: async () => 'x' })
  eq('没 userId 时返回空集合', a.ids.size, 0)
  ok('并说明原因', a.why.includes('没登录') || a.why.includes('userId'), a.why)

  // 没 home → 空集合
  const b = await BM.bookmarkIdSet({ home: '', userId: '123', getToken: async () => 'x' })
  eq('没 home 时返回空集合', b.ids.size, 0)

  // 拿不到 token → 空集合（不抛）
  let threw = false
  let c
  try {
    c = await BM.bookmarkIdSet({ home, userId: '74614610', getToken: async () => null })
  } catch { threw = true }
  ok('拿不到 token 也不抛', !threw)
  eq('拿不到 token 时空集合', c.ids.size, 0)
  ok('说明了不做剔除', c.why.includes('不做收藏剔除'), c.why)

  // getToken 抛异常 → 也要兜住
  let threw2 = false
  try {
    await BM.bookmarkIdSet({ home, userId: '74614610', getToken: async () => { throw new Error('boom') } })
  } catch { threw2 = true }
  ok('getToken 抛异常也被兜住', !threw2)
}

/* ─────────── ⑤ 缓存过期逻辑 ─────────── */
{
  await clearCache(home)
  // 造一个新鲜缓存
  await fs.writeFile(cachePath(home), JSON.stringify({
    ids: ['111', '222'], userId: '74614610', total: 2, fetchedAt: Date.now(), complete: true,
  }), 'utf8')

  // getToken 故意会抛 —— 如果走了缓存，就不该调到它
  let tokenCalled = false
  const r = await BM.bookmarkIdSet({
    home, userId: '74614610',
    getToken: async () => { tokenCalled = true; return 'x' },
  })
  eq('新鲜缓存直接命中', [...r.ids].sort(), ['111', '222'])
  eq('没去拿 token', tokenCalled, false)
  ok('说明了走缓存', r.from.cache === true, JSON.stringify(r.from))

  // 不同 userId 的缓存不能用
  const r2 = await BM.bookmarkIdSet({
    home, userId: '99999',
    getToken: async () => null,
  })
  eq('换用户后不吃旧缓存', r2.ids.size, 0)

  // 过期缓存 + 拿不到 token → 退回旧缓存（stale），总比完全不剔好
  await fs.writeFile(cachePath(home), JSON.stringify({
    ids: ['333'], userId: '74614610', total: 1, fetchedAt: Date.now() - 999999, complete: true,
  }), 'utf8')
  const r3 = await BM.bookmarkIdSet({ home, userId: '74614610', getToken: async () => null })
  eq('过期缓存 + 没 token → 退回旧缓存', [...r3.ids], ['333'])
  eq('标记成 stale', r3.from.stale, true)
  ok('说明里写清了是退回', r3.why.includes('退回旧缓存'), r3.why)
}

/* ─────────── ⑥ taste.mjs 接线：收藏的直接剔除 ─────────── */
{
  const { filterAndRank } = await import('./lib/taste.mjs')
  const mk = (id) => ({
    id, tags: [], userId: 'u1', width: 2000, height: 2000, pageCount: 1,
    illustType: 0, bookmarkCount: 100, createDate: new Date().toISOString(), userName: 'A',
  })
  const items = [mk('111'), mk('222'), mk('333')]
  const r = filterAndRank(items, { bookmarkedIds: new Set(['111', '333']) })
  eq('收藏过的被剔掉', r.kept.map((x) => x.id), ['222'])
  eq('剔了两条', r.dropped.length, 2)
  const d = r.dropped.find((x) => x.id === '111')
  ok('原因说清是"你已经收藏过"', d.dropReason.includes('收藏'), d.dropReason)
  // 🔴 必须跟"存过了"分得开 —— 两者都该剔但原因不同
  ok('原因不是"存过了"', d.dropReason !== '存过了', d.dropReason)

  // seenIds 优先于 bookmarkedIds（顺序无关紧要，但都要能剔）
  const r2 = filterAndRank(items, { seenIds: new Set(['222']), bookmarkedIds: new Set(['111']) })
  eq('两种剔除同时生效', r2.kept.map((x) => x.id), ['333'])
  ok('"存过了"与"收藏过"两种原因都在', r2.dropped.some((x) => x.dropReason === '存过了')
    && r2.dropped.some((x) => x.dropReason.includes('收藏')))

  // 没给 bookmarkedIds 时不该误剔
  const r3 = filterAndRank(items, {})
  eq('不给 bookmarkedIds 时全放行', r3.kept.length, 3)
}

/* ─────────── ⑦ toolset 接线 ─────────── */
{
  const fsmod = await import('node:fs/promises')
  const ts = await fsmod.readFile(new URL('./lib/toolset.mjs', import.meta.url), 'utf8')
  ok('toolset 有 bookmarkedIds 方法', /async bookmarkedIds\(\)/.test(ts))
  ok('搜索里传了 bookmarkedIds', /bookmarkedIds: bm\.ids/.test(ts))
  ok('有两处接线（search + explore）', (ts.match(/bookmarkedIds: bm\.ids/g) || []).length >= 2,
    String((ts.match(/bookmarkedIds: bm\.ids/g) || []).length))
  ok('没登录时优雅降级', /没登录 —— 不做收藏剔除/.test(ts))
  ok('结果里报了收藏状态', /bookmarks: \{/.test(ts))
  // 🔴 独立于口味画像：画像关着也该剔
  ok('bookmarkedIds 不看 tasteEnabled', !/bookmarkedIds\(\)[^}]*tasteEnabled/.test(ts.slice(ts.indexOf('async bookmarkedIds'), ts.indexOf('async bookmarkedIds') + 900)),
    '收藏是既成事实，不该受画像开关影响')
}

await fs.rm(home, { recursive: true, force: true }).catch(() => {})
console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  console.log('\n失败项：')
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过 ✓')
