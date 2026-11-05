/**
 * 口味画像的自检。
 *   node selfcheck-taste.mjs
 *
 * 不联网。覆盖的重点是那三条承诺：
 *   ① **默认关 = 行为完全不变**（这是最要紧的，破了就等于擅自改用户行为）
 *   ② 开了之后能真学、权重真涨、时间衰减真起作用
 *   ③ 冷启动没够数时**不许**干扰排序
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = join(tmpdir(), 'px-taste-' + Date.now())
await fs.mkdir(home, { recursive: true })

let pass = 0
const fails = []
const ok = (n, c, extra) => { if (c) pass++; else fails.push(n + (extra ? '  → ' + extra : '')) }
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)

const P = await import('./lib/profile.mjs')
const { filterAndRank, score, mergeWeights } = await import('./lib/taste.mjs')
const { normalize } = await import('./lib/config.mjs')

/* ─────────── ① 默认关 ─────────── */
{
  const d = normalize({})
  eq('tasteEnabled 默认 false（老大定的「要自己开」）', d.tasteEnabled, false)
  ok('tasteKeywords 有钳制', normalize({ tasteKeywords: 999 }).tasteKeywords <= 10)
  ok('tasteKeywords 下限 1', normalize({ tasteKeywords: -3 }).tasteKeywords >= 1)
  ok('tasteMinWeight 允许小数', normalize({ tasteMinWeight: 1.5 }).tasteMinWeight === 1.5)
  ok('tasteScale 有钳制', normalize({ tasteScale: 99 }).tasteScale <= 5)
  ok('tasteEnabled 只认显式 true', normalize({ tasteEnabled: 'yes' }).tasteEnabled === false)
}

/* ─────────── ② 读不存在的画像：给空画像、不抛 ─────────── */
{
  const p = await P.readProfile(home)
  eq('没有文件时 learned=0', p.learned, 0)
  eq('没有文件时 tags 是空对象', p.tags, {})
  ok('没有文件时 isWarm=false', !P.isWarm(p))
}

/* ─────────── ③ 学习：权重真涨、能落盘读回 ─────────── */
{
  let p = await P.readProfile(home)
  const item = {
    id: '100', title: 'T1', userName: '画师A', userId: '1',
    tags: ['初音ミク', '青'] , width: 2400, height: 3200, illustType: 0,
  }
  p = P.learn(p, item)
  eq('学了一件，learned=1', p.learned, 1)
  ok('标签有初音ミク', !!p.tags['初音ミク'])
  ok('标签权重 > 0', p.tags['初音ミク'].w > 0)
  ok('画师记下了', !!p.artists['1'])
  ok('画师名字记下了', p.artists['1'].name === '画师A')
  ok('流水记了一条', p.recent.length === 1)

  // 高清+插画应该有加成 → 基础分 > 1
  ok('高清插画加成生效（gain > 1）', p.recent[0].gain > 1, String(p.recent[0].gain))

  await P.writeProfile(home, p)
  const back = await P.readProfile(home)
  eq('写出去读得回', back.learned, 1)
  ok('读回的权重一致', Math.abs(back.tags['初音ミク'].w - p.tags['初音ミク'].w) < 1e-9)

  // 原子写：不该留 .tmp
  const files = await fs.readdir(home)
  ok('没留 .tmp', !files.some((f) => f.endsWith('.tmp')), files.join(','))
}

/* ─────────── ④ 学同一件两次：权重单调上升 ─────────── */
{
  let p = await P.readProfile(home)
  const w1 = p.tags['初音ミク'].w
  const before = p.learned
  p = P.learn(p, { id: '101', userId: '1', userName: '画师A', tags: ['初音ミク'], width: 2400, height: 2400, illustType: 0 })
  ok('再学一件，权重变大', p.tags['初音ミク'].w > w1, `${w1} → ${p.tags['初音ミク'].w}`)
  eq('n 计数到 2', p.tags['初音ミク'].n, 2)
  eq('学一件 learned 只 +1', p.learned, before + 1)
  ok('画师权重也涨', p.artists['1'].n === 2)
  // ⚠️ 写回，后面的段落要靠它 —— 之前就是漏了这一步导致计数对不上
  await P.writeProfile(home, p)
}

/* ─────────── ⑤ 冷启动门槛 ─────────── */
{
  let p = await P.readProfile(home)
  eq('学了 2 件', p.learned, 2)
  ok('2 件还不算 warm（门槛 5）', !P.isWarm(p))

  for (let i = 0; i < 5; i++) {
    p = P.learn(p, { id: String(200 + i), userId: '2', userName: '画师B', tags: ['風景'], width: 2000, height: 2000, illustType: 0 })
  }
  eq('学够 7 件', p.learned, 7)
  ok('够数后 warm', P.isWarm(p))
  await P.writeProfile(home, p)
}

/* ─────────── ⑥ 时间衰减 ─────────── */
{
  const now = Date.now()
  const today = new Date(now).toISOString()
  const old = new Date(now - P.HALF_LIFE_DAYS * 86_400_000).toISOString() // 正好一个半衰期前
  ok('今天的衰减系数 ≈ 1', P.decayFactor(today, now) === 1, String(P.decayFactor(today, now)))
  const h = P.decayFactor(old, now)
  ok('一个半衰期前衰减到 ≈0.5', Math.abs(h - 0.5) < 0.01, String(h))
  eq('没有时间戳当新的（=1）', P.decayFactor('', now), 1)

  // 衰减要真作用在权重上：造一个很旧的画像，学习时应被压低
  const stale = {
    version: 1, learned: 10, recent: [],
    tags: { '老标签': { w: 10, n: 5, last: old } },
    artists: {},
  }
  const after = P.learn(stale, { id: 'x', tags: ['新标签'], width: 1000, height: 1000, illustType: 0 }, { now })
  ok('旧标签权重被衰减（< 10）', after.tags['老标签'].w < 10, String(after.tags['老标签'].w))
  ok('旧标签仍约等于 5', Math.abs(after.tags['老标签'].w - 5) < 0.2, String(after.tags['老标签'].w))
}

/* ─────────── ⑦ pickKeywords / pickArtists：挑得出、挑得对 ─────────── */
{
  const prof = {
    learned: 20, recent: [],
    tags: {
      '初音ミク': { w: 12, n: 10, last: new Date().toISOString() },
      'オリジナル': { w: 30, n: 25, last: new Date().toISOString() }, // 极宽泛，必须被排除
      '弱标签': { w: 0.5, n: 1, last: new Date().toISOString() },     // 低于门槛，必须被排除
    },
    artists: {
      '743604': { w: 20, n: 5, name: '幸永', last: new Date().toISOString() },
      '999999': { w: 2, n: 1, name: '只存过一次', last: new Date().toISOString() }, // 只存过 1 次，不算
      'not-a-number': { w: 30, n: 9, name: '坏 id', last: new Date().toISOString() }, // 非数字 id，必须剔掉
    },
  }
  const kw = P.pickKeywords(prof, { max: 5, minWeight: 2 })
  eq('挑出了初音ミク', kw, ['初音ミク'])
  ok('极宽泛标签被排除', !kw.includes('オリジナル'), JSON.stringify(kw))
  ok('低权重标签被排除', !kw.includes('弱标签'), JSON.stringify(kw))
  ok('关键词里不再混画师（user: 语法已实测废弃）', !kw.some((w) => w.startsWith('user:')), JSON.stringify(kw))

  const kw2 = P.pickKeywords(prof, { max: 5, minWeight: 2, exclude: ['初音ミク'] })
  ok('exclude 生效', !kw2.includes('初音ミク'), JSON.stringify(kw2))

  const kw3 = P.pickKeywords(prof, { max: 1, minWeight: 2 })
  ok('max 生效', kw3.length <= 1, JSON.stringify(kw3))

  // 画师：返回的是 **userId**，不是名字
  const ar = P.pickArtists(prof, { max: 3, minWeight: 2, minTimes: 2 })
  eq('画师返回 userId', ar, ['743604'])
  ok('非数字 id 被剔掉', !ar.includes('not-a-number'), JSON.stringify(ar))
  ok('只存过一次的画师不算', !ar.includes('999999'), JSON.stringify(ar))
  const ar2 = P.pickArtists(prof, { max: 1, minWeight: 2, minTimes: 2 })
  ok('画师 max 生效', ar2.length <= 1, JSON.stringify(ar2))
}

/* ─────────── ⑧ 打分：画像权重真的影响排序 ─────────── */
{
  const items = [
    { id: 'a', tags: ['初音ミク'], userId: '1', width: 2000, height: 2000, pageCount: 1, illustType: 0, bookmarkCount: 100, createDate: new Date().toISOString(), userName: 'A' },
    { id: 'b', tags: ['風景'], userId: '9', width: 2000, height: 2000, pageCount: 1, illustType: 0, bookmarkCount: 100, createDate: new Date().toISOString(), userName: 'B' },
  ]
  // 不给画像：两条除了标签外条件一样，分应该接近
  const plain = filterAndRank(items, {})
  const sA0 = plain.kept.find((x) => x.id === 'a').score
  const sB0 = plain.kept.find((x) => x.id === 'b').score
  ok('没有画像时两条分接近', Math.abs(sA0 - sB0) < 1e-6, `${sA0} vs ${sB0}`)

  // 给了画像（初音权重高）：a 必须排前面
  const withTaste = filterAndRank(items, {
    tasteTagWeights: { '初音ミク': 10 },
    tasteArtistBoost: { "1": 8 },
    tasteScale: 1,
  })
  eq('有画像时初音那条排第一', withTaste.kept[0].id, 'a')
  ok('而且分数确实被抬高了', withTaste.kept.find((x) => x.id === 'a').score > sA0)
  ok('why 里说明了是口味加的', withTaste.kept.find((x) => x.id === 'a').why.some((w) => w.includes('口味')), JSON.stringify(withTaste.kept.find((x) => x.id === 'a').why))

  // 熟画师加成
  const withArtist = score(items[0], { tasteArtistBoost: { "1": 10 } })
  ok('熟画师有加成', withArtist.why.some((w) => w.includes('熟画师')), JSON.stringify(withArtist.why))

  // 🔴 最要紧的一条：画像权重**不该**让"标签多"的无脑胜出
  const manyTags = { id: 'c', tags: ['初音ミク', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], userId: '1', width: 2000, height: 2000, pageCount: 1, illustType: 0, bookmarkCount: 100, createDate: new Date().toISOString(), userName: 'C' }
  const oneTag = { id: 'd', tags: ['初音ミク'], userId: '1', width: 2000, height: 2000, pageCount: 1, illustType: 0, bookmarkCount: 100, createDate: new Date().toISOString(), userName: 'D' }
  const r2 = filterAndRank([manyTags, oneTag], { tasteTagWeights: { '初音ミク': 10 } })
  const sc = (id) => r2.kept.find((x) => x.id === id).score
  ok('命中数多不等于分数高（取平均的设计生效）', Math.abs(sc('c') - sc('d')) < 1e-6, `${sc('c')} vs ${sc('d')}`)
}

/* ─────────── ⑨ mergeWeights：显式 > 隐式，且关着时原样 ─────────── */
{
  eq('空 + 空 = 空', mergeWeights({}, {}), {})
  eq('只有手填时原样', mergeWeights({ a: 5 }, {}), { a: 5 })
  eq('手填 + 学到 = 相加', mergeWeights({ a: 5 }, { a: 3 }), { a: 8 })
  eq('scale 生效', mergeWeights({}, { a: 10 }, { scale: 0.5 }), { a: 5 })
  eq('0 值被丢掉', mergeWeights({ a: 0 }, {}), {})
}

/* ─────────── ⑩ byArtist 的守卫（不联网，只验参数校验与形状） ─────────── */
{
  const { PixivClient } = await import('./lib/pxclient.mjs')
  const c = new PixivClient({ proxyUrl: '' })
  let threw = ''
  try { await c.byArtist('abc') } catch (e) { threw = e.message }
  ok('非数字画师 id 直接拒', threw.includes('不合法'), threw)
  let threw2 = ''
  try { await c.byArtist('') } catch (e) { threw2 = e.message }
  ok('空画师 id 直接拒', threw2.includes('不合法'), threw2)
}

/* ─────────── ⑪ 清空 ─────────── */
{
  await P.clearProfile(home)
  const p = await P.readProfile(home)
  eq('清空后 learned 归零', p.learned, 0)
  eq('清空后 tags 空', p.tags, {})
  // 再清一次不该抛
  await P.clearProfile(home)
  ok('重复清空不抛', true)
}

/* ─────────── ⑫ 脏数据不能让插件崩（用户手改坏了 taste.json） ─────────── */
{
  const bad = join(home, 'taste.json')
  await fs.writeFile(bad, '{"tags": "not-an-object", "artists": 123, "recent": null, "learned": "abc"}', 'utf8')
  const p = await P.readProfile(home)
  ok('脏 tags 被兜成对象', p.tags && typeof p.tags === 'object' && !Array.isArray(p.tags))
  ok('脏 artists 被兜成对象', p.artists && typeof p.artists === 'object' && !Array.isArray(p.artists))
  eq('脏 recent 被兜成数组', Array.isArray(p.recent), true)
  // 还能正常学
  const p2 = P.learn(p, { id: 'z', tags: ['x'], width: 1000, height: 1000, illustType: 0 })
  ok('脏数据之后还能学', p2.learned >= 1)

  await fs.writeFile(bad, 'THIS IS NOT JSON AT ALL', 'utf8')
  const p3 = await P.readProfile(home)
  eq('完全不是 JSON 时给空画像', p3.learned, 0)

  await fs.writeFile(bad, '{"tags": {"x": null, "y": {"w": "abc", "n": 1}}}', 'utf8')
  const p4 = await P.readProfile(home)
  const p5 = P.learn(p4, { id: 'q', tags: ['z'], width: 1000, height: 1000, illustType: 0 })
  ok('值为 null 的标签不让学习崩', typeof p5.learned === 'number')
}

await fs.rm(home, { recursive: true, force: true }).catch(() => {})
console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  console.log('\n失败项：')
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过 ✓')
