/**
 * 智能漫游的自检。
 *   node selfcheck-explore.mjs
 *
 * 重点验两件事：
 *   ① 探索/利用的平衡**如实**（不足就说不足，不假装按比例凑齐）
 *   ② 推荐理由**诚实**（没读图就说没读图，不从标签编造视觉判断）
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let pass = 0
const fails = []
const ok = (n, c, extra) => { if (c) pass++; else fails.push(n + (extra ? '  → ' + extra : '')) }
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)

const E = await import('./lib/explore.mjs')
const { bucketize, diversify, assemble, explain, planMood, DEFAULT_QUOTA, EXPLORE_MODES, MOOD_LEXICON } = E

const mk = (id, tags, uid, score) => ({
  id, tags, userId: uid, userName: 'A' + uid, score,
  width: 2000, height: 2000, pageCount: 1, illustType: 0, bookmarkCount: 100,
  createDate: new Date().toISOString(),
})

/* ─────────── ① 常量 ─────────── */
{
  const sum = DEFAULT_QUOTA.familiar + DEFAULT_QUOTA.explore + DEFAULT_QUOTA.diversify
  ok('默认配额加起来是 1', Math.abs(sum - 1) < 1e-9, String(sum))
  eq('四种模式齐全', EXPLORE_MODES.sort(), ['deep_dive', 'for_you', 'mood', 'surprise'].sort())
  ok('词表非空', Object.keys(MOOD_LEXICON).length > 10)
  ok('词表里每个词都映射到非空标签数组',
    Object.values(MOOD_LEXICON).every((v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x)))
}

/* ─────────── ② bucketize：新/旧的定义要可解释 ─────────── */
{
  const items = [
    mk('1', ['夜景'], 'u1', 90),        // 熟画师 → familiar
    mk('2', ['冷门标签'], 'u9', 80),     // 新画师 + 新标签 → explore
    mk('3', ['夜景'], 'u9', 70),        // 新画师但熟标签 → familiar
    mk('4', ['另一个冷门'], 'u8', 60),   // 全新 → explore
  ]
  const b = bucketize(items, { familiarArtists: new Set(['u1']), familiarTags: new Set(['夜景']) })
  eq('熟画师进 familiar', b.familiar.map((x) => x.id), ['1', '3'])
  eq('全新进 explore', b.explore.map((x) => x.id), ['2', '4'])
  ok('diversify 桶是空的（它是同批去重，不是独立来源）', b.diversify.length === 0)

  // 空上下文时全算"新"
  const b2 = bucketize(items, {})
  eq('没有画像时全是新的', b2.explore.length, 4)
  eq('没有画像时 familiar 为空', b2.familiar.length, 0)
}

/* ─────────── ③ diversify：同画师不该刷屏 ─────────── */
{
  // 前 4 条全是同一个画师，第 5 条是别人
  const items = [
    mk('a1', ['x'], 'same', 100), mk('a2', ['x'], 'same', 99),
    mk('a3', ['x'], 'same', 98), mk('a4', ['x'], 'same', 97),
    mk('b1', ['y'], 'other', 90),
  ]
  const picked = diversify(items, { limit: 3 })
  const artists = picked.map((x) => x.userId)
  ok('不会三条全是同一个画师', new Set(artists).size > 1, artists.join(','))
  eq('本来分最高的 a1 仍会被选中', picked[0].id, 'a1')
  ok('另一个画师被提上来了', artists.includes('other'), artists.join(','))

  // 不改原对象的 score
  const before = items.map((x) => x.score)
  diversify(items, { limit: 5 })
  eq('不该改动原对象的 score', items.map((x) => x.score), before)

  // limit 超过候选数时不该死循环
  const few = [mk('x', [], 'u', 1)]
  eq('候选不够时返回全部', diversify(few, { limit: 10 }).length, 1)
  eq('空输入返回空', diversify([], { limit: 5 }).length, 0)
}

/* ─────────── ④ assemble：配额 + 如实处理不足 ─────────── */
{
  const fam = Array.from({ length: 20 }, (_, i) => mk('f' + i, ['夜景'], 'fu' + i, 100 - i))
  const exp = Array.from({ length: 20 }, (_, i) => mk('e' + i, ['新'], 'eu' + i, 80 - i))

  const r = assemble({ familiar: fam, explore: exp }, { limit: 10 })
  eq('总条数 = limit', r.items.length, 10)
  eq('familiar 配额 6（60%）', r.quota.familiar, 6)
  eq('explore 配额 3（精算后）', r.quota.explore, 3)
  ok('diversify 吃剩下的', r.quota.diversify >= 1, String(r.quota.diversify))
  ok('两桶都有进', r.actual.familiar > 0 && r.actual.explore > 0, JSON.stringify(r.actual))
  eq('没有不足时 shortfall 为 null', r.shortfall, null)

  // 🔴 关键：某桶不足时要**如实说**，不能假装按比例凑齐
  const r2 = assemble({ familiar: fam, explore: [mk('only', ['x'], 'u', 50)] }, { limit: 10 })
  ok('explore 不足时记进 shortfall', r2.shortfall && r2.shortfall.explore, JSON.stringify(r2.shortfall))
  eq('shortfall 说清缺多少', r2.shortfall.explore, { want: 3, got: 1 })
  ok('不足时仍凑够 limit（从 familiar 补）', r2.items.length === 10, String(r2.items.length))

  // 配额归一化：用户给个加起来不等于 1 的
  const r3 = assemble({ familiar: fam, explore: exp }, { limit: 10, quota: { familiar: 1, explore: 1, diversify: 0 } })
  ok('配额被归一化（1:1 → 5:5）', r3.quota.familiar === 5 && r3.quota.explore === 5,
    JSON.stringify(r3.quota))

  // 全 0 配额不该崩
  const r4 = assemble({ familiar: fam, explore: exp }, { limit: 5, quota: { familiar: 0, explore: 0, diversify: 0 } })
  ok('全 0 配额退回默认（不崩、不返回空）', r4.items.length > 0, String(r4.items.length))

  // 两个桶都空
  const r5 = assemble({ familiar: [], explore: [] }, { limit: 5 })
  eq('两桶都空时返回空', r5.items.length, 0)
  ok('两桶都空时 shortfall 说明了两边都不足', r5.shortfall && r5.shortfall.familiar && r5.shortfall.explore)
}

/* ─────────── ⑤ explain：诚实标注有没有读图 ─────────── */
{
  const it = mk('1', ['夜景'], 'u1', 88)
  it.why = ['口味+11.5(夜景)', '新鲜', '高清', '第3位']
  it.source = 'ranking'

  const e = explain(it)
  eq('id/标题/画师都在', [e.id, e.artist], ['1', 'A u1'.replace(' ', '')])
  ok('匹配项被提炼出来', e.matched.length >= 2, JSON.stringify(e.matched))
  eq('🔴 没读图就说没读图', e.visualChecked, false)
  ok('没读图时 note 明确写了', e.visualNote.includes('没有读图'), e.visualNote)
  ok('note 说明只从元数据推的', e.visualNote.includes('元数据'), e.visualNote)

  // 有视觉信息时
  const it2 = { ...it, vision: { style: '厚涂', confidence: 'medium' } }
  const e2 = explain(it2)
  eq('读过图时 visualChecked = true', e2.visualChecked, true)
  ok('说清置信度', e2.visualNote.includes('medium'), e2.visualNote)

  // 被扣分的要作为"差异"提出来
  const it3 = { ...it, why: ['口味−8.0(夜景)'] }
  const e3 = explain(it3)
  ok('被扣分的进 cautions', e3.cautions.length > 0, JSON.stringify(e3.cautions))
  ok('差异说明是有内容的', e3.diff.length > 0, e3.diff)

  // 空输入不崩
  const e4 = explain({})
  eq('空对象不崩', typeof e4.id, 'string')
  eq('空对象 score 是 0', e4.score, 0)
}

/* ─────────── ⑥ planMood：只映可靠词，不编 ─────────── */
{
  const r = planMood('找一些有空气感的夏日夜景')
  ok('认出了空气感', r.keywords.includes('空気感') || r.keywords.includes('透明感'), JSON.stringify(r.keywords))
  ok('认出了夏日', r.keywords.includes('夏'), JSON.stringify(r.keywords))
  ok('认出了夜景', r.keywords.includes('夜景'), JSON.stringify(r.keywords))
  ok('每个映射都能追溯到词', r.derived.length > 0 && r.derived.every((d) => d.word && d.tags.length))
  ok('给出了可执行的 plan', r.plan.length > 0 && r.plan.includes('搜'), r.plan)

  // 引号里的词直接当搜索词
  const r2 = planMood('想要「厚塗り」那种感觉')
  ok('引号里的词被直接采纳', r2.keywords.includes('厚塗り'), JSON.stringify(r2.keywords))
  ok('标记了是引号来源', r2.derived.some((d) => d.quoted), JSON.stringify(r2.derived))

  // 认不出来时**老实说**
  const r3 = planMood('随便来点好康的')
  eq('认不出来时 keywords 为空', r3.keywords, [])
  ok('认不出来时不假装懂', r3.note.includes('没解析出'), r3.note)
  ok('给出可操作的下一步建议', r3.note.includes('换'), r3.note)

  // 空输入
  const r4 = planMood('')
  eq('空输入 keywords 空', r4.keywords, [])
  eq('空输入不崩', typeof r4.plan, 'string')

  // 自定义词表
  const r5 = planMood('我要赛博和尚', { lexicon: { '赛博和尚': ['cyber-monk'] } })
  ok('自定义词表生效', r5.keywords.includes('cyber-monk'), JSON.stringify(r5.keywords))

  // 不超上限
  const many = planMood('空气感 透明感 安静 治愈 温暖 清冷 夜景 黄昏 清晨 逆光 低饱和 色彩丰富 黑白 远景 夏日 冬日 雨中 海边 森林 水彩 厚涂 像素')
  ok('keywords 有上限（不无限涨）', many.keywords.length <= 8, String(many.keywords.length))
}

/* ─────────── ⑦ deep_dive 的诚实约束 ─────────── */
{
  const fsmod = await import('node:fs/promises')
  const src = await fsmod.readFile(new URL('./lib/explore.mjs', import.meta.url), 'utf8')
  // 规格要求：不得假设 pixiv 有可用的以图搜图 / 相似度接口
  ok('源码里说明 pixiv 没有可用的相关作品接口', /相关作品.*404|404.*相关作品/.test(src.replace(/\n/g, ' ')),
    '注释里应写明这个实测结论')
  // 不得伪装成概率
  ok('配额叫 quota（不是 probability/confidence）', /quota/i.test(src) && !/confidence:\s*0\.\d/.test(src))
  ok('明确写了不得伪装成模型概率', src.includes('伪装'), '注释里应写明这条自我约束')
}

await Promise.resolve()
console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  console.log('\n失败项：')
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过 ✓')
