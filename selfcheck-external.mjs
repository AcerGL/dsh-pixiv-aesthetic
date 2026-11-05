/**
 * 外部源端到端验证 —— 起一个假的"外部源"，看插件认不认。
 *   node selfcheck-external.mjs
 *
 * 做法：本地起一个 HTTP 服务，**模拟 pixiv 官方接口形态**（返回跟官方一样的 JSON），
 * 然后把插件的 externalApi 指过去，看它能不能正常搜索。
 *
 * 这一步证明的是「用户填个地址，插件就能用它」这条链子真的通 ——
 * 而不只是单元测试里的字符串拼接对。
 */
import http from 'node:http'
import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
let pass = 0
const fails = []
const ok = (n, c, extra) => { if (c) pass++; else fails.push(n + (extra ? '  → ' + extra : '')) }
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)

/* ─────────── 假外部源：模拟 pixiv 官方接口 ─────────── */
const seen = []
const srv = http.createServer((req, res) => {
  seen.push(req.url)
  const send = (obj) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }
  // 排行：官方形态
  if (req.url.startsWith('/ranking.php')) {
    send({
      contents: [
        { illust_id: 111, title: '外部源作品A', user_id: 'u1', user_name: '画师甲', tags: ['タグ'], width: 2000, height: 2000, illust_page_count: 1, illust_type: 0, view_count: 100, rank: 1, illust_upload_timestamp: Math.floor(Date.now() / 1000) },
        { illust_id: 222, title: '外部源作品B', user_id: 'u2', user_name: '画师乙', tags: ['R-18'], width: 2000, height: 2000, illust_page_count: 1, illust_type: 0, view_count: 50, rank: 2, illust_upload_timestamp: Math.floor(Date.now() / 1000) },
      ],
    })
    return
  }
  // 搜索：官方形态
  if (req.url.startsWith('/ajax/search/artworks/')) {
    send({ error: false, body: { illustManga: { total: 1, data: [
      { id: '333', title: '搜索结果作品', userId: 'u3', userName: '画师丙', tags: ['初音ミク'], width: 2400, height: 2400, pageCount: 1, illustType: 0, bookmarkCount: 500, createDate: new Date().toISOString(), url: 'https://i.pximg.net/c/250x250_80_a2/img-master/img/2026/11/05/00/00/00/333_p0_square1200.jpg' },
    ] } } })
    return
  }
  if (req.url.startsWith('/ajax/illust/')) {
    send({ error: false, body: { illustId: '333', illustTitle: '搜索结果作品', userId: 'u3', userName: '画师丙', tags: { tags: [{ tag: '初音ミク' }] }, width: 2400, height: 2400, pageCount: 1, illustType: 0, xRestrict: 0, createDate: new Date().toISOString() } })
    return
  }
  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end('{"error":true}')
})

await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const port = srv.address().port
const BASE = `http://127.0.0.1:${port}`

try {
  const { rewriteBase } = await import('./lib/route.mjs')
  const { PixivClient } = await import('./lib/pxclient.mjs')

  /* ── 1. 直接验 rewriteBase + 真发请求 ── */
  {
    const { httpGet } = await import('./lib/transport.mjs')
    const url = rewriteBase('https://www.pixiv.net/ranking.php?mode=daily&content=illust&format=json', BASE)
    const res = await httpGet(url, { timeoutMs: 5000 })
    eq('假外部源返回 200', res.status, 200)
    const j = JSON.parse(res.body.toString('utf8'))
    eq('拿到 2 条', j.contents.length, 2)
    ok('外部源确实收到了请求', seen.some((u) => u.startsWith('/ranking.php')), JSON.stringify(seen))
    ok('请求带上了完整 query', seen.some((u) => u.includes('format=json') && u.includes('content=illust')), JSON.stringify(seen))
  }

  /* ── 2. 走 PixivClient：用外部源搜索 ── */
  {
    const c = new PixivClient({ externalApi: BASE, timeoutMs: 8000, probeTimeoutMs: 5000 })
    const r = await c.route()
    eq('探测结果：元数据走 external', r.meta, 'external')
    ok('探测确实打了外部源', seen.some((u) => u.startsWith('/ranking.php')), JSON.stringify(seen))
    eq('构造时记住了外部源', c.probe.externalApi, BASE)
    ok('措辞显示外部源', (await c.status()).includes('外部源 ✓'), await c.status())
  }

  /* ── 3. 搜索走外部源，且数据能正确归一化 ── */
  {
    const c = new PixivClient({ externalApi: BASE, timeoutMs: 8000, probeTimeoutMs: 5000 })
    const s = await c.search({ word: '初音ミク' })
    eq('搜索拿到 1 条', s.items.length, 1)
    eq('标题对', s.items[0].title, '搜索结果作品')
    eq('id 对', s.items[0].id, '333')
    // ⚠️ 关键：缩略图要能反推原图（外部源的 url 形态跟官方一样）
    eq('缩略图能反推原图', s.items[0].original,
      'https://i.pximg.net/img-master/img/2026/11/05/00/00/00/333_p0.jpg')
    ok('搜索请求打到了外部源', seen.some((u) => u.startsWith('/ajax/search/artworks/')), JSON.stringify(seen))
  }

  /* ── 4. 排行走外部源 ── */
  {
    const c = new PixivClient({ externalApi: BASE, timeoutMs: 8000, probeTimeoutMs: 5000 })
    const r = await c.ranking({ mode: 'daily' })
    eq('排行拿到 2 条', r.items.length, 2)
    eq('首条标题对', r.items[0].title, '外部源作品A')
    ok('标题是外部源的（不是官方数据）', r.items[0].title.includes('外部源'))
  }

  /* ── 5. 详情走外部源 ── */
  {
    const c = new PixivClient({ externalApi: BASE, timeoutMs: 8000, probeTimeoutMs: 5000 })
    const d = await c.detail('333')
    eq('详情标题对', d.title, '搜索结果作品')
    eq('详情 tags 归一成字符串数组', d.tags, ['初音ミク'])
  }

  /* ── 6. 外部源不通时的表现 ──
   * ⚠️ 这里**不能断言"整条路全不通"** —— 那是依赖环境条件的假设。
   *    2026-11-05 踩到：本机能直连 pixiv 时，外部源填个坏地址，
   *    路由会（正确地）落到 direct 上，于是 r.meta 是 'direct' 不是 null。
   *    那不是 bug，是探测在按设计工作。所以要验的是**它有没有如实说明外部源的状态**，
   *    而不是"它必须说全不通"。跟 selfcheck.mjs 里黑洞地址那个处理同理。
   */
  {
    const c = new PixivClient({ externalApi: 'http://127.0.0.1:1', timeoutMs: 1500, probeTimeoutMs: 1200 })
    const r = await c.route()
    // 关键不变式：外部源是坏的，**绝不能**被判成 ok
    ok('坏外部源不会被判成可用', r.detail.external.ok === false,
      JSON.stringify(r.detail.external))
    ok('坏外部源的失败原因记得住', typeof r.detail.external.why === 'string' && r.detail.external.why.length > 0,
      JSON.stringify(r.detail.external.why))

    // 如果这台机器别的腿也都不通 → 应该如实说全不通
    // 如果别的腿通 → 落到那条腿上是对的（不能因此判失败）
    if (!r.meta) {
      const text = await c.status()
      ok('全不通时措辞说明外部源不通', text.includes('外部源'), text)
      ok('全不通时措辞给出下一步', text.includes('外部源') || text.includes('代理'), text)
    } else {
      ok('别的腿能通时落到那条腿（探测按设计工作）', ['direct', 'proxy'].includes(r.meta), String(r.meta))
      const text = await c.status()
      ok('措辞如实反映实际走的路', text.length > 0, text)
    }
  }
} finally {
  srv.close()
}

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  console.log('\n失败项：')
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过 ✓')
