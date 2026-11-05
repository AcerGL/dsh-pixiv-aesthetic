/**
 * 外壳自检 —— package.json / cordis.patch.yml / locale / icon。
 *   node selfcheck-shell.mjs
 *
 * 这些错了不会报错，只会"插件装了但设置页里不出现"（刷B站踩过一模一样的坑），
 * 所以必须静态验一遍。
 */
import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
let pass = 0
const fails = []
const ok = (n, c, extra) => { if (c) pass++; else fails.push(n + (extra ? '  → ' + extra : '')) }
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)

const readJson = async (p) => JSON.parse(await fs.readFile(join(here, p), 'utf8'))

/* ─────────── package.json ─────────── */
const pkg = await readJson('package.json')
eq('包名', pkg.name, 'dsh-pixiv-scroll')
ok('有版本号', /^\d+\.\d+\.\d+/.test(pkg.version), pkg.version)
ok('是 ESM', pkg.type === 'module', pkg.type)
ok('声明了 dsh.bundle.patch（装上才会自动挂载）',
  pkg.dsh && pkg.dsh.bundle && typeof pkg.dsh.bundle.patch === 'string', JSON.stringify(pkg.dsh))
eq('patch 指向 cordis.patch.yml', pkg.dsh.bundle.patch, './cordis.patch.yml')
ok('main 指向 index.js', pkg.main === 'index.js', pkg.main)
ok('exports 导出了 .', pkg.exports && pkg.exports['.'], JSON.stringify(pkg.exports))
ok('exports 导出了 locale', pkg.exports['./locale/*.json'], JSON.stringify(pkg.exports))
ok('exports 导出了 icon', pkg.exports['./icon'], JSON.stringify(pkg.exports))
ok('有 license', pkg.license === 'MIT', pkg.license)
ok('声明了 engines.node', pkg.engines && pkg.engines.node, JSON.stringify(pkg.engines))

/* ─────────── 依赖声明：不许有解析不到的悬空 peer ───────────
 * 踩过的坑（2026-11-04）：`peerDependencies` 里写了 `@deepseek-ai/schemastery`，
 * 但对 **link: 安装**的插件，pnpm 明确不解析 peer（装的时候就有警告
 * "will not resolve the peer dependencies"）。实测从插件位置 MODULE_NOT_FOUND。
 * 结果：宿主那边插件**拒绝 activate**，apply 压根不被调用，
 * 表现是"装了但完全没反应"，而且日志里一个字都没有。
 *
 * 判据：本插件是**零依赖**设计（只用 Node 内置模块）。
 */
{
  const deps = Object.keys(pkg.dependencies || {})
  const peers = Object.keys(pkg.peerDependencies || {})
  eq('没有 dependencies（零依赖设计）', deps, [])
  eq('没有 peerDependencies（悬空 peer 会让插件拒绝 activate）', peers, [])
  ok('也没有 optional peer 的藏身之处',
    !pkg.peerDependenciesMeta || Object.keys(pkg.peerDependenciesMeta).length === 0,
    JSON.stringify(pkg.peerDependenciesMeta))
}

/* ─────────── dsh 段：bundle / client / compatibility ─────────── */
{
  ok('有 dsh.compatibility（宿主据此判断能不能跑）',
    !!(pkg.dsh && pkg.dsh.compatibility), JSON.stringify(pkg.dsh))
  const rel = (pkg.dsh.compatibility && pkg.dsh.compatibility.dshReleases) || {}
  ok('compatibility 里列了 dshReleases', Object.keys(rel).length > 0, JSON.stringify(rel))
  ok('列出的版本都标 compatible',
    Object.values(rel).every((v) => v === 'compatible'), JSON.stringify(rel))
  ok('compatibility 有一句说明',
    typeof (pkg.dsh.compatibility || {}).note === 'string' && pkg.dsh.compatibility.note.length > 10)
}

/* ─────────── files 列表要覆盖所有运行时文件 ─────────── */
{
  const declared = new Set(pkg.files || [])
  const need = ['index.js', 'lib', 'locale', 'icon.svg', 'cordis.patch.yml']
  for (const n of need) ok(`files 里含 ${n}`, declared.has(n), JSON.stringify([...declared]))
  // 实际存在的东西是不是都被覆盖
  const entries = await fs.readdir(here)
  const missed = entries.filter((e) =>
    !e.startsWith('.') && !declared.has(e) &&
    !['node_modules', 'package.json'].includes(e))
  ok('files 没漏掉实际文件', missed.length === 0, '漏了: ' + missed.join(','))
}

/* ─────────── patch 能被解析，且形状对 ─────────── */
{
  const text = await fs.readFile(join(here, 'cordis.patch.yml'), 'utf8')
  // 极简 YAML 形状校验（不引 yaml 依赖）：必须有 insert: 和一个 id/name
  ok('patch 有 insert:', /^\s*-\s*insert:/m.test(text), text.slice(0, 80))
  ok('patch 有 id: pixiv-scroll', /id:\s*pixiv-scroll/.test(text))
  ok('patch 的 name 指向本包', /name:\s*dsh-pixiv-scroll/.test(text))

  // 缩进一致性（YAML 最容易在这儿坏）
  const badIndent = text.split('\n').filter((l) => l.trim() && !l.startsWith('#') && /^\s+\S/.test(l) && (l.match(/^\s*/)[0].length % 2) !== 0)
  ok('缩进是偶数（YAML 缩进别错）', badIndent.length === 0, badIndent.join('|'))
}

/* ─────────── locale ─────────── */
for (const loc of ['zh', 'en']) {
  const j = await readJson(`locale/${loc}.json`)
  ok(`${loc}: 有 meta.title`, j.meta && typeof j.meta.title === 'string' && j.meta.title.length > 0, JSON.stringify(j).slice(0, 80))
  ok(`${loc}: 有 meta.description`, j.meta && typeof j.meta.description === 'string' && j.meta.description.length > 10)
  // 别留模板占位文案
  ok(`${loc}: 不是模板文案`, !/my-plugin|My Decoration|模板/i.test(JSON.stringify(j)), JSON.stringify(j).slice(0, 100))
}

/* ─────────── icon ─────────── */
{
  const svg = await fs.readFile(join(here, 'icon.svg'), 'utf8')
  ok('icon 是 svg', svg.trim().startsWith('<svg'))
  ok('icon 有 viewBox', /viewBox=/.test(svg))
  ok('icon 是闭合的', svg.trim().endsWith('</svg>'))
  const size = Buffer.byteLength(svg)
  ok('icon 不超过 256KiB', size < 256 * 1024, String(size))
}

/* ─────────── 家目录约定：配置与数据不能写进插件包目录 ─────────── */
{
  const files = await fs.readdir(join(here, 'lib'))
  let leak = []
  for (const f of files) {
    if (!f.endsWith('.mjs') && !f.endsWith('.js')) continue
    const t = await fs.readFile(join(here, 'lib', f), 'utf8')
    // 不该有任何"相对本文件往上写"的痕迹
    if (/__dirname\s*,\s*['"]\.\./.test(t) || /writeFileSync\([^)]*__dirname/.test(t)) leak.push(f)
  }
  ok('lib 里没有往插件目录写的代码', leak.length === 0, leak.join(','))
}

/* ─────────── 零凭证泄漏（开源红线） ─────────── */
{
  const suspicious = []
  // 🔴 关键：**这些真 ID 不能原样写进来** —— 本文件是会发布出去的。
  //    用片段拼正则：匹配能力完全一样，但仓库里扫不到完整的 ID / 密钥片段。
  // ⚠️ 注意转义：'\\\\b' 在正则源码里是 \b（词边界）。
  //    写成 '\\b' 会变成**字面反斜杠 + b**，守卫就静默失效了（踩过）。
  const idRe = (...parts) => new RegExp(String.raw`\b` + parts.join('') + String.raw`\b`)
  // 真·凭证模式：必须出现在**代码赋值**里才算，注释里科普不算
  const credentialPatterns = [
    { re: /\bappSecret\s*[:=]\s*['"][A-Za-z0-9_-]{10,}['"]/, why: '硬编码的 QQ appSecret' },
    { re: /\brv_[A-Za-z0-9_-]{16,}/, why: 'river key' },
    { re: /\bsk-[A-Za-z0-9]{20,}/, why: '通用 API key' },
    { re: idRe('g8b4Y2', 'X2|OqIl', 'EiCh'), why: '已知的 appSecret 片段' },
    { re: idRe('190582', '8754'), why: '本机 QQ appId' },
    { re: idRe('44372', '0005'), why: '号主 uid' },
    { re: idRe('58931', '7904'), why: '小号 uid' },
  ]
  // 本机代理端口：**只在代码默认值里算问题**，注释/示例/自检兜底都允许
  const proxyAsDefault = { re: /(proxyUrl|DEFAULTS[\s\S]{0,200}?proxyUrl)\s*[:=]\s*['"]https?:\/\/127\.0\.0\.1:7897['"]/, why: '把本机代理写成了默认值' }

  const stripComments = (t) => t
    .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1') // 行注释（避开 http://）

  const walk = async (dir) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) { await walk(full); continue }
      if (!/\.(mjs|js|json|yml|yaml|md|py|svg)$/.test(e.name)) continue
      if (e.name === 'selfcheck-shell.mjs') continue // 本文件自己含这些模式
      const raw = await fs.readFile(full, 'utf8')
      const code = stripComments(raw)
      for (const { re, why } of credentialPatterns) {
        if (re.test(code)) suspicious.push(`${e.name}: ${why}`)
      }
      if (proxyAsDefault.re.test(code)) suspicious.push(`${e.name}: ${proxyAsDefault.why}`)
    }
  }
  await walk(here)
  ok('代码里没有硬编码凭证 / 私人 ID / 本机代理默认值', suspicious.length === 0, suspicious.join(' | '))

  // 🔴 反向验证：**守卫本身必须真能抓到东西**。
  //    只测"没扫到"是不够的 —— 正则要是写错（比如 \\b 转义成字面反斜杠），
  //    它会对任何输入都返回 false，看起来全过，其实是废的。（2026-11-05 真踩过）
  {
    // ⚠️ 这里同样用片段拼，别把真 ID 写进来
    const sample = ['appId: ', ['190582', '8754'].join(''), ' u ', ['44372', '0005'].join(''), ' u ', ['58931', '7904'].join('')].join('')
    const hits = credentialPatterns.filter((c) => c.re.test(sample)).length
    ok('守卫真的抓得住塞进去的 ID（不是废正则）', hits >= 3, '命中 ' + hits + ' 条')

    // 边界也要对：不能匹配更短/更长的一串
    const appIdRe = credentialPatterns.find((c) => c.why.includes('appId')).re
    ok('守卫不吃更长的数字串', !appIdRe.test(['190582', '8754', '9'].join('')), '更长的不该命中')
  }

  // 明确验一次：默认值必须是空的
  const cfg = await fs.readFile(join(here, 'lib', 'config.mjs'), 'utf8')
  ok('proxyUrl 默认值是空', /proxyUrl:\s*''/.test(cfg), '看 config.mjs 的 DEFAULTS')
  ok('saveRoot 默认值是空', /saveRoot:\s*''/.test(cfg))
}

/* ─────────── README / LICENSE 存在 ─────────── */
for (const f of ['README.md', 'LICENSE']) {
  try { await fs.access(join(here, f)); ok(`${f} 存在`, true) }
  catch { ok(`${f} 存在`, false, '还没写') }
}

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  console.log('\n失败项：')
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过 ✓')
