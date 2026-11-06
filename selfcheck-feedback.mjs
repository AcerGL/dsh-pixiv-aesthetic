/**
 * 负向反馈的自检。
 *   node selfcheck-feedback.mjs
 *
 * 重点验的是规格里那句最难的要求：
 *   **不能把用户不喜欢一张作品，简单理解为不喜欢它所有标签。**
 *
 * 所以这个套件里最要紧的断言是「unlike 一个标签都不扣」——
 * 它要是挂了，画像会被噪声淹没，整个功能就是负资产。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = join(tmpdir(), 'px-fb-' + Date.now())
await fs.mkdir(home, { recursive: true })

let pass = 0
const fails = []
const ok = (n, c, extra) => { if (c) pass++; else fails.push(n + (extra ? '  → ' + extra : '')) }
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)

const FB = await import('./lib/feedback.mjs')
const P = await import('./lib/profile.mjs')
const { penalize, planPenalty, toPenalties, dislikedIds, undoPenalty, describePenalty, NEGATIVE_KINDS } = FB
const { filterAndRank, score } = await import('./lib/taste.mjs')

/* ═══════════ ① 核心规则：unlike 不扣任何标签 ═══════════ */
{
  const plan = planPenalty({ kind: 'unlike', tags: ['初音ミク', '夜景'], userId: 'u1' })
  eq('unlike 不扣标签（哪怕传了 tags）', plan.tags, [])
  eq('unlike 不扣画师', plan.artist, '')
  ok('unlike 的原因说清了为什么', plan.reason.includes('不牵连'), plan.reason)

  // 真跑一遍 penalize
  const prof = P.learn(P.learn(P.learn(P.learn(P.learn(
    { version: 1, learned: 0, disliked: 0, tags: {}, artists: {}, dislikes: [], recent: [] },
    { id: '1', userId: 'u1', userName: 'A', tags: ['初音ミク', '夜景'], width: 2000, height: 2000, illustType: 0 },
  ), { id: '2', userId: 'u1', userName: 'A', tags: ['初音ミク'], width: 2000, height: 2000, illustType: 0 }),
  { id: '3', userId: 'u2', userName: 'B', tags: ['夜景'], width: 2000, height: 2000, illustType: 0 }),
  { id: '4', userId: 'u2', userName: 'B', tags: ['夜景'], width: 2000, height: 2000, illustType: 0 }),
  { id: '5', userId: 'u3', userName: 'C', tags: ['初音ミク'], width: 2000, height: 2000, illustType: 0 });

  const before = JSON.parse(JSON.stringify(prof.tags))
  const { profile: after, applied } = penalize(prof, { kind: 'unlike', id: '1', title: 'T', tags: ['初音ミク'] })

  // 标签权重只该被"衰减"影响，不该被"扣分"影响 —— 这里 now 相同所以衰减是 1
  const tagsUnchanged = Object.keys(before).every((k) => Math.abs(after.tags[k].w - before[k].w) < 1e-9)
  ok('🔴 unlike 后所有标签权重都没被扣', tagsUnchanged,
    JSON.stringify(Object.keys(before).map((k) => `${k}: ${before[k].w.toFixed(2)}→${after.tags[k].w.toFixed(2)}`)))
  eq('unlike 的 applied.tags 是空的', applied.tags, [])
  ok('unlike 记进了 dislikes', after.dislikes.some((d) => d.id === '1'), JSON.stringify(after.dislikes))
  eq('disliked 计数 +1', after.disliked, 1)
  eq('learned 不变（负向不算"学到喜欢的"）', after.learned, prof.learned)
}

/* ═══════════ ② artist_down 只扣画师、不碰标签 ═══════════ */
{
  const plan = planPenalty({ kind: 'artist_down', userId: 'u1', tags: ['初音ミク'] })
  eq('artist_down 不扣标签', plan.tags, [])
  eq('artist_down 扣的就是那个画师', plan.artist, 'u1')

  const base = {
    version: 1, learned: 3, disliked: 0, dislikes: [], recent: [],
    tags: { '初音ミク': { w: 5, n: 3, last: new Date().toISOString() } },
    artists: { u1: { w: 6, n: 3, last: new Date().toISOString(), name: 'A' } },
  }
  const { profile: after, applied } = penalize(base, { kind: 'artist_down', userId: 'u1', userName: 'A' })
  eq('标签没动', after.tags['初音ミク'].w, 5)
  ok('画师被扣了', after.artists.u1.w < 6, String(after.artists.u1.w))
  eq('applied.tags 空', applied.tags, [])
  ok('applied.artist 有值', applied.artist && applied.artist.userId === 'u1')
}

/* ═══════════ ③ style_down 只扣点名的标签 ═══════════ */
{
  const plan = planPenalty({ kind: 'style_down', tags: ['高飽和', '夜景'] })
  eq('style_down 扣点名的两个', plan.tags.sort(), ['夜景', '高飽和'].sort())
  eq('style_down 不扣画师', plan.artist, '')

  const base = {
    version: 1, learned: 3, disliked: 0, dislikes: [], recent: [],
    tags: {
      '高飽和': { w: 2, n: 2, last: new Date().toISOString() },
      '夜景': { w: 3, n: 2, last: new Date().toISOString() },
      '初音ミク': { w: 8, n: 5, last: new Date().toISOString() },   // ← 没点名，不能动
    },
    artists: { u1: { w: 6, n: 3, last: new Date().toISOString(), name: 'A' } },
  }
  const { profile: after } = penalize(base, { kind: 'style_down', tags: ['高飽和', '夜景'] })
  // ⚠️ 是"越过零推到 -step"，不是"减 step" —— 见 ④b 那段说明
  eq('点名的标签被推到负', after.tags['高飽和'].w, -1)
  eq('第二个也被推到负', after.tags['夜景'].w, -1)
  eq('🔴 没点名的标签没动', after.tags['初音ミク'].w, 8)
  eq('画师没动', after.artists.u1.w, 6)
}

/* ═══════════ ④ 重复反馈不该让权重异常（规格第四节点名要防） ═══════════ */
{
  const base = {
    version: 1, learned: 0, disliked: 0, dislikes: [], recent: [],
    tags: {}, artists: {},
  }
  // 同一条反馈重复 10 次
  let p = base
  for (let i = 0; i < 10; i++) p = penalize(p, { kind: 'style_down', tags: ['X'] }).profile
  ok('重复反馈会累加（这是预期，但要被 floor 压住）', p.tags.X.w < -5, String(p.tags.X.w))
  ok('🔴 但不会跌破 floor（防权值异常）', p.tags.X.w >= FB.TAG_NEG_FLOOR - 1e-9, String(p.tags.X.w))

  // 同一批 tags 里有重复项，不该重复扣
  const { profile: q, applied } = penalize(base, { kind: 'style_down', tags: ['Y', 'Y', 'Y'] })
  eq('重复的标签只扣一次', q.tags.Y.w, -1)
  eq('applied.tags 去重了', applied.tags.length, 1)
}

/* ═══════════ ④b 🔴 明确指示必须能盖过之前攒的正权重 ═══════════
 * 实测踩到的 bug（2026-11-06）：原先写 `w - step`，于是
 * 画师攒了 +8 正权重时，减 1 只剩 +7 —— **还是正的**，
 * toPenalties 只收负数 ⇒ 惩罚表空 ⇒ 用户说"不要这个画师"完全没效果。
 * 修法：正权重直接"越过零"推到 -step。
 */
{
  const base = {
    version: 1, learned: 5, disliked: 0, dislikes: [], recent: [],
    tags: { '夜景': { w: 8, n: 5, last: new Date().toISOString() } },
    artists: { u1: { w: 8.1, n: 5, last: new Date().toISOString(), name: 'A' } },
  }
  const { profile: p1 } = penalize(base, { kind: 'artist_down', userId: 'u1', userName: 'A' })
  ok('🔴 正权重画师被一句话打成负数（不是 8.1-1=7.1）', p1.artists.u1.w < 0,
    String(p1.artists.u1.w))
  eq('一次说 = -1', p1.artists.u1.w, -1)

  const { profile: p2 } = penalize(base, { kind: 'style_down', tags: ['夜景'] })
  ok('🔴 正权重标签同理', p2.tags['夜景'].w < 0, String(p2.tags['夜景'].w))

  // 已经负了，再说是继续往下扣
  const { profile: p3 } = penalize(p1, { kind: 'artist_down', userId: 'u1' })
  eq('已经负了再扣就是 -2', p3.artists.u1.w, -2)

  // 真进得了惩罚表（这才是最终判据）
  const { tagPenalty, artistPenalty } = toPenalties(p1)
  ok('扣完确实进了惩罚表', artistPenalty.u1 !== undefined, JSON.stringify(artistPenalty))
  // 反向：如果还是 7.1（旧 bug），这里会是 undefined
  ok('🔴 反证：旧写法下惩罚表为空', Object.keys(toPenalties(base).artistPenalty).length === 0,
    'base 里画师是 +8.1，本来就该为空 —— 说明这条断言能区分修没修')
}

/* ═══════════ ⑤ 单条反馈的力度有上限（别一次踩死） ═══════════ */{
  const base = { version: 1, learned: 0, disliked: 0, dislikes: [], recent: [], tags: {}, artists: {} }
  const { profile: p } = penalize(base, { kind: 'style_down', tags: ['X'], weight: 999 })
  ok('weight 被钳到 5', Math.abs(p.tags.X.w) <= 5, String(p.tags.X.w))
  const { profile: p2 } = penalize(base, { kind: 'style_down', tags: ['X'], weight: 0.01 })
  ok('太小的 weight 有下限（不会变成没效果）', Math.abs(p2.tags.X.w) >= 0.2, String(p2.tags.X.w))
}

/* ═══════════ ⑥ toPenalties：收敛，别让一个词压死一切 ═══════════ */
{
  const prof = {
    version: 1, learned: 0, disliked: 0, dislikes: [], recent: [],
    tags: {
      A: { w: -30, n: 10 }, B: { w: -20, n: 8 }, C: { w: -5, n: 2 },
      GOOD: { w: 10, n: 5 },                       // 正的不能被当成惩罚
    },
    artists: { u1: { w: -50, n: 9, name: 'Bad' }, u2: { w: 8, n: 4, name: 'Good' } },
  }
  const { tagPenalty, artistPenalty } = toPenalties(prof)
  ok('只收负的标签', Object.values(tagPenalty).every((w) => w < 0), JSON.stringify(tagPenalty))
  ok('正权重不进惩罚表', !('GOOD' in tagPenalty), JSON.stringify(tagPenalty))
  ok('🔴 单条被 floor 收敛（不是 -30 直接砸下去）', tagPenalty.A >= -12, String(tagPenalty.A))
  ok('正的画师不进惩罚表', !('u2' in artistPenalty), JSON.stringify(artistPenalty))
  ok('画师负分给得更狠', Math.abs(artistPenalty.u1) > Math.abs(tagPenalty.A),
    `${artistPenalty.u1} vs ${tagPenalty.A}`)

  // 长尾限制
  const many = { version: 1, tags: {}, artists: {}, dislikes: [], recent: [], learned: 0, disliked: 0 }
  for (let i = 0; i < 30; i++) many.tags['T' + i] = { w: -(i + 1), n: 1 }
  const lim = toPenalties(many, { max: 5 })
  eq('长尾只取最负的 max 个', Object.keys(lim.tagPenalty).length, 5)
}

/* ═══════════ ⑦ 打分：惩罚真的拉低排序 ═══════════ */
{
  const items = [
    { id: 'a', tags: ['夜景', '初音ミク'], userId: 'u1', width: 2000, height: 2000, pageCount: 1, illustType: 0, bookmarkCount: 100, createDate: new Date().toISOString(), userName: 'A' },
    { id: 'b', tags: ['夜景'], userId: 'u2', width: 2000, height: 2000, pageCount: 1, illustType: 0, bookmarkCount: 100, createDate: new Date().toISOString(), userName: 'B' },
  ]
  const plain = score(items[0], {})
  const punished = score(items[0], { tasteTagPenalty: { '夜景': -8 } })
  ok('有惩罚时分数更低', punished.score < plain.score, `${plain.score} vs ${punished.score}`)
  ok('why 里说明是口味扣的', punished.why.some((w) => w.includes('口味−')), JSON.stringify(punished.why))

  // 画师惩罚
  const byArtist = score(items[0], { tasteArtistPenalty: { u1: -10 } })
  ok('画师惩罚生效', byArtist.score < plain.score)
  ok('why 里说清是避开画师', byArtist.why.some((w) => w.includes('避开画师')), JSON.stringify(byArtist.why))

  // 排序：被惩罚的应该排后面。
  // ⚠️ 这里**不能**断言"a 一定在最后" —— a 和 b 都命中「夜景」，
  //    取平均后扣得一样多，两者同分。要构造一个**只有一个被扣**的场景才测得出排序。
  const onlyA = [items[0], { ...items[1], id: 'b2', tags: ['无关标签'] }]
  const rSorted = filterAndRank(onlyA, { tasteTagPenalty: { '夜景': -20 } })
  eq('命中惩罚标签的排在没命中的后面', rSorted.kept[rSorted.kept.length - 1].id, 'a',
    JSON.stringify(rSorted.kept.map((x) => [x.id, x.score])))

  // 🔴 关键：惩罚也要**取平均**，不能因为标签多就扣得狠
  const manyTags = { ...items[0], id: 'c', tags: ['夜景', 'x', 'y', 'z', 'w', 'v'] }
  const oneTag = { ...items[0], id: 'd', tags: ['夜景'] }
  const r2 = filterAndRank([manyTags, oneTag], { tasteTagPenalty: { '夜景': -10 } })
  const sc = (id) => r2.kept.find((x) => x.id === id).score
  ok('标签多不等于扣得狠（取平均生效）', Math.abs(sc('c') - sc('d')) < 1e-6, `${sc('c')} vs ${sc('d')}`)
}

/* ═══════════ ⑧ 「不想再看」的 id 被剔除 ═══════════ */
{
  const items = [
    { id: 'dup', tags: [], width: 2000, height: 2000, pageCount: 1, illustType: 0, bookmarkCount: 100, createDate: new Date().toISOString(), userName: 'A' },
    { id: 'ok', tags: [], width: 2000, height: 2000, pageCount: 1, illustType: 0, bookmarkCount: 100, createDate: new Date().toISOString(), userName: 'B' },
  ]
  const r = filterAndRank(items, { dislikedIds: new Set(['dup']) })
  eq('不想看的被剔掉', r.kept.map((x) => x.id), ['ok'])
  const d = r.dropped.find((x) => x.id === 'dup')
  ok('剔除原因说清了是"你说过不想看"', d.dropReason.includes('不想看'), d.dropReason)
  // 跟"存过了"要能分开
  ok('原因不是"存过了"', d.dropReason !== '存过了', d.dropReason)

  // dislikedIds 从画像里取得对
  const prof = { dislikes: [{ id: '1' }, { id: 2 }, { id: '' }, null] }
  const set = dislikedIds(prof)
  ok('dislikedIds 收进了 1 和 2', set.has('1') && set.has('2'), JSON.stringify([...set]))
  // 🔴 这条是防真 bug 的：String(null) === "null"，直接 map 会混进一个垃圾 id
  ok('忽略空串 / null / 非对象（不产生 "null" 这种脏 id）',
    !set.has('') && !set.has('null') && !set.has('undefined') && set.size === 2,
    JSON.stringify([...set]))
}

/* ═══════════ ⑨ undo：撤回 ═══════════ */
{
  const prof = {
    version: 1, learned: 0, disliked: 0, dislikes: [{ id: '9', title: 'T' }], recent: [],
    tags: { X: { w: -5, n: 3 }, Y: { w: 4, n: 2 } },
    artists: { u1: { w: -6, n: 2, name: 'A' }, u2: { w: 5, n: 2, name: 'B' } },
  }
  const a = undoPenalty(prof, { kind: 'tag', key: 'X' })
  ok('撤回负标签：删掉了', !a.profile.tags.X && a.undone)
  const b = undoPenalty(prof, { kind: 'tag', key: 'Y' })
  ok('正权重不会被 undo 删（那是"喜欢"，不是负向反馈）', !!b.profile.tags.Y && !b.undone)
  const c = undoPenalty(prof, { kind: 'artist', key: 'u1' })
  ok('撤回负画师：删掉了', !c.profile.artists.u1 && c.undone)
  const d = undoPenalty(prof, { kind: 'artist', key: 'u2' })
  ok('正画师不会被 undo 删', !!d.profile.artists.u2 && !d.undone)
  const e = undoPenalty(prof, { kind: 'id', key: '9' })
  ok('撤回"不想看"：从 dislikes 里删了', e.profile.dislikes.length === 0 && e.undone)
  const f = undoPenalty(prof, { kind: 'tag', key: '不存在' })
  ok('撤回不存在的不报错、也不谎称成功', !f.undone)
}

/* ═══════════ ⑩ 🔴 存图不能把负权重抹平（会踩的结构坑） ═══════════ */
{
  // 先攒个负权重
  let prof = {
    version: 1, learned: 5, disliked: 1, dislikes: [], recent: [],
    tags: { '討厭的': { w: -6, n: 3, last: new Date().toISOString() } },
    artists: {},
  }
  // 然后存一件**完全无关**的图（正常使用中随时会发生）
  prof = P.learn(prof, { id: '999', userId: 'u9', userName: 'X', tags: ['喜欢的'], width: 2000, height: 2000, illustType: 0 })
  ok('🔴 存新图不会把既有负权重抹平成 0', prof.tags['討厭的'].w < -5,
    String(prof.tags['討厭的'] && prof.tags['討厭的'].w))
  ok('新标签照常学', prof.tags['喜欢的'].w > 0)
}

/* ═══════════ ⑪ 旧画像兼容（v1 没有 dislikes/disliked 字段） ═══════════ */
{
  const old = {
    version: 1, learned: 7, updatedAt: '2026-01-01T00:00:00Z',
    tags: { A: { w: 3, n: 2, last: new Date().toISOString() } },
    artists: { u1: { w: 4, n: 2, name: 'X' } },
    recent: [],
    // 注意：没有 dislikes、没有 disliked
  }
  await fs.writeFile(P.profilePath(home), JSON.stringify(old), 'utf8')
  const loaded = await P.readProfile(home)
  eq('旧文件读回来 learned 还在', loaded.learned, 7)
  ok('dislikes 被兜成空数组', Array.isArray(loaded.dislikes) && loaded.dislikes.length === 0)
  eq('disliked 被兜成 0', loaded.disliked, 0)

  // 旧画像上也能扣分（越过零推到 -step；权重过一遍衰减，用近似比较）
  const { profile: after } = penalize(loaded, { kind: 'style_down', tags: ['A'] })
  ok('旧画像上也能扣分', after.tags.A.w < 0 && Math.abs(after.tags.A.w + 1) < 1e-3, String(after.tags.A.w))
}

/* ═══════════ ⑫ 脏数据不能让插件崩 ═══════════ */
{
  await fs.writeFile(P.profilePath(home), '{"dislikes": "not-array", "tags": {"X": null}}', 'utf8')
  const p = await P.readProfile(home)
  ok('脏 dislikes 被兜成数组', Array.isArray(p.dislikes))
  let threw = false
  try { penalize(p, { kind: 'style_down', tags: ['X'] }) } catch { threw = true }
  ok('值为 null 的标签上扣分不抛', !threw)

  // 缺参数的处理
  const plans = [
    planPenalty({ kind: 'artist_down' }),       // 没给 userId
    planPenalty({ kind: 'style_down' }),        // 没给 tags
    planPenalty({ kind: 'bogus' }),             // 不认识的类型
    planPenalty({}),                            // 空
  ]
  ok('缺参数一律返回空计划（不抛）', plans.every((x) => Array.isArray(x.tags) && x.tags.length === 0))
  ok('缺参数时 reason 说明了原因', plans.every((x) => typeof x.reason === 'string' && x.reason.length > 0))
}

/* ═══════════ ⑬ describePenalty 说人话 ═══════════ */
{
  const t = describePenalty({
    reason: '不要这种风格',
    tags: [{ tag: 'X', w: -2 }],
    artist: { userId: 'u1', name: 'A', w: -3 },
    suppressedId: '99',
  })
  ok('提到了标签', t.includes('X'), t)
  ok('提到了画师', t.includes('A'), t)
  ok('提到了不再推那张', t.includes('99'), t)
  eq('空输入返回空串', describePenalty({}).trim(), '')
}

/* ═══════════ ⑭ 常量与导出完整 ═══════════ */
{
  eq('负数下界是有意义的负数', FB.TAG_NEG_FLOOR < 0 && FB.ARTIST_NEG_FLOOR < 0, true)
  eq('三种负向类型齐全', NEGATIVE_KINDS.sort(), ['artist_down', 'style_down', 'unlike'].sort())
  ok('toPenalties 导出', typeof toPenalties === 'function')
  ok('undoPenalty 导出', typeof undoPenalty === 'function')
}

await fs.rm(home, { recursive: true, force: true }).catch(() => {})
console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  console.log('\n失败项：')
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过 ✓')
