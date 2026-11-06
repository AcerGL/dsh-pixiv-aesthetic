/**
 * 配置 + 工具 的离线自检。
 *   node selfcheck-tools.mjs
 * 不联网（网络那部分由 selfcheck.mjs --net 负责）。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { normalize, DEFAULTS, loadConfig, saveConfig, readConfig } from './lib/config.mjs'
import { Toolset } from './lib/toolset.mjs'

let pass = 0
const fails = []
const ok = (n, c, extra) => { if (c) pass++; else fails.push(n + (extra ? '  → ' + extra : '')) }
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)

const home = join(tmpdir(), 'px-cfg-' + Date.now())
await fs.mkdir(home, { recursive: true })

/* ─────────── 归一化 / 钳制 ─────────── */
eq('空配置给默认值', normalize({}).perDay, DEFAULTS.perDay)
eq('负数被钳到下限', normalize({ perDay: -5 }).perDay, 0)
eq('超大被钳到上限', normalize({ perDay: 99999 }).perDay, 999)
eq('非数字回默认', normalize({ perDay: 'abc' }).perDay, DEFAULTS.perDay)
eq('小数取整', normalize({ perDay: 3.9 }).perDay, 3)
eq('R18 默认关', normalize({}).allowR18, false)
ok('R18 只能显式 true', normalize({ allowR18: 'yes' }).allowR18 === false)
eq('channels 非法值被滤掉', normalize({ channels: ['local', 'telegram', 'qq'] }).channels, ['local', 'qq'])
eq('mirrorHost 去掉协议头', normalize({ mirrorHost: 'https://pixiv.re/' }).mirrorHost, 'pixiv.re')

/* ── 外部源（externalApi）：用户填写姿势五花八门，规范化要稳 ── */
eq('默认空的', normalize({}).externalApi, '')
eq('不带协议时补 http://', normalize({ externalApi: '127.0.0.1:8080' }).externalApi, 'http://127.0.0.1:8080')
eq('末尾斜杠去掉', normalize({ externalApi: 'http://127.0.0.1:8080/' }).externalApi, 'http://127.0.0.1:8080')
eq('末尾多个斜杠也去掉', normalize({ externalApi: 'http://a.b///' }).externalApi, 'http://a.b')
eq('https 保持 https', normalize({ externalApi: 'https://x.com' }).externalApi, 'https://x.com')
eq('带子路径时保留', normalize({ externalApi: 'https://x.com/api/pixiv' }).externalApi, 'https://x.com/api/pixiv')
eq('纯空白当没填', normalize({ externalApi: '   ' }).externalApi, '')
eq('前后空格去掉', normalize({ externalApi: '  http://a.b  ' }).externalApi, 'http://a.b')
eq('keywords 非数组回退', normalize({ keywords: 'abc' }).keywords, [])
eq('tagWeights 非对象回退', normalize({ tagWeights: [1, 2] }).tagWeights, {})
eq('intervalMin 钳制', normalize({ intervalMin: 99999 }).intervalMin, 1440)
eq('maxLook 有下限', normalize({ maxLook: 0 }).maxLook, 1)

/* ─────────── 双层配置：config.json 为准 ─────────── */
{
  // 宿主（profile）给的值
  const hostCfg = { perDay: 20, proxyUrl: 'http://host:1', keywords: ['从profile来的'] }
  const c1 = await loadConfig(home, hostCfg)
  eq('没有 config.json 时用宿主的', c1.perDay, 20)
  eq('宿主的 keywords 也生效', c1.keywords, ['从profile来的'])

  // 现在往 config.json 里写一份不同的
  await saveConfig(home, { perDay: 3, keywords: ['从文件来的'] }, hostCfg)
  const c2 = await loadConfig(home, hostCfg)
  eq('config.json 覆盖宿主的 perDay', c2.perDay, 3)
  eq('config.json 覆盖宿主的 keywords', c2.keywords, ['从文件来的'])
  eq('没写的键仍用宿主的', c2.proxyUrl, 'http://host:1')

  // 关键：只写 FILE_WINS 里的键，别把宿主的默认值也固化进文件
  const raw = await readConfig(home)
  ok('文件里不含无关键', !('enabled' in raw), JSON.stringify(Object.keys(raw)))
  ok('文件里含写过的键', 'perDay' in raw && 'keywords' in raw)

  // 改配置后立刻生效（工具每次现取）
  const c3 = await loadConfig(home, hostCfg)
  eq('重读拿到最新值', c3.perDay, 3)
}

/* ─────────── 工具定义 ─────────── */
{
  let cfg = await loadConfig(home, {})
  const ts = new Toolset({
    home,
    getConfig: () => cfg,
    getDelivery: () => null, // 没挂 QQ
    python: '',
  })
  const defs = ts.definitions()
  const names = defs.map((d) => d.name)
  // ⚠️ 必须走 definitions() 拿绑定过的 execute —— 宿主就是
  //    `tool.execute(args, exec)` 这么摘下来调的，直接调 this.toolX().execute 测不出
  //    this 绑定问题（那个 bug 真出现过）。
  const tool = (n) => defs.find((d) => d.name === n)

  // ⚠️ 加工具时**这里和 README 都要跟着改** —— docs 自检会核对这两处，
  //    别只改一处（2026-11-05 加 pixiv_taste 时就是靠它抓到的）。
  eq('九个工具都注册了', names.sort(), ['pixiv_explore', 'pixiv_feedback', 'pixiv_pick', 'pixiv_save', 'pixiv_search', 'pixiv_send', 'pixiv_status', 'pixiv_taste', 'pixiv_works'].sort())
  for (const d of defs) {
    ok(`${d.name} 有描述`, typeof d.description === 'string' && d.description.length > 20, d.name)
    ok(`${d.name} 有 parameters`, d.parameters && d.parameters.type === 'object', d.name)
    ok(`${d.name} 有 execute`, typeof d.execute === 'function', d.name)
  }
  ok('pixiv_send 描述里说明了聊天框发不了图',
    tool('pixiv_send').description.includes('不支持助手发图'))
  ok('pixiv_save 描述里说明了占额度',
    tool('pixiv_save').description.includes('占每日额度'))

  /* ─── 搜索必须做画师去重（2026-11-06 实测：83% 同一个画师）───
 * 不做的后果：画像生效后「翻熟画师」一次带回十来件、都带加成 ⇒
 * 实测 12 条里 10 条同一画师。explore 有配额+diversify 所以没事，
 * search 也得有，否则两个工具行为天差地别。
 */
{
  const fs2 = await import('node:fs/promises')
  const ts = await fs2.readFile(new URL('./lib/toolset.mjs', import.meta.url), 'utf8')
  ok('search 里做了 diversify', /const picked = diversify\(kept, \{/.test(ts))
  ok('用户指定词时压制力度更小（别硬拆）', /args\.word \? 8 : 14/.test(ts))
  ok('返回用去重后的结果', /returned: picked\.length/.test(ts))
}

/* ── 缩略图扩展名必须按**字节**定，不能写死 .jpg ──
   *  踩过（2026-11-05）：pixiv 的 c/540x540_70/ 会返回 **PNG 字节**，
   *  我们原先写死存成 "xxx.jpg" ⇒ read_image 读到扩展名与内容不符，直接报
   *  "the .jpg extension declares image/jpeg, but the bytes use a different image format"
   *  —— 读图那一步整个断掉（挑选流程的灵魂就在读图）。 */
  {
    const src = await fs.readFile(new URL('./lib/toolset.mjs', import.meta.url), 'utf8')
    ok('toolset 里有 sniffExt（按字节认格式）', /function sniffExt\s*\(/.test(src))
    ok('pick 用 sniffExt 定扩展名', /const ext = sniffExt\(bytes\)/.test(src))
    ok('pick 不再写死 .jpg 路径', !/sanitize\(id, \{ max: 20 \}\)\}\.jpg/.test(src))
    // 缓存探测要覆盖多种扩展名，否则改成 .png 后会重复下载
    ok('pick 缓存探测覆盖多扩展名', /for \(const ext of \['\.jpg', '\.png', '\.webp', '\.gif'\]\)/.test(src))
  }
  /* ── execute 被摘下来调也必须能跑（this 绑定回归） ── */
  {
    const detached = tool('pixiv_status').execute
    const r = await detached({})
    ok('execute 摘下来调不报 this 错', r && typeof r === 'object', JSON.stringify(r).slice(0, 100))
  }

  /* ─────────── 🔴 每个工具都必须声明 output ───────────
   * 踩过的大坑（2026-11-04，排查了两轮）：只给 name/description/parameters/execute 不够，
   * 宿主 `ctx.tools.register()` 会抛：
   *     TypeError: tool "pixiv_status" must declare output { schema, render, presentationMeta? }
   * 而这个异常被宿主吞掉（只写 stderr）⇒ entry 不 activate ⇒ apply 完全不执行。
   * 表现就是"插件装了但完全没反应"，极难查。
   */
  for (const d of defs) {
    ok(`${d.name} 声明了 output`, !!d.output, JSON.stringify(Object.keys(d)))
    if (!d.output) continue
    ok(`${d.name} 的 output 有 schema`, !!d.output.schema && typeof d.output.schema === 'object')
    ok(`${d.name} 的 output 有 render`, typeof d.output.render === 'function')
    // render 真跑一次：任何返回值都得能变成文本块，且不抛
    let rendered = null
    let threw = null
    try {
      rendered = d.output.render({}, { a: 1, b: [1, 2], c: 'x' })
    } catch (e) { threw = e.message }
    ok(`${d.name} 的 output.render 不抛`, threw === null, threw || '')
    ok(`${d.name} 的 output.render 回文本块`,
      Array.isArray(rendered) && rendered.length > 0 && rendered[0] && rendered[0].type === 'text',
      JSON.stringify(rendered).slice(0, 90))
    // 边界：null / undefined / 循环引用 / 超长，都不该抛
    let edgeOk = true
    const edgeWhy = []
    for (const [lbl, v] of [['null', null], ['undefined', undefined], ['字符串', 'hi'], ['数字', 42]]) {
      try { d.output.render({}, v) } catch (e) { edgeOk = false; edgeWhy.push(lbl + ': ' + e.message) }
    }
    const circ = {}; circ.self = circ
    try { d.output.render({}, circ) } catch { /* 循环引用抛了也接受，只要不是崩溃 */ }
    try {
      const huge = { s: 'x'.repeat(50000) }
      const out = d.output.render({}, huge)
      const len = out[0].text.length
      ok(`${d.name} 的超长返回被截断`, len < 20000, `len=${len}`)
    } catch (e) { edgeOk = false; edgeWhy.push('超长: ' + e.message) }
    ok(`${d.name} 的 render 边界输入不抛`, edgeOk, edgeWhy.join(' | '))
  }

  /* ── status 在没网时也不该抛，要给人话 ── */
  const st = await tool('pixiv_status').execute({})
  ok('status 能跑（没网也给结果）', st.ok === true || st.ok === false)
  ok('status 有 network 字段', st.network && typeof st.network.text === 'string', JSON.stringify(st.network).slice(0, 120))
  ok('status 有额度', st.quota && typeof st.quota.limit === 'number', JSON.stringify(st.quota))
  ok('status 有通道状态', Array.isArray(st.channels) && st.channels.some((c) => c.name === 'local'))

  /* ── 参数校验 ── */
  ok('pick 缺 ids 会报错', await rejects(() => tool('pixiv_pick').execute({})))
  ok('works 缺 id 会报错', await rejects(() => tool('pixiv_works').execute({})))
  ok('save 缺 id 会报错', await rejects(() => tool('pixiv_save').execute({})))
  ok('send 缺 paths 会报错', await rejects(() => tool('pixiv_send').execute({})))
  ok('send 路径不存在会报错', await rejects(() => tool('pixiv_send').execute({ paths: [join(home, 'nope.jpg')] })))

  /* ── 判重与额度闸门（不需要网络：先塞台账） ── */
  const { Ledger } = await import('./lib/seen.mjs')
  const led = new Ledger(home)
  await led.add({ id: '111', title: 'x', pages: 1, bytes: 1 })
  const dup = await tool('pixiv_save').execute({ id: '111' })
  ok('存过的直接被判重', dup.ok === false && dup.skipped === true, JSON.stringify(dup))
  ok('判重说明原因', dup.reason === '存过了', dup.reason)

  // 把今天的额度塞满
  for (let i = 0; i < cfg.perDay; i++) await led.add({ id: 'q' + i })
  const over = await tool('pixiv_save').execute({ id: '222' })
  ok('额度满了会被拦', over.ok === false && over.skipped === true, JSON.stringify(over))
  ok('额度说明原因', String(over.reason).includes('额度'), over.reason)
}

async function rejects(fn) { try { await fn(); return false } catch { return true } }

/* ─────────── 投递：默认只有落盘 ─────────── */
{
  const cfg = await loadConfig(home, {})
  const ts = new Toolset({ home, getConfig: () => cfg, getDelivery: () => null })
  const chans = await ts.delivery().status()
  eq('没宿主时只有落盘通道', chans.map((c) => c.name), ['local'])
  ok('落盘通道就绪', chans[0].ok, chans[0].why)
}

/* ─────────── 投递：有 QQ 时两个都在 ─────────── */
{
  const cfg = await loadConfig(home, { channels: ['local', 'qq'] })
  const ts = new Toolset({
    home,
    getConfig: () => cfg,
    getDelivery: () => ({ qq: { bot: {}, manager: {}, msgsLog: join(home, 'none.log') } }),
  })
  const chans = await ts.delivery().status()
  eq('有宿主时两个通道都在', chans.map((c) => c.name).sort(), ['local', 'qq'])
  const qq = chans.find((c) => c.name === 'qq')
  ok('QQ 没窗口时如实报不可用', qq.ok === false && /窗口|被动|消息/.test(qq.why), qq.why)
}

/* ─────────── 登录：可选项，坏了不能拖垮刷图 ─────────── */
{
  const home3 = join(home, 'login')
  await fs.mkdir(home3, { recursive: true })

  // 1) 默认不登录
  {
    const cfg = await loadConfig(home3, {})
    const ts = new Toolset({ home: home3, getConfig: () => cfg, getDelivery: () => null })
    const defs = ts.definitions()
    const st = await defs.find((d) => d.name === 'pixiv_status').execute({})
    ok('status 里有 login 字段', st.login && typeof st.login.text === 'string', JSON.stringify(st.login).slice(0, 100))
    ok('默认说的是游客模式', st.login.enabled === false && st.login.text.includes('游客'), st.login.text)
  }

  // 2) 开了登录但没贴 token → status 要明说，且**不能抛**
  {
    const cfg = await loadConfig(home3, { useLogin: true })
    const ts = new Toolset({ home: home3, getConfig: () => cfg, getDelivery: () => null })
    const st = await ts.definitions().find((d) => d.name === 'pixiv_status').execute({})
    ok('开了登录没 token 时不抛', st && st.login, JSON.stringify(st.login))
    ok('并明确说要贴 token', st.login.enabled === true && st.login.loggedIn === false && /refresh_token|贴/.test(st.login.text), st.login.text)
  }

  // 3) 登录相关失败时，search 仍要能出结果（只是少两个池子）
  {
    const cfg = await loadConfig(home3, { useLogin: true, loginSources: ['follow', 'recommend'], keywords: ['x'] })
    const ts = new Toolset({ home: home3, getConfig: () => cfg, getDelivery: () => null })
    // 把网络请求全部打桩成失败：验证"登录池失败不影响整体结论"
    const c = ts.client()
    c.ranking = async () => { throw new Error('打桩：排行失败') }
    c.search = async () => ({ items: [{ id: '1', tags: [], title: 't', userName: 'u', pageCount: 1, illustType: 0, bookmarkCount: 0, createDate: new Date().toISOString(), width: 2000, height: 2000 }], total: 1 })
    c.following = async () => { throw new Error('打桩：关注流炸了') }
    c.recommended = async () => { throw new Error('打桩：推荐炸了') }
    c.usingLogin = async () => false

    const r = await ts.definitions().find((d) => d.name === 'pixiv_search').execute({})
    ok('登录池炸了不影响出结果', r.ok === true && r.items.length === 1, JSON.stringify(r).slice(0, 160))
    ok('但如实报告登录池为什么没成', Array.isArray(r.loginSkipped) && r.loginSkipped.length === 2, JSON.stringify(r.loginSkipped))
    ok('loginUsed 是 false', r.loginUsed === false)
  }
}

await fs.rm(home, { recursive: true, force: true }).catch(() => {})
console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  console.log('\n失败项：')
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过 ✓')
