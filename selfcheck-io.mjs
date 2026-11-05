/**
 * 落盘 / 台账 / 投递 的离线自检 —— 全在临时目录里跑，不碰真磁盘。
 *   node selfcheck-io.mjs
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sanitize, extFor, dirFor, saveWork, writeAtomic, sha256 } from './lib/save.mjs'
import { Ledger, localDay } from './lib/seen.mjs'
import { LocalFolderChannel, QQChannel, Delivery, filesFromSaved } from './lib/deliver.mjs'

let pass = 0
const fails = []
const ok = (n, c, extra) => { if (c) pass++; else fails.push(n + (extra ? '  → ' + extra : '')) }
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)

const root = join(tmpdir(), 'px-io-test-' + Date.now())
await fs.mkdir(root, { recursive: true })

/* ─────────── 命名清洗 ─────────── */
eq('非法字符换掉', sanitize('a<b>c:d"e/f\\g|h?i*j'), 'a_b_c_d_e_f_g_h_i_j')
eq('结尾点去掉', sanitize('名字...'), '名字')
eq('结尾空格去掉', sanitize('名字   '), '名字')
eq('保留名加前缀', sanitize('CON'), '_CON')
eq('保留名 com1', sanitize('com1'), '_com1')
eq('空 → untitled', sanitize(''), 'untitled')
eq('全是非法字符也能出名字', sanitize('///'), '___')
{
  const long = 'あ'.repeat(200)
  const s = sanitize(long, { max: 10 })
  ok('超长会截断', s.length <= 12, `len=${s.length}`)
  ok('截断不留半个字符', !/[\ud800-\udbff]$/.test(s), JSON.stringify(s))
}
eq('控制字符干掉', sanitize('a\u0000b\u001fc'), 'abc')

/* ─────────── 扩展名 ─────────── */
eq('png', extFor('image/png', ''), '.png')
eq('jpeg → .jpg', extFor('image/jpeg', ''), '.jpg')
eq('webp', extFor('image/webp', ''), '.webp')
eq('从 url 猜', extFor('', 'https://i.pximg.net/x/y.jpg'), '.jpg')
eq('都没有就给 jpg', extFor('', ''), '.jpg')

/* ─────────── 目录模板 ─────────── */
{
  const item = { id: '123', title: '标题', userName: '画师' }
  const d = dirFor('D:\\P', item, { dirTemplate: '{artist}/{title}_{id}', kind: '插画' })
  ok('模板展开', d.includes('画师') && d.includes('标题_123'), d)
  const d2 = dirFor('D:\\P', item, { dirTemplate: '{artist}/{title}' })
  ok('模板缺 {id} 会自动补上', d2.endsWith('123'), d2)

  // 目录穿越：真正危险的是**模板本身**写了 ..，不是标题里带 ..（那个已被 sanitize 中和）
  // 注意：sanitize 会把 "../../evil" 变成 ".._.._evil" —— 里面虽然有 ".." 字样，
  // 但**不是独立的一段**，所以安全。判定要用「段」而不是子串。
  const hasDotDotSeg = (p) => p.split(/[/\\]+/).some((s) => s === '..')

  const d3 = dirFor('D:\\P', item, { dirTemplate: '../../{artist}/{id}' })
  ok('模板里的 .. 整段被丢掉', !hasDotDotSeg(d3), d3)
  const d4 = dirFor('D:\\P', item, { dirTemplate: 'a/../../b/{id}' })
  ok('模板中段的 .. 也被丢掉', !hasDotDotSeg(d4), d4)
  ok('丢完仍落在根下面', d4.startsWith('D:\\P\\'), d4)
  const d5 = dirFor('D:\\P', { ...item, title: '../../evil' }, {})
  ok('标题里的 .. 被清洗（不构成独立段）', !hasDotDotSeg(d5), d5)
  ok('标题里的 .. 不会穿出根', d5.startsWith('D:\\P\\'), d5)
}

/* ─────────── 原子写 ─────────── */
{
  const f = join(root, 'sub', 'a.txt')
  await writeAtomic(f, 'hello')
  eq('原子写能读回', await fs.readFile(f, 'utf8'), 'hello')
  const left = (await fs.readdir(join(root, 'sub'))).filter((n) => n.endsWith('.tmp'))
  eq('没留 .tmp', left.length, 0)
}

/* ─────────── 存一件作品 ─────────── */
{
  const item = { id: '999', title: '测试作品', userName: '画师A', userId: 'u1', tags: ['タグ'], pageCount: 2, url: 'https://www.pixiv.net/artworks/999' }
  const images = [
    { page: 0, bytes: Buffer.from('PAGE1'), contentType: 'image/jpeg', via: 'official', url: 'x.jpg' },
    { page: 1, bytes: Buffer.from('PAGE2'), contentType: 'image/png', via: 'mirror', url: 'y.png' },
  ]
  const r = await saveWork({ root, item, images, opts: { keyword: '测试' } })
  ok('两页都存下', r.saved.length === 2, JSON.stringify(r.saved))
  eq('页名有前导零', r.saved, ['001.jpg', '002.png'])
  const meta = JSON.parse(await fs.readFile(r.metaPath, 'utf8'))
  eq('metadata 记了 id', meta.id, '999')
  eq('metadata 记了 sha256', typeof meta.files[0].sha256, 'string')
  ok('metadata 带 licenseNote', typeof meta.licenseNote === 'string' && meta.licenseNote.length > 0)
  eq('metadata 有 savedAt', typeof meta.savedAt, 'string')

  // 再存一次：应该合并、不重复写
  const r2 = await saveWork({ root, item, images, opts: { keyword: '测试' } })
  eq('重复时跳过已有页', r2.skipped.length, 2)
  eq('重复时不再写新页', r2.saved.length, 0)
  ok('重复时算合并', r2.merged === true)
  const meta2 = JSON.parse(await fs.readFile(r2.metaPath, 'utf8'))
  eq('合并时保留原 savedAt', meta2.savedAt, meta.savedAt)
}

/* ─────────── 台账 ─────────── */
{
  const home = join(root, 'ledger')
  const L = new Ledger(home)

  eq('空台账今天 0 件', await L.countToday(), 0)
  await L.add({ id: '1', title: 'a', pages: 1, bytes: 10 })
  await L.add({ id: '2', title: 'b', pages: 2, bytes: 20 })
  eq('存两件后今天 2 件', await L.countToday(), 2)
  ok('has 认得存过的', await L.has('1'))
  ok('has 认不得不存在的', !(await L.has('3')))
  eq('seenIds 有 2 个', (await L.seenIds()).size, 2)

  /* ── 额度：remaining 与 hasRoomFor 分开，别混 ──
   * ⚠️ 踩过的坑（2026-11-05）：原来只有一个 `quota(left, limit)`，把
   *    「还剩多少」和「够不够存 N 件」塞进同一签名。保存成功后调
   *    `quota(0, limit)` 想报告剩余，结果 left 被算成 0，还输出
   *    「今天的额度用完了（1/5）」这种吓人的假话（其实还剩 4 件）。
   */
  {
    const r = await L.remaining(20)
    eq('remaining: 已用 2', r.used, 2)
    eq('remaining: 上限 20', r.limit, 20)
    eq('remaining: 还剩 18', r.left, 18)
    ok('remaining: 还有额度时 ok', r.ok)
    eq('remaining: 没问题时 why 为空', r.why, '')

    // 关键回归：保存后报告剩余，**不能**算出 0
    const afterSave = await L.remaining(20)
    ok('保存后报告的剩余不是 0', afterSave.left === 18, JSON.stringify(afterSave))

    // hasRoomFor：想存 N 件够不够
    const h1 = await L.hasRoomFor(1, 20)
    ok('hasRoomFor(1,20) 够', h1.ok && h1.canDo === 1, JSON.stringify(h1))
    const h5 = await L.hasRoomFor(5, 3)
    ok('hasRoomFor(5,3) 只能做 1 件（3-2=1）', h5.canDo === 1, JSON.stringify(h5))
    const h99 = await L.hasRoomFor(99, 3)
    ok('hasRoomFor 会被上限截断', h99.canDo === 1, JSON.stringify(h99))

    // limit=0 表示不限
    const un = await L.remaining(0)
    ok('limit=0 视为不限', un.unlimited === true && un.ok === true, JSON.stringify(un))
    const un2 = await L.hasRoomFor(50, 0)
    ok('不限时 hasRoomFor 也放行', un2.ok === true, JSON.stringify(un2))
  }

  // 模拟今天已经满了
  for (let i = 0; i < 20; i++) await L.add({ id: 'x' + i })
  const q2 = await L.remaining(20)
  ok('额度用完要拦住', !q2.ok && q2.left === 0, JSON.stringify(q2))
  ok('额度用完给人话', q2.why.includes('额度用完'), q2.why)
  const q3 = await L.hasRoomFor(1, 20)
  ok('满了之后 hasRoomFor 也拦', !q3.ok && q3.canDo === 0, JSON.stringify(q3))

  // 坏行不该让台账打不开
  await fs.appendFile(L.file, 'this is not json\n', 'utf8')
  const L2 = new Ledger(home)
  const rows = await L2.rows()
  ok('坏行被跳过，其余照读', rows.length >= 22, `rows=${rows.length}`)
}
eq('localDay 格式', /^\d{4}-\d{2}-\d{2}$/.test(localDay()), true, localDay())

/* ─────────── 投递：落盘通道 ─────────── */
{
  const folder = new LocalFolderChannel({ home: join(root, 'out') })
  const rdy = await folder.ready()
  ok('落盘通道永远就绪', rdy.ok, rdy.why)

  const f1 = join(root, 'out', 'a.jpg')
  await fs.writeFile(f1, 'xxx')
  const r = await folder.send({ files: [{ path: f1, name: 'a.jpg' }] })
  ok('落盘通道发送成功', r.ok)
  ok('落盘通道回报字节', r.results[0].bytes === 3, JSON.stringify(r.results[0]))

  const r2 = await folder.send({ files: [{ path: join(root, 'out', 'nope.jpg'), name: 'nope.jpg' }] })
  ok('文件不存在要如实报错', !r2.ok && r2.results[0].why.includes('读不到'))
}

/* ─────────── 投递：QQ 通道的窗口逻辑 ─────────── */
{
  const msgs = join(root, 'msgs.log')
  const now = Date.now()
  await fs.writeFile(msgs,
    `${now - 999_999}|c2c|OLD|msg-old|\n` +
    `${now - 10_000}|c2c|A4BD|msg-new|hi\n`, 'utf8')

  const qq = new QQChannel({ bot: {}, msgsLog: msgs, passiveWindowMs: 270_000 })
  const win = await qq.recentWindow()
  ok('找到窗口内的最新一条', win && win.targetId === 'A4BD', JSON.stringify(win))
  ok('窗口年龄合理', win.ageMs >= 9000 && win.ageMs <= 12000, String(win && win.ageMs))

  // 全是过期消息 → 找不到窗口
  const msgs2 = join(root, 'msgs-old.log')
  await fs.writeFile(msgs2, `${now - 999_999}|c2c|OLD|msg-old|\n`, 'utf8')
  const qq2 = new QQChannel({ bot: {}, msgsLog: msgs2, passiveWindowMs: 270_000 })
  eq('过期消息不算窗口', await qq2.recentWindow(), null)

  // 没有窗口时 send 要如实说，不能假装成功
  const r = await qq2.send({ files: [{ path: join(root, 'out', 'a.jpg'), name: 'a.jpg' }] })
  ok('没窗口时发送失败', !r.ok)
  ok('没窗口时说明原因', r.why.includes('窗口'), r.why)

  // 没有 bot 时 ready 说清楚
  const qq3 = new QQChannel({ bot: null, msgsLog: msgs })
  const rdy = await qq3.ready()
  ok('没机器人实例时如实说', !rdy.ok && rdy.why.includes('im-qqbot'), rdy.why)
}

/* ─────────── 通道编排 ─────────── */
{
  const folder = new LocalFolderChannel({ home: join(root, 'out') })
  await folder.ready()
  const qq = new QQChannel({ bot: null, msgsLog: join(root, 'none.log') })
  const D = new Delivery([qq, folder])

  const st = await D.status()
  eq('两个通道都报状态', st.length, 2)
  ok('QQ 报不可用', st.find((s) => s.name === 'qq').ok === false)
  ok('落盘报可用', st.find((s) => s.name === 'local').ok === true)

  const f1 = join(root, 'out', 'b.jpg')
  await fs.writeFile(f1, 'yyy')
  // 先试 QQ（没配置 → 跳过），再退落盘 —— 最终应成功，且两类原因分得清
  const d = await D.deliver([{ path: f1, name: 'b.jpg' }], { order: ['qq', 'local'] })
  ok('QQ 不可用后落到本地', d.ok && d.channel === 'local', JSON.stringify(d))
  eq('只把真发过的记进 tried', d.tried.length, 1)
  eq('tried 里是落盘', d.tried[0].name, 'local')
  ok('skipped 说明 QQ 为什么没发', d.skipped.some((s) => s.name === 'qq' && s.why), JSON.stringify(d.skipped))

  // QQ 有实例但发送失败 → 这条要进 tried（说明"发了但失败"）
  const fakeBot = { sendImage: async () => { throw new Error('40034105 主动消息失败, 无权限') } }
  const msgs = join(root, 'msgs2.log')
  await fs.writeFile(msgs, `${Date.now() - 1000}|c2c|TID|MSGID|x\n`, 'utf8')
  const qqSendable = new QQChannel({ bot: fakeBot, msgsLog: msgs })
  const D3 = new Delivery([qqSendable, new LocalFolderChannel({ home: join(root, 'out') })])
  const d3 = await D3.deliver([{ path: f1, name: 'b.jpg' }], { order: ['qq', 'local'] })
  ok('QQ 发送失败但最终落到本地', d3.ok && d3.channel === 'local')
  ok('发送失败进 tried（区别于没配置）', d3.tried.some((t) => t.name === 'qq' && !t.ok))
  ok('权限错误被翻译成人话',
    d3.tried.some((t) => t.name === 'qq' && /权限|窗口/.test(t.why)), JSON.stringify(d3.tried))

  // broadcast：每个通道都试，一个成功就算成功
  const { broadcast } = await import('./lib/deliver.mjs')
  const B = await broadcast(D3, [{ path: f1, name: 'b.jpg' }], { order: ['qq', 'local'] })
  ok('broadcast 有成功的就算成功', B.ok)
  eq('broadcast 记录了成功的通道', B.sent, ['local'])
  ok('broadcast 记录了失败的通道', B.failed.some((f) => f.name === 'qq'), JSON.stringify(B.failed))

  // 全失败要如实返回
  const D2 = new Delivery([qqSendable])
  const d2 = await D2.deliver([{ path: f1, name: 'b.jpg' }])
  ok('没有可用通道时失败', !d2.ok)
  ok('失败给理由', typeof d2.why === 'string' && d2.why.length > 0, d2.why)
}

/* ─────────── 结果 ─────────── */
await fs.rm(root, { recursive: true, force: true }).catch(() => {})
console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  console.log('\n失败项：')
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过 ✓')
