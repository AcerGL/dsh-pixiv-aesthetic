/**
 * 浮窗（右侧停靠面板）的自检。
 *   node selfcheck-pane.mjs
 *
 * 不联网。验：
 *   · 缩略图 URL 推导（那个双重 replace 的坑）
 *   · 图库列举（depth=0 不当作品的那个坑）
 *   · 路径穿越必须被挡住（**安全**，参数来自 HTTP）
 *   · client bundle 的接线（tab 注册、样式、两个正文）
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = join(tmpdir(), 'px-pane-' + Date.now())
const libRoot = join(home, 'library')
await fs.mkdir(libRoot, { recursive: true })

let pass = 0
const fails = []
const ok = (n, c, extra) => { if (c) pass++; else fails.push(n + (extra ? '  → ' + extra : '')) }
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)

const TS = await import('./lib/toolset.mjs')

/* ─────────── ① 缩略图 URL 推导（双重 replace 的坑） ─────────── */
{
  const { thumbFromOriginal } = TS
  const original = 'https://i.pximg.net/img-original/img/2026/11/06/23/27/27/151759763_p0.png'
  const t = thumbFromOriginal(original)
  eq('原图 → 缩略图',
    t, 'https://i.pximg.net/c/540x540_70/img-master/img/2026/11/06/23/27/27/151759763_p0.png')
  ok('🔴 不含双重前缀（那个坑）', !t.includes('/c/540x540_70/c/540x540_70/'), t)
  // 幂等：已经是缩略图就别再套一层
  eq('再次调用不变（幂等）', thumbFromOriginal(t), t)
  // img-master 形态
  const m = thumbFromOriginal('https://i.pximg.net/img-master/img/2026/11/06/00/00/00/1_p0.jpg')
  ok('img-master 形态也能转', m.includes('/c/540x540_70/img-master/') && !m.includes('/c/540x540_70/c/'), m)
  // 空/异形
  eq('空输入返回空', thumbFromOriginal(''), '')
  eq('非 pixiv 地址原样返回', thumbFromOriginal('https://x.com/a.png'), 'https://x.com/a.png')
}

/* ─────────── ② 图库列举 ─────────── */
{
  // 造一个真实形状：<root>/<画师>/<标题_id>/001.png
  await fs.mkdir(join(libRoot, 'Nitoha', '雲の上_151759763'), { recursive: true })
  await fs.writeFile(join(libRoot, 'Nitoha', '雲の上_151759763', '001.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  await fs.writeFile(join(libRoot, 'Nitoha', '雲の上_151759763', '002.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  await fs.mkdir(join(libRoot, 'Kuro', '安魂曲_151762557'), { recursive: true })
  await fs.writeFile(join(libRoot, 'Kuro', '安魂曲_151762557', '001.jpg'), Buffer.from([0xff, 0xd8, 0xff]))
  // 🔴 根目录直接躺一张散图 —— 这正是那个 bug 的触发条件
  await fs.writeFile(join(libRoot, 'preview_151759763.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

  const ts = new TS.Toolset({
    home,
    getConfig: () => ({ saveRoot: libRoot, proxyUrl: '', timeoutMs: 1000 }),
    getDelivery: () => null, python: '', log: () => {},
  })
  const lib = await ts.libraryList({ limit: 50 })
  const names = lib.items.map((x) => x.name)
  ok('🔴 根目录有散图时，子目录的作品仍被列出来', names.includes('雲の上_151759763'), JSON.stringify(names))
  ok('第二件也在', names.includes('安魂曲_151762557'), JSON.stringify(names))
  ok('根目录的散图也收进来了', names.includes('preview_151759763.png'), JSON.stringify(names))
  eq('总共 3 项（2 作品 + 1 散图）', lib.count, 3)
  // 作品 id 从目录名解出来
  const w1 = lib.items.find((x) => x.name === '雲の上_151759763')
  eq('从目录名解出作品 id', w1.id, '151759763')
  eq('页数数对了', w1.pages, 2)
  // 散图标记了 loose
  const loose = lib.items.find((x) => x.name === 'preview_151759763.png')
  eq('散图标了 loose', loose.loose, true)
  // 不存在的目录：返回空、不抛
  const ts2 = new TS.Toolset({
    home, getConfig: () => ({ saveRoot: join(home, 'nope'), proxyUrl: '' }),
    getDelivery: () => null, python: '', log: () => {},
  })
  const empty = await ts2.libraryList({})
  eq('目录不存在时返回 0 件（不抛）', empty.count, 0)
}

/* ─────────── ③ 路径穿越（安全，必须挡住） ─────────── */
{
  const ts = new TS.Toolset({
    home,
    getConfig: () => ({ saveRoot: libRoot, proxyUrl: '' }),
    getDelivery: () => null, python: '', log: () => {},
  })
  const evil = [
    '../../../../Windows/System32/drivers/etc/hosts',
    '..\\..\\secret.png',
    '/etc/passwd',
    'a/../../../x.png',
    './../y.png',
    '',
  ]
  for (const e of evil) {
    let blocked = false
    try { await ts.libraryFileBytes(e) } catch { blocked = true }
    ok(`挡住了路径穿越：${JSON.stringify(e)}`, blocked)
  }
  // 非图片后缀也要挡（不然能读任意文本）
  let blockedTxt = false
  try { await ts.libraryFileBytes('a/b.txt') } catch { blockedTxt = true }
  ok('挡住非图片后缀', blockedTxt)
  // 正常路径要能读
  const good = await ts.libraryFileBytes('Nitoha/雲の上_151759763/001.png')
  ok('正常路径读得到', good.bytes.length > 0 && good.contentType === 'image/png', good.contentType)
  // 反斜杠也要能处理（Windows 手输）
  const good2 = await ts.libraryFileBytes('Nitoha\\雲の上_151759763\\001.png')
  ok('反斜杠路径也能读', good2.bytes.length > 0)
  // revealInExplorer 也要挡穿越
  let blockedReveal = false
  try { await ts.revealInExplorer('../../x.png') } catch { blockedReveal = true }
  ok('revealInExplorer 也挡穿越', blockedReveal)
}

/* ─────────── ④ 结果推给浮窗（onResult） ─────────── */
{
  let got = null
  const ts = new TS.Toolset({
    home,
    getConfig: () => ({ saveRoot: libRoot, proxyUrl: '' }),
    getDelivery: () => null, python: '', log: () => {},
    onResult: (p) => { got = p },
  })
  ts.publish([{ id: '1', title: 'T' }], '测试')
  ok('publish 调到了 onResult', got && got.items.length === 1)
  eq('label 传过去了', got.label, '测试')

  // onResult 抛异常不能影响 publish 的调用方
  const ts2 = new TS.Toolset({
    home, getConfig: () => ({ saveRoot: libRoot }), getDelivery: () => null, python: '', log: () => {},
    onResult: () => { throw new Error('浮窗炸了') },
  })
  let threw = false
  try { ts2.publish([{ id: '1' }], 'x') } catch { threw = true }
  ok('🔴 浮窗异常不影响主流程（展示层不该拖垮工具）', !threw)

  // 没有 onResult 时 publish 也不该抛
  const ts3 = new TS.Toolset({
    home, getConfig: () => ({ saveRoot: libRoot }), getDelivery: () => null, python: '', log: () => {},
  })
  let threw3 = false
  try { ts3.publish([{ id: '1' }], 'x') } catch { threw3 = true }
  ok('没接 onResult 时 publish 不抛', !threw3)
}

/* ─────────── ⑤ client bundle 接线 ─────────── */
{
  const src = await fs.readFile(new URL('./client.js', import.meta.url), 'utf8')
  ok('注册了两个 tab 类型', /'pixiv-board'/.test(src) && /'pixiv-library'/.test(src))
  ok('用 sidebarRightTabs.register', /tabs\.register\(\{/.test(src))
  ok('正文注册到 sidebar.right.pane.tab', /'sidebar\.right\.pane\.tab'/.test(src))

  /**
   * 🔴 三步注册，缺一步 tab 就不显示（2026-11-07 实测踩到）。
   *
   * 这里以前断言的是 `inject: ['slots','sidebarRightTabs','sidebarRight']` ——
   * **那条断言把 bug 锁住了**：它要求把两个可选服务写进 inject，
   * 而当时我误以为"inject 里缺服务宿主就不跑 apply()"，于是把列表删成
   * `['slots']` —— 那才是 2026-11-07 把 DSH 弄崩的真因。
   * 现在反过来断言"三个都得在"。
   */
  /**
   * ⚠️ 查"有没有这段代码"之前**必须先去注释** —— 否则断言会命中注释里
   *    那段解释文字而**假通过**（2026-11-07 实测踩到：把标题 chip 的注册
   *    整段删掉，自检照样全绿，因为它匹配的是注释里写的
   *    `sidebar.right.pane.tab.title`）。这类"断言在测文档"的假通过
   *    比没断言更坏 —— 它会让人以为安全。
   */
  const codeOnly0 = src
    .replace(/\/\*[\s\S]*?\*\//g, '')     // 块注释
    .replace(/^\s*\/\/[^\n]*/gm, '')      // 整行行注释

  ok('① 声明 tab 类型（带 priority/canOpen）',
     /priority:\s*'builtin'/.test(codeOnly0) && /canOpen:/.test(codeOnly0))
  ok('② 正文注册（带 key）',
     /name:\s*'sidebar\.right\.pane\.tab'[\s\S]{0,80}?key:\s*t\.id/.test(codeOnly0))
  ok('🔴 ③ 标题 chip 也注册（漏了 tab 整条不显示）',
     /'sidebar\.right\.pane\.tab\.title'/.test(codeOnly0),
     '必须注册 sidebar.right.pane.tab.title，否则标签条上没这个 tab')
  ok('🔴 有 openTab 去把 tab 真的打开（光注册不会出现）',
     /openTab/.test(codeOnly0),
     '注册只是声明类型，得有人 openTab 才会实例化标签页')
  ok('🔴 inject 必须列全要用的服务（少一个 ⇒ 摸一下就抛 ⇒ 整个应用起不来）',
     /inject:\s*\['slots',\s*'sidebarRightTabs',\s*'sidebarRight'\]/.test(codeOnly0),
     'ctx 是 Proxy：没写进 inject 的服务，ctx.get(\'x\') 和 ctx.x 都会抛 ' +
     'cannot get property "x" without inject。2026-11-07 就是因为把这个列表删成 ' +
     "['slots']，又把 DSH 弄崩了一次")

  ok('有「这一轮」正文', /const BoardBody/.test(codeOnly0))
  ok('有「图库」正文', /const LibraryBody/.test(src))
  // 浮窗上要能选（老大明确要求）
  ok('浮窗上有喜欢按钮', /more_like_this/.test(src))
  ok('浮窗上有不喜欢按钮', /'unlike'/.test(src))
  ok('浮窗上有存按钮', /jpost\('\/save'/.test(src))
  // 缩略图走插件接口，不是直连 pximg
  ok('缩略图走插件接口', /\/thumb\?id=/.test(src))
  // 🔴 防回归：代码里不能直连 i.pximg.net（会被防盗链拦）
  //    ⚠️ 要**去掉注释再查** —— 注释里正解释着"为什么不直连"，会误伤
  {
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释
      .replace(/^\s*\/\/[^\n]*/gm, '')       // 整行行注释
      .replace(/([^:])\/\/[^\n]*/g, '$1')    // 行尾注释（避开 http://）
    ok('🔴 代码里没有直连 i.pximg.net（会被防盗链拦）', !/i\.pximg\.net/.test(codeOnly),
      '注释里提它是可以的（那是在解释为什么不那么做）')
  }
  // 样式
  ok('有 grid 样式', /\[data-px-grid\]/.test(src))
  ok('网格自适应（不写死列数）', /auto-fill,minmax/.test(src))
}

/* ─────────── ⑥ 宿主接口接线 ─────────── */
{
  const idx = await fs.readFile(new URL('./index.js', import.meta.url), 'utf8')
  for (const p of ['/thumb', '/file', '/board', '/library', '/feedback', '/save', '/reveal']) {
    ok(`注册了 ${p} 路由`, idx.includes(`'/api/pixiv-scroll${p}'`), '浮窗拿不到数据')
  }
  ok('有发二进制的 binary()', /const binary = \(code, bytes/.test(idx))
  ok('🔴 connection 分支会原样透传二进制（不当字符串用）',
    /out\.body !== undefined && out\.body !== null\)\s*\n\s*\? out\.body/.test(idx),
    '原来无条件当字符串，图片会变成 [object Uint8Array]')
  ok('看板只在内存（不落盘）', /let lastBoard = \{/.test(idx) && !/board\.json/.test(idx))
  ok('接了 onResult', /onResult: \(payload\) =>/.test(idx))
}

await fs.rm(home, { recursive: true, force: true }).catch(() => {})
console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  console.log('\n失败项：')
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过 ✓')
