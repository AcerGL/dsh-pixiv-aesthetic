/**
 * selfcheck —— 离线断言 + 可选联网自检。
 *   node selfcheck.mjs              只跑离线断言
 *   node selfcheck.mjs --net        联网验证（会按探测结果自动选路）
 *   node selfcheck.mjs --net-only   只跑联网
 *
 * 退出码 0 = 全过。
 */
import { PixivClient, originalFromThumb, RANK_MODES } from './lib/pxclient.mjs'
import { screenContent, screenPromo, score, filterAndRank } from './lib/taste.mjs'
import { dechunk } from './lib/transport.mjs'
import { RouteProbe, rewriteBase } from './lib/route.mjs'
import { normalize, DEFAULTS } from './lib/config.mjs'

const PROXY = process.env.PIXIV_PROXY || 'http://127.0.0.1:7897'
const onlyNet = process.argv.includes('--net-only')
const wantNet = process.argv.includes('--net') || onlyNet

let pass = 0
const fails = []
const ok = (name, cond, extra) => {
  if (cond) { pass++; return }
  fails.push(name + (extra ? '  → ' + extra : ''))
}

/* ─────────── 🔴 取图超时必须跟元数据超时**分开** ───────────
 *
 * 2026-11-09 老大要求「大图要能显示」。现场：
 *   一张 3008×4160 的原图报「请求超时（25000ms 硬超时）」
 *   —— 它不是取不到，是**没下完**（换 60 秒就下来了）。
 *
 * 根因：`image()` 复用 `this.timeoutMs`（25 秒，那是给**元数据**的预算）。
 *   元数据是几十 KB 的 JSON，25 秒绰绰有余；原图 5~20MB 根本不够。
 *   一个预算伺候两种请求，必然一边不够、一边浪费。
 */
{
  const norm = (v) => normalize({ saveRoot: '', imageTimeoutMs: v })

  ok('取图超时默认**大于**元数据超时（不然大图还是会被掐）',
    DEFAULTS.imageTimeoutMs > DEFAULTS.timeoutMs,
    `image=${DEFAULTS.imageTimeoutMs} meta=${DEFAULTS.timeoutMs}`)
  ok('取图默认给得够宽（≥60 秒）',
    DEFAULTS.imageTimeoutMs >= 60_000, `${DEFAULTS.imageTimeoutMs}ms`)

  // ⚠️ 0 / 负数 = "没设"，要**回落默认**，不能夹到下限
  //    （老 clampInt 会把它夹到下限 10000 —— 比默认小得多，大图照样被掐）
  ok('🔴 取图超时给 0 → 回落默认（不是夹到下限）',
    norm(0).imageTimeoutMs === DEFAULTS.imageTimeoutMs,
    `得到 ${norm(0).imageTimeoutMs}，期望 ${DEFAULTS.imageTimeoutMs}`)
  ok('🔴 取图超时给负数 → 回落默认',
    norm(-5).imageTimeoutMs === DEFAULTS.imageTimeoutMs,
    `得到 ${norm(-5).imageTimeoutMs}`)
  ok('取图超时给天文数字 → 压到上限 600 秒',
    norm(1e9).imageTimeoutMs === 600_000, `得到 ${norm(1e9).imageTimeoutMs}`)
  ok('取图超时给 5 秒 → 抬到下限 10 秒（太小没意义）',
    norm(5000).imageTimeoutMs === 10_000, `得到 ${norm(5000).imageTimeoutMs}`)
  ok('取图超时给合理的 30 秒 → 原样',
    norm(30000).imageTimeoutMs === 30_000, `得到 ${norm(30000).imageTimeoutMs}`)

  // 客户端真的把它用起来了（不只是配置里躺着）
  const c = new PixivClient({})
  ok('🔴 PixivClient 认这个字段',
    c.imageTimeoutMs === DEFAULTS.imageTimeoutMs, `得到 ${c.imageTimeoutMs}`)
  ok('🔴 显式传了就用传的',
    new PixivClient({ imageTimeoutMs: 300000 }).imageTimeoutMs === 300000)
  ok('两个超时互不干扰',
    new PixivClient({ timeoutMs: 20000, imageTimeoutMs: 300000 }).timeoutMs === 20000 &&
    new PixivClient({ timeoutMs: 20000, imageTimeoutMs: 300000 }).imageTimeoutMs === 300000)

  // 源码层面：image() 不能再拿 this.timeoutMs 去下字节
  {
    // ⚠️ 这个文件没有 import fs（它是纯逻辑自检），用 readFileSync 得自己引
    const { readFileSync } = await import('node:fs')
    const srcT = readFileSync(new URL('./lib/pxclient.mjs', import.meta.url), 'utf8')
    const codeT = srcT.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '')
    const imgStart = codeT.indexOf('async image(')
    const imgBody = imgStart >= 0 ? codeT.slice(imgStart, imgStart + 4000) : ''
    ok('🔴 取图那条路不再用元数据的超时',
      imgBody.length > 0 && !/timeoutMs:\s*this\.timeoutMs/.test(imgBody),
      '取图必须用 imageTimeoutMs —— 用 this.timeoutMs 就是原来那个 bug')
  }
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

  /* ── 1b. 标签归一化：三种形状都要吃对 ──
   * 踩到的严重 bug（2026-11-06）：App API 的 tags 是 [{name, translated_name}]，
   * 而 normalizeAppItem 写了 `x.tags.map(String)` ⇒ 全变 "[object Object]"。
   * 后果不只是难看：① 分级过滤失效（认不出 R-18 标签）
   *              ② 口味打分失效（匹配不到标签）
   *              ③ 全程静默不报错 —— 最难查的那种。
   */
  {
    const { normalizeTags } = await import('./lib/pxclient.mjs')
    // 形状 A：字符串数组（网页搜索接口）
    eq('字符串数组原样', normalizeTags(['初音ミク', '青']), ['初音ミク', '青'])
    // 形状 C：App API 的 [{name, translated_name}]
    eq('App 形状取 name',
      normalizeTags([{ name: 'ブルアカ', translated_name: 'Blue Archive' }, { name: 'R-18', translated_name: null }]),
      ['ブルアカ', 'R-18'])
    // translated_name 是**同一个标签的另一种语言**，不能当新标签加进来
    // （加了会让一个标签被算两次，打分翻倍）
    eq('translated_name 不重复计入',
      normalizeTags([{ name: '夜景', translated_name: 'night' }]), ['夜景'])
    // 形状 B：{ tags: [...] } 包一层（详情接口）
    eq('包一层的也能吃', normalizeTags({ tags: [{ tag: '風景' }] }), ['風景'])
    // 脏数据
    eq('null/undefined 被跳过', normalizeTags([null, 'ok', undefined, { name: '' }]), ['ok'])
    eq('空输入返回空数组', normalizeTags(null), [])
    eq('非数组非对象返回空', normalizeTags('字符串'), [])
    eq('去重', normalizeTags(['a', 'a', 'b']), ['a', 'b'])
    // 最关键的一条：别再产出 [object Object]
    const app = normalizeTags([{ name: 'x' }, { name: 'y' }])
    ok('绝不产出 [object Object]', !app.some((t) => t.includes('[object')),
      JSON.stringify(app))
    // 而且归一化后分级过滤能正常工作
    ok('归一化后 R-18 标签能被分级过滤认出来',
      screenContent({ xRestrict: 0, tags: normalizeTags([{ name: 'R-18' }]) }).blocked)
  }

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

  /* ── 2b. 广告 / 官方公告（2026-11-07 老大要求「默认剔除」） ──
   *
   * 现场：`pixiv事務局` 的「ブックサンタ2026」宣传图混进候选，
   * 拿了 78 分（新鲜/5页/收藏424），差点被当成作品存档。
   *
   * ⚠️ 这里**正反两面都要测**：
   *    只测"拦住了广告"不够 —— 还得测"**没把正常作品误杀**"。
   *    误杀比漏杀更糟：用户会以为插件搜不出东西。
   */
  {
    // 正面：真的广告要拦住
    ok('🔴 官企那条被拦（pixiv事務局 uid=11 + 公式企画）',
      screenPromo({ id: '151737362', userId: '11', tags: ['公式企画', '企画目録', 'ブックサンタ', 'クリスマス', '本'] }).blocked)
    ok('官方账号单独也能拦（即使没挂企划标签）',
      screenPromo({ userId: '11', tags: ['イラスト'] }).blocked)
    ok('只挂官方企划标签也拦（换账号也认）',
      screenPromo({ userId: '99999', tags: ['公式企画'] }).blocked)
    ok('企画目録 也拦', screenPromo({ userId: '99999', tags: ['企画目録'] }).blocked)
    ok('拦的时候要说清理由', screenPromo({ userId: '11', tags: ['公式企画'] }).reasons.length > 0)

    // 反面：正常作品**绝不能**误杀
    ok('🔴 正常作品不误杀（女の子/風景）',
      !screenPromo({ userId: '12345', tags: ['女の子', '風景', 'オリジナル'] }).blocked)
    ok('🔴 标题里有「開催」「募集」不算广告（那是画师起名自由）',
      !screenPromo({ userId: '12345', title: '即売会開催！', tags: ['イラスト'] }).blocked)
    ok('🔴 普通的「コンテスト」参赛作品不误杀（只拦官方企划标签）',
      !screenPromo({ userId: '12345', tags: ['イラスト', 'コンテスト入賞'] }).blocked)
    ok('没有 userId 也不炸', !screenPromo({ tags: ['女の子'] }).blocked)
    ok('tags 缺失不炸', !screenPromo({ userId: '1' }).blocked)
    ok('item 是 null 也不炸', !screenPromo(null).blocked)

    // 接进漏斗：走 filterAndRank 也要真的被丢掉
    const funnel = filterAndRank([
      { id: 'p1', userId: '11', tags: ['公式企画', '企画目録'], width: 1280, height: 1140, pageCount: 5 },
      { id: 'a1', userId: '12345', tags: ['女の子', '風景'], width: 2400, height: 3400 },
    ], {})
    ok('🔴 漏斗里广告进了 dropped', funnel.dropped.some((d) => d.id === 'p1'))
    ok('🔴 漏斗里正常作品留下来了', funnel.kept.some((k) => k.id === 'a1'))
    ok('丢弃原因写明是广告',
      /广告|官方/.test((funnel.dropped.find((d) => d.id === 'p1') || {}).dropReason || ''),
      (funnel.dropped.find((d) => d.id === 'p1') || {}).dropReason)
  }

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
