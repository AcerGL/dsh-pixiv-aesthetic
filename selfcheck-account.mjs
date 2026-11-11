/**
 * 账号喜好（从登录的 pixiv 账号读来的那份）—— 全离线自检。
 *   node selfcheck-account.mjs
 *
 * 为什么必须离线：这条功能**只在有 token 时才跑**，而本机直连 pixiv 不通
 * （oauth.secure.pixiv.net 被墙）⇒ 真机验不了。所以逻辑全靠这里的桩钉住。
 *
 * 老大 2026-11-10 定的口径（这些断言就是它们的化身）：
 *   ① 只记第一个账号；换账号不覆盖，而是**慢慢**把权重移过去。
 *   ② 权重以**本机跑出来的**为主；账号喜好只在本机没热身 / 刚重置过时占大。
 *   ③ 两种重置：完全重置 / 只重置账号那份。两种都**保留**"不想看 / 删过了"。
 */
import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const imp = (...p) => import(pathToFileURL(join(here, ...p)).href)
let pass = 0
const fails = []
const ok = (n, c, extra) => { if (c) pass++; else fails.push(n + (extra ? '  → ' + extra : '')) }
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)

const A = await imp('lib', 'accounttaste.mjs')
const { Toolset } = await imp('lib', 'toolset.mjs')
const prof = await imp('lib', 'profile.mjs')
const cfgmod = await imp('lib', 'config.mjs')

/* ═══════════ 1. 采样 → 槽位 ═══════════ */
const works = [
  { id: '1', tags: ['風景', 'オリジナル'], userId: 'u1', userName: 'A', width: 2000, height: 2000, illustType: 0 },
  { id: '2', tags: ['風景'], userId: 'u1', userName: 'A', width: 1000, height: 1000, illustType: 0 },
  { id: '3', tags: ['夜景'], userId: 'u2', userName: 'B', width: 2000, height: 2000, illustType: 1 },
]
{
  const slot = A.slotFromWorks(works, { userId: '777', userName: '某人', source: '收藏' })
  eq('采样件数记对', slot.sampled, 3)
  eq('账号记对', [slot.userId, slot.userName], ['777', '某人'])
  ok('标签进来了', slot.tags['風景'] && slot.tags['風景'].w > 0)
  ok('画师进来了', slot.artists.u1 && slot.artists.u1.w > 0)
  ok('🔴 只产生正权重（账号画像不许学出负口味）',
    Object.values(slot.tags).every((e) => e.w > 0) && Object.values(slot.artists).every((e) => e.w > 0))
}

/* ═══════════ 2. 占比规则（老大那条 ②） ═══════════ */
const accFrom = (sampled) => ({ ...A.emptyAccount(), owner: { userId: '777', userName: 'A', sampled, tags: { 風景: { w: 10 } }, artists: {} } })
{
  const cold = { learned: 0, tags: {}, artists: {} }
  const warm = { learned: 10, tags: { 夜景: { w: 5 } }, artists: {} }

  eq('没有账号画像 ⇒ 占比 0', A.accountShare(A.emptyAccount(), warm).share, 0)
  const s1 = A.accountShare(accFrom(30), cold)
  ok('🔴 本机没热身 ⇒ 账号喜好占大', s1.promoted === true && s1.share === A.SHARE_PROMOTE, JSON.stringify(s1))
  const s2 = A.accountShare(accFrom(30), warm)
  ok('🔴 本机已热身、没重置 ⇒ 账号喜好只当零头',
    s2.promoted === false && s2.share === A.SHARE_SMALL, JSON.stringify(s2))
  const s3 = A.accountShare({ ...accFrom(30), resetBaseline: 10, resetAt: new Date().toISOString() }, warm)
  ok('🔴 刚重置过 ⇒ 又占大（哪怕本机画像还热）', s3.promoted === true && s3.share === A.SHARE_PROMOTE, JSON.stringify(s3))
  const s4 = A.accountShare({ ...accFrom(30), resetBaseline: 10, resetAt: new Date().toISOString() }, { learned: 15, tags: {}, artists: {} })
  ok('🔴 重置后本机又攒够 ⇒ 退回零头',
    s4.promoted === false && s4.share === A.SHARE_SMALL, JSON.stringify(s4))
  ok('占比说明是人话', /本机/.test(s1.why) || /跟前/.test(s1.why), s1.why)
}

/* ═══════════ 3. 合并画像 ═══════════ */
{
  const local = { learned: 2, tags: { 夜景: { w: 4 } }, artists: { u9: { w: 3, name: 'X' } } }
  const m0 = A.mergeTasteProfiles(local, A.emptyAccount(), {})
  eq('没有账号 ⇒ 本机权重原样', m0.tags['夜景'].w, 4)
  eq('没有账号 ⇒ learned 就是本机的', m0.learned, 2)

  const acc = accFrom(10)
  const mBig = A.mergeTasteProfiles({ learned: 0, tags: {}, artists: {} }, acc, {})
  ok('占大时账号标签按 1.0 进来', mBig.tags['風景'].w === 10, JSON.stringify(mBig.tags))
  ok('合并后的 learned 够热身（账号那份算进来了）', prof.isWarm(mBig), String(mBig.learned))

  const mSmall = A.mergeTasteProfiles({ learned: 10, tags: {}, artists: {} }, acc, {})
  ok('零头时账号标签只乘 0.2', Math.abs(mSmall.tags['風景'].w - 2) < 1e-6, JSON.stringify(mSmall.tags))

  // 迁移：owner 10 分、latest 30 分，走到一半 ⇒ 20 分
  const accDrift = {
    ...A.emptyAccount(),
    owner: { userId: 'A', sampled: 1, tags: { X: { w: 10 } }, artists: {} },
    latest: { userId: 'B', sampled: 1, tags: { X: { w: 30 } }, artists: {} },
    migration: 0.5, resetBaseline: 0, resetAt: '',
  }
  const mDrift = A.mergeTasteProfiles({ learned: 0, tags: {}, artists: {} }, accDrift, {})
  ok('🔴 迁移中：两个账号的权重按进度插值', Math.abs(mDrift.tags.X.w - 20) < 1e-6, JSON.stringify(mDrift.tags))

  const mLocal = A.mergeTasteProfiles({ learned: 10, tags: { X: { w: 5 } }, artists: {} }, accDrift, {})
  ok('本机权重永远在（账号只是叠加）', mLocal.tags.X.w > 5)
}

/* ═══════════ 4. 换账号：慢慢移过去 ═══════════ */
{
  const slotB = A.slotFromWorks(works, { userId: '888', userName: 'B', source: '收藏' })
  const base = A.setOwner(A.emptyAccount(), A.slotFromWorks(works, { userId: '777', userName: 'A', source: '收藏' }))
  eq('第一次记录：owner 就是它', (base.owner || {}).userId, '777')
  eq('第一次记录：没有 latest', base.latest, null)

  const same = A.advanceMigration(base, { ...slotB, userId: '777' })
  eq('同一个账号 ⇒ 不动', same.action, 'none')

  let cur = base
  const steps = []
  for (let i = 0; i < 10; i++) {
    const r = A.advanceMigration(cur, slotB)
    steps.push(r.action)
    cur = r.acc
  }
  ok('🔴 换账号 ⇒ 每轮往前走一步（drift）', steps.slice(0, 9).every((a) => a === 'drift'), steps.join(','))
  eq('🔴 走满十步交接给新账号', steps[9], 'handover')
  eq('交接后 owner 变成新账号', (cur.owner || {}).userId, '888')
  eq('交接后迁移进度归零', cur.migration, 0)
  eq('交接后没有 latest', cur.latest, null)
}

/* ═══════════ 5. 两种重置 ═══════════ */
{
  const acc = { ...accFrom(20), migration: 0.4, latest: { userId: 'x', sampled: 5, tags: {}, artists: {} } }
  const r = A.resetAccountOnly(acc, 7)
  eq('只重置账号：owner 清掉', r.owner, null)
  eq('只重置账号：迁移清掉', [r.migration, r.latest], [0, null])
  eq('🔴 只重置账号：留下"重置那一刻本机学到哪了"的基线', r.resetBaseline, 7)
  ok('记下重置时间', !!r.resetAt)
  ok('基线在 ⇒ 新账号立刻占大',
    A.accountShare({ ...r, owner: acc.owner }, { learned: 7, tags: {}, artists: {} }).promoted === true)
}

/* ═══════════ 6. 描述 ═══════════ */
{
  const acc = { ...accFrom(12), latest: { userId: 'z', userName: '新号', sampled: 4, tags: {}, artists: {} }, migration: 0.3 }
  const t = A.describeAccount(acc, A.accountShare(acc, { learned: 0, tags: {}, artists: {} }))
  ok('描述里有账号名', /A/.test(t), t)
  ok('描述里有件数', /12 件/.test(t), t)
  ok('🔴 迁移中要说出来', /慢慢移向 新号（已移 30%）/.test(t), t)
}

/* ═══════════ 7. 接进 toolset：tasteContext 真的用了账号权重 ═══════════ */
const mkHome = async () => await fs.mkdtemp(join(tmpdir(), 'px-acct-'))
{
  const home = await mkHome()
  const cfg = await cfgmod.loadConfig(home, { tasteEnabled: true, useLogin: true })
  const ts = new Toolset({ home, getConfig: () => cfg, getDelivery: () => null })

  // 本机冷启动，账号有一份
  await A.writeAccount(home, A.setOwner(A.emptyAccount(), A.slotFromWorks(
    Array.from({ length: 8 }, (_, i) => ({ id: String(i), tags: ['風景'], userId: 'u1', userName: 'A', width: 2000, height: 2000, illustType: 0 })),
    { userId: '777', userName: 'A', source: '收藏' },
  )))
  const ctx1 = await ts.tasteContext()
  ok('🔴 本机没学过，但账号画像能顶上 ⇒ 不再"还没学到东西"', !/还没学到东西/.test(ctx1.note || ''), ctx1.note)
  ok('🔴 账号标签进了打分权重', (ctx1.tasteTagWeights['風景'] || 0) > 0, JSON.stringify(ctx1.tasteTagWeights))
  ok('说明里点出账号喜好', /账号喜好/.test(ctx1.note || ''), ctx1.note)

  // 本机热了 ⇒ 账号只当零头，且权重变小
  let p = await prof.readProfile(home)
  for (let i = 0; i < 10; i++) {
    p = prof.learn({ ...p, learned: p.learned }, { id: 'x' + i, tags: ['夜景'], userId: 'uz', userName: 'Z', width: 2000, height: 2000, illustType: 0 })
  }
  await prof.writeProfile(home, p)
  const ctx2 = await ts.tasteContext()
  ok('🔴 本机热了 ⇒ 账号只当零头（同一份账号画像，权重变小）',
    (ctx2.tasteTagWeights['風景'] || 0) < (ctx1.tasteTagWeights['風景'] || 0),
    `${ctx1.tasteTagWeights['風景']} → ${ctx2.tasteTagWeights['風景']}`)
  ok('本机的标签在里面', (ctx2.tasteTagWeights['夜景'] || 0) > 0)
  await fs.rm(home, { recursive: true, force: true })
}

/* ═══════════ 8. 账号再大也不能盖过"不想看/删过了" ═══════════ */
{
  const home = await mkHome()
  const cfg = await cfgmod.loadConfig(home, { tasteEnabled: true, useLogin: true })
  const ts = new Toolset({ home, getConfig: () => cfg, getDelivery: () => null })
  let p = await prof.readProfile(home)
  p = { ...p, dislikes: [{ id: '999', title: 't', at: new Date().toISOString() }], disliked: 1 }
  await prof.writeProfile(home, p)
  await A.writeAccount(home, A.setOwner(A.emptyAccount(), A.slotFromWorks(works, { userId: '777', userName: 'A', source: '收藏' })))
  const ctx = await ts.tasteContext()
  ok('🔴 账号喜好不会抹掉"不想看"的那张', ctx.dislikedIds.has('999'), [...ctx.dislikedIds].join(','))
  await fs.rm(home, { recursive: true, force: true })
}

/* ═══════════ 9. 两种重置在 toolset 上的行为 ═══════════ */
{
  const home = await mkHome()
  const cfg = await cfgmod.loadConfig(home, { tasteEnabled: true, useLogin: true })
  const ts = new Toolset({ home, getConfig: () => cfg, getDelivery: () => null })
  let p = await prof.readProfile(home)
  for (let i = 0; i < 6; i++) p = prof.learn(p, { id: 'k' + i, tags: ['夜景'], userId: 'u1', userName: 'A', width: 2000, height: 2000, illustType: 0 })
  p = { ...p, dislikes: [{ id: '888', title: 'x', at: new Date().toISOString() }], disliked: 1 }
  await prof.writeProfile(home, p)
  await A.writeAccount(home, A.setOwner(A.emptyAccount(), A.slotFromWorks(works, { userId: '777', userName: 'A', source: '收藏' })))

  // ① 只重置账号
  const r1 = await ts.resetTaste({ account: true })
  eq('只重置账号：kind 对', r1.kind, 'account')
  const pAfter1 = await prof.readProfile(home)
  eq('🔴 只重置账号：本机画像**一点没动**', Number(pAfter1.learned) || 0, 6)
  ok('本机标签还在', !!(pAfter1.tags || {})['夜景'])
  const a1 = await A.readAccount(home)
  eq('账号那份清掉了', a1.owner, null)
  eq('🔴 基线记成了本机当时的 learned', a1.resetBaseline, 6)

  // ② 完全重置
  const r2 = await ts.resetTaste({})
  eq('完全重置：kind 对', r2.kind, 'all')
  const pAfter2 = await prof.readProfile(home)
  eq('本机权重清空（回到冷启动）', Number(pAfter2.learned) || 0, 0)
  eq('本机标签清空', Object.keys(pAfter2.tags || {}).length, 0)
  eq('🔴 "不想看"的清单**留着**（清了你删过的图会全冒出来）', (pAfter2.dislikes || []).length, 1)
  eq('不喜欢的计数也留着', Number(pAfter2.disliked) || 0, 1)
  const a2 = await A.readAccount(home)
  eq('账号那份也清了', a2.owner, null)
  await fs.rm(home, { recursive: true, force: true })
}

/* ═══════════ 10. 抓取：什么时候抓、抓到了写什么 ═══════════ */
const fakeWorks = Array.from({ length: 6 }, (_, i) => ({
  id: 'w' + i, tags: ['風景', '少女'], userId: 'u9', userName: '画师', width: 2000, height: 2000, illustType: 0,
}))
const mkTs = async (home, o = {}) => {
  const cfg = await cfgmod.loadConfig(home, { tasteEnabled: true, useLogin: true })
  const ts = new Toolset({ home, getConfig: () => cfg, getDelivery: () => null })
  ts.session = () => o.session || {
    who: async () => ({ loggedIn: true, userId: '777', userName: '某个账号' }),
    token: async () => 'TOKEN',
  }
  ts._bookmarksFetch = o.fetch || (async () => ({ ids: fakeWorks.map((w) => w.id), works: fakeWorks, total: 6, complete: true, pages: 1 }))
  ts.client = () => ({ recommended: o.recommended || (async () => ({ items: [] })) })
  return ts
}
{
  const home = await mkHome()
  const ts = await mkTs(home)
  const r1 = await ts.snapshotAccountTaste({})
  ok('第一次抓：记下了', r1.ok === true && r1.kind === 'first', JSON.stringify({ ok: r1.ok, kind: r1.kind, why: r1.why }))
  const acc1 = await A.readAccount(home)
  eq('owner 是登录的那个账号', (acc1.owner || {}).userId, '777')
  ok('采样件数记上了', ((acc1.owner || {}).sampled || 0) >= 5, JSON.stringify(acc1))
  ok('来源标了收藏', /收藏/.test((acc1.owner || {}).source || ''), JSON.stringify(acc1))

  const r2 = await ts.snapshotAccountTaste({})
  eq('🔴 同一账号 7 天内不重复抓', r2.kind, 'fresh')

  // 换账号（没重置）⇒ 开始迁移
  const ts2 = await mkTs(home, {
    session: { who: async () => ({ loggedIn: true, userId: '888', userName: '别人' }), token: async () => 'T' },
  })
  const r3 = await ts2.snapshotAccountTaste({})
  eq('🔴 换账号 ⇒ drift（不立刻接管）', r3.kind, 'drift', JSON.stringify({ kind: r3.kind, why: r3.why }))
  const acc3 = await A.readAccount(home)
  eq('原账号还是 owner（没被覆盖）', (acc3.owner || {}).userId, '777')
  eq('新账号进了 latest', (acc3.latest || {}).userId, '888')
  ok('迁移进度往前走了一格', Math.abs(acc3.migration - A.DRIFT_STEP) < 1e-6, String(acc3.migration))
  await fs.rm(home, { recursive: true, force: true })
}
{
  // 换账号前先"只重置账号" ⇒ 一次就记成新账号（老大要的互补关系）
  const home = await mkHome()
  const ts = await mkTs(home)
  await ts.snapshotAccountTaste({})
  await ts.resetTaste({ account: true })
  const ts2 = await mkTs(home, {
    session: { who: async () => ({ loggedIn: true, userId: '888', userName: '别人' }), token: async () => 'T' },
  })
  const r = await ts2.snapshotAccountTaste({})
  eq('🔴 重置过之后 ⇒ 直接记成新账号（不用慢慢移）', r.kind, 'first', JSON.stringify({ kind: r.kind, why: r.why }))
  eq('owner 换成新账号了', ((await A.readAccount(home)).owner || {}).userId, '888')
  await fs.rm(home, { recursive: true, force: true })
}
{
  // 没 token：登录 ≠ 能读
  const home = await mkHome()
  const ts = await mkTs(home, { session: { who: async () => ({ loggedIn: true, userId: '777', userName: '某个账号' }), token: async () => { throw new Error('超时') } } })
  const r = await ts.snapshotAccountTaste({})
  ok('换不到 token ⇒ 不抓', r.ok === false, JSON.stringify(r))
  ok('🔴 别把"换不到 token"说成"没登录"', !/^没登录/.test(r.why), r.why)
  ok('说清是 token 的事', /token/.test(r.why), r.why)

  // 真没登录
  const ts2 = await mkTs(home, { session: { who: async () => ({ loggedIn: false }) } })
  const r2 = await ts2.snapshotAccountTaste({})
  ok('真没登录 ⇒ 才说没登录', /没登录/.test(r2.why), r2.why)
  await fs.rm(home, { recursive: true, force: true })
}
{
  // 收藏太少 ⇒ 用个性化推荐补
  const home = await mkHome()
  let recCalled = 0
  const ts = await mkTs(home, {
    fetch: async () => ({ ids: [], works: [{ id: 'only', tags: ['x'], userId: 'u', userName: 'U', width: 900, height: 900, illustType: 0 }], total: 1, complete: true, pages: 1 }),
    recommended: async () => { recCalled++; return { items: fakeWorks } },
  })
  const r = await ts.snapshotAccountTaste({})
  ok('收藏不够时用个性化推荐补', r.ok === true && recCalled === 1, JSON.stringify({ ok: r.ok, recCalled, why: r.why }))
  ok('来源里说清补过', /个性化推荐/.test(r.source || ''), r.source)
  await fs.rm(home, { recursive: true, force: true })
}
{
  // 采集少到不够门槛 ⇒ 不记（别拿两件糊弄）
  const home = await mkHome()
  const ts = await mkTs(home, {
    fetch: async () => ({ ids: ['a'], works: [{ id: 'a', tags: ['x'], userId: 'u', userName: 'U', width: 900, height: 900, illustType: 0 }], total: 1, complete: true, pages: 1 }),
  })
  const r = await ts.snapshotAccountTaste({})
  ok('只采到 1 件 ⇒ 不记', r.ok === false && /少于/.test(r.why), JSON.stringify(r))
  eq('也没写进文件', (await A.readAccount(home)).owner, null)
  await fs.rm(home, { recursive: true, force: true })
}
{
  // 口味画像关着 ⇒ 整条不跑
  const home = await mkHome()
  const cfg = await cfgmod.loadConfig(home, { tasteEnabled: false })
  const ts = new Toolset({ home, getConfig: () => cfg, getDelivery: () => null })
  ts.session = () => ({ who: async () => ({ loggedIn: true, userId: '777' }), token: async () => 'T' })
  const r = await ts.snapshotAccountTaste({})
  ok('画像关着就不抓', r.ok === false && /关着/.test(r.why), JSON.stringify(r))
  await fs.rm(home, { recursive: true, force: true })
}

/* ═══════════ 结果 ═══════════ */
console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  console.log('\n失败项：')
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过 ✓')
