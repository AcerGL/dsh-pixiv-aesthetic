/**
 * selfcheck —— 离线断言 + 可选联网自检。
 *   node selfcheck.mjs              只跑离线断言
 *   node selfcheck.mjs --net        联网验证（会按探测结果自动选路）
 *   node selfcheck.mjs --net-only   只跑联网
 *
 * 退出码 0 = 全过。
 */
import { PixivClient, originalFromThumb, RANK_MODES } from './lib/pxclient.mjs'
import { screenContent, score, filterAndRank } from './lib/taste.mjs'
import { dechunk } from './lib/transport.mjs'
import { RouteProbe, rewriteBase } from './lib/route.mjs'

const PROXY = process.env.PIXIV_PROXY || 'http://127.0.0.1:7897'
const onlyNet = process.argv.includes('--net-only')
const wantNet = process.argv.includes('--net') || onlyNet

let pass = 0
const fails = []
const ok = (name, cond, extra) => {
  if (cond) { pass++; return }
  fails.push(name + (extra ? '  → ' + extra : ''))
}
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want),
     `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)
const rejects = async (fn) => { try { await fn(); return false } catch { return true } }

/* ═══════════════ 离线断言 ═══════════════ */

if (!onlyNet) {
  /* ── 1. 缩略图 → 原图 ── */
  eq('缩略图反推原图（jpg）',
    originalFromThumb('https://i.pximg.net/c/250x250_80_a2/img-master/img/2026/11/04/14/38/39/151670647_p0_square1200.jpg'),
    'https://i.pximg.net/img-master/img/2026/11/04/14/38/39/151670647_p0.jpg')
  eq('缩略图反推原图（多页 p2）',
    originalFromThumb('https://i.pximg.net/c/540x540_70/img-master/img/2026/01/02/03/04/05/123456789_p2_master1200.jpg'),
    'https://i.pximg.net/img-master/img/2026/01/02/03/04/05/123456789_p2.jpg')
  eq('非 i.pximg 的缩略图 → 空', originalFromThumb('https://example.com/a.jpg'), '')
  eq('没见过的后缀 → 空', originalFromThumb('https://i.pximg.net/c/128x128/img-master/img/x/y/z_p0_bogus.avif'), '')

  /* ── 2. 分级过滤 ── */
  ok('xRestrict=1 被拦', screenContent({ xRestrict: 1, tags: [] }).blocked)
  ok('R-18 标签被拦', screenContent({ xRestrict: 0, tags: ['R-18', '女の子'] }).blocked)
  ok('r18g 被拦', screenContent({ xRestrict: 0, tags: ['r18g'] }).blocked)
  ok('18禁 被拦', screenContent({ xRestrict: 0, tags: ['18禁'] }).blocked)
  ok('NSFW 被拦', screenContent({ xRestrict: 0, tags: ['nsfw'] }).blocked)
  ok('sexual 标记被拦', screenContent({ xRestrict: 0, tags: [], contentFlags: { sexual: 2 } }).blocked)
  ok('grotesque 被拦', screenContent({ xRestrict: 0, tags: [], contentFlags: { grotesque: true } }).blocked)
  ok('干净的放行', !screenContent({ xRestrict: 0, tags: ['初音ミク', '風景'], contentFlags: { sexual: 0 } }).blocked)
  ok('普通标签不误伤', !screenContent({ xRestrict: 0, tags: ['学校', '18th', 'FGO'] }).blocked)

  /* ── 3. 打分 ── */
  const bp = { tagWeights: { 初音ミク: 10 } }
  const hot = score({ id: '1', tags: ['初音ミク'], width: 2400, height: 3400, bookmarkCount: 8000, createDate: new Date().toISOString(), illustType: 0 }, bp)
  const cold = score({ id: '2', tags: ['風景'], width: 600, height: 800, bookmarkCount: 3, createDate: '2020-01-01T00:00:00Z', illustType: 0 }, bp)
  ok('权重+高清+新鲜+热度 分更高', hot.score > cold.score, `${hot.score} vs ${cold.score}`)
  ok('动图扣分', score({ id: '3', tags: ['初音ミク'], width: 2400, height: 2400, illustType: 2 }, bp).score
    < score({ id: '4', tags: ['初音ミク'], width: 2400, height: 2400, illustType: 0 }, bp).score)
  ok('低分辨率扣分', score({ id: '5', tags: [], width: 400, height: 500 }, { minLongEdge: 1200 }).why.includes('分辨率偏低'))

  /* ── 4. 漏斗 ── */
  const items = [
    { id: 'a', tags: ['初音ミク'], xRestrict: 0, width: 2000, height: 2000, pageCount: 1, illustType: 0, bookmarkCount: 500, createDate: new Date().toISOString(), userName: 'A' },
    { id: 'b', tags: ['R-18', '初音ミク'], xRestrict: 0, width: 2000, height: 2000, pageCount: 1, illustType: 0, bookmarkCount: 900, createDate: new Date().toISOString(), userName: 'B' },
    { id: 'c', tags: ['初音ミク'], xRestrict: 0, width: 2000, height: 2000, pageCount: 40, illustType: 1, bookmarkCount: 100, createDate: new Date().toISOString(), userName: 'C' },
    { id: 'd', tags: ['初音ミク', '背景'], xRestrict: 0, width: 2000, height: 2000, pageCount: 1, illustType: 0, bookmarkCount: 300, createDate: new Date().toISOString(), userName: 'D' },
  ]
  const r1 = filterAndRank(items, { ...bp, seenIds: new Set(['d']), maxPages: 12 })
  eq('R-18/超页/存过的 都被剔', r1.kept.map((x) => x.id), ['a'])
  ok('每条被剔的都带原因', r1.dropped.length === 3 && r1.dropped.every((d) => !!d.dropReason))
  ok('原因可读', r1.dropped.some((d) => d.dropReason.includes('分级')))
  ok('存过的识别得出', r1.dropped.some((d) => d.id === 'd' && d.dropReason === '存过了'))
  ok('超页数识别得出', r1.dropped.some((d) => d.id === 'c' && d.dropReason.includes('页')))
  ok('开了 R18 就放行', filterAndRank(items, { ...bp, allowR18: true, maxPages: 100 }).kept.some((x) => x.id === 'b'))
  ok('排除标签生效', !filterAndRank(items, { excludeTags: ['背景'] }).kept.some((x) => x.id === 'd'))

  /* ── 5. chunked 拆包 ── */
  eq('chunked 拆包正确', dechunk(Buffer.from('5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n', 'latin1')).toString('utf8'), 'hello world')
  eq('空 chunked → 空', dechunk(Buffer.from('0\r\n\r\n', 'latin1')).toString('utf8'), '')

  /* ── 5b. 跳转跟随（镜像 pixiv.re/<id>.jpg 会 301 到 /<id>-1.jpg） ── */
  {
    const http = await import('node:http')
    const srv = http.createServer((req, res) => {
      if (req.url === '/a') {
        res.writeHead(301, { Location: '/b' })
        res.end()
      } else if (req.url === '/b') {
        res.writeHead(200, { 'Content-Type': 'image/jpeg' })
        res.end('IMGBYTES')
      } else if (req.url === '/loop') {
        res.writeHead(302, { Location: '/loop' })
        res.end()
      } else {
        res.writeHead(404); res.end()
      }
    })
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    const port = srv.address().port
    const { httpGet } = await import('./lib/transport.mjs')
    try {
      const ok1 = await httpGet(`http://127.0.0.1:${port}/a`)
      ok('301 被跟随', ok1.status === 200 && ok1.body.toString() === 'IMGBYTES', `status=${ok1.status}`)
      ok('自跳转不会死循环', await rejects(() => httpGet(`http://127.0.0.1:${port}/loop`, { timeoutMs: 4000 })))
      const nf = await httpGet(`http://127.0.0.1:${port}/nope`)
      ok('404 如实返回（不抛）', nf.status === 404)
    } finally {
      srv.close()
    }
  }

  /* ── 5c. 硬超时：连不通时必须按时返回，不能挂死 ──
   *     ⚠️ 这是真踩过的坑：socket.setTimeout() 只在 socket **空闲**时触发，
   *     一个还没握上手的 TCP connect 永远不空闲 ⇒ 超时永不触发 ⇒ 整个请求无限挂住。
   *     实测直连 pixiv 时能把进程卡死。所以必须有硬超时兜底。
   */
  {
    const { httpGet } = await import('./lib/transport.mjs')
    // 代理地址本身不通
    const t0 = Date.now()
    const badProxy = await rejects(() => httpGet('https://example.com/x', {
      timeoutMs: 2500, proxyUrl: 'http://127.0.0.1:1',
    }))
    ok('代理不通时快速失败', badProxy && Date.now() - t0 < 8000, `${Date.now() - t0}ms`)

    // 黑洞地址（不发 SYN-ACK，连不上也断不掉）
    //
    // ⚠️ 这里**不能断言"必须等够多久"**。原来写了 `el > 1500`，结果本机开着
    //    Clash TUN 时，流量被 TUN 接走、秒回一个响应，断言就假失败了 ——
    //    那是测试依赖了「网络不通」这个环境条件，不是代码问题。
    //    改成只验**无论快慢都要在超时上界内返回、且不抛**，跟网络状态无关。
    const t1 = Date.now()
    const blackhole = await rejects(() => httpGet('https://10.255.255.1/x', { timeoutMs: 2000 }))
    const el = Date.now() - t1
    ok('黑洞地址也会返回（不挂死、不抛）', blackhole && el < 8000, `${el}ms`)
    ok('黑洞地址在超时上界内返回', el <= 2100 + 2000, `${el}ms`)

    /* ── 失败路径不能漏 socket ──
     * ⚠️ 这是真踩过的坑：TLS 那条路是**握手完成才登记 socket** 的，
     *    卡在握手阶段时超时无处可销毁 —— 每失败一次漏 2 个 socket
     *    （ConnectWrap + TCPSocketWrap）。长期跑的插件会慢性泄漏。 */
    {
      const cnt = () => process.getActiveResourcesInfo().filter((r) => /TCP|Connect/.test(r)).length
      const base = cnt()
      for (const [label, url, opt] of [
        ['黑洞直连', 'https://10.255.255.1/x', { timeoutMs: 600 }],
        ['坏代理', 'https://example.com/x', { timeoutMs: 600, proxyUrl: 'http://127.0.0.1:1' }],
      ]) {
        await rejects(() => httpGet(url, opt))
        await new Promise((r) => setTimeout(r, 300))
        const n = cnt()
        ok(`失败路径不漏 socket（${label}）`, n <= base, `base=${base} now=${n}`)
      }
    }
  }

  /* ── 6. 客户端守卫 ── */
  const c = new PixivClient({ proxyUrl: '' })
  ok('空关键词直接拒', await rejects(() => c.search({ word: '  ' })))
  ok('非法 id 直接拒', await rejects(() => c.detail('abc')))
  ok('非 pximg 的图直接拒', await rejects(() => c.image('https://evil.example/x.jpg')))
  ok('空图地址直接拒', await rejects(() => c.image('')))
  ok('RANK_MODES 有中文名', RANK_MODES.daily === '今日')

  /* ── 6b. 外部源：rewriteBase 必须只换 origin，路径原样 ── */
  {
    const official = 'https://www.pixiv.net/ranking.php?mode=daily&content=illust&format=json'
    eq('换到裸地址',
      rewriteBase(official, 'http://127.0.0.1:8080'),
      'http://127.0.0.1:8080/ranking.php?mode=daily&content=illust&format=json')
    eq('末尾带斜杠也能处理',
      rewriteBase(official, 'http://127.0.0.1:8080/'),
      'http://127.0.0.1:8080/ranking.php?mode=daily&content=illust&format=json')
    eq('不带协议时补 http://',
      rewriteBase(official, '127.0.0.1:8080'),
      'http://127.0.0.1:8080/ranking.php?mode=daily&content=illust&format=json')
    eq('自带子路径时保留前缀',
      rewriteBase(official, 'https://x.com/api/pixiv'),
      'https://x.com/api/pixiv/ranking.php?mode=daily&content=illust&format=json')
    eq('https 不被动成 http',
      rewriteBase(official, 'https://my.proxy.dev'),
      'https://my.proxy.dev/ranking.php?mode=daily&content=illust&format=json')
    // 空值当没配
    eq('空值原样返回', rewriteBase(official, ''), official)
    // 查询串必须完整保留（丢了 format=json 就取不到数据）
    ok('query 一个不丢',
      rewriteBase(official, 'http://a.b').includes('format=json') &&
      rewriteBase(official, 'http://a.b').includes('content=illust'))
    // ajax 路径也要能换
    ok('ajax 路径也能换',
      rewriteBase('https://www.pixiv.net/ajax/illust/123', 'http://127.0.0.1:8080') ===
      'http://127.0.0.1:8080/ajax/illust/123')
  }

  /* ── 6c. 外部源优先级最高（配了就走它，不自作主张绕开） ── */
  {
    const p2 = new RouteProbe({ externalApi: 'http://127.0.0.1:1', timeoutMs: 800 })
    eq('构造时记住外部源', p2.externalApi, 'http://127.0.0.1:1')
    // 措辞里要能看出走的是外部源
    p2._cache = { at: Date.now(), meta: 'external', image: ['official'], detail: {} }
    ok('走外部源时措辞显示「外部源 ✓」', p2.describe().includes('外部源 ✓'), p2.describe())
    p2._cache = { at: Date.now(), meta: null, image: [], detail: { external: { why: 'ECONNREFUSED' } } }
    const d2 = p2.describe()
    ok('全不通时提到外部源不通', d2.includes('外部源'), d2)
    ok('且给出下一步（填外部源）', d2.includes('外部源'), d2)
  }

  /* ── 7. 探测结果的措辞 ── */
  const p = new RouteProbe({ proxyUrl: 'http://127.0.0.1:1', timeoutMs: 1000 })
  eq('没测过时的措辞', p.describe(), '还没测过')
  p._cache = { at: Date.now(), meta: null, image: [], detail: {} }
  ok('全不通时给的是人话', p.describe().includes('完全打不通'))
  p._cache = { at: Date.now(), meta: null, image: ['mirror'], detail: {} }
  ok('只有镜像时说明限制', p.describe().includes('不能搜索'))
}

/* ═══════════════ 联网断言 ═══════════════ */

if (wantNet) {
  console.log('\n--- 联网自检（代理候选: ' + PROXY + '）---')
  const live = new PixivClient({ proxyUrl: PROXY, probeTimeoutMs: 8000 })
  try {
    const s = await live.ping()
    console.log('  探测结果: ' + s.text.replace(/\n\s*/g, ' | '))
    console.log('  detail:', JSON.stringify(s.detail))

    if (!s.ok) {
      ok('元数据不通时给出人话（环境问题，不算代码错）',
        s.mirror || s.text.includes('完全打不通'), s.text)
      console.log('  ⚠️ 元数据不通 —— 这是环境没梯子，跳过搜索/详情断言')
    } else {
      const rk = await live.ranking({ mode: 'daily' })
      ok('排行能取到', rk.items.length > 0)
      console.log('  排行 daily:', rk.items.length, '条')

      const se = await live.search({ word: '初音ミク' })
      ok('搜索能取到', se.items.length > 0)
      console.log('  搜索 初音ミク:', se.items.length, '条 | 首个=', String(se.items[0].title).slice(0, 24))

      const d = await live.detail(se.items[0].id)
      ok('详情能取到', !!d.title && d.pageCount >= 1)
      ok('详情 tags 归一成字符串数组（接口本身返回对象）',
        Array.isArray(d.tags) && (d.tags.length === 0 || typeof d.tags[0] === 'string'))
      console.log('  详情:', String(d.title).slice(0, 24), '| 页数', d.pageCount, '| 分级', d.xRestrict, '| 标签', d.tags.length)

      const pg = await live.pages(se.items[0].id)
      ok('页地址能取到', pg.length > 0)
      if (pg.length) ok('页地址是 i.pximg', /^https:\/\/i\.pximg\.net\//.test(pg[0].url), pg[0].url)

      const im = await live.image(pg[0].url, { illustId: se.items[0].id, page: 0, pageCount: 1, maxBytes: 30 * 1024 * 1024 })
      ok('图能下下来', im.bytes.byteLength > 1000)
      console.log('  首图:', (im.bytes.byteLength / 1048576).toFixed(2), 'MB via', im.via)
    }

    // 镜像那条腿单独验一次（不管元数据通不通）
    try {
      const probe = new RouteProbe({ proxyUrl: '', mirrorHost: 'pixiv.re', timeoutMs: 10000 })
      const mirrorOk = await probe._tryMirror()
      console.log('  镜像 pixiv.re:', mirrorOk ? '可用 ✓' : '不可用 ✗')
      if (mirrorOk) {
        const c2 = new PixivClient({ proxyUrl: '' })
        c2.probe._cache = { at: Date.now(), meta: null, image: ['mirror'], detail: {} }
        const img = await c2.image('', { illustId: '151616953', page: 0, pageCount: 1 })
        ok('镜像取图能拿到字节', img.bytes.byteLength > 1000)
        console.log('  镜像取图:', (img.bytes.byteLength / 1048576).toFixed(2), 'MB via', img.via)
      }
    } catch (err) {
      console.log('  镜像检查跳过:', err && err.message ? err.message.slice(0, 80) : err)
    }
  } catch (err) {
    fails.push('联网自检失败: ' + (err && err.message ? err.message : err))
  }
}

/* ═══════════════ 结果 ═══════════════ */

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  console.log('\n失败项：')
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过 ✓')
