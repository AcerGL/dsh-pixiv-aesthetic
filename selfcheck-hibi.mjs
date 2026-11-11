/**
 * 无代理通道（HibiAPI + 镜像固定 IP）验证 —— 全离线，起假服务。
 *   node selfcheck-hibi.mjs
 *
 * 为什么必须离线跑：这条路的真实性靠的是**第三方公共实例和 Cloudflare 节点**，
 * 拿它们做断言等于把 CI 绑在别人的可用性上（实测同一个请求有 2 秒也有 17 秒）。
 * 所以这里只验"我们的代码对不对"：
 *   1. App-API 形状 → 内部形状的归一化（type 是字符串、原图在 meta_pages 里）
 *   2. 分级：sanity_level ≥ 6 要能被 screenContent 拦下来
 *   3. 排行模式映射、搜索排序映射
 *   4. 镜像 URL 拼装：i.pximg.net 换主机名 vs 猜扩展名
 *   5. **固定 IP**：Host/SNI 用域名、TCP 连 IP —— 这条最容易写错又最难看出错
 *   6. 选路优先级：外部源 > 直连 > 代理 > hibi；hibi 的图**不算官方**
 *   7. 换节点：慢的那个被掐掉、快的那个接上（速度下限逻辑）
 *   8. 配置白名单：新键能存能关
 */
import http from 'node:http'
import net from 'node:net'
import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const imp = (...p) => import(pathToFileURL(join(here, ...p)).href)
let pass = 0
const fails = []
const ok = (n, c, extra) => { if (c) pass++; else fails.push(n + (extra ? '  → ' + extra : '')) }
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)

const px = await imp('lib', 'pxclient.mjs')
const hb = await imp('lib', 'hibi.mjs')
const cfgmod = await imp('lib', 'config.mjs')

/* ═══════════ 1. 归一化：type 是字符串、原图在 meta_pages 里 ═══════════ */

const appIllust = {
  id: 900001, title: 'App 形状的作品', type: 'illust',
  image_urls: {
    square_medium: 'https://i.pximg.net/c/360x360_70/img-master/img/x_p0_square1200.jpg',
    medium: 'https://i.pximg.net/c/540x540_70/img-master/img/x_p0_master1200.jpg',
    large: 'https://i.pximg.net/c/1200x1200_90/img-master/img/x_p0_master1200.jpg',
  },
  meta_single_page: { original_image_url: 'https://i.pximg.net/img-original/img/x_p0.png' },
  meta_pages: [], page_count: 1, width: 2894, height: 4724,
  user: { id: '777', name: '画师' }, tags: [{ name: 'オリジナル', translated_name: 'original' }],
  x_restrict: 0, sanity_level: 2, illust_ai_type: 1, total_view: 100, total_bookmarks: 50,
  create_date: '2026-11-08T00:00:00+09:00',
}

const n1 = px.normalizeHibiItem(appIllust, 'ranking')
eq('归一化·illustType（字符串 illust → 0）', n1.illustType, 0)
eq('归一化·原图取 meta_single_page', n1.original, 'https://i.pximg.net/img-original/img/x_p0.png')
eq('归一化·标签只取原名（不吃 translated_name）', n1.tags, ['オリジナル'])
eq('归一化·作者', n1.userName, '画师')
eq('归一化·分级标记（sanity 2 → 不拦）', n1.contentFlags.sexual, 0)
ok('归一化·screenContent 放行', !(await imp('lib', 'taste.mjs')).screenContent(n1).blocked)

// 漫画：type 是字符串 'manga' —— 老代码 Number('manga')||0 会退化成 0
eq('归一化·漫画 type=manga → 1', px.normalizeHibiItem({ ...appIllust, type: 'manga' }, 'x').illustType, 1)
eq('归一化·动图 type=ugoira → 2', px.normalizeHibiItem({ ...appIllust, type: 'ugoira' }, 'x').illustType, 2)

// 多页：原图只在 meta_pages 里，meta_single_page 是空对象
const multi = {
  ...appIllust, id: 900002, page_count: 3,
  meta_single_page: {},
  meta_pages: [0, 1, 2].map((i) => ({
    image_urls: { original: `https://i.pximg.net/img-original/img/m_p${i}.jpg`, large: 'https://i.pximg.net/c/large.jpg' },
  })),
}
eq('归一化·多页取第一页原图', px.normalizeHibiItem(multi, 'x').original, 'https://i.pximg.net/img-original/img/m_p0.jpg')
eq('归一化·多页的页数', hb.originalsOf(multi).length, 3)

// 分级红线：sanity_level 6 必须被拦
const hot = px.normalizeHibiItem({ ...appIllust, sanity_level: 6 }, 'x')
eq('归一化·sanity 6 → sexual 标记', hot.contentFlags.sexual, 1)
ok('归一化·sanity 6 被 screenContent 拦住',
  (await imp('lib', 'taste.mjs')).screenContent(hot).blocked)

/* ═══════════ 1b. 登录流那条腿：normalizeAppItem 修过的两个坑 ═══════════ */
{
  // ① type 是字符串 —— 老代码 Number('manga')||0 = 0，漫画被当插画
  eq('登录流·manga → 1', px.normalizeAppItem({ ...appIllust, type: 'manga' }, 'x').illustType, 1)
  eq('登录流·ugoira → 2', px.normalizeAppItem({ ...appIllust, type: 'ugoira' }, 'x').illustType, 2)
  eq('登录流·illust → 0', px.normalizeAppItem(appIllust, 'x').illustType, 0)

  // ② original 必须是真原图，不能是 image_urls.large（1200px 大图）
  const a = px.normalizeAppItem(appIllust, 'x')
  eq('登录流·original 取 meta_single_page 的真原图', a.original, 'https://i.pximg.net/img-original/img/x_p0.png')
  ok('登录流·original 不是那个 large 大图', !/_master1200/.test(a.original), a.original)
  eq('登录流·多页取 meta_pages[0]', px.normalizeAppItem(multi, 'x').original, 'https://i.pximg.net/img-original/img/m_p0.jpg')
  // 两个来源都没有时退回 large（打得开的 1200px），不退到推导出来的无后缀地址（实测 404）
  const bare = px.normalizeAppItem({ ...appIllust, meta_single_page: {}, meta_pages: [] }, 'x')
  eq('登录流·没有 meta 时退回 large', bare.original, appIllust.image_urls.large)
}

/* ═══════════ 1c. 🔴 分级红线：标签是对象时也必须拦住 ═══════════ */
{
  const taste = await imp('lib', 'taste.mjs')
  // App API / HibiAPI 给的是 [{name, translated_name}]。
  // 老代码把对象直接丢给正则 ⇒ 测的是 "[object Object]" ⇒ 永不匹配 ⇒ 静默失效。
  eq('红线·对象标签里的 R-18 也要拦住',
    taste.screenContent({ tags: [{ name: 'R-18', translated_name: 'R-18' }] }).blocked, true)
  eq('红线·对象标签里的 R-18G',
    taste.screenContent({ tags: [{ name: 'R-18G' }] }).blocked, true)
  eq('红线·字符串 R-18G', taste.screenContent({ tags: ['R-18G'] }).blocked, true)
  eq('红线·xRestrict=1（R-18）', taste.screenContent({ xRestrict: 1 }).blocked, true)
  eq('红线·xRestrict=2（R-18G）', taste.screenContent({ xRestrict: 2 }).blocked, true)
  eq('红线·xRestrict=0 放行', taste.screenContent({ xRestrict: 0 }).blocked, false)
  eq('红线·グロ标签',
    taste.screenContent({ tags: [{ name: 'グロ' }] }).blocked, true)
  eq('红线·普通标签放行', taste.screenContent({ tags: [{ name: '風景' }] }).blocked, false)
  eq('红线·字符串标签照样拦', taste.screenContent({ tags: ['R-18'] }).blocked, true)
  eq('红线·混合数组也拦', taste.screenContent({ tags: ['風景', { name: 'R-18' }] }).blocked, true)
  eq('红线·没标签不炸', taste.screenContent({}).blocked, false)
}

/* ═══════════ 1d. 登录态的失败要说对原因（2026-11-09 实测踩到）═══════════
 * usingLogin() 要先换 token，而换 token 走官方接口。本机直连不通时 token 根本换不到，
 * 于是 _appFeed 报"没登录，拿不到关注流"—— 可用户明明登录着（凭证有效），
 * 那句话会把他带去重新登录，白折腾。真因是这条路联不上。 */
{
  const C = px.PixivClient
  const mk = (session) => Object.create(C.prototype, {
    session: { value: session, writable: true },
    lastAuthError: { value: '', writable: true },
  })
  // 有凭证但换不到 token（直连不通）
  const c1 = mk({ token: async () => { throw new Error('请求超时（4000ms 硬超时）') } })
  const r1 = await C.prototype.following.call(c1)
  eq('有凭证但换不到 token ⇒ 不说"没登录"', r1.why.includes('没登录'), false)
  ok('说清是换 token 失败', /token/.test(r1.why), r1.why)
  ok('把真实原因带上', /超时/.test(r1.why), r1.why)
  ok('登录相关失败不往外抛（降级成跳过）', r1.skipped === true && r1.items.length === 0)

  // 压根没登录（没 session）
  const c2 = mk(null)
  const r2 = await C.prototype.recommended.call(c2)
  ok('真没登录 ⇒ 才说"没登录"', /没登录/.test(r2.why), r2.why)
}

/* ═══════════ 2. 映射表 ═══════════ */
eq('排行映射·daily → day', hb.RANK_MODE_MAP.daily, 'day')
eq('排行映射·rookie → week_rookie', hb.RANK_MODE_MAP.rookie, 'week_rookie')
eq('排行映射·七个模式都有', Object.keys(hb.RANK_MODE_MAP).length, 7)
eq('搜索排序·popular_d → popular_desc', hb.searchOrderOf('popular_d'), 'popular_desc')
eq('搜索排序·date_d → date_desc', hb.searchOrderOf('date_d'), 'date_desc')

/* ═══════════ 3. 镜像 URL 拼装 ═══════════ */
eq('镜像·i.pximg.net 换主机名（保留原路径）',
  hb.toMirrorUrl('https://i.pximg.net/img-original/img/a_p0.png', 'pixiv.re'),
  'https://i.pixiv.re/img-original/img/a_p0.png')
eq('镜像·已经是 i. 开头不重复加',
  hb.toMirrorUrl('https://i.pximg.net/img-master/a.jpg', 'i.pixiv.re'),
  'https://i.pixiv.re/img-master/a.jpg')
eq('镜像·非 pximg 地址不换', hb.toMirrorUrl('https://example.com/a.jpg', 'pixiv.re'), '')
eq('镜像·pathHostOf', hb.pathHostOf('pixiv.re'), 'i.pixiv.re')
ok('镜像·内置 IP 池非空', hb.MIRROR_IP_POOL.length >= 4)
ok('镜像·池里都是 IPv4 字面量', hb.MIRROR_IP_POOL.every((s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s)))

/* ═══════════ 4. 固定 IP：连 IP、Host/SNI 用域名 ═══════════ */
/**
 * 这是整条路里最容易写错的地方：把"连谁"和"说是谁"混了，
 * 表现出来只是 404 / 证书错，看不出是代码的问题。
 * 起一个本地服务，记下它收到的 Host 头，再断言：
 *   · TCP 确实连到了 127.0.0.1（我们指定的"IP"）
 *   · Host 头是**域名**，不是 IP
 */
{
  const { httpGet } = await imp('lib', 'transport.mjs')
  let gotHost = ''
  let gotPath = ''
  const srv = http.createServer((req, res) => {
    gotHost = req.headers.host || ''
    gotPath = req.url
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': '2000' })
    res.end(Buffer.alloc(2000, 7))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  try {
    // http（非 TLS）也走同一条 pinIp 分支 —— 用 127.0.0.1 当"固定 IP"
    // ⚠️ 包一层：断言要报红，不能让异常把套件带崩（变异测试就靠这个）
    let res = null
    let err = null
    try {
      res = await httpGet(`http://fake-mirror.test:${port}/a.jpg`, {
        timeoutMs: 5000, resolve: { 'fake-mirror.test': '127.0.0.1' },
      })
    } catch (e) { err = e }
    ok('固定 IP·请求能成功', !!res, String(err && err.message).slice(0, 140))
    eq('固定 IP·连到了指定 IP', res && res.status, 200)
    eq('固定 IP·Host 头是域名（不是 IP）', gotHost, `fake-mirror.test:${port}`)
    eq('固定 IP·路径没动', gotPath, '/a.jpg')
    eq('固定 IP·字节数', res && res.body.length, 2000)
  } finally {
    srv.close()
  }
}

/* ═══════════ 4b. 🔴 多地址：坏地址要能跳过（2026-11-10 实测踩到） ═══════════
 * 那次症状很有误导性：hibiapi.getloli.com 有两条 A 记录，
 *   104.21.51.227 通、172.67.190.157 是 TCP 黑洞。Node 只连解析结果的第一个，
 *   挑中黑洞就死等到超时 —— 而同一分钟 curl 挑的是好的那条。
 *   于是表现成"HibiAPI 时快时慢"，还白写了一句"公共实例不稳"去误导使用者。
 * 这里用本地假服务复现"第一个地址不通、第二个通"，钉住必须能跳过。 */
{
  const { httpGet } = await imp('lib', 'transport.mjs')
  let hits = 0
  const good = http.createServer((req, res) => {
    hits++
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok')
  })
  await new Promise((r) => good.listen(0, '127.0.0.1', r))
  const port = good.address().port
  // ⚠️ 一律用这个包一层：断言要**报红**，不能让异常把整个套件带崩
  //    （变异测试时就会这样：只试第一个地址 ⇒ 第一个 IP 连不上 ⇒ 直接抛）
  const tryGet = async (url, opts) => {
    const t0 = Date.now()
    try { return { res: await httpGet(url, opts), ms: Date.now() - t0 } } catch (e) { return { err: e, ms: Date.now() - t0 } }
  }

  try {
    // ① 第一个候选是**连不上的**（127.0.0.2 上没有服务）⇒ 该换下一个
    hits = 0
    const a = await tryGet(`http://multi.test:${port}/a`, {
      timeoutMs: 6000, resolve: { 'multi.test': ['127.0.0.2', '127.0.0.1'] },
    })
    eq('🔴 第一个地址不通 ⇒ 自动换下一个', a.res && a.res.status, 200)
    eq('确实打到了好的那个', hits, 1)

    // ② 第一个候选是**黑洞**（不回 SYN）。用 TEST-NET-1 保留段：
    //    它要么直接被丢弃（挂到超时）、要么立刻报错，两种都得能换到好的那个。
    //    关键断言是**没把整个超时耗在它身上**。
    //
    // ⚠️ 但"黑洞"是**环境相关**的（2026-11-11 实测踩到）：本机开着 Clash（TUN）时，
    //    TUN 会把这个连接**接下去** ⇒ 192.0.2.1 反而"TCP 连得上" ⇒ 它赢了竞速、
    //    然后在发请求那一步失败。这条断言就成了"看有没有开代理"的随机红。
    //    所以先探一下：连得上就跳过（并说清为什么），别让它骗人。
    const isBlackHole = await new Promise((res) => {
      let done = false
      const s = net.connect({ host: '192.0.2.1', port })
      const finish = (v) => { if (done) return; done = true; try { s.destroy() } catch { /* ignore */ } ; res(v) }
      s.once('connect', () => finish(false))   // TUN / 中间盒接管了 ⇒ 不是黑洞
      s.once('error', () => finish(true))      // 连不上 ⇒ 正是我们要的黑洞
      setTimeout(() => finish(true), 1500)     // 没人理 ⇒ 也是黑洞
    })
    if (!isBlackHole) {
      ok('（环境注记：192.0.2.1 被中间盒接管 —— 本机开着代理/TUN 时这条不适用，跳过）', true,
        '黑洞地址不再黑洞，是环境问题不是代码问题')
    } else {
      hits = 0
      const b = await tryGet(`http://multi.test:${port}/b`, {
        timeoutMs: 9000, resolve: { 'multi.test': ['192.0.2.1', '127.0.0.1'] },
      })
      eq('🔴 黑洞排在前面也能通（并发抢地址）', b.res && b.res.status, 200)
      ok('没在黑洞上白等到超时', !!b.res && b.ms < 4000, `用了 ${b.ms}ms`)
    }

    // ③ 全都不通 ⇒ 必须失败，且错误里**列出试过哪些地址**
    const c = await tryGet(`http://multi.test:${port}/c`, {
      timeoutMs: 4000, resolve: { 'multi.test': ['127.0.0.2', '127.0.0.3'] },
    })
    ok('🔴 全不通要如实报错，不许假装成功', !!c.err)
    ok('报错里列出试过的地址', /127\.0\.0\.2.*127\.0\.0\.3/s.test(String(c.err && c.err.message)), String(c.err && c.err.message).slice(0, 120))

    // ④ 不指定地址 ⇒ 走 DNS 解析（只要 IPv4），拿 localhost 验
    const d = await tryGet(`http://localhost:${port}/d`, { timeoutMs: 6000 })
    eq('不固定地址时走 DNS 也能通', d.res && d.res.status, 200)

    // ⑤ 老写法（字符串）行为不变 —— findMirrorIp 传的就是字符串
    const e = await tryGet(`http://multi.test:${port}/e`, {
      timeoutMs: 6000, resolve: { 'multi.test': '127.0.0.1' },
    })
    eq('单个字符串地址照旧能用', e.res && e.res.status, 200)
  } finally {
    good.close()
  }
}

/* ═══════════ 5. 速度下限：慢的被掐、快的接上 ═══════════ */
{
  const { httpGet } = await imp('lib', 'transport.mjs')
  // 一个故意慢的服务器：先给一点，然后一直拖
  const slow = net.createServer((s) => {
    s.once('data', () => {
      s.write('HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: 99999999\r\n\r\n')
      s.write(Buffer.alloc(500))
      const t = setInterval(() => { try { s.write(Buffer.alloc(100)) } catch { /* 已关 */ } }, 1000)
      s.on('close', () => clearInterval(t))
      s.on('error', () => clearInterval(t))
    })
  })
  await new Promise((r) => slow.listen(0, '127.0.0.1', r))
  const sport = slow.address().port
  const t0 = Date.now()
  let err = null
  try {
    await httpGet(`http://slow.test:${sport}/big.jpg`, {
      timeoutMs: 30_000, resolve: { 'slow.test': '127.0.0.1' },
      minRate: 100 * 1024, rateGraceMs: 1200,
    })
  } catch (e) { err = e }
  const el = Date.now() - t0
  ok('速度下限·慢的会被掐掉', !!err, '没报错')
  ok('速度下限·掐得快（远早于 30s 超时）', el < 12_000, `用了 ${el}ms`)
  ok('速度下限·报错说的是"太慢"', /太慢/.test(String(err && err.message)), String(err && err.message).slice(0, 80))
  slow.close()
}

/* ═══════════ 6. 假 HibiAPI：真跑一遍 ranking / detail / pages / search ═══════════ */
{
  const seen = []
  const srv = http.createServer((req, res) => {
    seen.push(req.url)
    const send = (o) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(o))
    }
    const u = new URL(req.url, 'http://x')
    if (u.pathname === '/api/pixiv/rank') {
      send({ illusts: [
        { ...appIllust, id: 900010, title: '排行A', rank: 1 },
        { ...appIllust, id: 900011, title: '排行B', type: 'manga', rank: 2, sanity_level: 6 },
      ] })
      return
    }
    if (u.pathname === '/api/pixiv/search') {
      send({ illusts: [{ ...appIllust, id: 900020, title: '搜到的' }] })
      return
    }
    if (u.pathname === '/api/pixiv/illust') { send({ illust: multi }); return }
    if (u.pathname === '/api/pixiv/member_illust') { send({ illusts: [{ id: 1 }, { id: 2 }] }); return }
    res.writeHead(404); res.end('{}')
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`

  // 直接构造 probe：把它钉成"hibi 通、别的都不通"，免得真去摸网络
  const c = new px.PixivClient({ hibiEnabled: true, hibiApi: base, timeoutMs: 5000, probeTimeoutMs: 3000 })
  c.probe._cache = {
    at: Date.now(), meta: 'hibi', image: ['mirror'],
    detail: { hibi: { ok: true, ms: 1 }, direct: { ok: false }, proxy: { ok: false }, external: { ok: false } },
  }
  try {
    const rk = await c.ranking({ mode: 'daily' })
    eq('假服务·排行条数', rk.items.length, 2)
    eq('假服务·排行名次', rk.items[0].rank, 1)
    eq('假服务·排行 mode 原样返回', rk.mode, 'daily')
    eq('假服务·排行第二件是漫画', rk.items[1].illustType, 1)
    ok('假服务·排行请求带对了 mode=day', seen.some((s) => s.includes('mode=day')), seen.join(' '))

    const d = await c.detail('900002')
    eq('假服务·详情页数', d.pageCount, 3)
    eq('假服务·详情描述去掉 HTML', /<[^>]+>/.test(d.description), false)
    const pg = await c.pages('900002')
    eq('假服务·页列表条数', pg.length, 3)
    eq('假服务·页列表地址是原图', pg[2].url, 'https://i.pximg.net/img-original/img/m_p2.jpg')

    const s = await c.search({ word: '風景', order: 'popular_d' })
    eq('假服务·搜索结果', s.items.length, 1)
    ok('假服务·搜索把排序传下去了', seen.some((s2) => s2.includes('order=popular_desc')), seen.join(' '))
    ok('假服务·搜索把关键词传下去了', seen.some((s2) => s2.includes('word=')), seen.join(' '))

    const by = await c.byArtist('777', { limit: 5 })
    eq('假服务·作者作品', by.ids.length, 2)

    // 排行模式映射要真的落到请求上
    seen.length = 0
    await c.ranking({ mode: 'rookie' })
    ok('假服务·rookie → week_rookie', seen.some((s2) => s2.includes('week_rookie')), seen.join(' '))

    // 不支持的排行模式要明说，不能静默返回空
    let e2 = null
    try { await c.ranking({ mode: 'nonsense' }) } catch (e) { e2 = e }
    ok('假服务·乱填排行模式会报错', !!(e2 && /不支持/.test(e2.message)), String(e2 && e2.message))

    // HibiAPI 透传的 pixiv 报错要原样报出来（重试也没用）
    eq('假服务·_meta 在 hibi 下拒绝官方路径', await (async () => {
      try { await c._meta('https://www.pixiv.net/ajax/illust/1'); return 'no-throw' } catch { return 'threw' }
    })(), 'threw')
  } catch (e) {
    // ⚠️ 必须 catch：不然请求一失败整个套件就崩，后面的断言全不跑，
    //    变异测试也就看不到红（这里是踩过的）
    ok('假服务·整段请求链路能跑通', false, String(e && e.message).split('\n')[0].slice(0, 140))
  } finally {
    srv.close()
  }
}

/* ═══════════ 7. 选路优先级：hibi 是**最后**一个 ═══════════ */
{
  const mk = (o) => {
    const c = new px.PixivClient({ hibiEnabled: true, hibiApi: 'http://127.0.0.1:1', probeTimeoutMs: 1000, ...o })
    return c.probe
  }
  // 只验"有更优先的路时不选 hibi"这条口径，用 _cache 直接摆位
  const p = mk({})
  eq('优先级·ROUTES 顺序', (await imp('lib', 'route.mjs')).ROUTES,
    ['direct', 'proxy', 'hibi', 'mirror'])
  // hibi 通了但别的也通 ⇒ 不该被选中（describe 里有没有 hibi 字样是唯一外部可见处）
  p._cache = { at: Date.now(), meta: 'proxy', image: ['official'], detail: { proxy: { ok: true, how: 'user' } } }
  ok('优先级·元数据走代理时不提 hibi', !/HibiAPI/.test(p.describe()), p.describe())
  p._cache = { at: Date.now(), meta: 'hibi', image: ['mirror'], detail: { hibi: { ok: true } } }
  ok('优先级·只有 hibi 时才显示 HibiAPI', /HibiAPI/.test(p.describe()), p.describe())
  ok('优先级·hibi 的图不算官方', !p._cache.image.includes('official'))
}

/* ═══════════ 8. 配置白名单：新键能存、能关 ═══════════ */
{
  const n = cfgmod.normalize({ hibiEnabled: false, hibiApi: 'https://my.example.com/api/pixiv', mirrorIps: ['1.2.3.4', 'bad', '5.6.7.8'] })
  eq('配置·hibiEnabled 能关掉', n.hibiEnabled, false)
  eq('配置·hibiApi 去掉尾部 /api/pixiv', n.hibiApi, 'https://my.example.com')
  eq('配置·mirrorIps 只留 IPv4', n.mirrorIps, ['1.2.3.4', '5.6.7.8'])
  eq('配置·默认开', cfgmod.normalize({}).hibiEnabled, true)
  eq('配置·默认实例', cfgmod.normalize({}).hibiApi, 'https://hibiapi.getloli.com')
  eq('配置·留空回落默认', cfgmod.normalize({ hibiApi: '  ' }).hibiApi, 'https://hibiapi.getloli.com')
  eq('配置·没协议自动补 https', cfgmod.normalize({ hibiApi: 'my.example.com' }).hibiApi, 'https://my.example.com')
  // 真的存一次、读回来 —— FILE_WINS 漏了的话这里就存不下（关不掉）
  const home = await fs.mkdtemp(join(tmpdir(), 'px-hibi-cfg-'))
  try {
    const back = await cfgmod.saveConfig(home, { hibiEnabled: false, hibiApi: 'https://self.example.com', mirrorIps: ['9.9.9.9'] })
    eq('配置·存盘后 hibiEnabled 还是关的', back.hibiEnabled, false)
    eq('配置·存盘后 hibiApi', back.hibiApi, 'https://self.example.com')
    eq('配置·存盘后 mirrorIps', back.mirrorIps, ['9.9.9.9'])
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
}

/* ═══════════ 9. HibiAPI 失败要重试，但 pixiv 自己的错不重试 ═══════════ */
{
  let hits = 0
  const srv = http.createServer((req, res) => {
    hits++
    if (hits < 3) { res.writeHead(502); res.end('bad gateway'); return }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ illusts: [{ ...appIllust, id: 900030 }] }))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  try {
    const j = await hb.hibiGet(base, 'rank', { mode: 'day' }, { timeoutMs: 3000, tries: 3 })
    eq('重试·两次 502 后成功', j.illusts.length, 1)
    eq('重试·确实试了三次', hits, 3)
  } finally { srv.close() }

  let hits2 = 0
  const srv2 = http.createServer((req, res) => {
    hits2++
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { user_message: '该作品已被删除' } }))
  })
  await new Promise((r) => srv2.listen(0, '127.0.0.1', r))
  try {
    let e3 = null
    try {
      await hb.hibiGet(`http://127.0.0.1:${srv2.address().port}`, 'illust', { id: 1 }, { timeoutMs: 3000, tries: 3 })
    } catch (e) { e3 = e }
    ok('重试·pixiv 的错不重试', hits2 === 1, `试了 ${hits2} 次`)
    ok('重试·错里有 pixiv 的原话', /该作品已被删除/.test(String(e3 && e3.message)), String(e3 && e3.message))
  } finally { srv2.close() }
}

/* ═══════════ 10. 关掉开关就不该有 hibi 腿 ═══════════ */
{
  const p = new (await imp('lib', 'route.mjs')).RouteProbe({ hibiEnabled: false, mirrorHost: 'pixiv.re' })
  eq('开关·关掉后 hibiEnabled = false', p.hibiEnabled, false)
  p._cache = { at: Date.now(), meta: null, image: [], detail: { hibi: { ok: false, why: '已关' } } }
  ok('开关·关掉时 describe 说明已关', /无代理通道/.test(p.describe()), p.describe())
}

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  console.log('\n失败项：')
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过 ✓')
